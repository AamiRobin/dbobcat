/**
 * Updatable query results (Phase 9-A): detect whether a SELECT provably
 * reads exactly one table, so its result grid can be edited through the
 * normal changeset machinery.
 *
 * The detector is deliberately conservative — it must never claim a table
 * for SQL it does not fully understand. Everything that smells like a join,
 * subquery, set operation or aggregate-only projection yields `null` and the
 * grid stays read-only.
 */

export interface DetectedQueryTable {
  /** Qualifying database; `null` = unqualified (use the session database). */
  db: string | null;
  table: string;
}

/** Tokens that may legally follow the FROM table reference. */
const CLAUSE_KEYWORDS = new Set([
  "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET",
  "FETCH", "WINDOW", "FOR", "INTO",
]);

const JOIN_KEYWORDS = new Set([
  "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL",
  "LATERAL", "STRAIGHT_JOIN", "ON", "USING",
]);

interface Token {
  text: string;
  quoted: boolean;
}

/** Lex a statement into word/quoted-identifier tokens (comments removed). */
function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    // Comments (handled before strings so `--` inside them never matters).
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "#") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      const start = i;
      i += 1;
      while (i < n) {
        if (sql[i] === "\\" && close !== "`") {
          i += 2;
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      tokens.push({ text: sql.slice(start, i), quoted: true });
      continue;
    }
    if (/\s|,|;|\(|\)|\./.test(c)) {
      // Structural separators end words but are tracked as boundaries only.
      if (/[\s]/.test(c)) {
        i += 1;
      } else {
        i += 1;
        tokens.push({ text: c, quoted: false });
      }
      continue;
    }
    const start = i;
    while (i < n && !/[\s,;()'"`[\].]/.test(sql[i])) i += 1;
    if (i > start) tokens.push({ text: sql.slice(start, i), quoted: false });
    else i += 1;
  }
  return tokens;
}

function isKeyword(token: Token, ...names: string[]): boolean {
  return !token.quoted && names.includes(token.text.toUpperCase());
}

/**
 * Detect the single table read by a plain SELECT.
 *
 * Returns `{db, table}` when the statement:
 * - starts with SELECT (no WITH / UNION / VALUES / parenthesised head),
 * - has a top-level FROM naming one table (optionally `db`.`table`,
 *   optional alias), with no JOIN / comma / derived table,
 * - keeps its WHERE free of another FROM or SELECT.
 */
export function detectQueryTable(sql: string): DetectedQueryTable | null {
  const tokens = lex(sql);
  let idx = 0;

  const nextMeaningful = (): Token | null => {
    while (idx < tokens.length && tokens[idx].text === "(") {
      return null; // parenthesised head → not a plain SELECT
    }
    return tokens[idx] ?? null;
  };

  const first = nextMeaningful();
  if (!first || !isKeyword(first, "SELECT")) return null;
  idx += 1;

  // Reject set operations anywhere in the statement.
  for (let k = idx; k < tokens.length; k++) {
    if (isKeyword(tokens[k], "UNION", "INTERSECT", "EXCEPT", "MINUS")) {
      return null;
    }
  }

  // Find the top-level FROM.
  let depth = 0;
  let fromIdx = -1;
  for (let k = idx; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.quoted && t.text === "(") depth += 1;
    else if (!t.quoted && t.text === ")") depth -= 1;
    else if (depth === 0 && isKeyword(t, "FROM")) {
      fromIdx = k;
      break;
    }
  }
  if (fromIdx < 0) return null;

  // Exactly one FROM at the top level (a second one inside the WHERE would
  // have been caught by depth tracking; a third-level FROM means subquery).
  depth = 0;
  for (let k = fromIdx + 1; k < tokens.length; k++) {
    const t = tokens[k];
    if (!t.quoted && t.text === "(") depth += 1;
    else if (!t.quoted && t.text === ")") depth -= 1;
    else if (depth === 0 && isKeyword(t, "FROM")) return null;
  }

  // Parse the table reference.
  let k = fromIdx + 1;
  if (k >= tokens.length || tokens[k].text === "(") return null; // derived table

  const parts: string[] = [];
  for (;;) {
    if (k >= tokens.length) break;
    const t = tokens[k];
    parts.push(t.text.replace(/^["'`[\]]+|["'`[\]]+$/g, ""));
    k += 1;
    if (k < tokens.length && tokens[k].text === ".") {
      k += 1;
      continue;
    }
    break;
  }
  if (parts.length === 0 || parts.length > 2) return null;
  const [tableOrDb, maybeTable] =
    parts.length === 2 ? [parts[0], parts[1]] : [null, parts[0]];
  if (!maybeTable) return null;

  // Optional alias (AS x or bare identifier), then a clause keyword or end.
  if (k < tokens.length) {
    const t = tokens[k];
    if (isKeyword(t, "AS")) {
      k += 1;
      if (k >= tokens.length) return null;
      k += 1;
    } else if (
      t.quoted ||
      !(CLAUSE_KEYWORDS.has(t.text.toUpperCase()) || JOIN_KEYWORDS.has(t.text.toUpperCase()))
    ) {
      k += 1; // bare alias
    }
  }

  if (k < tokens.length) {
    const t = tokens[k];
    if (t.text === "," ) return null; // comma join
    if (isKeyword(t, "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "OUTER", "CROSS", "NATURAL", "STRAIGHT_JOIN", "LATERAL")) {
      return null;
    }
    if (!isKeyword(t, "WHERE", "GROUP", "HAVING", "ORDER", "LIMIT", "OFFSET", "FETCH", "WINDOW", "FOR")) {
      return null; // unexpected token — stay conservative
    }

    // Best-effort WHERE guard: reject references to other sources — any
    // nested FROM/SELECT token (subqueries included) disqualifies.
    if (isKeyword(t, "WHERE")) {
      for (let w = k + 1; w < tokens.length; w++) {
        if (isKeyword(tokens[w], "FROM", "SELECT")) return null;
      }
    }
  }

  return { db: tableOrDb, table: maybeTable };
}

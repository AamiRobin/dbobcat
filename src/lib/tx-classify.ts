/**
 * First-keyword SQL classifier for the transaction UI — a behavioural mirror
 * of `src-tauri/src/connections/tx.rs` (dual-maintenance discipline: keep
 * both keyword vectors and test data in sync, like script.rs ↔
 * sql-splitter.ts).
 *
 * Used by the query editor to warn before a statement that would implicitly
 * commit an open manual-mode transaction (MySQL/MariaDB DDL only).
 */

export type SqlDialect = "mysql" | "postgres" | "sqlite";

/**
 * Statement class. `"ddl-commit"` marks MySQL DDL that force-commits an open
 * transaction; plain `"ddl"` is transactional (PostgreSQL always, MySQL
 * TEMPORARY exceptions).
 */
export type StmtClass =
  | "select"
  | "dml"
  | "tcl"
  | "ddl-commit"
  | "ddl"
  | "other";

const TCL_KEYWORDS = [
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
] as const;

const DML_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE"] as const;

/** CREATE / ALTER / DROP / RENAME / TRUNCATE — same vector as the Rust side. */
const DDL_KEYWORDS = ["CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE"] as const;

/** Up to `count` significant (non-comment) keywords, uppercased. */
export function leadingKeywords(sql: string, count: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length && out.length < count) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === "#") {
      while (i < sql.length && sql[i] !== "\n") i += 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const next = sql[i + 2];
      if (next === undefined || /\s/.test(next)) {
        while (i < sql.length && sql[i] !== "\n") i += 1;
      } else {
        // `--x` is code, not a comment.
        const word = readWordAt(sql, i + 1);
        out.push(word);
        i += 1 + word.length;
      }
    } else if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, sql.length);
    } else if (/[A-Za-z_]/.test(c)) {
      const word = readWordAt(sql, i);
      out.push(word);
      i += word.length;
    } else {
      break; // non-word code char — classifier stops here
    }
  }
  return out.map((w) => w.toUpperCase());
}

function readWordAt(sql: string, from: number): string {
  let end = from;
  while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
  return sql.slice(from, end);
}

/**
 * Classify a statement by its first significant keyword(s). Case-,
 * whitespace- and leading-comment tolerant; comment-only input is "other".
 *
 * MySQL/MariaDB: CREATE/ALTER/DROP/RENAME/TRUNCATE implicitly commit an open
 * transaction — EXCEPT `CREATE TEMPORARY` / `DROP TEMPORARY` (`ALTER
 * TEMPORARY` does not exist as syntax but is treated as committing).
 * PostgreSQL DDL never commits implicitly (it is transactional).
 */
export function classify(dialect: SqlDialect, sql: string): StmtClass {
  const [first, second] = leadingKeywords(sql, 2);
  if (!first) return "other";

  // CTE prologue: overwhelmingly SELECT-shaped (`WITH … INSERT/UPDATE/
  // DELETE` is mis-classified — accepted first-keyword limit).
  if (first === "SELECT" || first === "WITH") return "select";
  if ((DML_KEYWORDS as readonly string[]).includes(first)) return "dml";
  if ((TCL_KEYWORDS as readonly string[]).includes(first)) return "tcl";
  if ((DDL_KEYWORDS as readonly string[]).includes(first)) {
    const temporary = second === "TEMPORARY";
    const exception = dialect === "mysql" && temporary && first !== "ALTER";
    return dialect === "mysql" && !exception ? "ddl-commit" : "ddl";
  }
  return "other";
}

/**
 * True when ANY of the (pre-split) statements would implicitly commit the
 * caller's open transaction on this dialect — drives the query editor's
 * DDL warning before running a script in manual mode.
 */
export function hasImplicitCommitDdl(
  statements: readonly string[],
  dialect: SqlDialect,
): boolean {
  return statements.some((stmt) => classify(dialect, stmt) === "ddl-commit");
}

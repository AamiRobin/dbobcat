/**
 * SQL script splitting for the query editor — a behavioural mirror of
 * `src-tauri/src/connections/script.rs` (keep both in sync).
 *
 * Handles MySQL lexical rules: single/double-quoted strings with backslash
 * and doubled-quote escapes, backtick identifiers (double-backtick escaping
 * only, no backslash escapes), `-- ` and `#` line comments, and non-nested
 * slash-star block comments.
 */

export interface StatementRange {
  /** Byte-safe JS string offsets into the source document. */
  start: number;
  end: number;
  text: string;
}

interface Chunk {
  start: number;
  end: number;
  hasCode: boolean;
}

/** Scan raw chunks between top-level semicolons (no trimming). */
function scanChunks(sql: string): Chunk[] {
  const n = sql.length;
  const chunks: Chunk[] = [];
  let start = 0;
  let hasCode = false;
  let i = 0;

  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === "`") {
      hasCode = true;
      // Inside backticks a backslash is literal; strings allow escapes.
      const escapes = c !== "`";
      i += 1;
      while (i < n) {
        if (escapes && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === c) {
          if (sql[i + 1] === c) {
            i += 2; // doubled quote stays inside
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === "#") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const next = sql[i + 2];
      if (next === undefined || next === " " || next === "\t" || next === "\n" || next === "\r") {
        while (i < n && sql[i] !== "\n") i += 1;
        continue;
      }
      hasCode = true;
      i += 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    if (c === ";") {
      chunks.push({ start, end: i, hasCode });
      hasCode = false;
      i += 1;
      start = i;
      continue;
    }
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    hasCode = true;
    i += 1;
  }

  chunks.push({ start, end: n, hasCode });
  return chunks;
}

/** Trimmed [start, end) of the non-whitespace part within [from, to). */
function trimmedRange(sql: string, from: number, to: number): { start: number; end: number } | null {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(sql[start])) start += 1;
  while (end > start && /\s/.test(sql[end - 1])) end -= 1;
  return start < end ? { start, end } : null;
}

/**
 * Split a script into executable statements (trimmed text, in order).
 * Comment-only / empty chunks are dropped.
 */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  for (const chunk of scanChunks(sql)) {
    if (!chunk.hasCode) continue;
    const range = trimmedRange(sql, chunk.start, chunk.end);
    if (range) {
      out.push({ start: range.start, end: range.end, text: sql.slice(range.start, range.end) });
    }
  }
  return out;
}

/**
 * Statement containing (or immediately left/right of) `offset` — used by
 * "run current statement". The semicolon after a statement belongs to the
 * FOLLOWING chunk, so a caret right before `;` selects that statement and a
 * caret on/after it selects the next one. Returns null when the surrounding
 * chunk contains no code (comments/blank area).
 */
export function statementAtOffset(sql: string, offset: number): StatementRange | null {
  const chunks = scanChunks(sql);
  const clamped = Math.max(0, Math.min(offset, sql.length));
  let found: Chunk | undefined;
  for (const chunk of chunks) {
    // `end` is exclusive but includes everything before its `;`, so an
    // offset exactly at chunk.end sits on the semicolon → previous chunk.
    if (clamped >= chunk.start && clamped <= chunk.end) {
      found = chunk;
      break;
    }
  }

  // Caret parked at the very end of the document (after any trailing
  // whitespace/comments): run the last executable statement instead.
  if ((!found || !found.hasCode) && clamped >= sql.length) {
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i].hasCode) {
        found = chunks[i];
        break;
      }
    }
  }

  if (!found || !found.hasCode) return null;
  const range = trimmedRange(sql, found.start, found.end);
  if (!range) return null;
  return { start: range.start, end: range.end, text: sql.slice(range.start, range.end) };
}

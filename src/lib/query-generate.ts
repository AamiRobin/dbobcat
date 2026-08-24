import type { SqlDialect } from "@/types/ipc";

/**
 * SQL skeleton generation for the query helpers panel (Phase 9-B). Pure
 * functions mirroring the backend's identifier quoting (backticks on MySQL,
 * doubled double-quotes on PostgreSQL/SQLite) — see
 * `src-tauri/src/connections/dialect.rs`. Values are never interpolated:
 * INSERT/UPDATE/DELETE skeletons use bind placeholders (`?`, or `$n` on
 * PostgreSQL) so the generated text is safe to run after filling values.
 */

/** Quote one identifier exactly like the Rust `SqlDialect::quote_ident`. */
export function quoteIdent(name: string, dialect: SqlDialect): string {
  if (dialect === "mysql") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Fully qualified table reference (`db.table`), both parts quoted. */
export function qualifyTable(
  db: string,
  table: string,
  dialect: SqlDialect,
): string {
  return `${quoteIdent(db, dialect)}.${quoteIdent(table, dialect)}`;
}

/** Positional placeholder for the n-th parameter (1-based). */
export function placeholder(dialect: SqlDialect, index: number): string {
  return dialect === "postgres" ? `$${index}` : "?";
}

export interface SkeletonInput {
  db: string;
  table: string;
  /** Checked columns from the helpers panel, in display order. */
  columns: string[];
}

/** `SELECT a, b FROM db.table` — every column when none is checked. */
export function generateSelect(input: SkeletonInput, dialect: SqlDialect): string {
  const cols = input.columns.length
    ? input.columns.map((c) => quoteIdent(c, dialect)).join(", ")
    : "*";
  return `SELECT ${cols}\nFROM ${qualifyTable(input.db, input.table, dialect)};`;
}

/** INSERT with one bind placeholder per column. */
export function generateInsert(input: SkeletonInput, dialect: SqlDialect): string {
  if (!input.columns.length) return "";
  const cols = input.columns.map((c) => quoteIdent(c, dialect)).join(", ");
  const marks = input.columns
    .map((_, i) => placeholder(dialect, i + 1))
    .join(", ");
  return `INSERT INTO ${qualifyTable(input.db, input.table, dialect)} (${cols})\nVALUES (${marks});`;
}

/** UPDATE setting each checked column to its own bind placeholder. */
export function generateUpdate(input: SkeletonInput, dialect: SqlDialect): string {
  if (!input.columns.length) return "";
  const sets = input.columns
    .map((c, i) => `${quoteIdent(c, dialect)} = ${placeholder(dialect, i + 1)}`)
    .join(", ");
  return `UPDATE ${qualifyTable(input.db, input.table, dialect)}\nSET ${sets}\nWHERE <condition>;`;
}

/** DELETE restricted by an explicit condition the user fills in. */
export function generateDelete(input: SkeletonInput, dialect: SqlDialect): string {
  return `DELETE FROM ${qualifyTable(input.db, input.table, dialect)}\nWHERE <condition>;`;
}

import type { ForeignKeyMeta, TableSchemaData } from "@/types/ipc";

/**
 * Schema context serialization for the AI assistant (Phase 12).
 *
 * Trust contract made concrete: this module decides EVERYTHING the model
 * can see about a database, and it only ever emits metadata — table and
 * column names, types, nullability, keys, FK shape, comments. No row
 * values, no counts, no defaults that could embed data. The output is a
 * compact SQL-flavored pseudo-DDL that LLMs map to joins reliably.
 */

/**
 * Hard cap on the serialized schema. ~15k tokens; beyond this, drafting
 * quality collapses anyway, so we truncate and say so instead of silently
 * sending (and paying for) an enormous prompt.
 */
export const MAX_SCHEMA_CHARS = 60_000;

/** Single table's column limit — pathological schemas stay bounded. */
const MAX_COLUMNS_PER_TABLE = 120;

const DIALECT_LABELS: Record<string, string> = {
  mysql: "MySQL/MariaDB",
  postgresql: "PostgreSQL",
  sqlite: "SQLite",
};

export function dialectLabel(dialect: string): string {
  return DIALECT_LABELS[dialect] ?? dialect;
}

/** FK lookup: `table.column` → `refTable(refColumn)` (first column wins). */
function fkIndex(fks: ForeignKeyMeta[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const fk of fks) {
    const owner = fk.table ?? null;
    if (!owner) continue;
    fk.columns.forEach((col, i) => {
      const ref = fk.refColumns[i] ?? fk.refColumns[0];
      if (ref) index.set(`${owner}.${col}`, `${fk.refTable}(${ref})`);
    });
  }
  return index;
}

function columnLine(
  column: TableSchemaData["columns"][number],
  fkRef: string | undefined,
): string {
  const parts = [`  ${column.name} ${column.dataType}`];
  parts.push(column.nullable ? "NULL" : "NOT NULL");
  if (column.key === "PRI") parts.push("PRIMARY KEY");
  if (column.extra?.toLowerCase().includes("auto_increment")) {
    parts.push("AUTO_INCREMENT");
  }
  if (fkRef) parts.push(`REFERENCES ${fkRef}`);
  const line = parts.join(" ");
  return column.comment ? `${line}, -- ${column.comment}` : `${line},`;
}

/**
 * Serialize one database's schema for the model. Truncates at
 * {@link MAX_SCHEMA_CHARS} with an explicit note so the model knows the
 * catalog it sees is partial.
 */
export function buildSchemaContext(
  db: string,
  dialect: string,
  tables: TableSchemaData[],
  fks: ForeignKeyMeta[],
): string {
  const header = [
    `-- Database: ${db} (${dialectLabel(dialect)})`,
    "-- Metadata only: no row data is included or sent.",
  ];
  const references = fkIndex(fks);

  const body: string[] = [];
  let size = header.join("\n").length;
  let truncated = false;

  for (const table of tables) {
    const columns = table.columns.slice(0, MAX_COLUMNS_PER_TABLE);
    const lines = [
      `TABLE ${table.table} (`,
      ...columns.map((column) => columnLine(column, references.get(`${table.table}.${column.name}`))),
      table.columns.length > columns.length
        ? `  -- ${table.columns.length - columns.length} more columns omitted),`
        : ");",
    ];
    const text = lines.join("\n");
    if (size + text.length > MAX_SCHEMA_CHARS) {
      truncated = true;
      break;
    }
    body.push(text);
    size += text.length + 1;
  }

  const tail = truncated
    ? ["-- …schema truncated: only these tables were shared with the model."]
    : [];

  return [...header, "", ...body, ...tail].join("\n").trimEnd();
}

/**
 * Models keep inserting markdown fences despite instructions; peel the
 * outermost one so the draft lands in the editor runnable. Returns the
 * input untouched when no fence is present.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z0-9]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

/** Detect a fence-wrapped (or bare) SQL-only response — prose fails this. */
export function looksLikeSql(text: string): boolean {
  const body = stripCodeFence(text);
  if (!body) return false;
  return /^(WITH|SELECT|INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|RENAME|CALL|SET|SHOW|EXPLAIN|DESCRIBE|USE|PRAGMA|ANALYZE|OPTIMIZE|VACUUM)\b/i.test(
    body,
  );
}

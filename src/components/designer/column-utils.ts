import type {
  ColumnDef,
  ForeignKeyMeta,
  IndexKind,
  IndexMeta,
  TableDdl,
  TableOptions,
} from "@/types/ipc";

/**
 * Pure helpers shared by the table designer tabs: splitting full MySQL type
 * text into editable parts, draft factories and structural dirty tracking.
 */

export interface SplitType {
  /** Base word, e.g. `varchar`, `int`. */
  base: string;
  /** Parenthesized args without parens, e.g. `40` or `'a','b'`; null when absent. */
  args: string | null;
  unsigned: boolean;
}

/** Split `int unsigned` / `varchar(40)` / `decimal(10,2) unsigned` into parts. */
export function splitDataType(full: string): SplitType {
  const text = full.trim();
  const parenMatch = text.match(/^(\S+?)\s*\((.*)\)\s*(.*)$/);
  if (parenMatch) {
    const tail = parenMatch[3].trim();
    return {
      base: parenMatch[1],
      args: parenMatch[2],
      unsigned: /\bunsigned\b/i.test(tail),
    };
  }
  const words = text.split(/\s+/);
  let base = words[0] ?? "";
  const rest = words.slice(1);
  let unsigned = false;
  for (const w of rest) {
    if (/^unsigned$/i.test(w)) unsigned = true;
    else if (!base.includes(" ") && /^(zerofill|signed|binary)$/i.test(w)) {
      base += ` ${w}`;
    }
  }
  return { base, args: null, unsigned };
}

/** Inverse of splitDataType; keeps zerofill/binary suffixes from the base. */
export function joinDataType(base: string, args: string | null, unsigned: boolean): string {
  let out = base.trim();
  const trimmedArgs = args?.trim();
  if (trimmedArgs) out += `(${trimmedArgs})`;
  if (unsigned) out += " unsigned";
  return out;
}

export function emptyColumn(name = ""): ColumnDef {
  return {
    name,
    previousName: null,
    dataType: "varchar(40)",
    nullable: true,
    defaultKind: "none",
    defaultValue: null,
    autoIncrement: false,
    onUpdate: null,
    generated: null,
    comment: null,
    preservedAttrs: [],
  };
}

export function emptyIndex(kind: IndexKind, name: string, columns: string[] = []): IndexMeta {
  return { name, kind, columns, comment: null };
}

export function emptyForeignKey(): ForeignKeyMeta {
  return {
    name: "",
    columns: [],
    refDb: null,
    refTable: "",
    refColumns: [],
    onUpdate: null,
    onDelete: null,
  };
}

export function emptyTableOptions(): TableOptions {
  return {
    engine: "InnoDB",
    charset: null,
    collation: null,
    comment: null,
    autoIncrement: null,
    rowFormat: null,
    extra: [],
    partition: null,
  };
}

export function blankDraft(db: string, table: string): TableDdl {
  return {
    db,
    table,
    columns: [{ ...emptyColumn("id"), dataType: "int unsigned", nullable: false }],
    indexes: [emptyIndex("primary", "PRIMARY", ["id"])],
    foreignKeys: [],
    options: emptyTableOptions(),
    checks: [],
    createSql: "",
  };
}

// ---------------------------------------------------------------------------
// Dirty tracking (structural equality against the loaded snapshot)
// ---------------------------------------------------------------------------

function normalizeType(t: string): string {
  return t.split(/\s+/).join(" ").trim();
}

export function sameColumn(a: ColumnDef, b: ColumnDef): boolean {
  return (
    a.name === b.name &&
    normalizeType(a.dataType) === normalizeType(b.dataType) &&
    a.nullable === b.nullable &&
    a.defaultKind === b.defaultKind &&
    (a.defaultValue ?? null) === (b.defaultValue ?? null) &&
    a.autoIncrement === b.autoIncrement &&
    (a.onUpdate ?? null) === (b.onUpdate ?? null) &&
    (a.generated ?? null) === (b.generated ?? null) &&
    (a.comment ?? null) === (b.comment ?? null)
  );
}

export function sameIndex(a: IndexMeta, b: IndexMeta): boolean {
  return (
    a.name === b.name &&
    a.kind === b.kind &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => c === b.columns[i]) &&
    (a.comment ?? null) === (b.comment ?? null)
  );
}

export function sameForeignKey(a: ForeignKeyMeta, b: ForeignKeyMeta): boolean {
  const eqArr = (x: string[], y: string[]) =>
    x.length === y.length && x.every((c, i) => c === y[i]);
  return (
    a.name === b.name &&
    eqArr(a.columns, b.columns) &&
    (a.refDb ?? null) === (b.refDb ?? null) &&
    a.refTable === b.refTable &&
    eqArr(a.refColumns, b.refColumns) &&
    (a.onUpdate ?? null) === (b.onUpdate ?? null) &&
    (a.onDelete ?? null) === (b.onDelete ?? null)
  );
}

export function isDirty(current: TableDdl | null, draft: TableDdl): boolean {
  if (!current) {
    // Create mode: dirty as soon as anything meaningful exists beyond blank.
    return !sameColumnList(blankDraft(draft.db, draft.table).columns, draft.columns);
  }
  if (draft.table !== current.table) return true;
  if (!sameColumnList(current.columns, draft.columns)) return true;
  if (!sameIndexList(current.indexes, draft.indexes)) return true;
  if (!sameFkList(current.foreignKeys, draft.foreignKeys)) return true;
  return !sameOptions(current.options, draft.options);
}

function sameColumnList(a: ColumnDef[], b: ColumnDef[]): boolean {
  return a.length === b.length && a.every((col, i) => sameColumn(col, b[i]));
}

function sameIndexList(a: IndexMeta[], b: IndexMeta[]): boolean {
  return a.length === b.length && a.every((ix, i) => sameIndex(ix, b[i]));
}

function sameFkList(a: ForeignKeyMeta[], b: ForeignKeyMeta[]): boolean {
  return a.length === b.length && a.every((fk, i) => sameForeignKey(fk, b[i]));
}

function sameOptions(a: TableOptions, b: TableOptions): boolean {
  return (
    (a.engine ?? null) === (b.engine ?? null) &&
    (a.charset ?? null) === (b.charset ?? null) &&
    (a.collation ?? null) === (b.collation ?? null) &&
    (a.comment ?? null) === (b.comment ?? null) &&
    (a.autoIncrement ?? null) === (b.autoIncrement ?? null) &&
    (a.rowFormat ?? null) === (b.rowFormat ?? null)
  );
}

/** Common MySQL data types offered in the column editor's datalist. */
export const COMMON_TYPES = [
  "tinyint",
  "smallint",
  "mediumint",
  "int",
  "bigint",
  "decimal",
  "float",
  "double",
  "bit",
  "char",
  "varchar",
  "binary",
  "varbinary",
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "enum",
  "set",
  "date",
  "datetime",
  "timestamp",
  "time",
  "year",
  "json",
  "uuid",
];

export const ENGINES = ["InnoDB", "MyISAM", "Aria", "MEMORY", "CSV"];
export const CHARSETS = ["utf8mb4", "utf8mb3", "latin1", "ascii", "binary"];
export const ROW_FORMATS = ["Dynamic", "Compact", "Redundant", "Compressed", "Fixed", "Page"];
export const FK_ACTIONS = ["CASCADE", "SET NULL", "NO ACTION", "RESTRICT", "SET DEFAULT"];

/**
 * Sync the PK index after a PK checkbox toggle on a column.
 * Returns updated indexes; the primary key is always named PRIMARY.
 */
export function togglePrimaryKey(
  indexes: IndexMeta[],
  columnName: string,
  checked: boolean,
): IndexMeta[] {
  const pkIdx = indexes.findIndex((ix) => ix.kind === "primary");
  if (checked) {
    if (pkIdx >= 0) {
      return indexes.map((ix, i) =>
        i === pkIdx
          ? { ...ix, columns: ix.columns.includes(columnName) ? ix.columns : [...ix.columns, columnName] }
          : ix,
      );
    }
    return [...indexes, emptyIndex("primary", "PRIMARY", [columnName])];
  }
  if (pkIdx < 0) return indexes;
  const remaining = indexes[pkIdx].columns.filter((c) => c !== columnName);
  if (remaining.length === 0) {
    return indexes.filter((_, i) => i !== pkIdx);
  }
  return indexes.map((ix, i) => (i === pkIdx ? { ...ix, columns: remaining } : ix));
}

/** Columns that participate in the primary key. */
export function primaryKeyColumns(indexes: IndexMeta[]): Set<string> {
  const pk = indexes.find((ix) => ix.kind === "primary");
  return new Set(pk?.columns ?? []);
}

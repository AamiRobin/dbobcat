import type { ColumnMeta, RowValue } from "@/types/ipc";

/**
 * Grid column geometry: width estimation from the MySQL type plus per-table
 * persistence of user-resized widths in localStorage.
 */

export interface GridColumn {
  meta: ColumnMeta;
  /** Pixel width (user-resizable, persisted per table). */
  width: number;
}

const MIN_WIDTH = 60;
const MAX_WIDTH = 900;

/** Rough monospace-ish estimate: ~7px/char + padding. */
function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
}

/** Estimate a sensible initial width from the driver type string. */
export function estimateColumnWidth(meta: ColumnMeta): number {
  const t = meta.dataType.toLowerCase();
  if (/\b(tinyint|smallint|mediumint|bigint|int|integer|year|bit)\b/.test(t)) return 90;
  if (/\b(decimal|numeric|double|float|real)\b/.test(t)) return 120;
  if (/^datetime|^timestamp/.test(t)) return 170;
  if (/^(date|time)\b/.test(t)) return 110;
  const paren = /\((\d+)\)/.exec(t);
  if (paren && /char|binary/.test(t)) {
    const n = Number(paren[1]);
    // Cap long varchar estimates; the cell ellipsises anyway.
    return clampWidth(Math.min(n, 40) * 7.2 + 44);
  }
  if (/\b(enum|set)\b/.test(t)) return 140;
  // text/blob/json/binary leftovers
  return 240;
}

const widthsKey = (db: string, table: string) => `hc.grid.widths.${db}.${table}`;

/** Load persisted width overrides for a table (empty on any failure). */
export function loadPersistedWidths(db: string, table: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(widthsKey(db, table));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([, v]) => typeof v === "number" && v >= MIN_WIDTH && v <= MAX_WIDTH,
        ),
      ) as Record<string, number>;
    }
  } catch {
    // corrupted entry — ignore and re-estimate
  }
  return {};
}

export function persistWidths(
  db: string,
  table: string,
  widths: Record<string, number>,
): void {
  try {
    localStorage.setItem(widthsKey(db, table), JSON.stringify(widths));
  } catch {
    // storage full/unavailable — non-fatal
  }
}

const hiddenKey = (db: string, table: string) => `hc.grid.hidden.${db}.${table}`;

/** Load persisted hidden-column names for a table (empty on any failure). */
export function loadPersistedHidden(db: string, table: string): string[] {
  try {
    const raw = localStorage.getItem(hiddenKey(db, table));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // corrupted entry — start fresh
  }
  return [];
}

export function persistHidden(db: string, table: string, hidden: string[]): void {
  try {
    localStorage.setItem(hiddenKey(db, table), JSON.stringify(hidden));
  } catch {
    // storage full/unavailable — non-fatal
  }
}

const orderKey = (db: string, table: string) => `hc.grid.order.${db}.${table}`;

/** Load persisted display order for a table (empty = canonical order). */
export function loadPersistedOrder(db: string, table: string): string[] {
  try {
    const raw = localStorage.getItem(orderKey(db, table));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // corrupted entry — start fresh
  }
  return [];
}

export function persistOrder(db: string, table: string, order: string[]): void {
  try {
    localStorage.setItem(orderKey(db, table), JSON.stringify(order));
  } catch {
    // storage full/unavailable — non-fatal
  }
}

/** Merge persisted overrides onto fresh estimates, preserving column order. */
export function buildGridColumns(
  columns: ColumnMeta[],
  db: string,
  table: string,
): GridColumn[] {
  const saved = loadPersistedWidths(db, table);
  return columns.map((meta) => ({
    meta,
    width: saved[meta.name] ?? estimateColumnWidth(meta),
  }));
}

// ---------------------------------------------------------------------------
// Cell formatting
// ---------------------------------------------------------------------------

export function isNumericType(dataType: string): boolean {
  return /\b(tinyint|smallint|mediumint|bigint|int|integer|decimal|numeric|double|float|real|year|bit)\b/i.test(
    dataType,
  );
}

export function isTemporalType(dataType: string): boolean {
  return /^(datetime|timestamp|date|time)/i.test(dataType.trim());
}

export function isBinaryType(dataType: string): boolean {
  return /\b(blob|tinyblob|mediumblob|longblob|binary|varbinary|geometry)\b/i.test(dataType) ||
    dataType.toLowerCase() === "json";
}

/** Human-readable byte size, e.g. "12 B", "1.2 KB", "3.4 MB". */
export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Raw text form used when editing a cell (NULL → ""). */
export function cellRawText(value: RowValue | undefined): string {
  if (!value || value.t === "null") return "";
  switch (value.t) {
    case "int":
    case "uint":
    case "float":
      return String(value.v);
    case "str":
    case "date":
    case "time":
    case "datetime":
      return value.v;
    case "bytes":
      // Inline editing of binary payloads is out of scope; viewer handles it.
      return "";
  }
}

/**
 * Display text for a cell. Long strings are NOT truncated here — CSS handles
 * overflow — but binary sizes render as badges in the cell component.
 */
export function cellDisplayText(value: RowValue | undefined): string {
  if (!value || value.t === "null") return "NULL";
  switch (value.t) {
    case "int":
    case "uint":
    case "float":
      return String(value.v);
    case "str":
      return value.v;
    case "date":
      return value.v; // already YYYY-MM-DD
    case "time":
    case "datetime":
      return value.v.replace("T", " ");
    case "bytes":
      return formatByteSize(value.v.length);
  }
}

/**
 * Interpret raw editor/paste text as a typed value using the column's type
 * family: integers split by sign, decimals become floats, everything else
 * (including empty strings) stays text. Shared by inline edits and TSV
 * paste so both paths coerce identically.
 */
export function parseCellValue(rawText: string, numericType: boolean): RowValue {
  if (!numericType) return { t: "str", v: rawText };
  const trimmed = rawText.trim();
  if (/^-?\d+$/.test(trimmed) && !trimmed.includes(".")) {
    return trimmed.startsWith("-")
      ? { t: "int", v: Number(trimmed) }
      : { t: "uint", v: Number(trimmed) };
  }
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    return { t: "float", v: Number(trimmed) };
  }
  return { t: "str", v: rawText };
}

// ---------------------------------------------------------------------------
// Typed cell editors (HeidiSQL parity): ENUM/SET dropdowns, date/time pickers
// ---------------------------------------------------------------------------

/** Parse `enum('a','b')` / `set('x','y')` into its option list; else null. */
export function parseEnumSetValues(dataType: string): { kind: "enum" | "set"; values: string[] } | null {
  const match = /^\s*(enum|set)\s*\((.*)\)\s*$/i.exec(dataType);
  if (!match) return null;
  const body = match[2];
  const values: string[] = [];
  let cur = "";
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (ch === "'" && body[i + 1] === "'") {
        cur += "'";
        i++;
      } else if (ch === "'") {
        inString = false;
        values.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    } else if (ch === "'") {
      inString = true;
      cur = "";
    }
    // commas/whitespace outside strings are separators — handled by the
    // quote close above.
  }
  return { kind: match[1].toLowerCase() as "enum" | "set", values };
}

/** `date` / `time` / `datetime` / `timestamp` → editor kind; else null. */
export type TemporalKind = "date" | "time" | "datetime";

export function temporalKind(dataType: string): TemporalKind | null {
  const t = dataType.trim().toLowerCase();
  if (/^(datetime|timestamp)\b/.test(t)) return "datetime";
  if (/^date\b/.test(t)) return "date";
  if (/^time\b/.test(t)) return "time";
  return null;
}

/** DB storage text → value for the HTML input of that temporal kind. */
export function temporalToInputValue(kind: TemporalKind, stored: string): string {
  const trimmed = stored.trim();
  if (kind === "date") return trimmed.slice(0, 10);
  if (kind === "time") {
    // "HH:MM:SS" / "HH:MM" → "HH:MM:SS" (time inputs accept both; keep s).
    return trimmed.length === 5 ? `${trimmed}:00` : trimmed.slice(0, 8);
  }
  // datetime: "YYYY-MM-DD HH:MM[:SS]" → "YYYY-MM-DDTHH:MM[:SS]"
  const normalized = trimmed.replace(" ", "T");
  return normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
}

/** HTML input value → DB storage text for that temporal kind. */
export function inputValueToTemporal(kind: TemporalKind, input: string): string {
  const trimmed = input.trim();
  if (kind === "date") return trimmed.slice(0, 10);
  if (kind === "time") {
    return trimmed.length === 5 ? `${trimmed}:00` : trimmed.slice(0, 8);
  }
  const normalized = trimmed.replace(" ", "T");
  const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized.slice(0, 19);
  return withSeconds.replace("T", " ");
}

/** Join SET checkbox selections back into the stored `a,b` form. */
export function joinSetValues(values: string[]): string {
  return values.join(",");
}

// ---------------------------------------------------------------------------
// Find / replace in grid
// ---------------------------------------------------------------------------

export interface CellMatch {
  /** Row index within the loaded dataset (real rows only). */
  rowIndex: number;
  colIndex: number;
}

/**
 * All cells of `columns` (list of visible column indexes) whose display text
 * contains `query` (case-insensitive unless `caseSensitive`).
 */
export function findCellMatches(
  rows: RowValue[][],
  visibleIndexes: number[],
  query: string,
  caseSensitive = false,
): CellMatch[] {
  const needle = caseSensitive ? query : query.toLowerCase();
  if (needle === "") return [];
  const matches: CellMatch[] = [];
  rows.forEach((row, rowIndex) => {
    for (const colIndex of visibleIndexes) {
      const text = cellDisplayText(row[colIndex]);
      const hay = caseSensitive ? text : text.toLowerCase();
      if (hay.includes(needle)) matches.push({ rowIndex, colIndex });
    }
  });
  return matches;
}

/**
 * Replace `query` with `replacement` inside one cell's display text and
 * parse the result back through the column's type family (identical
 * coercion to manual edits). Returns null when the cell didn't change.
 */
export function replaceInCell(
  row: RowValue[] | undefined,
  colIndex: number,
  meta: ColumnMeta,
  query: string,
  replacement: string,
  caseSensitive = false,
): RowValue | null {
  if (!row) return null;
  const current = row[colIndex];
  const text = cellDisplayText(current);
  const flags = caseSensitive ? "g" : "gi";
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!new RegExp(escaped, flags).test(text)) return null;
  const nextText = text.replace(new RegExp(escaped, flags), replacement);
  if (nextText === text) return null;
  // NULL cells that become empty stay NULL; empty edits of real cells use
  // the same parseCellValue path as manual typing.
  if (nextText === "" && current?.t === "null") return null;
  return parseCellValue(nextText, isNumericType(meta.dataType));
}

// ---------------------------------------------------------------------------
// Column reordering (drag & drop in the grid header)
// ---------------------------------------------------------------------------

/**
 * Apply a display order to `names`. `order` is the persisted preference
 * (column names in desired display order): known names come first in that
 * order, unknown/renamed names keep their original relative order appended
 * at the end, and stale order entries are dropped. Pure and unit-tested.
 */
export function reorderColumnNames(names: string[], order: string[]): string[] {
  const known = new Set(names);
  const head: string[] = [];
  const seenHead = new Set<string>();
  for (const name of order) {
    if (known.has(name) && !seenHead.has(name)) {
      head.push(name);
      seenHead.add(name);
    }
  }
  const tail = names.filter((name) => !seenHead.has(name));
  return [...head, ...tail];
}

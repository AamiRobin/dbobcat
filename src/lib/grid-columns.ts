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

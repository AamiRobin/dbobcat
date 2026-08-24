import type { RowValue } from "@/types/ipc";

/**
 * TSV clipboard parsing for "paste rows" (Phase 9-A).
 *
 * The grid copies rows as tab-separated display text (see DataView/DataGrid
 * `onCopy`) and spreadsheets emit the same shape — so pasting round-trips.
 * Parsing is intentionally line-oriented: embedded tabs/newlines were already
 * flattened to spaces by the copy side, and spreadsheet cells cannot contain
 * raw newlines in TSV either.
 */

/** Split clipboard text into cell rows; trailing empty lines are dropped. */
export function parseTsvRows(text: string): string[][] {
  const lines = text.split(/\r\n|\n|\r/);
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((line) => line.split("\t"));
}

/**
 * Interpret one pasted cell as a typed value:
 * - literal `NULL` → SQL NULL,
 * - integer / decimal numbers → int/uint/float (same rules as cell edits),
 * - everything else stays a string (empty string stays an empty string).
 */
export function tsvCellToRowValue(raw: string): RowValue {
  if (raw === "NULL") return { t: "null" };
  const trimmed = raw.trim();
  if (/^-?\d+$/.test(trimmed) && !trimmed.includes(".")) {
    return trimmed.startsWith("-")
      ? { t: "int", v: Number(trimmed) }
      : { t: "uint", v: Number(trimmed) };
  }
  if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
    return { t: "float", v: Number(trimmed) };
  }
  return { t: "str", v: raw };
}

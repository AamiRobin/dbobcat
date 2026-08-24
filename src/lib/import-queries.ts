import { ipc } from "@/lib/ipc";
import type {
  CsvParseOptions,
  CsvPreview,
  ImportMode,
  ImportErrorMode,
  ImportResult,
  MapSpec,
  NewTableSpec,
  SqlImportResult,
} from "@/types/ipc";

/**
 * CSV / SQL-file import IPC (Phase 5). Progress flows through the
 * `import://progress` event — see `onBackendEvent` in lib/ipc.ts.
 */

export function importCsvPreview(
  sourcePath: string | null,
  clipboardText: string | null,
  options: CsvParseOptions,
): Promise<CsvPreview> {
  return ipc<CsvPreview>("import_csv_preview", {
    sourcePath,
    clipboardText,
    options,
  });
}

export interface CsvRunRequest {
  connId: number;
  db: string;
  table: string;
  sourcePath: string | null;
  clipboardText: string | null;
  options: CsvParseOptions;
  mapping: MapSpec[];
  newTable: NewTableSpec | null;
  mode: ImportMode;
  batchSize: number;
  onError: ImportErrorMode;
}

export function importCsvRun(req: CsvRunRequest): Promise<ImportResult> {
  return ipc<ImportResult>("import_csv_run", {
    connId: req.connId,
    db: req.db,
    table: req.table,
    sourcePath: req.sourcePath,
    clipboardText: req.clipboardText,
    options: req.options,
    mapping: req.mapping,
    newTable: req.newTable,
    mode: req.mode,
    batchSize: req.batchSize,
    onError: req.onError,
  });
}

export function importSqlFile(
  connId: number,
  path: string,
  stopOnError: boolean,
  batchSize = 50,
): Promise<SqlImportResult> {
  return ipc<SqlImportResult>("import_sql_file", {
    connId,
    path,
    stopOnError,
    batchSize,
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Build a default column mapping: every preview column maps onto the target
 * column with the same (case-insensitive) name when one exists; unmatched
 * columns map to `null` (= skipped).
 */
export function autoMapColumns(
  csvColumns: string[],
  targetColumns: { name: string }[],
): (string | null)[] {
  const byLower = new Map(
    targetColumns.map((t) => [t.name.toLowerCase(), t.name] as const),
  );
  return csvColumns.map((name) => byLower.get(name.toLowerCase()) ?? null);
}

/** Guess TEXT/INT/DOUBLE for a create-new table from sampled cell values. */
export function guessColumnTypes(
  columns: string[],
  rows: (string | null)[][],
): NewTableSpec["columns"] {
  const isInt = (v: string) => /^[+-]?\d+$/.test(v);
  const isFloat = (v: string) => /^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(v);

  return columns.map((name, idx) => {
    const samples = rows
      .map((r) => r[idx])
      .filter((v): v is string => v !== null && v !== "");
    let dataType = "TEXT";
    if (samples.length > 0 && samples.every(isInt)) {
      dataType = "INT";
    } else if (samples.length > 0 && samples.every(isFloat)) {
      dataType = "DOUBLE";
    }
    return { name, dataType };
  });
}

/** Compact human summary of an import run for the message log. */
export function summarizeImport(result: ImportResult): string {
  const parts = [
    `${result.inserted.toLocaleString()} row(s) inserted`,
    result.skipped > 0 ? `${result.skipped} skipped` : null,
    `${result.errors.length} error(s)`,
    `${result.elapsedMs}ms`,
  ].filter(Boolean);
  return parts.join(" · ");
}

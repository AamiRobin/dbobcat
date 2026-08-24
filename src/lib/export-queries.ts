import { ipc } from "@/lib/ipc";
import type {
  DdlObjectRequest,
  ExportDestination,
  ExportFormat,
  ExportResult,
  FileDialogFilter,
  GridExportOptions,
  SqlDumpOptions,
} from "@/types/ipc";

/**
 * Export engine IPC (Phase 5). All heavy lifting streams inside Rust; only
 * `ExportResult` summaries come back. Progress flows through the
 * `export://progress` event — see `onBackendEvent` in lib/ipc.ts.
 */

// ---------------------------------------------------------------------------
// Native dialogs
// ---------------------------------------------------------------------------

export function pickSavePath(
  defaultName: string | null,
  filters: FileDialogFilter[],
): Promise<string | null> {
  return ipc<string | null>("pick_save_path", { defaultName, filters });
}

export function pickOpenPath(filters: FileDialogFilter[]): Promise<string | null> {
  return ipc<string | null>("pick_open_path", { filters });
}

/** Filter presets per export format (kept next to the format enum). */
export function formatFilters(format: ExportFormat): FileDialogFilter[] {
  const map: Record<ExportFormat, [string, string[]]> = {
    csv: ["CSV", ["csv"]],
    tsv: ["TSV", ["tsv", "txt"]],
    json: ["JSON", ["json"]],
    xml: ["XML", ["xml"]],
    html: ["HTML", ["html", "htm"]],
    markdown: ["Markdown", ["md"]],
    latex: ["LaTeX", ["tex"]],
    php: ["PHP", ["php"]],
    textile: ["Textile", ["txt"]],
    sql_inserts: ["SQL", ["sql"]],
    sql_replaces: ["SQL REPLACE", ["sql"]],
    sql_updates: ["SQL UPDATE", ["sql"]],
  };
  const [name, extensions] = map[format];
  return [{ name, extensions }];
}

// ---------------------------------------------------------------------------
// Export runs
// ---------------------------------------------------------------------------

export interface GridExportRequest {
  connId: number;
  /** Context database (source schema for tables, target for INSERTs). */
  db?: string | null;
  table?: string | null;
  sql?: string | null;
  selectionColumns?: string[] | null;
  selectionRows?: RowValueMatrix | null;
  format: ExportFormat;
  destination: ExportDestination;
  options: GridExportOptions;
  overwrite: boolean;
}

/** Rows already fetched client-side (grid selections). */
type RowValueMatrix = import("@/types/ipc").RowValue[][];

export function exportGridData(req: GridExportRequest): Promise<ExportResult> {
  return ipc<ExportResult>("export_grid_data", {
    connId: req.connId,
    db: req.db ?? null,
    table: req.table ?? null,
    sql: req.sql ?? null,
    selectionColumns: req.selectionColumns ?? null,
    selectionRows: req.selectionRows ?? null,
    format: req.format,
    destination: req.destination,
    options: req.options,
    overwrite: req.overwrite,
  });
}

export function exportSqlDump(
  connId: number,
  options: SqlDumpOptions,
  destination: ExportDestination,
  overwrite: boolean,
): Promise<ExportResult> {
  return ipc<ExportResult>("export_sql_dump", {
    connId,
    options,
    destination,
    overwrite,
  });
}

export function exportObjectsDdl(
  connId: number,
  requests: DdlObjectRequest[],
  destination: ExportDestination,
  title: string | null,
  overwrite: boolean,
): Promise<ExportResult> {
  return ipc<ExportResult>("export_objects_ddl", {
    connId,
    requests,
    destination,
    title,
    overwrite,
  });
}

/** Cooperatively cancel a running export; true when the run existed. */
export function cancelExport(id: number): Promise<boolean> {
  return ipc<boolean>("export_cancel", { id });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Default dump option set shown by the dialog (Heidi-like defaults). */
export function defaultSqlDumpOptions(dbs: string[]): SqlDumpOptions {
  return {
    dbs,
    tables: null,
    what: "structure_and_data",
    dropAdd: true,
    addLocks: true,
    completeInserts: false,
    extendedInserts: true,
    useTransactions: false,
    createDbHeader: true,
    definerStrip: true,
    includeViews: true,
    includeRoutines: false,
    includeTriggers: false,
    includeEvents: false,
    insertIgnore: false,
    hexBlobs: false,
  };
}

/** Default file name for an export run, e.g. `users_export.csv`. */
export function defaultExportFileName(
  stem: string,
  format: ExportFormat,
): string {
  const ext: Record<ExportFormat, string> = {
    csv: "csv",
    tsv: "tsv",
    json: "json",
    xml: "xml",
    html: "html",
    markdown: "md",
    latex: "tex",
    php: "php",
    textile: "txt",
    sql_inserts: "sql",
    sql_replaces: "sql",
    sql_updates: "sql",
  };
  const safe = stem.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "export";
  return `${safe}_export.${ext[format]}`;
}

/**
 * Build the destination payload for the file target. `gzip` only applies to
 * files (clipboard/server ignore it server-side).
 */
export function fileDestination(
  path: string,
  gzip: boolean,
): ExportDestination {
  return { kind: "file", path, gzip };
}

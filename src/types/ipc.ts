/**
 * Shared IPC payload types.
 *
 * These mirror the serde structs in `src-tauri/src/connections/mod.rs`,
 * `src-tauri/src/ssh.rs` and `src-tauri/src/commands/sessions.rs` exactly
 * (`rename_all = "camelCase"` on every Rust struct). Keep both sides in
 * sync until codegen is introduced.
 *
 * Errors cross IPC as plain strings (the Display of `AppError`); the
 * `ipc<T>()` wrapper turns them into `IpcError`.
 */

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/** Supported engines for saved sessions. Grows with each new driver. */
export type DbType = "mysql" | "postgres" | "sqlite";

/** SQL family a connection speaks (mirrors `ServerInfo.dialect`). */
export type SqlDialect = "mysql" | "postgres" | "sqlite";

export type SslMode = "disabled" | "preferred" | "required";

/**
 * SSH authentication. Mirrors `SshAuth` (internally tagged via `method`).
 * Neither variant carries a stored secret in SavedSession JSON: the SSH login
 * password lives in the encrypted credential store under `<sessionId>#ssh`,
 * the key passphrase under `<sessionId>#key`. `password` is required because
 * the Rust side always sends it (empty string when nothing is stored).
 */
export type SshAuth =
  | { method: "password"; password: string }
  | { method: "key"; keyPath: string; passphrase?: string | null };

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
}

/**
 * A saved connection profile. NEVER contains passwords — engine login
 * passwords are referenced by session id in the credential store.
 *
 * SQLite sessions store the database FILE path in `host` (port/user are
 * ignored); MySQL/PostgreSQL keep the usual server fields.
 */
export interface SavedSession {
  id: string;
  name: string;
  dbType: DbType;
  host: string;
  port: number;
  user: string;
  database?: string | null;
  sslMode: SslMode;
  useSsh: boolean;
  ssh?: SshConfig | null;
  // Phase 9-B organization + resilience metadata (all optional so older
  // settings.json payloads keep loading).
  /** Slash-separated folder path, e.g. "Work/Prod". */
  group?: string | null;
  /** One of SESSION_COLORS hex values; rendered as a dot accent. */
  color?: string | null;
  /** Free-form note shown under the session name in lists. */
  comment?: string | null;
  /** Keep-alive ping interval seconds; 0 = off, unset = 20 (server engines). */
  keepAliveSec?: number | null;
}

/** Outcome of `session_test`; failures are reported inline. */
export interface TestResult {
  ok: boolean;
  serverVersion?: string | null;
  elapsedMs: number;
  error?: string | null;
}

// ---------------------------------------------------------------------------
// Connection / server
// ---------------------------------------------------------------------------

export interface ServerInfo {
  /** "MySQL", "MariaDB", "PostgreSQL", ... (heuristic from the version string). */
  product: string;
  /** Raw server version string, e.g. "8.0.36". */
  version: string;
  /** SQL family this connection speaks; drives per-dialect UI behaviour. */
  dialect: SqlDialect;
  /** RFC 3339 timestamp of when this connection was established. */
  connectedAt: string;
}

export interface ConnInfo {
  connId: number;
  serverInfo: ServerInfo;
}

/**
 * Payload of the `connection://status` backend event (Phase 9-B keep-alive /
 * silent reconnect). `status` is "reconnecting" | "reconnected" | "lost".
 */
export interface ConnStatusEvent {
  connId: number;
  status: "reconnecting" | "reconnected" | "lost";
  message?: string | null;
}

// ---------------------------------------------------------------------------
// Schema metadata
// ---------------------------------------------------------------------------

export interface DatabaseInfo {
  name: string;
  charset?: string | null;
  collation?: string | null;
}

export type TableKind = "table" | "view" | "materialized_view" | "sequence" | "system_table";

export interface TableMeta {
  name: string;
  kind: TableKind;
  /** Estimated row count from engine statistics (null for views). */
  rows?: number | null;
  sizeBytes?: number | null;
  comment?: string | null;
  engine?: string | null;
}

export interface ColumnMeta {
  name: string;
  /** Driver-native type name, e.g. `int unsigned`, `varchar(255)`. */
  dataType: string;
  nullable: boolean;
  /** Driver-native key flag: MySQL reports `PRI` / `UNI` / `MUL`. */
  key?: string | null;
  defaultValue?: string | null;
  /** Extra modifiers, e.g. `auto_increment`. */
  extra?: string | null;
  comment?: string | null;
}

/** One table's full column list from the ER diagram batch loader. */
export interface TableSchemaData {
  table: string;
  columns: ColumnMeta[];
}

// ---------------------------------------------------------------------------
// Data grid (Phase 2)
// ---------------------------------------------------------------------------

/**
 * A single cell value crossing IPC as an adjacently tagged union:
 * `{ t: "str", v: "hi" }`, `{ t: "null" }`, ...
 *
 * `uint` values above 2^53 - 1 lose precision in JS (accepted for P2).
 */
export type RowValue =
  | { t: "null"; v?: never }
  | { t: "int"; v: number }
  | { t: "uint"; v: number }
  | { t: "float"; v: number }
  | { t: "str"; v: string }
  | { t: "bytes"; v: number[] }
  | { t: "date"; v: string }
  | { t: "time"; v: string }
  | { t: "datetime"; v: string };

export type SortDirection = "asc" | "desc";

export interface SortSpec {
  column: string;
  direction: SortDirection;
}

/** Server-validated filter operators. */
export type FilterOp =
  | "eq"
  | "not_eq"
  | "lt"
  | "lt_e"
  | "gt"
  | "gt_e"
  | "like"
  | "not_like"
  | "is_null"
  | "is_not_null"
  | "in";

/**
 * One WHERE term; `value` is always bound server-side, never interpolated.
 * The `in` operator ignores `value` and binds every item of `values`.
 */
export interface FilterSpec {
  column: string;
  op: FilterOp;
  value?: string | null;
  /** Typed items for the `in` operator (quick-filter "More values…"). */
  values?: RowValue[];
}

/** A `column = value` pair for inserts, update sets and PK predicates. */
export interface CellAssign {
  column: string;
  value: RowValue;
}

/** One grid change posted to the backend. */
export type RowChange =
  | { kind: "insert"; values: CellAssign[] }
  | { kind: "update"; pk: CellAssign[]; set: CellAssign[] }
  | { kind: "delete"; pk: CellAssign[] };

/** Request shape of `data_query_page` (informational mirror). */
export interface QueryPageRequest {
  db: string;
  table: string;
  pageSize?: number;
  offset?: number;
  orderBy?: SortSpec[];
  /** AND-combined WHERE terms; an empty list reads the table unfiltered. */
  filters: FilterSpec[];
}

export interface QueryPageResult {
  columns: ColumnMeta[];
  rows: RowValue[][];
  /** Engine estimate (information_schema.TABLE_ROWS), not exact. */
  totalRowsEstimate?: number | null;
  elapsedMs: number;
  hasMore: boolean;
}

export interface ApplyChangesRequest {
  db: string;
  table: string;
  changes: RowChange[];
}

/** Per-row failure inside an ApplyChangesResult; other rows still apply. */
export interface RowError {
  index: number;
  message: string;
}

export interface ApplyChangesResult {
  applied: number;
  failed: number;
  errors: RowError[];
  elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Grid power features (Phase 9-A)
// ---------------------------------------------------------------------------

/** One row of the quick-filter "More values…" dialog. */
export interface DistinctValue {
  value: RowValue;
  count: number;
}

/**
 * Top-N rows of a foreign key's referenced table (grid editor dropdown).
 * Column order mirrors the FK's `refColumns` with an optional trailing
 * display column.
 */
export interface FkRefValues {
  columns: string[];
  rows: RowValue[][];
}

// ---------------------------------------------------------------------------
// Query editor (Phase 3)
// ---------------------------------------------------------------------------

/**
 * One column of a query result set. Slimmer than `ColumnMeta`: result
 * columns are anonymous expressions, not table columns.
 */
export interface ResultColumnMeta {
  name: string;
  /** Driver-native-ish type name, e.g. `bigint unsigned`, `varchar(64)`. */
  dataType: string;
}

/**
 * Per-statement outcome of `query_run_script`. One statement may yield
 * several outcomes (e.g. a procedure call returning multiple result sets).
 * Mirrors the internally-tagged `QueryOutcome` Rust enum (`kind`).
 */
export type QueryOutcome =
  | {
      kind: "result_set";
      columns: ResultColumnMeta[];
      rows: RowValue[][];
      elapsedMs: number;
      /** True when fetching stopped early because of the backend row cap. */
      truncated: boolean;
      /**
       * Full source statement text — lets updatable result grids detect the
       * backing table (Phase 9-A). Absent on older payloads.
       */
      sql?: string;
    }
  | {
      kind: "exec";
      affected: number;
      lastInsertId?: number | null;
      /** Server info string ("Rows matched: ...") when present. */
      info?: string | null;
      elapsedMs: number;
    }
  | { kind: "error"; message: string; sqlSnippet: string };

/** One executed script in the persisted query history (most-recent-first). */
export interface HistoryEntry {
  id: string;
  sql: string;
  connName: string;
  executedAt: string;
}

/**
 * One saved SQL fragment (Phase 9-B helpers panel). Persisted in the
 * settings store; names are unique — re-saving a name replaces the entry.
 */
export interface Snippet {
  id: string;
  name: string;
  sql: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Table designer / object management (Phase 4)
// ---------------------------------------------------------------------------

export type IndexKind = "primary" | "unique" | "index" | "fulltext" | "spatial";

/** One table index (the primary key is an index named `PRIMARY`). */
export interface IndexMeta {
  name: string;
  kind: IndexKind;
  /** Indexed columns in order (prefix lengths are not modelled). */
  columns: string[];
  comment?: string | null;
}

/** One FOREIGN KEY constraint; `refDb` null means "same database". */
export interface ForeignKeyMeta {
  name: string;
  columns: string[];
  refDb?: string | null;
  refTable: string;
  refColumns: string[];
  /** Raw action text: CASCADE, SET NULL, RESTRICT, NO ACTION, SET DEFAULT. */
  onUpdate?: string | null;
  onDelete?: string | null;
  /**
   * Table this constraint lives on. Only set by the REVERSE lookup
   * (`obj_list_referencing_foreign_keys`), where the entry describes a child
   * table's constraint; forward listings omit it.
   */
  table?: string | null;
}

/** A table option round-tripped verbatim (AVG_ROW_LENGTH, PAGE_CHECKSUM...). */
export interface ExtraTableOption {
  key: string;
  value: string;
}

export interface TableOptions {
  engine?: string | null;
  charset?: string | null;
  collation?: string | null;
  comment?: string | null;
  autoIncrement?: number | null;
  rowFormat?: string | null;
  extra?: ExtraTableOption[];
  /** Raw partitioning clause, preserved verbatim. */
  partition?: string | null;
}

/** How `defaultValue` renders into DDL. */
export type DefaultKind = "none" | "null" | "value" | "expression";

/** One column of a table in designer form. */
export interface ColumnDef {
  name: string;
  /** Name when loaded from the server; drives CHANGE vs MODIFY. */
  previousName?: string | null;
  /** Full type text, e.g. `varchar(40)`, `int unsigned`, `enum('a','b')`. */
  dataType: string;
  nullable: boolean;
  defaultKind: DefaultKind;
  defaultValue?: string | null;
  autoIncrement: boolean;
  /** Raw `ON UPDATE <expr>` expression. */
  onUpdate?: string | null;
  /** Raw generated-column clause (`GENERATED ALWAYS AS (...) STORED`). */
  generated?: string | null;
  comment?: string | null;
  /** Attributes preserved verbatim on rebuilt definitions (SRID, ...). */
  preservedAttrs?: string[];
}

/** Full editable structure of one table (designer state). */
export interface TableDdl {
  db: string;
  table: string;
  columns: ColumnDef[];
  indexes: IndexMeta[];
  foreignKeys: ForeignKeyMeta[];
  options: TableOptions;
  checks?: string[];
  createSql: string;
}

/** Request shape of `obj_create_table`. */
export interface CreateTableRequest {
  name: string;
  columns: ColumnDef[];
  indexes?: IndexMeta[];
  foreignKeys?: ForeignKeyMeta[];
  options?: TableOptions;
}

/** Result of `obj_alter_table` (preview or partial apply). */
export interface AlterResult {
  statements: string[];
  warnings: string[];
  executed?: string[];
  error?: string | null;
}

/** `SHOW CREATE <object>` payload for views/routines/triggers/events. */
export interface ShowCreateResult {
  db: string;
  object: string;
  kind: "view" | "procedure" | "function" | "trigger" | "event";
  createSql: string;
}

export type RoutineKind = "procedure" | "function";

/** One stored procedure/function; the body is pulled lazily via DDL. */
export interface RoutineMeta {
  name: string;
  kind: RoutineKind;
  params?: string | null;
  returns?: string | null;
  comment?: string | null;
  definer?: string | null;
  created?: string | null;
}

export interface TriggerMeta {
  name: string;
  /** BEFORE / AFTER. */
  timing: string;
  /** INSERT / UPDATE / DELETE. */
  event: string;
  table: string;
  definer?: string | null;
  created?: string | null;
}

export interface EventMeta {
  name: string;
  status: string;
  eventType?: string | null;
  interval?: string | null;
  executeAt?: string | null;
  ends?: string | null;
  definer?: string | null;
  comment?: string | null;
}

/** Object kind for drops and code-editor tabs. */
export type ObjectKind = "table" | "view" | "routine" | "trigger" | "event";

export interface DropObjectRequest {
  db: string;
  kind: ObjectKind;
  name: string;
}

/** Per-object result of bulk operations. */
export interface ObjectOpResult {
  name: string;
  ok: boolean;
  error?: string | null;
}

export type MaintenanceOp =
  | "analyze"
  | "optimize"
  | "repair"
  | "check"
  | "flush"
  | "checksum";

export interface MaintenanceResult {
  table: string;
  resultText: string;
}

// ---------------------------------------------------------------------------
// Export / import (Phase 5)
// ---------------------------------------------------------------------------

/** Output syntax of a grid/query export (mirrors `ExportFormat`). */
export type ExportFormat =
  | "csv"
  | "tsv"
  | "json"
  | "xml"
  | "html"
  | "markdown"
  | "latex"
  | "php"
  | "textile"
  | "sql_inserts"
  /** Copy-as variant of sql_inserts (`REPLACE INTO`). */
  | "sql_replaces"
  /** Copy-as UPDATE statements (requires PK columns in the selection). */
  | "sql_updates";

/**
 * Where generated output lands. Internally tagged via `kind`
 * (`rename_all_fields = "camelCase"` on the Rust side).
 */
export type ExportDestination =
  | { kind: "file"; path: string; gzip: boolean }
  | { kind: "clipboard" }
  | { kind: "server"; connId: number; db: string };

/** Summary returned after a finished (or cancelled) export run. */
export interface ExportResult {
  bytesWritten: number;
  rows: number;
  elapsedMs: number;
  path?: string | null;
  cancelled: boolean;
}

/** Payload of the `export://progress` event. */
export interface ExportProgress {
  id: number;
  /** "structure" | "data" | "objects" | "done" | "cancelled". */
  phase: string;
  table?: string | null;
  rowsDone: number;
  totalTables: number;
  bytes: number;
}

/** Knobs for grid exports coming from the dialog. */
export interface GridExportOptions {
  delimiter?: string | null;
  quote?: string | null;
  nullText?: string | null;
  /** Primary-key column names for the `sql_updates` copy-as format. */
  pkColumns?: string[] | null;
}

/** Full option set of the "Export database as SQL" tool. */
export interface SqlDumpOptions {
  dbs: string[];
  /** Restrict tables per db; null dumps every base table. */
  tables?: string[] | null;
  what: DumpWhat;
  dropAdd: boolean;
  addLocks: boolean;
  completeInserts: boolean;
  extendedInserts: boolean;
  useTransactions: boolean;
  createDbHeader: boolean;
  definerStrip: boolean;
  includeViews: boolean;
  includeRoutines: boolean;
  includeTriggers: boolean;
  includeEvents: boolean;
  insertIgnore: boolean;
  hexBlobs: boolean;
}

export type DumpWhat = "structure_and_data" | "structure" | "data";

/** Per-object request for DDL export (designer parity). */
export interface DdlObjectRequest {
  db: string;
  kind: ObjectKind;
  name: string;
  /** Required when `kind` is routine. */
  routineKind?: RoutineKind | null;
}

/** Native-dialog file filter (`extensions` without dots). */
export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

/** CSV dialect knobs (UTF-8 only in Phase 5). */
export interface CsvParseOptions {
  delimiter: string;
  quote: string;
  hasHeader: boolean;
  skipRows: number;
  emptyIsNull: boolean;
}

/** First-N preview of a CSV source. */
export interface CsvPreview {
  columns: string[];
  rows: (string | null)[][];
  /** Approximate record count (embedded newlines make it an estimate). */
  totalLinesEst: number;
}

/** One CSV column ↔ table column assignment. */
export interface MapSpec {
  csvColIdx: number;
  targetCol: string;
}

/** Column definition for create-new import targets (guessed TEXT/INT/…). */
export interface ImportColumnSpec {
  name: string;
  dataType: string;
}

export interface NewTableSpec {
  name: string;
  columns: ImportColumnSpec[];
}

export type ImportMode = "append" | "replace" | "insert_ignore" | "upsert";

export type ImportErrorMode = "abort" | "skip" | "through";

export interface ImportErrorItem {
  /** 1-based CSV record number (estimate). */
  line: number;
  message: string;
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  errors: ImportErrorItem[];
  elapsedMs: number;
}

export interface SqlImportResult {
  statements: number;
  errors: string[];
  elapsedMs: number;
}

/** Payload of the `import://progress` event. */
export interface ImportProgress {
  phase: "import" | "sql" | "done";
  imported: number;
  skipped: number;
  totalEstimate?: number | null;
}

// ---------------------------------------------------------------------------
// Server tools (Phase 7)
// ---------------------------------------------------------------------------

/** One account (`mysql.user`) / role (`pg_roles`). */
export interface UserMeta {
  user: string;
  /** MySQL host part; absent on PostgreSQL roles. */
  host?: string | null;
  authPlugin?: string | null;
  passwordLastChanged?: string | null;
  /** MySQL ACCOUNT LOCK; PG maps non-login roles here. */
  locked: boolean;
  maxConnections?: number | null;
}

/** One parsed privilege scope of a GRANT. */
export interface GrantScope {
  /** e.g. "SELECT", "ALL PRIVILEGES". */
  privilege: string;
  /** "*" = global. */
  db?: string | null;
  table?: string | null;
  grantOption: boolean;
}

/** Raw SHOW GRANTS statements plus their parsed scopes. */
export interface GrantDetail {
  rawStatements: string[];
  scopes: GrantScope[];
}

/** One row of the process list. */
export interface ProcessInfo {
  id: number;
  user: string;
  host?: string | null;
  db?: string | null;
  command?: string | null;
  state?: string | null;
  info?: string | null;
  timeSeconds: number;
  waitEventType?: string | null;
  waitEvent?: string | null;
  /** True when this row is our own session. */
  isOwn: boolean;
}

export interface ServerVariable {
  name: string;
  value: string;
}

export interface StatusVariable {
  name: string;
  value: string;
}

/** Search mode of the find-text tool (regex is MySQL-only in v1). */
export type FindMode = "contains" | "prefix" | "whole" | "regex";

export interface FindTextRequest {
  dbs: string[];
  /** Restrict tables per db; null scans every base table. */
  tables?: string[] | null;
  search: string;
  mode: FindMode;
  caseSensitive: boolean;
  maxMatchesPerTable: number;
}

/** One hit of the find-text-on-server scan. */
export interface FindTextMatch {
  db: string;
  table: string;
  /** Column whose content matched (drives the preview). */
  column: string;
  /** First PK column; enables jump-to-row together with `rowPk`. */
  pkColumn?: string | null;
  /** Rendered PK values ("a|b" across PK columns, ctid when no PK). */
  rowPk: string;
  /** Matched cell rendered, truncated (~200 chars). */
  preview: string;
}

/** Payload of the `find://progress` event. */
export interface FindTextProgress {
  id: number;
  /** "scanning" | "table_done" | "done" | "cancelled". */
  phase: string;
  db?: string | null;
  table?: string | null;
  tablesDone: number;
  totalTables: number;
  matches: number;
}

/** Final outcome of `server_find_text_start`. */
export interface FindTextResult {
  id: number;
  matches: FindTextMatch[];
  cancelled: boolean;
  tablesScanned: number;
  elapsedMs: number;
}

export interface ResourceLimits {
  maxConnections?: number | null;
  maxUserConnections?: number | null;
  maxQueriesPerHour?: number | null;
  maxUpdatesPerHour?: number | null;
}

export interface CreateUserRequest {
  user: string;
  /** MySQL only ('%' default); ignored on PostgreSQL. */
  host?: string | null;
  password?: string | null;
  authPlugin?: string | null;
}

export interface AlterUserRequest {
  newPassword?: string | null;
  newName?: string | null;
  authPlugin?: string | null;
  lock?: boolean | null;
  limits?: ResourceLimits;
}

export interface GrantRequest {
  user: string;
  host?: string | null;
  privileges: string[];
  /** null → global (*.*); table scope requires a database. */
  db?: string | null;
  table?: string | null;
  grantOption: boolean;
  revoke: boolean;
}

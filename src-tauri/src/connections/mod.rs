//! Database connection abstraction: shared DTOs and helpers.
//!
//! Concrete drivers (MySQL/MariaDB first, then Postgres/SQLite) implement
//! [`traits::DbConnection`] in their own modules; [`manager::ConnectionManager`]
//! owns the running sessions. All serde structs mirror the TypeScript types
//! in `src/types/ipc.ts` exactly (`rename_all = "camelCase"` everywhere).

pub mod alter_builder;
pub mod ddl_parse;
pub mod dialect;
pub mod manager;
pub mod mysql;
pub mod postgres;
pub mod reconnect;
pub mod script;
pub mod server_admin;
pub mod sqlite;
pub mod sql;
pub mod traits;
pub mod tx;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::ssh::SshTunnelConfig;
use dialect::SqlDialect;

pub use tx::{IsolationLevel, TxEntry, TxLedger, TxMode, TxPhase};

/// Quote a MySQL/MariaDB identifier for embedding in SQL text.
///
/// Wraps in backticks and escapes embedded backticks by doubling. Never
/// interpolate user-supplied names into SQL without passing them through
/// here; values (as opposed to identifiers) must always use bind parameters.
/// Other engines quote via [`SqlDialect::quote_ident`].
pub fn quote_ident(name: &str) -> String {
    SqlDialect::Mysql.quote_ident(name)
}

/// Fully qualified identifier, e.g. `` `db`.`table` ``.
pub fn quote_qualified(parts: &[&str]) -> String {
    SqlDialect::Mysql.quote_qualified(parts)
}

/// Supported engines for saved sessions and connection dispatch.
/// Serialized as `"mysql" | "postgres" | "sqlite"` (mirrors `DbType` in
/// `src/types/ipc.ts`).
pub type DbType = dialect::SqlDialect;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TableKind {
    Table,
    View,
    MaterializedView,
    Sequence,
    SystemTable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableMeta {
    pub name: String,
    pub kind: TableKind,
    /// Estimated row count from the engine's statistics (NULL for views).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Driver-native type name, e.g. `int unsigned`, `varchar(255)`.
    pub data_type: String,
    pub nullable: bool,
    /// Driver-native key flag: MySQL reports `PRI` / `UNI` / `MUL`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    /// Extra modifiers, e.g. `auto_increment`, `DEFAULT_GENERATED`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

impl ColumnMeta {
    /// True when the column participates as the table's primary key.
    pub fn is_primary_key(&self) -> bool {
        self.key.as_deref() == Some("PRI")
    }
}

/// One table's full column list, produced by the whole-schema batch loader
/// (`dia_describe_tables`). Mirrors `TableSchemaData` in `src/types/ipc.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchemaData {
    pub table: String,
    pub columns: Vec<ColumnMeta>,
}

/// Identity + version banner captured at connect time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// "MySQL", "MariaDB", "PostgreSQL", ... (heuristic from the version string).
    pub product: String,
    /// Raw server version string, e.g. "8.0.36" or "11.4.2-MariaDB".
    pub version: String,
    /// SQL family this connection speaks; drives per-dialect UI behaviour.
    pub dialect: SqlDialect,
    /// When this connection was established.
    pub connected_at: DateTime<Utc>,
}

/// Handle returned to the frontend after a successful connect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnInfo {
    pub conn_id: u32,
    pub server_info: ServerInfo,
}

/// TLS posture requested by the user for a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SslMode {
    Disabled,
    /// Use TLS when the server supports it; fall back to plaintext otherwise.
    #[default]
    Preferred,
    /// Refuse to connect unless TLS is negotiated.
    Required,
}

/// Fully resolved parameters a driver needs — after session config, stored
/// passwords and tunnels have been applied. Never serialized over IPC.
#[derive(Debug, Clone)]
pub struct ResolvedConnectionConfig {
    /// Which driver will consume these parameters.
    pub engine: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub ssl_mode: SslMode,
    /// When present, the DB endpoint is reached through an SSH tunnel.
    /// (Server engines only; SQLite ignores it.)
    pub ssh: Option<SshTunnelConfig>,
}

/// One page of rows read server-side (offset/limit paging).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPageResult {
    pub columns: Vec<ColumnMeta>,
    /// Cells are typed values; see [`RowValue`].
    pub rows: Vec<Vec<RowValue>>,
    /// Best-effort total row count for scrollbar math (engine statistics).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_rows_estimate: Option<u64>,
    /// Server-side execution time of the page query.
    pub elapsed_ms: u64,
    /// True when more pages exist beyond this one.
    pub has_more: bool,
}

// ---------------------------------------------------------------------------
// Data grid request/response payloads (Phase 2)
// ---------------------------------------------------------------------------

/// A single cell value crossing IPC as an adjacently tagged enum:
/// `{"t":"str","v":"hi"}`, `{"t":"null"}`, ...
///
/// `u64` values above `2^53 - 1` lose precision in JS — accepted for P2
/// (only affects extreme BIGINT UNSIGNED / BIT payloads).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum RowValue {
    Null,
    Int(i64),
    UInt(u64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
    Date(String),
    Time(String),
    Datetime(String),
}

impl RowValue {
    /// True for [`RowValue::Null`].
    pub fn is_null(&self) -> bool {
        matches!(self, RowValue::Null)
    }
}

/// Sort direction for one ORDER BY term.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
    Asc,
    Desc,
}

/// One ORDER BY term; the column is validated against the table schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortSpec {
    pub column: String,
    pub direction: SortDirection,
}

/// Filter operator. Parsed strictly — anything else is rejected before it
/// can reach SQL text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FilterOp {
    Eq,
    NotEq,
    Lt,
    LtE,
    Gt,
    GtE,
    Like,
    NotLike,
    IsNull,
    IsNotNull,
    /// `column IN (?, ?, ...)` over [`FilterSpec::values`] (quick-filter
    /// "More values…" picks). The per-item `value` field is ignored.
    In,
}

/// One WHERE term (`column op value`); the value is always a bind parameter.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterSpec {
    pub column: String,
    pub op: FilterOp,
    /// Raw text value bound as a parameter. Unused by `is_null`/`is_not_null`
    /// and by `in` (which reads [`FilterSpec::values`] instead).
    #[serde(default)]
    pub value: Option<String>,
    /// Typed items for the `in` operator, each bound as its own parameter.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<RowValue>,
}

/// A `column = value` pair used by INSERT lists, UPDATE sets and PK predicates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellAssign {
    pub column: String,
    pub value: RowValue,
}

/// One grid change posted to the backend.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum RowChange {
    Insert { values: Vec<CellAssign> },
    Update { pk: Vec<CellAssign>, set: Vec<CellAssign> },
    Delete { pk: Vec<CellAssign> },
}

/// Request one page of table data. The owning connection is selected by the
/// separate `conn_id` command argument.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryPageRequest {
    pub db: String,
    pub table: String,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(default)]
    pub offset: u64,
    #[serde(default)]
    pub order_by: Vec<SortSpec>,
    /// AND-combined WHERE terms; an empty list reads the table unfiltered.
    #[serde(default)]
    pub filters: Vec<FilterSpec>,
}

fn default_page_size() -> u32 {
    1000
}

/// Per-row failure inside an [`ApplyChangesResult`]; other rows still apply.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowError {
    /// Index into the submitted `changes` array.
    pub index: usize,
    pub message: String,
}

/// Request to apply a batch of grid changes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesRequest {
    pub db: String,
    pub table: String,
    pub changes: Vec<RowChange>,
}

/// Outcome of posting grid changes. Rows are applied independently where the
/// engine allows; failures are reported per row instead of aborting.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyChangesResult {
    pub applied: u32,
    pub failed: u32,
    pub errors: Vec<RowError>,
    pub elapsed_ms: u64,
}

/// Outcome of a non-SELECT statement.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub rows_affected: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_insert_id: Option<u64>,
    pub elapsed_ms: u64,
}

/// One row of the "More values…" distinct-values dialog (Phase 9-A):
/// the grouped cell value plus how often it occurs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DistinctValue {
    pub value: RowValue,
    pub count: u64,
}

/// Top-N referenced rows of one FOREIGN KEY target, backing the grid
/// editor's value dropdown. Column order mirrors the FK's `ref_columns`
/// with an optional trailing display column.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FkRefValues {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<RowValue>>,
}

// ---------------------------------------------------------------------------
// Query editor script execution (Phase 3)
// ---------------------------------------------------------------------------

/// One column of a query result set. Slimmer than [`ColumnMeta`]: result
/// columns are anonymous expressions, not table columns — only the name and
/// a display type string are known.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumnMeta {
    pub name: String,
    /// Driver-native-ish type name, e.g. `bigint unsigned`, `varchar(64)`.
    pub data_type: String,
}

/// Per-statement outcome of `run_script`. One statement may yield several
/// outcomes (e.g. a procedure call returning multiple result sets).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum QueryOutcome {
    /// A result set was returned; rows are fully fetched (capped at
    /// `MAX_SCRIPT_RESULT_ROWS`, see mysql driver).
    ResultSet {
        columns: Vec<ResultColumnMeta>,
        rows: Vec<Vec<RowValue>>,
        elapsed_ms: u64,
        /// True when fetching stopped early because of the row cap.
        truncated: bool,
        /// Full source statement text (Phase 9-A updatable results detect
        /// the backing table from it). Absent on older payloads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sql: Option<String>,
    },
    /// No result set (DDL/DML/...).
    Exec {
        affected: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        last_insert_id: Option<u64>,
        /// Server info string ("Rows matched: ... Changed: ...") when present.
        #[serde(skip_serializing_if = "Option::is_none")]
        info: Option<String>,
        elapsed_ms: u64,
        /// Full source statement text (transaction-ledger bookkeeping — the
        /// actor classifies it). Absent on older payloads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sql: Option<String>,
    },
    /// The statement failed. With `stop_on_error = false` remaining
    /// statements still execute. `aborted_tx` marks PostgreSQL's 25P02
    /// state: the failure poisoned an open transaction that now needs
    /// ROLLBACK (the connection actor flips its ledger phase on seeing it).
    Error {
        message: String,
        sql_snippet: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        aborted_tx: bool,
    },
}

/// Serializable snapshot of one connection's transaction ledger, carried by
/// the `connection://tx` event and returned by `tx_get_state`. Mirrors
/// `TxState` in `src/types/ipc.ts`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxState {
    pub mode: TxMode,
    pub phase: TxPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub isolation: Option<IsolationLevel>,
    /// Number of uncommitted DML statements currently tracked.
    pub dml_count: u64,
    pub entries: Vec<TxEntry>,
}

// ---------------------------------------------------------------------------
// Table designer / object management (Phase 4)
// ---------------------------------------------------------------------------

/// Index flavour, mirroring the keywords SHOW CREATE TABLE emits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexKind {
    Primary,
    Unique,
    Index,
    Fulltext,
    Spatial,
}

/// One table index (the primary key is an index named `PRIMARY`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexMeta {
    pub name: String,
    pub kind: IndexKind,
    /// Indexed columns in order (prefix lengths / sort orders are not modelled).
    pub columns: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// One FOREIGN KEY constraint.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyMeta {
    pub name: String,
    pub columns: Vec<String>,
    /// Referenced database; `None` means "same database as the table".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ref_db: Option<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    /// Raw action text: CASCADE, SET NULL, RESTRICT, NO ACTION, SET DEFAULT.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_delete: Option<String>,
    /// Table this constraint lives on. Only populated by the REVERSE lookup
    /// (`list_referencing_foreign_keys`), where the constraint belongs to a
    /// child table rather than the queried parent; forward listings leave it
    /// unset because the owning [`TableDdl`] already carries it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
}

/// A table option that is round-tripped verbatim without a dedicated field
/// (AVG_ROW_LENGTH, PAGE_CHECKSUM, ...). `value` keeps the original token text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtraTableOption {
    pub key: String,
    pub value: String,
}

/// CREATE TABLE tail options.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_increment: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_format: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<ExtraTableOption>,
    /// Raw partitioning clause (`PARTITION BY ...`), preserved verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition: Option<String>,
}

/// How [`ColumnDef::default_value`] must be rendered into DDL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DefaultKind {
    /// No DEFAULT clause at all.
    #[default]
    None,
    /// Explicit `DEFAULT NULL`.
    Null,
    /// Literal default — quoted when emitted unless purely numeric.
    Value,
    /// Expression/function default (`CURRENT_TIMESTAMP`, `(expr)`) — emitted raw.
    Expression,
}

/// One column of a table in designer form. The same shape is used for
/// CREATE requests and ALTER diffs; `previous_name` marks a renamed column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnDef {
    pub name: String,
    /// Name this column had when it was loaded; drives CHANGE vs MODIFY.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_name: Option<String>,
    /// Full type text, e.g. `varchar(40)`, `int unsigned`, `enum('a','b')`.
    pub data_type: String,
    pub nullable: bool,
    #[serde(default)]
    pub default_kind: DefaultKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
    #[serde(default)]
    pub auto_increment: bool,
    /// Raw `ON UPDATE <expr>` expression (usually CURRENT_TIMESTAMP family).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub on_update: Option<String>,
    /// Raw generated-column clause (`GENERATED ALWAYS AS (...) STORED`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generated: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// Attributes the designer cannot edit structurally but preserves
    /// verbatim on rebuilt definitions (SRID, INVISIBLE, column charset...).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub preserved_attrs: Vec<String>,
}

/// Full structure of one table as shown by SHOW CREATE TABLE, in the editable
/// form used by the designer. `create_sql` carries the server's original text.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDdl {
    pub db: String,
    pub table: String,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    pub options: TableOptions,
    /// Table-level CHECK constraints preserved verbatim (not yet editable).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub checks: Vec<String>,
    pub create_sql: String,
}

/// Request for `create_table`: everything needed to emit CREATE TABLE.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTableRequest {
    pub name: String,
    pub columns: Vec<ColumnDef>,
    #[serde(default)]
    pub indexes: Vec<IndexMeta>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyMeta>,
    #[serde(default)]
    pub options: TableOptions,
}

/// Result of `alter_table`: the planned statements plus non-fatal warnings;
/// after a partial apply, `executed` holds the statements that succeeded and
/// `error` the failure that stopped the run.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterResult {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executed: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Object flavour reported by [`ShowCreateResult`]; serialized as the
/// lowercase wire string ("view" | "procedure" | ... ) the frontend expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShowCreateKind {
    View,
    Procedure,
    Function,
    Trigger,
    Event,
}

/// `SHOW CREATE <object>` payload shared by views/routines/triggers/events.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowCreateResult {
    pub db: String,
    pub object: String,
    pub kind: ShowCreateKind,
    pub create_sql: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineKind {
    Procedure,
    Function,
}

/// One stored procedure/function from information_schema.ROUTINES; the body
/// is pulled lazily via `get_routine_ddl`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineMeta {
    pub name: String,
    pub kind: RoutineKind,
    /// Parameter summary like `(IN p1 int, OUT p2 varchar(10))`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<String>,
    /// Return type summary (functions only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub returns: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// One trigger from information_schema.TRIGGERS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerMeta {
    pub name: String,
    /// BEFORE / AFTER.
    pub timing: String,
    /// INSERT / UPDATE / DELETE.
    pub event: String,
    pub table: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
}

/// One scheduled event from information_schema.EVENTS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMeta {
    pub name: String,
    /// ENABLED / DISABLED / SLAVESIDE_DISABLED.
    pub status: String,
    /// RECURRING / ONE TIME.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_type: Option<String>,
    /// Interval summary like `1 DAY` (recurring events only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execute_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ends: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

/// Object kind for drops and code-editor tabs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Table,
    View,
    Routine,
    Trigger,
    Event,
}

/// One drop/truncate request + its per-object outcome.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DropObjectRequest {
    pub db: String,
    pub kind: ObjectKind,
    pub name: String,
}

/// Per-object result of bulk operations (serde-friendly `Result`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectOpResult {
    pub name: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MaintenanceOp {
    Analyze,
    Optimize,
    Repair,
    Check,
    Flush,
    Checksum,
}

impl MaintenanceOp {
    /// The SQL verb prefix for this operation.
    pub fn sql_verb(self) -> &'static str {
        match self {
            MaintenanceOp::Analyze => "ANALYZE TABLE",
            MaintenanceOp::Optimize => "OPTIMIZE TABLE",
            MaintenanceOp::Repair => "REPAIR TABLE",
            MaintenanceOp::Check => "CHECK TABLE",
            MaintenanceOp::Flush => "FLUSH TABLE",
            MaintenanceOp::Checksum => "CHECKSUM TABLE",
        }
    }
}

/// Textual result of running one maintenance operation on one table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceResult {
    pub table: String,
    pub result_text: String,
}

// ---------------------------------------------------------------------------
// Server tools (Phase 7): user admin, process list, variables/status
// ---------------------------------------------------------------------------

/// One account/role from `mysql.user` / `pg_roles`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMeta {
    /// Account name (`User` column / `rolname`).
    pub user: String,
    /// MySQL host part (`'u'@'h'`); always `None` for PostgreSQL roles.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Auth plugin (MySQL) — `caching_sha2_password`, `mysql_native_password`, ...
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_plugin: Option<String>,
    /// Raw timestamp text from the catalog when available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub password_last_changed: Option<String>,
    /// MySQL `ACCOUNT LOCK`; PG maps disabled-login roles here.
    pub locked: bool,
    /// Concurrent-connection cap (`MAX_CONNECTIONS` / PG `rolconnlimit`,
    /// `-1` meaning unlimited).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<i64>,
}

/// One privilege scope parsed out of a GRANT statement or the catalogs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantScope {
    /// e.g. `SELECT`, `ALL PRIVILEGES` (already upper-cased).
    pub privilege: String,
    /// Qualified scope database; `"*"` means global.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    /// Statement carried `WITH GRANT OPTION`.
    pub grant_option: bool,
}

/// Everything known about one account's grants: the raw statements (shown
/// verbatim like Heidi's user manager) plus the parsed scopes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantDetail {
    pub raw_statements: Vec<String>,
    pub scopes: Vec<GrantScope>,
}

/// One row of the process list (`SHOW PROCESSLIST` / `pg_stat_activity`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub id: i64,
    pub user: String,
    /// Client address/host (`'h:port'` on MySQL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    /// Command verb (MySQL) / activity state (PG).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Progress/state detail (MySQL `State` / PG `state` + wait events).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// Current statement text where visible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub info: Option<String>,
    /// Seconds the operation has been running (fractional for PG, derived
    /// from `backend_start`/`query_start`).
    pub time_seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_event_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wait_event: Option<String>,
    /// True when this row belongs to our own session.
    pub is_own: bool,
}

/// One `name = value` pair of `SHOW VARIABLES` / `SHOW ALL`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerVariable {
    pub name: String,
    pub value: String,
}

/// One counter of `SHOW GLOBAL STATUS` / the PG statistics views.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusVariable {
    pub name: String,
    pub value: String,
}

/// A rendered primary-key reference for a [`FindTextMatch`] row
/// (`v1|v2` across PK columns, ctid/rowid when no PK exists).
pub type RenderedPk = String;

/// One hit of the find-text-on-server tool.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTextMatch {
    pub db: String,
    pub table: String,
    /// Column whose content matched (drives the preview).
    pub column: String,
    /// First primary-key column (`""` when the table has none); lets the UI
    /// build a jump-to-row filter together with [`FindTextMatch::row_pk`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pk_column: Option<String>,
    /// Rendered PK values (`a|b` across PK columns, ctid on PG w/o PK).
    pub row_pk: RenderedPk,
    /// Matched cell rendered, truncated (~200 chars).
    pub preview: String,
}

/// Search mode of the find-text tool (regex is MySQL-only in v1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FindMode {
    #[default]
    Contains,
    Prefix,
    Whole,
    Regex,
}

/// Request for `server_find_text_start`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTextRequest {
    pub dbs: Vec<String>,
    /// Restrict to these tables; `None` scans every base table of each db.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tables: Option<Vec<String>>,
    pub search: String,
    #[serde(default)]
    pub mode: FindMode,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default = "default_find_max_per_table")]
    pub max_matches_per_table: u32,
}

fn default_find_max_per_table() -> u32 {
    50
}

/// Resource caps applied through `ALTER USER ... WITH ...` (MySQL) /
/// `CONNECTION LIMIT` (PG — hourly quotas are ignored there).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_user_connections: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_queries_per_hour: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_updates_per_hour: Option<i64>,
}

impl ResourceLimits {
    /// True when no limit is set (no WITH clause needed).
    pub fn is_empty(&self) -> bool {
        self.max_connections.is_none()
            && self.max_user_connections.is_none()
            && self.max_queries_per_hour.is_none()
            && self.max_updates_per_hour.is_none()
    }
}

/// `CREATE USER` payload. `host` applies to MySQL only (`'%` default).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserRequest {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    /// MySQL auth plugin (`IDENTIFIED WITH <plugin> BY <pw>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_plugin: Option<String>,
}

/// `ALTER USER/ROLE` payload; every option is independent.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlterUserRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_name: Option<String>,
    /// Switch the MySQL auth plugin (requires a new password too).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_plugin: Option<String>,
    /// Some → ACCOUNT LOCK / UNLOCK (MySQL), NOLOGIN / LOGIN (PG).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lock: Option<bool>,
    #[serde(default)]
    pub limits: ResourceLimits,
}

/// GRANT/REVOKE payload. Privilege names are validated against a dialect
/// allowlist before any SQL is built (injection guard).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantRequest {
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    pub privileges: Vec<String>,
    /// `None` → global (`*.*`). `"*"` is rejected; use `None` instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub grant_option: bool,
    /// True → REVOKE instead of GRANT.
    #[serde(default)]
    pub revoke: bool,
}

// ---------------------------------------------------------------------------
// Streaming row reads (Phase 5 export)
// ---------------------------------------------------------------------------

/// One chunk of rows pushed by `stream_table_rows` / `stream_query_rows`.
/// Columns repeat on every chunk so late joiners (or selection exports that
/// skip the first chunks) still see a schema.
#[derive(Debug, Clone)]
pub struct RowsChunk {
    pub columns: Vec<ResultColumnMeta>,
    pub rows: Vec<Vec<RowValue>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_simple_identifiers() {
        assert_eq!(quote_ident("users"), "`users`");
        assert_eq!(quote_ident("my db"), "`my db`");
    }

    #[test]
    fn escapes_embedded_backticks() {
        assert_eq!(quote_ident("we`ird"), "`we``ird`");
        assert_eq!(quote_ident("`"), "````");
    }

    #[test]
    fn qualifies_multiple_parts() {
        assert_eq!(quote_qualified(&["db", "tbl"]), "`db`.`tbl`");
        assert_eq!(quote_qualified(&["a`b"]), "`a``b`");
    }
}

//! The `DbConnection` trait every database driver must implement.
//!
//! Design notes:
//! - `async_trait` keeps object-safety so drivers can be stored as
//!   `Box<dyn DbConnection>` inside a connection task.
//! - Methods are intentionally coarse (page reads, whole-statement exec);
//!   fine-grained cursor control can be added later without breaking impls
//!   because new methods get default implementations returning `Unsupported`.

use async_trait::async_trait;
use tokio::sync::mpsc;

use crate::connections::{
    AlterUserRequest, ApplyChangesRequest, ApplyChangesResult, ColumnMeta, CreateUserRequest,
    DatabaseInfo, DistinctValue, EventMeta, ExecResult, FilterSpec, ForeignKeyMeta, GrantDetail,
    GrantRequest, ProcessInfo, QueryOutcome, QueryPageRequest, QueryPageResult,
    ResultColumnMeta, RowValue, RowsChunk, RoutineKind, RoutineMeta, ServerInfo, ServerVariable,
    ShowCreateResult, StatusVariable, TableDdl, TableMeta, TableSchemaData, TriggerMeta, UserMeta,
};
use crate::error::{AppError, Result};

#[async_trait]
pub trait DbConnection: Send {
    /// Human-readable driver label, e.g. "MySQL 8.0" — for logs/status bar.
    fn server_label(&self) -> String;

    /// Server identity captured at connect time (product, version, ...).
    fn server_info(&self) -> ServerInfo;

    /// Release driver resources (send QUIT, close sockets).
    async fn close(&mut self) {}

    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>>;

    async fn list_tables(&mut self, database: &str) -> Result<Vec<TableMeta>>;

    /// Column metadata for the tree / designer / grid header.
    async fn describe_table(
        &mut self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnMeta>>;

    /// Drop any cached column metadata. Called after DDL executes and by the
    /// tree Refresh; drivers that cache must override, the default suits the
    /// rest.
    fn clear_schema_cache(&mut self) {}

    /// Whole-schema column metadata in one round-trip (ER diagram batch
    /// load). One entry per table; views are not included.
    async fn list_schema_columns(&mut self, database: &str) -> Result<Vec<TableSchemaData>> {
        let _ = database;
        Err(unsupported())
    }

    /// Every foreign key of one schema in one round-trip (ER diagram edges).
    /// Each entry describes the CHILD constraint — `columns` are the child's
    /// FK columns, `ref_table` the referenced parent and `table` the child
    /// table the constraint lives on.
    async fn list_schema_foreign_keys(&mut self, database: &str) -> Result<Vec<ForeignKeyMeta>> {
        let _ = database;
        Err(unsupported())
    }

    /// Read one page of table rows for a data tab (sort/filter validated and
    /// applied server-side; see [`QueryPageRequest`]).
    async fn query_page(&mut self, req: &QueryPageRequest) -> Result<QueryPageResult> {
        let _ = req;
        Err(unsupported())
    }

    /// Apply a batch of grid changes (insert/update/delete). Rows are applied
    /// independently where possible; per-row failures are reported, not fatal.
    ///
    /// `join_tx` (Transactions Phase 1): when true the statements run on the
    /// driver's raw connection WITHOUT opening an internal transaction, so
    /// they join the explicit transaction the connection actor manages in
    /// manual mode. When false drivers keep their own atomic-batch behaviour.
    async fn apply_changes(
        &mut self,
        req: &ApplyChangesRequest,
        join_tx: bool,
    ) -> Result<ApplyChangesResult> {
        let _ = (req, join_tx);
        Err(unsupported())
    }

    /// Exact `COUNT(*)` honouring an optional filter; `None` when the driver
    /// cannot count this object (e.g. some views).
    async fn count_rows(
        &mut self,
        database: &str,
        table: &str,
        filter: Option<&FilterSpec>,
    ) -> Result<Option<u64>> {
        let _ = (database, table, filter);
        Err(unsupported())
    }

    /// Distinct-value census of one column for the quick-filter "More
    /// values…" dialog: up to `limit` rows, most frequent first, NULLs
    /// grouped into one bucket and counted. The optional `search` narrows
    /// via a bound LIKE pattern.
    async fn distinct_values(
        &mut self,
        database: &str,
        table: &str,
        column: &str,
        limit: u32,
        search: Option<&str>,
    ) -> Result<Vec<DistinctValue>> {
        let _ = (database, table, column, limit, search);
        Err(unsupported())
    }

    /// Execute a single statement (DDL/DML); result-set statements should go
    /// through `query_page`.
    async fn execute(&mut self, sql: &str) -> Result<ExecResult> {
        let _ = sql;
        Err(unsupported())
    }

    /// Split a script into statements, execute them in order on this
    /// connection and report one outcome per statement/result set. When
    /// `stop_on_error` is true the first failure aborts the rest of the
    /// script; otherwise execution continues with the next statement.
    async fn run_script(&mut self, sql: &str, stop_on_error: bool) -> Result<Vec<QueryOutcome>> {
        let _ = (sql, stop_on_error);
        Err(unsupported())
    }

    // -----------------------------------------------------------------------
    // Object management (Phase 4)
    // -----------------------------------------------------------------------

    /// Full table structure from SHOW CREATE TABLE, parsed for the designer.
    async fn get_table_ddl(
        &mut self,
        database: &str,
        table: &str,
    ) -> Result<TableDdl> {
        let _ = (database, table);
        Err(unsupported())
    }

    /// Foreign keys pointing AT this table (reverse view). Each entry
    /// describes the CHILD constraint — `columns` are the child's FK
    /// columns, `ref_columns` the queried parent's referenced columns and
    /// `table` the child table name.
    async fn list_referencing_foreign_keys(
        &mut self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyMeta>> {
        let _ = (database, table);
        Err(unsupported())
    }

    /// Stored procedures/functions of one database (bodies pulled lazily).
    async fn list_routines(&mut self, database: &str) -> Result<Vec<RoutineMeta>> {
        let _ = database;
        Err(unsupported())
    }

    /// SHOW CREATE PROCEDURE / FUNCTION.
    async fn get_routine_ddl(
        &mut self,
        database: &str,
        name: &str,
        kind: RoutineKind,
    ) -> Result<ShowCreateResult> {
        let _ = (database, name, kind);
        Err(unsupported())
    }

    async fn list_triggers(&mut self, database: &str) -> Result<Vec<TriggerMeta>> {
        let _ = database;
        Err(unsupported())
    }

    async fn get_trigger_ddl(
        &mut self,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let _ = (database, name);
        Err(unsupported())
    }

    async fn get_view_ddl(
        &mut self,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let _ = (database, name);
        Err(unsupported())
    }

    /// Scheduled events; an empty list is valid when the scheduler is off.
    async fn list_events(&mut self, database: &str) -> Result<Vec<EventMeta>> {
        let _ = database;
        Err(unsupported())
    }

    async fn get_event_ddl(
        &mut self,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let _ = (database, name);
        Err(unsupported())
    }

    // -----------------------------------------------------------------------
    // Streaming reads (Phase 5 export)
    // -----------------------------------------------------------------------

    /// Stream every row of `SELECT * FROM database.table` in chunks of at
    /// most `chunk_size` rows. Never buffers the whole table: chunks are
    /// pushed through `tx` as they arrive from the wire. Dropping the
    /// receiver cancels the scan (the send fails and the driver stops
    /// fetching). Returns the total number of rows sent.
    async fn stream_table_rows(
        &mut self,
        database: &str,
        table: &str,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    ) -> Result<u64> {
        let _ = (database, table, chunk_size, tx);
        Err(unsupported())
    }

    /// Stream the rows of an arbitrary single SELECT in the same chunked
    /// fashion as [`DbConnection::stream_table_rows`].
    async fn stream_query_rows(
        &mut self,
        sql: &str,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    ) -> Result<u64> {
        let _ = (sql, chunk_size, tx);
        Err(unsupported())
    }

    /// Bulk-insert rows with positional bind parameters (CSV import).
    /// One multi-row INSERT is executed per call; returns affected rows.
    /// Contract: `columns` were validated against a live table description
    /// by the caller before reaching the driver.
    #[allow(clippy::too_many_arguments)]
    async fn insert_rows(
        &mut self,
        database: &str,
        table: &str,
        columns: &[String],
        rows: &[Vec<RowValue>],
        ignore: bool,
        upsert_columns: Option<&[String]>,
    ) -> Result<u64> {
        let _ = (database, table, columns, rows, ignore, upsert_columns);
        Err(unsupported())
    }

    // -----------------------------------------------------------------------
    // Server tools (Phase 7)
    // -----------------------------------------------------------------------

    /// All accounts/roles visible to the current connection.
    async fn list_users(&mut self) -> Result<Vec<UserMeta>> {
        Err(unsupported())
    }

    /// Raw `SHOW GRANTS` statements plus parsed scopes for one account.
    async fn show_user_grants(&mut self, user: &str, host: Option<&str>) -> Result<GrantDetail> {
        let _ = (user, host);
        Err(unsupported())
    }

    /// Create a new account. Passwords cannot be bound in CREATE USER — the
    /// drivers escape them via [`server_admin::sql_literal`] instead.
    async fn create_user(&mut self, req: &CreateUserRequest) -> Result<()> {
        let _ = req;
        Err(unsupported())
    }

    /// Alter an existing account (password/rename/plugin/lock/limits).
    async fn alter_user(
        &mut self,
        user: &str,
        host: Option<&str>,
        req: &AlterUserRequest,
    ) -> Result<()> {
        let _ = (user, host, req);
        Err(unsupported())
    }

    /// Drop an account.
    async fn drop_user(&mut self, user: &str, host: Option<&str>) -> Result<()> {
        let _ = (user, host);
        Err(unsupported())
    }

    /// Grant or revoke privileges (names validated against a dialect
    /// allowlist before any SQL text is built).
    async fn grant_revoke(&mut self, req: &GrantRequest) -> Result<()> {
        let _ = req;
        Err(unsupported())
    }

    /// One snapshot of server activity (`SHOW PROCESSLIST` /
    /// `pg_stat_activity`).
    async fn list_processes(&mut self) -> Result<Vec<ProcessInfo>> {
        Err(unsupported())
    }

    /// Cancel (`query_only`) or terminate a running backend/connection.
    async fn kill_process(&mut self, process_id: i64, query_only: bool) -> Result<()> {
        let _ = (process_id, query_only);
        Err(unsupported())
    }

    /// Server configuration variables (`SHOW VARIABLES` / `SHOW ALL`).
    async fn list_variables(&mut self) -> Result<Vec<ServerVariable>> {
        Err(unsupported())
    }

    /// Server status counters since start (`SHOW GLOBAL STATUS` / PG stats).
    async fn list_status(&mut self) -> Result<Vec<StatusVariable>> {
        Err(unsupported())
    }
}

/// Push one chunk, treating a closed channel as "consumer cancelled".
/// Awaits capacity so slow exporters apply backpressure to the driver.
/// Returns false when the stream must stop.
pub(crate) async fn send_chunk(
    tx: &mpsc::Sender<Result<RowsChunk>>,
    columns: &[ResultColumnMeta],
    rows: Vec<Vec<RowValue>>,
) -> bool {
    tx.send(Ok(RowsChunk {
        columns: columns.to_vec(),
        rows,
    }))
    .await
    .is_ok()
}

fn unsupported() -> AppError {
    AppError::Unsupported("not implemented for this driver yet".into())
}

/// Placeholder implementation used before any real session is open.
/// Every operation reports `Unsupported`, which the UI surfaces as an error
/// log entry instead of panicking.
pub struct UnconnectedConnection;

impl UnconnectedConnection {
    fn server_info() -> ServerInfo {
        ServerInfo {
            product: "none".into(),
            version: String::new(),
            dialect: crate::connections::dialect::SqlDialect::Mysql,
            backslash_escapes: true,
            connected_at: chrono::Utc::now(),
        }
    }
}

#[async_trait]
impl DbConnection for UnconnectedConnection {
    fn server_label(&self) -> String {
        "not connected".to_string()
    }

    fn server_info(&self) -> ServerInfo {
        Self::server_info()
    }

    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>> {
        Err(no_active_session())
    }

    async fn list_tables(&mut self, _database: &str) -> Result<Vec<TableMeta>> {
        Err(no_active_session())
    }

    async fn describe_table(&mut self, _database: &str, _table: &str) -> Result<Vec<ColumnMeta>> {
        Err(no_active_session())
    }
}

fn no_active_session() -> AppError {
    AppError::Unsupported("no active session".into())
}

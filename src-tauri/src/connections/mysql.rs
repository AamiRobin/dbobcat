//! MySQL / MariaDB driver built on `mysql_async`.
//!
//! One `Conn` per connection task (pool-less for Phase 1). All metadata
//! queries go through `information_schema` with bind parameters; identifiers
//! that must appear in SQL text are quoted via [`quote_ident`]. Values are
//! never string-concatenated into SQL.

use async_trait::async_trait;
use chrono::Utc;
use mysql_async::consts::{ColumnFlags, ColumnType};
use mysql_async::prelude::Queryable;
use mysql_async::{
    Column, Conn, Opts, OptsBuilder, Params, Pool, PoolConstraints, PoolOpts, Row, SslOpts, TxOpts,
    Value,
};

use crate::connections::dialect::SqlDialect;
use crate::connections::script::split_statements;
use crate::connections::server_admin;
use crate::connections::sql::{
    build_change_sql, build_distinct_values_sql, build_order_by_clause, build_page_sql,
    build_where_clause, build_where_clause_and, qualify_table, validate_column,
};
use crate::connections::traits::DbConnection;
use crate::connections::{
    quote_qualified, AlterUserRequest, ApplyChangesRequest, ApplyChangesResult, ColumnMeta,
    CreateUserRequest, DatabaseInfo, DistinctValue, EventMeta, ExecResult, FilterSpec,
    GrantDetail, GrantRequest, ProcessInfo, QueryOutcome, QueryPageRequest, QueryPageResult,
    ResolvedConnectionConfig, ResultColumnMeta, RowError, RowValue, RowsChunk, RoutineKind,
    RoutineMeta, ServerInfo, ServerVariable, ShowCreateKind, ShowCreateResult, SslMode,
    StatusVariable, TableDdl, TableKind, TableMeta, TriggerMeta, UserMeta,
};
use crate::error::{AppError, Result};

/// Hard ceiling on the TCP+TLS+auth handshake so unreachable hosts fail
/// fast with a friendly message instead of hanging forever.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// Hard ceiling on a single page read; protects the UI from runaway queries.
const MAX_PAGE_SIZE: u32 = 50_000;

/// Engines that support multi-statement transactions. Anything else falls
/// back to per-row autocommit (still collecting per-row errors).
const TRANSACTIONAL_ENGINES: [&str; 4] = ["INNODB", "NDB", "ROCKSDB", "TOKUDB"];

pub struct MysqlConnection {
    /// `Some` until closed; lets `close()` consume the conn to send QUIT.
    conn: Option<Conn>,
    /// Kept so `close()` can shut the (1-connection) pool down properly.
    pool: Option<Pool>,
    server_info: ServerInfo,
}

impl MysqlConnection {
    /// Open a connection applying the session's TLS posture.
    ///
    /// `Preferred` tries TLS first and retries plaintext when the server
    /// cannot do TLS (`mysql_async` 0.37 has no native preferred mode).
    /// `mysql_async` 0.37 only exposes connections through `Pool`, so we
    /// wrap every session in a single-slot pool.
    pub async fn open(config: &ResolvedConnectionConfig) -> Result<Self> {
        let opened = match config.ssl_mode {
            SslMode::Preferred => {
                match connect_with_info(&build_opts(config, false)).await {
                    ok @ Ok(_) => ok,
                    Err(tls_err) => {
                        // Retry without TLS; if the fallback also fails the
                        // first error is usually the more telling one.
                        match connect_with_info(&build_opts(config, true)).await {
                            Ok(opened) => Ok(opened),
                            Err(_) => Err(tls_err),
                        }
                    }
                }
            }
            _ => connect_with_info(&build_opts(config, false)).await,
        }?;

        Ok(Self {
            pool: Some(opened.pool),
            conn: Some(opened.conn),
            server_info: opened.server_info,
        })
    }

    /// Borrow the live connection or fail with a stable error.
    fn conn(&mut self) -> Result<&mut Conn> {
        self.conn
            .as_mut()
            .ok_or_else(|| AppError::Db("connection is closed".into()))
    }

    /// Estimated row count from engine statistics (information_schema).
    async fn table_row_estimate(&mut self, db: &str, table: &str) -> Result<Option<u64>> {
        let rows = run_query(
            self.conn()?,
            "SELECT TABLE_ROWS FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            Params::Positional(vec![db.into(), table.into()]),
        )
        .await?;
        match rows.first() {
            Some(row) => col_opt_u64(row, 0),
            None => Ok(None),
        }
    }

    /// Storage engine of a table (None for views and missing objects).
    async fn table_engine(&mut self, db: &str, table: &str) -> Result<Option<String>> {
        let rows = run_query(
            self.conn()?,
            "SELECT ENGINE FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
            Params::Positional(vec![db.into(), table.into()]),
        )
        .await?;
        match rows.first() {
            Some(row) => col_opt_string(row, 0).map(|e| e.filter(|e| !e.is_empty())),
            None => Ok(None),
        }
    }

    /// Run `SHOW CREATE <object>` and extract the definition column, which
    /// sits at a different index per statement (`Create Table`=1,
    /// `Create View`=1, `Create Procedure`=2, `SQL Original Statement`=2,
    /// `Create Event`=3). Matched by name with a positional fallback.
    async fn show_create(&mut self, sql: &str, fallback_idx: usize) -> Result<String> {
        let result = self.conn()?.query_iter(sql).await?;
        let wanted = [
            "create table",
            "create view",
            "create procedure",
            "create function",
            "create trigger",
            "create event",
            "sql original statement",
        ];
        let idx = result
            .columns_ref()
            .iter()
            .position(|c| wanted.contains(&c.name_str().to_ascii_lowercase().as_str()))
            .unwrap_or(fallback_idx);
        let rows: Vec<Row> = result.collect_and_drop().await?;
        match rows.into_iter().next() {
            Some(row) => col_string(&row, idx),
            None => Err(AppError::Db("object not found".into())),
        }
    }

    /// Execute one raw statement (no client-side splitting) — used by object
    /// editors where CREATE PROCEDURE bodies contain semicolons that must
    /// reach the server as a single statement.
    async fn execute_single(&mut self, sql: &str) -> Result<ExecResult> {
        let started = std::time::Instant::now();
        let mut result = self.conn()?.query_iter(sql).await?;
        // Drain any unexpectedly returned rows so the connection stays
        // reusable; DDL/DML never produce them.
        if !result.columns_ref().is_empty() {
            while let Some(row) = result.next().await? {
                let _ = row;
            }
        }
        Ok(ExecResult {
            rows_affected: result.affected_rows(),
            last_insert_id: result.last_insert_id(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    // -----------------------------------------------------------------------
    // Server tools helpers (Phase 7)
    // -----------------------------------------------------------------------

    /// Rich `mysql.user` read (MySQL 5.7+ / MariaDB 10.2+ shape).
    async fn list_users_rich(&mut self) -> Result<Vec<UserMeta>> {
        let rows = run_query(
            self.conn()?,
            "SELECT User, Host, plugin, CAST(password_last_changed AS CHAR), \
                    account_locked, max_connections \
             FROM mysql.user ORDER BY User, Host",
            Params::Positional(Vec::new()),
        )
        .await?;
        rows.iter()
            .map(|row| {
                Ok(UserMeta {
                    user: col_string(row, 0)?,
                    host: Some(col_string(row, 1)?),
                    auth_plugin: col_opt_string(row, 2)?.filter(|p| !p.is_empty()),
                    password_last_changed: col_opt_string(row, 3)?.filter(|c| !c.is_empty()),
                    locked: col_opt_string(row, 4)?.as_deref() == Some("Y"),
                    max_connections: col_opt_u64(row, 5)?.map(|v| v.min(i64::MAX as u64) as i64),
                })
            })
            .collect()
    }

    /// Minimal fallback covering older/flavored servers: only the two columns
    /// every MySQL/MariaDB version guarantees.
    async fn list_users_minimal(&mut self) -> Result<Vec<UserMeta>> {
        let rows = run_query(
            self.conn()?,
            "SELECT User, Host FROM mysql.user ORDER BY User, Host",
            Params::Positional(Vec::new()),
        )
        .await?;
        rows.iter()
            .map(|row| {
                Ok(UserMeta {
                    user: col_string(row, 0)?,
                    host: Some(col_string(row, 1)?),
                    ..Default::default()
                })
            })
            .collect()
    }

    /// Our own thread id, used to tag the process-list row.
    async fn own_thread_id(&mut self) -> Option<u64> {
        let conn = self.conn().ok()?;
        let rows = run_query(
            conn,
            "SELECT CONNECTION_ID()",
            Params::Positional(Vec::new()),
        )
        .await
        .ok()?;
        rows.first().and_then(|row| col_opt_u64(row, 0).ok()).flatten()
    }
}

struct OpenedConnection {
    pool: Pool,
    conn: Conn,
    server_info: ServerInfo,
}

fn build_opts(config: &ResolvedConnectionConfig, force_no_tls: bool) -> Opts {
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(config.host.as_str())
        .tcp_port(config.port)
        .prefer_socket(false) // never sneak in a unix socket path
        .user(Some(config.user.as_str()))
        .pass(config.password.clone())
        .pool_opts(
            PoolOpts::default().with_constraints(PoolConstraints::new(0, 1).expect("0 <= 1")),
        );

    if let Some(db) = config.database.as_deref() {
        builder = builder.db_name(Some(db));
    }

    if !force_no_tls && config.ssl_mode == SslMode::Required {
        builder = builder.ssl_opts(SslOpts::default());
    }
    builder.into()
}

async fn connect_with_info(opts: &Opts) -> Result<OpenedConnection> {
    let attempt = async {
        let pool = Pool::new(opts.clone());
        let mut conn = pool.get_conn().await?;
        let server_info = fetch_server_info(&mut conn).await?;
        Ok(OpenedConnection {
            pool,
            conn,
            server_info,
        })
    };

    tokio::time::timeout(CONNECT_TIMEOUT, attempt)
        .await
        .map_err(|_| {
            AppError::Db(format!(
                "connection timed out after {}s",
                CONNECT_TIMEOUT.as_secs()
            ))
        })?
}

async fn fetch_server_info(conn: &mut Conn) -> Result<ServerInfo> {
    let version = query_single_scalar(conn, "SELECT VERSION()")
        .await?
        .unwrap_or_default();

    let product = if version.contains("MariaDB") {
        "MariaDB".to_string()
    } else {
        "MySQL".to_string()
    };

    // Best effort; some hardened servers restrict @@variables.
    let comment = query_single_scalar(conn, "SELECT @@version_comment")
        .await
        .ok()
        .flatten()
        .filter(|c| !c.is_empty());

    Ok(ServerInfo {
        product,
        version: match comment {
            Some(comment) => format!("{version} ({comment})"),
            None => version,
        },
        dialect: SqlDialect::Mysql,
        connected_at: Utc::now(),
    })
}

/// Run a fixed (no user input) SQL statement and take the first cell of the
/// first row, if any.
async fn query_single_scalar(
    conn: &mut Conn,
    sql: &str,
) -> Result<Option<String>> {
    let rows = run_query(conn, sql, Params::Positional(Vec::new())).await?;
    match rows.first() {
        Some(row) => col_opt_string(row, 0),
        None => Ok(None),
    }
}

/// Execute with positional bind params; collects (and drops) the first
/// result set so the connection is immediately reusable.
async fn run_query(conn: &mut Conn, sql: &str, params: Params) -> Result<Vec<Row>> {
    Ok(conn
        .exec_iter(sql, params)
        .await?
        .collect_and_drop::<Row>()
        .await?)
}

// ---------------------------------------------------------------------------
// Row extraction helpers — panic-free wrappers over `Row::get_opt`.
// ---------------------------------------------------------------------------

fn missing_column(idx: usize) -> AppError {
    AppError::Db(format!("result set is missing column {idx}"))
}

/// Non-NULL string column.
fn col_string(row: &Row, idx: usize) -> Result<String> {
    col_opt_string(row, idx)?.ok_or_else(|| missing_column(idx))
}

/// Nullable string column.
fn col_opt_string(row: &Row, idx: usize) -> Result<Option<String>> {
    row.get_opt::<Option<String>, usize>(idx)
        .ok_or_else(|| missing_column(idx))?
        .map_err(|e| AppError::Db(format!("column {idx}: {e}")))
}

/// Nullable unsigned integer column.
fn col_opt_u64(row: &Row, idx: usize) -> Result<Option<u64>> {
    row.get_opt::<Option<u64>, usize>(idx)
        .ok_or_else(|| missing_column(idx))?
        .map_err(|e| AppError::Db(format!("column {idx}: {e}")))
}

fn table_kind_from_mysql_type(table_type: &str) -> TableKind {
    match table_type {
        "VIEW" => TableKind::View,
        "SYSTEM VIEW" | "SYSTEM TABLE" => TableKind::SystemTable,
        _ => TableKind::Table,
    }
}

// ---------------------------------------------------------------------------
// Result-set → RowValue conversion
// ---------------------------------------------------------------------------

/// The MySQL binary charset id (63) marks BLOB/BINARY/BIT/GEOMETRY payloads.
const CHARSET_BINARY: u16 = 63;

/// Decide whether raw `Value::Bytes` for a column is binary or text.
fn is_binary_column(col: &Column) -> bool {
    if col.character_set() == CHARSET_BINARY {
        // JSON columns also report the binary charset but are always text.
        return col.column_type() != ColumnType::MYSQL_TYPE_JSON;
    }
    matches!(
        col.column_type(),
        ColumnType::MYSQL_TYPE_GEOMETRY | ColumnType::MYSQL_TYPE_VECTOR
    )
}

/// Convert one driver cell into the wire [`RowValue`], using column metadata
/// to disambiguate bytes/text and date vs. datetime.
fn to_row_value(col: &Column, value: Value) -> RowValue {
    let date_string = |(y, mo, d, h, mi, s, us): (u16, u8, u8, u8, u8, u8, u32)| {
        let base = format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}");
        if us > 0 {
            format!("{base}.{us:06}")
        } else {
            base
        }
    };

    match value {
        Value::NULL => RowValue::Null,
        Value::Int(v) => RowValue::Int(v),
        Value::UInt(v) => RowValue::UInt(v),
        Value::Float(v) => RowValue::Float(v as f64),
        Value::Double(v) => RowValue::Float(v),
        Value::Bytes(bytes) => {
            if is_binary_column(col) {
                RowValue::Bytes(bytes)
            } else {
                RowValue::Str(String::from_utf8_lossy(&bytes).into_owned())
            }
        }
        Value::Date(y, mo, d, h, mi, s, us) => {
            let text = date_string((y, mo, d, h, mi, s, us));
            match col.column_type() {
                ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => {
                    RowValue::Date(text)
                }
                _ => RowValue::Datetime(text),
            }
        }
        Value::Time(neg, days, h, m, s, us) => {
            let sign = if neg { "-" } else { "" };
            let base = format!("{sign}{days}d {h:02}:{m:02}:{s:02}");
            RowValue::Time(if us > 0 { format!("{base}.{us:06}") } else { base })
        }
    }
}

/// Convert a whole result row; consumes the row into raw values.
fn convert_row(row: Row) -> Result<Vec<RowValue>> {
    let cols = row.columns();
    let values = row.unwrap();
    if cols.len() != values.len() {
        return Err(AppError::Db(format!(
            "result set arity mismatch: {} columns, {} values",
            cols.len(),
            values.len()
        )));
    }
    Ok(cols
        .iter()
        .zip(values)
        .map(|(col, val)| to_row_value(col, val))
        .collect())
}

// ---------------------------------------------------------------------------
// Script execution (Phase 3 query editor)
// ---------------------------------------------------------------------------

/// Per-result-set fetch ceiling. Rows beyond the cap are still drained from
/// the wire (keeping the connection in sync) but discarded; the outcome is
/// flagged `truncated` so the UI can say so.
const MAX_SCRIPT_RESULT_ROWS: usize = 100_000;

/// Max bytes per character for a handful of common charsets, used only to
/// render friendly `varchar(N)` lengths on result columns. Everything not
/// listed is treated as single-byte.
fn charset_max_len(character_set: u16) -> u32 {
    match character_set {
        33 => 3,                      // utf8mb3 / utf8_general_ci
        45 | 46 | 224 | 255 => 4,     // utf8mb4 family
        _ => 1,
    }
}

/// Wire metadata → display type string in the spirit of information_schema's
/// `COLUMN_TYPE` (`bigint unsigned`, `varchar(64)`, `decimal(10,2)`, ...).
/// The data grid keys its numeric/temporal formatting off these names.
fn result_type_string(col: &Column) -> String {
    let unsigned = col.flags().contains(ColumnFlags::UNSIGNED_FLAG);
    let signed = |base: &str| {
        if unsigned {
            format!("{base} unsigned")
        } else {
            base.to_string()
        }
    };
    let len = col.column_length();
    let chars = || (len / charset_max_len(col.character_set())).max(1);

    match col.column_type() {
        ColumnType::MYSQL_TYPE_TINY => signed("tinyint"),
        ColumnType::MYSQL_TYPE_SHORT => signed("smallint"),
        ColumnType::MYSQL_TYPE_INT24 => signed("mediumint"),
        ColumnType::MYSQL_TYPE_LONG => signed("int"),
        ColumnType::MYSQL_TYPE_LONGLONG => signed("bigint"),
        ColumnType::MYSQL_TYPE_YEAR => "year".into(),
        ColumnType::MYSQL_TYPE_BIT => format!("bit({len})"),
        ColumnType::MYSQL_TYPE_DECIMAL | ColumnType::MYSQL_TYPE_NEWDECIMAL => {
            signed(&format!("decimal({}, {})", len.max(1), col.decimals()))
        }
        ColumnType::MYSQL_TYPE_FLOAT => "float".into(),
        ColumnType::MYSQL_TYPE_DOUBLE => "double".into(),
        ColumnType::MYSQL_TYPE_VARCHAR | ColumnType::MYSQL_TYPE_VAR_STRING => {
            format!("varchar({})", chars())
        }
        ColumnType::MYSQL_TYPE_STRING => format!("char({})", chars()),
        // One wire type covers all text/blob sizes; length + charset pick the name.
        ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB => {
            let prefix = if len <= 255 {
                "tiny"
            } else if len <= 65_535 {
                ""
            } else if len <= 16_777_215 {
                "medium"
            } else {
                "long"
            };
            if col.character_set() == CHARSET_BINARY {
                format!("{prefix}blob")
            } else {
                format!("{prefix}text")
            }
        }
        ColumnType::MYSQL_TYPE_DATE | ColumnType::MYSQL_TYPE_NEWDATE => "date".into(),
        ColumnType::MYSQL_TYPE_TIME => "time".into(),
        ColumnType::MYSQL_TYPE_DATETIME => "datetime".into(),
        ColumnType::MYSQL_TYPE_TIMESTAMP => "timestamp".into(),
        ColumnType::MYSQL_TYPE_JSON => "json".into(),
        ColumnType::MYSQL_TYPE_ENUM => "enum".into(),
        ColumnType::MYSQL_TYPE_SET => "set".into(),
        ColumnType::MYSQL_TYPE_GEOMETRY => "geometry".into(),
        ColumnType::MYSQL_TYPE_VECTOR => "vector".into(),
        ColumnType::MYSQL_TYPE_NULL => "null".into(),
        other => format!("{other:?}").to_lowercase(),
    }
}

/// Wire column → slim result-column DTO.
fn result_column_meta(col: &Column) -> ResultColumnMeta {
    ResultColumnMeta {
        name: col.name_str().into_owned(),
        data_type: result_type_string(col),
    }
}

/// Single-line snippet of a failed statement for error reporting.
fn sql_snippet(sql: &str) -> String {
    let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(120).collect();
    if flat.chars().count() > 120 {
        out.push('…');
    }
    out
}

/// Server info string ("Rows matched: ... Changed: ...") when present.
fn server_info_text(result: &mysql_async::QueryResult<'_, '_, mysql_async::TextProtocol>) -> Option<String> {
    let info = result.info();
    (!info.trim().is_empty()).then(|| info.into_owned())
}

// ---------------------------------------------------------------------------
// Streaming row reads (Phase 5 export)
// ---------------------------------------------------------------------------

/// Upper bound on one streamed export chunk; keeps peak memory tiny no
/// matter what the caller asks for.
const MAX_STREAM_CHUNK: usize = 10_000;

/// Pull rows from an already-open result set and push them through `tx` in
/// batches of at most `chunk_size`. Only one batch is ever buffered. When
/// the consumer drops its receiver the send fails and fetching stops early
/// (that is how exports cancel); rows already sent are reported in the
/// return value.
async fn stream_open_result(
    mut result: mysql_async::QueryResult<'_, '_, mysql_async::TextProtocol>,
    chunk_size: usize,
    tx: tokio::sync::mpsc::Sender<crate::error::Result<RowsChunk>>,
) -> Result<u64> {
    use crate::connections::traits::send_chunk;

    let columns_meta: Vec<ResultColumnMeta> =
        result.columns_ref().iter().map(result_column_meta).collect();
    let cap = chunk_size.clamp(1, MAX_STREAM_CHUNK);
    let mut total = 0u64;
    let mut buffer: Vec<Vec<RowValue>> = Vec::with_capacity(cap);

    loop {
        match result.next().await {
            Ok(None) => break,
            Ok(Some(row)) => {
                buffer.push(convert_row(row)?);
                if buffer.len() >= cap {
                    total += buffer.len() as u64;
                    let rows = std::mem::take(&mut buffer);
                    if !send_chunk(&tx, &columns_meta, rows).await {
                        return Ok(total);
                    }
                }
            }
            Err(err) => return Err(err.into()),
        }
    }

    if !buffer.is_empty() {
        total += buffer.len() as u64;
        // Consumer gone mid-tail: still counted, not delivered.
        send_chunk(&tx, &columns_meta, buffer).await;
    }
    Ok(total)
}

#[async_trait]
impl DbConnection for MysqlConnection {
    fn server_label(&self) -> String {
        format!("{} {}", self.server_info.product, self.server_info.version)
    }

    fn server_info(&self) -> ServerInfo {
        self.server_info.clone()
    }

    async fn close(&mut self) {
        // Dropping the conn returns it to the single-slot pool; disconnect
        // then closes the underlying socket (COM_QUIT). Ignore errors — the
        // peer may already be gone.
        drop(self.conn.take());
        if let Some(pool) = self.pool.take() {
            let _ = pool.disconnect().await;
        }
    }

    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>> {
        let rows = run_query(
            self.conn()?,
            "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
             FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME",
            Params::Positional(Vec::new()),
        )
        .await?;

        rows.iter()
            .map(|row| {
                Ok(DatabaseInfo {
                    name: col_string(row, 0)?,
                    charset: col_opt_string(row, 1)?,
                    collation: col_opt_string(row, 2)?,
                })
            })
            .collect()
    }

    async fn list_tables(&mut self, database: &str) -> Result<Vec<TableMeta>> {
        let rows = run_query(
            self.conn()?,
            "SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_ROWS, \
                    DATA_LENGTH + INDEX_LENGTH, TABLE_COMMENT \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
            Params::Positional(vec![database.into()]),
        )
        .await?;

        rows.iter()
            .map(|row| {
                let name = col_string(row, 0)?;
                let kind = table_kind_from_mysql_type(&col_string(row, 1)?);
                Ok(TableMeta {
                    kind,
                    name,
                    engine: col_opt_string(row, 2)?,
                    rows: col_opt_u64(row, 3)?,
                    size_bytes: col_opt_u64(row, 4)?,
                    comment: col_opt_string(row, 5)?,
                })
            })
            .collect()
    }

    async fn describe_table(&mut self, database: &str, table: &str) -> Result<Vec<ColumnMeta>> {
        // The qualified identifier goes through the quoting helper; both
        // schema and table names are bound as values inside the WHERE clause.
        let rows = run_query(
            self.conn()?,
            "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, \
                    COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
             ORDER BY ORDINAL_POSITION",
            Params::Positional(vec![database.into(), table.into()]),
        )
        .await?;

        if rows.is_empty() {
            return Err(AppError::Db(format!(
                "table {} not found",
                quote_qualified(&[database, table])
            )));
        }

        rows.iter()
            .map(|row| {
                Ok(ColumnMeta {
                    name: col_string(row, 0)?,
                    data_type: col_string(row, 1)?,
                    nullable: col_string(row, 2)?.eq_ignore_ascii_case("YES"),
                    key: col_opt_string(row, 3)?.filter(|k| !k.is_empty()),
                    default_value: col_opt_string(row, 4)?,
                    extra: col_opt_string(row, 5)?.filter(|e| !e.is_empty()),
                    comment: col_opt_string(row, 6)?.filter(|c| !c.is_empty()),
                })
            })
            .collect()
    }

    async fn query_page(&mut self, req: &QueryPageRequest) -> Result<QueryPageResult> {
        let started = std::time::Instant::now();

        // Schema first: every identifier in the SQL below is validated
        // against this description before being quoted into text.
        let columns = self.describe_table(&req.db, &req.table).await?;
        let where_clause =
            build_where_clause_and(SqlDialect::Mysql, &columns, &req.filters)?;
        let order_clause = build_order_by_clause(SqlDialect::Mysql, &columns, &req.order_by)?;
        let table_q = qualify_table(&req.db, &req.table);

        let total_rows_estimate = self.table_row_estimate(&req.db, &req.table).await?;

        // Fetch one extra row to learn whether another page exists.
        let page_size = req.page_size.clamp(1, MAX_PAGE_SIZE);
        let sql = build_page_sql(
            SqlDialect::Mysql,
            &table_q,
            &columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
            &where_clause,
            &order_clause,
            page_size.saturating_add(1),
            req.offset,
        );
        let mut rows = run_query(self.conn()?, &sql, Params::Positional(where_clause.params)).await?;
        let has_more = rows.len() > page_size as usize;
        if has_more {
            rows.truncate(page_size as usize);
        }

        let rows_out = rows.into_iter().map(convert_row).collect::<Result<Vec<_>>>()?;

        Ok(QueryPageResult {
            columns,
            rows: rows_out,
            total_rows_estimate,
            elapsed_ms: started.elapsed().as_millis() as u64,
            has_more,
        })
    }

    async fn apply_changes(&mut self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult> {
        let started = std::time::Instant::now();
        if req.changes.is_empty() {
            return Ok(ApplyChangesResult {
                applied: 0,
                failed: 0,
                errors: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let columns = self.describe_table(&req.db, &req.table).await?;
        let table_q = qualify_table(&req.db, &req.table);

        // Build everything up front; a malformed change becomes a per-row
        // error instead of aborting the batch.
        let mut built: Vec<(usize, crate::connections::sql::BuiltSql)> = Vec::new();
        let mut errors: Vec<RowError> = Vec::new();
        for (index, change) in req.changes.iter().enumerate() {
            match build_change_sql(SqlDialect::Mysql, &table_q, &columns, change) {
                Ok(stmt) => built.push((index, stmt)),
                Err(err) => errors.push(RowError { index, message: err.to_string() }),
            }
        }
        let failed_in_build = errors.len();

        let transactional = match self.table_engine(&req.db, &req.table).await? {
            Some(engine) => TRANSACTIONAL_ENGINES.contains(&engine.to_ascii_uppercase().as_str()),
            None => false, // views etc. — no engine row to consult
        };

        let (mut applied, mut failed) = (0u32, failed_in_build as u32);
        if transactional {
            // One atomic batch; statement-level failures roll back only their
            // own statement and are collected like any other row error.
            let mut tx = self.conn()?.start_transaction(TxOpts::default()).await?;
            for (index, stmt) in &built {
                match tx.exec_drop(stmt.sql.as_str(), Params::Positional(stmt.params.clone())).await {
                    Ok(()) => applied += 1,
                    Err(err) => {
                        failed += 1;
                        errors.push(RowError { index: *index, message: err.to_string() });
                    }
                }
            }
            tx.commit().await?;
        } else {
            for (index, stmt) in &built {
                match self
                    .conn()?
                    .exec_drop(stmt.sql.as_str(), Params::Positional(stmt.params.clone()))
                    .await
                {
                    Ok(()) => applied += 1,
                    Err(err) => {
                        failed += 1;
                        errors.push(RowError { index: *index, message: err.to_string() });
                    }
                }
            }
        }

        Ok(ApplyChangesResult {
            applied,
            failed,
            errors,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn count_rows(
        &mut self,
        database: &str,
        table: &str,
        filter: Option<&FilterSpec>,
    ) -> Result<Option<u64>> {
        let columns = self.describe_table(database, table).await?;
        let where_clause = build_where_clause(SqlDialect::Mysql, &columns, filter)?;
        let sql = format!(
            "SELECT COUNT(*) FROM {}{}",
            qualify_table(database, table),
            where_clause.sql
        );
        let rows = run_query(
            self.conn()?,
            &sql,
            Params::Positional(where_clause.params),
        )
        .await?;
        let Some(row) = rows.into_iter().next() else {
            return Ok(None);
        };
        let values = row.unwrap();
        Ok(match values.first() {
            Some(Value::UInt(v)) => Some(*v),
            Some(Value::Int(v)) if *v >= 0 => Some(*v as u64),
            Some(Value::Bytes(b)) => String::from_utf8_lossy(b).trim().parse::<u64>().ok(),
            _ => None,
        })
    }

    async fn distinct_values(
        &mut self,
        database: &str,
        table: &str,
        column: &str,
        limit: u32,
        search: Option<&str>,
    ) -> Result<Vec<DistinctValue>> {
        let columns = self.describe_table(database, table).await?;
        let meta = validate_column(&columns, column)?;
        let built = build_distinct_values_sql(
            SqlDialect::Mysql,
            &qualify_table(database, table),
            meta,
            &SqlDialect::Mysql.quote_ident(meta.name.as_str()),
            "COUNT(*)",
            search,
            limit,
        );
        let rows = run_query(self.conn()?, &built.sql, Params::Positional(built.params)).await?;
        rows.into_iter()
            .map(|row| {
                let values = convert_row(row)?;
                let count = match values.get(1) {
                    Some(RowValue::UInt(n)) => *n,
                    Some(RowValue::Int(n)) if *n >= 0 => *n as u64,
                    _ => 0,
                };
                Ok(DistinctValue {
                    value: values.first().cloned().unwrap_or(RowValue::Null),
                    count,
                })
            })
            .collect()
    }

    /// Execute a single statement without client-side splitting (object
    /// editors rely on compound-statement bodies reaching the server whole).
    async fn execute(&mut self, sql: &str) -> Result<ExecResult> {
        self.execute_single(sql).await
    }

    async fn run_script(&mut self, sql: &str, stop_on_error: bool) -> Result<Vec<QueryOutcome>> {
        let mut outcomes: Vec<QueryOutcome> = Vec::new();

        for stmt in split_statements(sql) {            let started = std::time::Instant::now();
            let snippet = sql_snippet(&stmt);

            match self.conn()?.query_iter(stmt.as_str()).await {
                Err(err) => {
                    outcomes.push(QueryOutcome::Error {
                        message: err.to_string(),
                        sql_snippet: snippet,
                    });
                    if stop_on_error {
                        break;
                    }
                }
                Ok(mut result) => {
                    // Consume every result set this statement produces
                    // (procedures can yield several). `next()` transparently
                    // advances past a result-set boundary.
                    let mut failed: Option<String> = None;
                    while failed.is_none() && !result.is_empty() {
                        let columns: Vec<ResultColumnMeta> =
                            result.columns_ref().iter().map(result_column_meta).collect();

                        if columns.is_empty() {
                            // OK-packet-only set (DDL/DML/...).
                            outcomes.push(QueryOutcome::Exec {
                                affected: result.affected_rows(),
                                last_insert_id: result.last_insert_id(),
                                info: server_info_text(&result),
                                elapsed_ms: started.elapsed().as_millis() as u64,
                            });
                            match result.next().await {
                                Ok(Some(_)) => {} // unexpected rows — keep draining next loop pass
                                Ok(None) => {}
                                Err(err) => failed = Some(err.to_string()),
                            }
                        } else {
                            // Full fetch with a hard cap; over-cap rows are
                            // drained but discarded so the wire stays in sync.
                            let mut rows: Vec<Vec<RowValue>> = Vec::new();
                            let mut truncated = false;
                            loop {
                                match result.next().await {
                                    Ok(None) => break,
                                    Ok(Some(row)) => {
                                        if rows.len() >= MAX_SCRIPT_RESULT_ROWS {
                                            truncated = true;
                                            continue;
                                        }
                                        match convert_row(row) {
                                            Ok(values) => rows.push(values),
                                            Err(err) => {
                                                failed = Some(err.to_string());
                                                break;
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        failed = Some(err.to_string());
                                        break;
                                    }
                                }
                            }
                            if failed.is_none() {
                                outcomes.push(QueryOutcome::ResultSet {
                                    columns,
                                    rows,
                                    elapsed_ms: started.elapsed().as_millis() as u64,
                                    truncated,
                                    sql: Some(stmt.clone()),
                                });
                            }
                        }
                    }

                    if let Some(message) = failed {
                        // Best-effort drain of any remaining result sets so
                        // the connection is reusable for the next statement.
                        let _ = result.drop_result().await;
                        outcomes.push(QueryOutcome::Error { message, sql_snippet: snippet });
                        if stop_on_error {
                            break;
                        }
                    }
                }
            }
        }

        Ok(outcomes)
    }

    // -----------------------------------------------------------------------
    // Object management (Phase 4)
    // -----------------------------------------------------------------------

    async fn get_table_ddl(&mut self, database: &str, table: &str) -> Result<TableDdl> {
        let qualified = quote_qualified(&[database, table]);
        let create_sql = self.show_create(&format!("SHOW CREATE TABLE {qualified}"), 1).await?;
        let parsed = crate::connections::ddl_parse::parse_create_table(&create_sql)?;
        Ok(TableDdl {
            db: database.to_string(),
            table: parsed.table,
            columns: parsed.columns,
            indexes: parsed.indexes,
            foreign_keys: parsed.foreign_keys,
            options: parsed.options,
            checks: parsed.checks,
            create_sql,
        })
    }

    async fn list_routines(&mut self, database: &str) -> Result<Vec<RoutineMeta>> {
        let rows = run_query(
            self.conn()?,
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, ROUTINE_COMMENT, DEFINER, CREATED, DTD_IDENTIFIER \
             FROM information_schema.ROUTINES \
             WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
            Params::Positional(vec![database.into()]),
        )
        .await?;

        // Parameter summaries come from a second view; keyed by routine name.
        let mut params_by_name: std::collections::HashMap<String, Vec<(String, String, String)>> =
            std::collections::HashMap::new();
        let param_rows = run_query(
            self.conn()?,
            "SELECT SPECIFIC_NAME, ORDINAL_POSITION, PARAMETER_MODE, PARAMETER_NAME, DTD_IDENTIFIER \
             FROM information_schema.PARAMETERS \
             WHERE SPECIFIC_SCHEMA = ? ORDER BY SPECIFIC_NAME, ORDINAL_POSITION",
            Params::Positional(vec![database.into()]),
        )
        .await?;
        for row in &param_rows {
            let name = col_string(row, 0)?;
            let pos: u64 = row.get_opt::<Option<u64>, usize>(1)
                .ok_or_else(|| missing_column(1))?
                .map_err(|e| AppError::Db(format!("column 1: {e}")))?
                .unwrap_or_default();
            let mode = col_opt_string(row, 2)?.unwrap_or_default();
            let pname = col_opt_string(row, 3)?.unwrap_or_default();
            let dtd = col_opt_string(row, 4)?.unwrap_or_default();
            params_by_name
                .entry(name)
                .or_default()
                .push((pos.to_string(), mode, format!("{pname} {dtd}").trim().to_string()));
        }

        rows.iter()
            .map(|row| {
                let name = col_string(row, 0)?;
                let kind = match col_string(row, 1)?.to_ascii_uppercase().as_str() {
                    "FUNCTION" => RoutineKind::Function,
                    _ => RoutineKind::Procedure,
                };
                let comment = col_opt_string(row, 2)?.filter(|c| !c.is_empty());
                let definer = col_opt_string(row, 3)?.filter(|d| !d.is_empty());
                let created = col_opt_string(row, 4)?.filter(|c| !c.is_empty());
                let dtd = col_opt_string(row, 5)?.filter(|d| !d.is_empty());

                let mut parts: Vec<String> = Vec::new();
                let mut returns = None;
                if let Some(list) = params_by_name.get(&name) {
                    for (_, mode, part) in list {
                        if part.is_empty() {
                            continue;
                        }
                        // Ordinal 0 is the RETURN type of functions.
                        if mode.is_empty() {
                            returns = Some(part.clone());
                        } else {
                            parts.push(format!("{} {}", mode, part));
                        }
                    }
                }
                if kind == RoutineKind::Function {
                    if let Some(dtd) = &dtd {
                        returns.get_or_insert_with(|| dtd.clone());
                    }
                }
                let params = (!parts.is_empty())
                    .then(|| format!("({})", parts.join(", ")));

                Ok(RoutineMeta {
                    name,
                    kind,
                    params,
                    returns,
                    comment,
                    definer,
                    created,
                })
            })
            .collect()
    }

    async fn get_routine_ddl(
        &mut self,
        database: &str,
        name: &str,
        kind: RoutineKind,
    ) -> Result<ShowCreateResult> {
        let qualified = quote_qualified(&[database, name]);
        let (stmt, kind, fallback) = match kind {
            RoutineKind::Procedure => (
                format!("SHOW CREATE PROCEDURE {qualified}"),
                ShowCreateKind::Procedure,
                2,
            ),
            RoutineKind::Function => (
                format!("SHOW CREATE FUNCTION {qualified}"),
                ShowCreateKind::Function,
                2,
            ),
        };
        let create_sql = self.show_create(&stmt, fallback).await?;
        Ok(ShowCreateResult {
            db: database.to_string(),
            object: name.to_string(),
            kind,
            create_sql,
        })
    }

    async fn list_triggers(&mut self, database: &str) -> Result<Vec<TriggerMeta>> {
        let rows = run_query(
            self.conn()?,
            "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, \
                     DEFINER, CREATED \
             FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
            Params::Positional(vec![database.into()]),
        )
        .await?;

        rows.iter()
            .map(|row| {
                Ok(TriggerMeta {
                    name: col_string(row, 0)?,
                    timing: col_string(row, 1)?,
                    event: col_string(row, 2)?,
                    table: col_string(row, 3)?,
                    definer: col_opt_string(row, 4)?.filter(|d| !d.is_empty()),
                    created: col_opt_string(row, 5)?.filter(|c| !c.is_empty()),
                })
            })
            .collect()
    }

    async fn get_trigger_ddl(&mut self, database: &str, name: &str) -> Result<ShowCreateResult> {
        let qualified = quote_qualified(&[database, name]);
        let create_sql = self
            .show_create(&format!("SHOW CREATE TRIGGER {qualified}"), 2)
            .await?;
        Ok(ShowCreateResult {
            db: database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::Trigger,
            create_sql,
        })
    }

    async fn get_view_ddl(&mut self, database: &str, name: &str) -> Result<ShowCreateResult> {
        let qualified = quote_qualified(&[database, name]);
        let create_sql = self
            .show_create(&format!("SHOW CREATE VIEW {qualified}"), 1)
            .await?;
        Ok(ShowCreateResult {
            db: database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::View,
            create_sql,
        })
    }

    async fn list_events(&mut self, database: &str) -> Result<Vec<EventMeta>> {
        // Works even with the scheduler disabled; an empty result simply
        // means no events are defined for this schema.
        let rows = run_query(
            self.conn()?,
            "SELECT EVENT_NAME, STATUS, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD, \
                     EXECUTE_AT, ENDS, DEFINER, EVENT_COMMENT \
             FROM information_schema.EVENTS \
             WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME",
            Params::Positional(vec![database.into()]),
        )
        .await?;

        rows.iter()
            .map(|row| {
                let interval_value = col_opt_string(row, 3)?.filter(|v| !v.is_empty());
                let interval_field = col_opt_string(row, 4)?.filter(|v| !v.is_empty());
                let interval = match (interval_value, interval_field) {
                    (Some(v), Some(f)) => Some(format!("{v} {f}")),
                    (Some(v), None) => Some(v),
                    _ => None,
                };
                Ok(EventMeta {
                    name: col_string(row, 0)?,
                    status: col_string(row, 1)?,
                    event_type: col_opt_string(row, 2)?.filter(|t| !t.is_empty()),
                    interval,
                    execute_at: col_opt_string(row, 5)?.filter(|t| !t.is_empty()),
                    ends: col_opt_string(row, 6)?.filter(|t| !t.is_empty()),
                    definer: col_opt_string(row, 7)?.filter(|d| !d.is_empty()),
                    comment: col_opt_string(row, 8)?.filter(|c| !c.is_empty()),
                })
            })
            .collect()
    }

    async fn get_event_ddl(&mut self, database: &str, name: &str) -> Result<ShowCreateResult> {
        let qualified = quote_qualified(&[database, name]);
        let create_sql = self
            .show_create(&format!("SHOW CREATE EVENT {qualified}"), 3)
            .await?;
        Ok(ShowCreateResult {
            db: database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::Event,
            create_sql,
        })
    }

    // -----------------------------------------------------------------------
    // Streaming reads (Phase 5 export)
    // -----------------------------------------------------------------------

    /// Unbuffered `SELECT *` scan: rows stream off the wire in batches and
    /// never accumulate in RAM. Cancels when the consumer hangs up.
    async fn stream_table_rows(
        &mut self,
        database: &str,
        table: &str,
        chunk_size: usize,
        tx: tokio::sync::mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        let sql = format!("SELECT * FROM {}", quote_qualified(&[database, table]));
        self.stream_query_rows(&sql, chunk_size, tx).await
    }

    /// Stream the rows of an arbitrary single SELECT (query-result export).
    async fn stream_query_rows(
        &mut self,
        sql: &str,
        chunk_size: usize,
        tx: tokio::sync::mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        let result = self.conn()?.query_iter(sql).await?;
        stream_open_result(result, chunk_size, tx).await
    }

    /// One multi-row INSERT with positional binds (CSV import batches).
    async fn insert_rows(
        &mut self,
        database: &str,
        table: &str,
        columns: &[String],
        rows: &[Vec<RowValue>],
        ignore: bool,
        upsert_columns: Option<&[String]>,
    ) -> Result<u64> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        let table_q = qualify_table(database, table);
        let sql = crate::connections::sql::build_multirow_insert(
            SqlDialect::Mysql,
            &table_q,
            columns,
            rows.len(),
            ignore,
            upsert_columns,
        );
        let mut params =
            Vec::with_capacity(rows.len() * columns.len());
        for row in rows {
            for value in row {
                params.push(crate::connections::sql::bind_value(value));
            }
        }
        let mut result = self.conn()?.exec_iter(&sql, Params::Positional(params)).await?;
        // INSERTs return no result set; drain defensively so the
        // connection stays reusable either way.
        if !result.columns_ref().is_empty() {
            while result.next().await?.is_some() {}
        }
        Ok(result.affected_rows())
    }

    // -----------------------------------------------------------------------
    // Server tools (Phase 7)
    // -----------------------------------------------------------------------

    async fn list_users(&mut self) -> Result<Vec<UserMeta>> {
        match self.list_users_rich().await {
            Ok(users) => Ok(users),
            // Missing columns (older MariaDB flavors) or missing privileges:
            // degrade to the two-column read, else surface a friendly error.
            Err(rich_err) => match self.list_users_minimal().await {
                Ok(users) if !users.is_empty() => Ok(users),
                Ok(_) => Err(friendly_user_error(rich_err)),
                Err(_) => Err(friendly_user_error(rich_err)),
            },
        }
    }

    async fn show_user_grants(&mut self, user: &str, host: Option<&str>) -> Result<GrantDetail> {
        let account = account_literal(user, host);
        let rows = run_query(
            self.conn()?,
            &format!("SHOW GRANTS FOR {account}"),
            Params::Positional(Vec::new()),
        )
        .await?;
        let raw_statements: Vec<String> = rows
            .iter()
            .map(|row| col_string(row, 0))
            .collect::<Result<Vec<_>>>()?;
        let scopes = server_admin::parse_grant_statements(&raw_statements);
        Ok(GrantDetail {
            raw_statements,
            scopes,
        })
    }

    async fn create_user(&mut self, req: &CreateUserRequest) -> Result<()> {
        validate_account_name(&req.user)?;
        let mut sql = format!("CREATE USER {}", account_literal(&req.user, req.host.as_deref()));
        match (&req.auth_plugin, &req.password) {
            (Some(plugin), Some(pw)) => {
                sql.push_str(&format!(
                    " IDENTIFIED WITH {} BY {}",
                    plugin_ident(plugin)?,
                    server_admin::sql_literal(SqlDialect::Mysql, pw)
                ));
            }
            (Some(plugin), None) => {
                sql.push_str(&format!(" IDENTIFIED WITH {}", plugin_ident(plugin)?));
            }
            (None, Some(pw)) => {
                sql.push_str(&format!(
                    " IDENTIFIED BY {}",
                    server_admin::sql_literal(SqlDialect::Mysql, pw)
                ));
            }
            (None, None) => {}
        }
        self.execute_single(&sql).await.map(|_| ())
    }

    async fn alter_user(
        &mut self,
        user: &str,
        host: Option<&str>,
        req: &AlterUserRequest,
    ) -> Result<()> {
        validate_account_name(user)?;
        let base = account_literal(user, host);
        let mut statements: Vec<String> = Vec::new();

        // MySQL keeps RENAME separate from the option list.
        if let Some(new_name) = req.new_name.as_deref().filter(|n| !n.is_empty()) {
            validate_account_name(new_name)?;
            statements.push(format!(
                "ALTER USER {base} RENAME TO {}",
                account_literal(new_name, host)
            ));
        }

        let mut alter = format!("ALTER USER {base}");
        let mut touched = false;

        if req.auth_plugin.is_some() || req.new_password.is_some() {
            alter.push_str(" IDENTIFIED");
            if let Some(plugin) = &req.auth_plugin {
                alter.push_str(&format!(" WITH {}", plugin_ident(plugin)?));
            }
            if let Some(pw) = &req.new_password {
                alter.push_str(&format!(
                    " BY {}",
                    server_admin::sql_literal(SqlDialect::Mysql, pw)
                ));
            }
            touched = true;
        }

        if !req.limits.is_empty() {
            let limits = &req.limits;
            alter.push_str(" WITH");
            let mut clauses: Vec<String> = Vec::new();
            for (name, value) in [
                ("MAX_QUERIES_PER_HOUR", limits.max_queries_per_hour),
                ("MAX_UPDATES_PER_HOUR", limits.max_updates_per_hour),
                ("MAX_CONNECTIONS", limits.max_connections),
                ("MAX_USER_CONNECTIONS", limits.max_user_connections),
            ] {
                if let Some(v) = value {
                    clauses.push(format!("{name} {}", v.clamp(0, i64::MAX)));
                }
            }
            alter.push(' ');
            alter.push_str(&clauses.join(" "));
            touched = true;
        }

        if let Some(lock) = req.lock {
            alter.push_str(if lock { " ACCOUNT LOCK" } else { " ACCOUNT UNLOCK" });
            touched = true;
        }

        if touched {
            statements.push(alter);
        }
        for stmt in statements {
            self.execute_single(&stmt).await.map(|_| ())?;
        }
        Ok(())
    }

    async fn drop_user(&mut self, user: &str, host: Option<&str>) -> Result<()> {
        validate_account_name(user)?;
        self.execute_single(&format!("DROP USER {}", account_literal(user, host)))
            .await
            .map(|_| ())
    }

    async fn grant_revoke(&mut self, req: &GrantRequest) -> Result<()> {
        validate_account_name(&req.user)?;
        let scope = server_admin::grant_scope_sql(SqlDialect::Mysql, req)?;
        let privs = server_admin::normalized_privileges(&req.privileges).join(", ");
        let account = account_literal(&req.user, req.host.as_deref());
        let sql = if req.revoke {
            let grant_option_for = if req.grant_option { "GRANT OPTION FOR " } else { "" };
            format!("REVOKE {grant_option_for}{privs} ON {scope} FROM {account}")
        } else {
            let with = if req.grant_option { " WITH GRANT OPTION" } else { "" };
            format!("GRANT {privs} ON {scope} TO {account}{with}")
        };
        self.execute_single(&sql).await.map(|_| ())
    }

    async fn list_processes(&mut self) -> Result<Vec<ProcessInfo>> {
        let own = self.own_thread_id().await;

        // SHOW FULL PROCESSLIST first (full Info text); without the PROCESS
        // privilege it still works but only lists our own threads.
        let rows = match run_query(
            self.conn()?,
            "SHOW FULL PROCESSLIST",
            Params::Positional(Vec::new()),
        )
        .await
        {
            Ok(rows) => rows,
            Err(_) => run_query(
                self.conn()?,
                "SELECT Id, User, Host, db, Command, Time, State, Info \
                 FROM information_schema.PROCESSLIST",
                Params::Positional(Vec::new()),
            )
            .await?,
        };

        rows.iter()
            .map(|row| {
                let id = col_opt_u64(row, 0)?.unwrap_or(0);
                Ok(ProcessInfo {
                    id: id.min(i64::MAX as u64) as i64,
                    user: col_string(row, 1)?,
                    host: col_opt_string(row, 2)?.filter(|h| !h.is_empty()),
                    db: col_opt_string(row, 3)?.filter(|d| !d.is_empty()),
                    command: col_opt_string(row, 4)?.filter(|c| !c.is_empty()),
                    time_seconds: col_opt_u64(row, 5)?.unwrap_or(0) as f64,
                    state: col_opt_string(row, 6)?.filter(|s| !s.is_empty()),
                    info: col_opt_string(row, 7)?.filter(|i| !i.is_empty()),
                    wait_event_type: None,
                    wait_event: None,
                    is_own: own == Some(id),
                })
            })
            .collect()
    }

    async fn kill_process(&mut self, process_id: i64, query_only: bool) -> Result<()> {
        let verb = if query_only { "KILL QUERY" } else { "KILL" };
        self.execute_single(&format!("{verb} {process_id}"))
            .await
            .map(|_| ())
    }

    async fn list_variables(&mut self) -> Result<Vec<ServerVariable>> {
        let rows = run_query(
            self.conn()?,
            "SHOW VARIABLES",
            Params::Positional(Vec::new()),
        )
        .await?;
        rows.iter()
            .map(|row| {
                Ok(ServerVariable {
                    name: col_string(row, 0)?,
                    value: col_opt_string(row, 1)?.unwrap_or_default(),
                })
            })
            .collect()
    }

    async fn list_status(&mut self) -> Result<Vec<StatusVariable>> {
        let rows = run_query(
            self.conn()?,
            "SHOW GLOBAL STATUS",
            Params::Positional(Vec::new()),
        )
        .await?;
        rows.iter()
            .map(|row| {
                Ok(StatusVariable {
                    name: col_string(row, 0)?,
                    value: col_opt_string(row, 1)?.unwrap_or_default(),
                })
            })
            .collect()
    }
}

/// `'user'@'host'` account literal. Account parts are quoted as string
/// literals in GRANT/DROP syntax — bind parameters are impossible there, so
/// both halves go through [`server_admin::sql_literal`].
fn account_literal(user: &str, host: Option<&str>) -> String {
    format!(
        "{}@{}",
        server_admin::sql_literal(SqlDialect::Mysql, user),
        server_admin::sql_literal(SqlDialect::Mysql, host.unwrap_or("%"))
    )
}

/// Reject obviously invalid / injection-shaped account names early.
fn validate_account_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(AppError::Db("account name must not be empty".into()));
    }
    Ok(())
}

/// Auth plugin names are identifiers (`caching_sha2_password`); anything
/// beyond identifier characters is refused before it reaches SQL text.
fn plugin_ident(plugin: &str) -> Result<String> {
    let ok = !plugin.is_empty()
        && plugin
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.');
    if ok {
        Ok(plugin.to_string())
    } else {
        Err(AppError::Db(format!("invalid auth plugin name: {plugin}")))
    }
}

/// Privilege failures reading mysql.user become actionable messages.
fn friendly_user_error(err: AppError) -> AppError {
    let msg = err.to_string();
    let lower = msg.to_ascii_lowercase();
    if lower.contains("command denied") || lower.contains("access denied") {
        AppError::Db(format!(
            "Listing users requires SELECT privilege on the mysql.user table ({msg})"
        ))
    } else {
        AppError::Db(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a synthetic wire column (no server needed).
    fn col(column_type: ColumnType, length: u32, charset: u16, flags: ColumnFlags) -> Column {
        mysql_async::Column::new(column_type)
            .with_column_length(length)
            .with_character_set(charset)
            .with_flags(flags)
    }

    #[test]
    fn integer_types_render_with_unsigned_suffix() {
        let signed = col(ColumnType::MYSQL_TYPE_LONGLONG, 20, 63, ColumnFlags::empty());
        assert_eq!(result_type_string(&signed), "bigint");

        let unsigned = col(
            ColumnType::MYSQL_TYPE_LONG,
            10,
            63,
            ColumnFlags::UNSIGNED_FLAG,
        );
        assert_eq!(result_type_string(&unsigned), "int unsigned");
    }

    #[test]
    fn string_types_normalize_length_by_charset() {
        // utf8mb4 reports byte-length on the wire (4 bytes/char).
        let utf8mb4 = col(ColumnType::MYSQL_TYPE_VAR_STRING, 160, 255, ColumnFlags::empty());
        assert_eq!(result_type_string(&utf8mb4), "varchar(40)");

        let latin1 = col(ColumnType::MYSQL_TYPE_STRING, 32, 8, ColumnFlags::empty());
        assert_eq!(result_type_string(&latin1), "char(32)");
    }

    #[test]
    fn blob_family_uses_charset_and_size() {
        let text = col(ColumnType::MYSQL_TYPE_BLOB, 65_535, 33, ColumnFlags::empty());
        assert_eq!(result_type_string(&text), "text");

        let longblob = col(
            ColumnType::MYSQL_TYPE_BLOB,
            u32::MAX,
            63,
            ColumnFlags::BINARY_FLAG,
        );
        assert_eq!(result_type_string(&longblob), "longblob");

        let tinytext = col(ColumnType::MYSQL_TYPE_BLOB, 255, 8, ColumnFlags::empty());
        assert_eq!(result_type_string(&tinytext), "tinytext");
    }

    #[test]
    fn temporal_and_decimal_types_render() {
        let dt = col(ColumnType::MYSQL_TYPE_DATETIME, 19, 63, ColumnFlags::empty());
        assert_eq!(result_type_string(&dt), "datetime");

        let dec = col(ColumnType::MYSQL_TYPE_NEWDECIMAL, 10, 63, ColumnFlags::empty())
            .with_decimals(2);
        assert_eq!(result_type_string(&dec), "decimal(10, 2)");

        let dec_unsigned = col(
            ColumnType::MYSQL_TYPE_NEWDECIMAL,
            10,
            63,
            ColumnFlags::UNSIGNED_FLAG,
        )
        .with_decimals(0);
        assert_eq!(result_type_string(&dec_unsigned), "decimal(10, 0) unsigned");
    }

    #[test]
    fn snippets_are_flattened_and_capped() {
        assert_eq!(sql_snippet("SELECT\n   1"), "SELECT 1");
        let long = "A".repeat(300);
        let snippet = sql_snippet(&long);
        assert_eq!(snippet.chars().count(), 121); // 120 chars + ellipsis
        assert!(snippet.ends_with('…'));
    }
}

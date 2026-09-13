//! Connection lifecycle management.
//!
//! One dedicated tokio task per database session owns its driver
//! (`Box<dyn DbConnection>`) and processes commands arriving over an mpsc
//! channel, replying through oneshots. Execution within a connection is
//! therefore strictly serialized — mirroring Heidi's session model, keeping
//! session variables coherent, and readying query cancellation (`KILL
//! QUERY`) in Phase 3.
//!
//! Each registered connection remembers which SSH tunnel it dials through so
//! both die together on disconnect.
//!
//! Phase 9-B adds supervised resilience inside the same actor:
//! - **Keep-alive**: an independent interval task pings `SELECT 1` through
//!   the actor channel; the loop stops at the first failed ping.
//! - **Silent reconnect**: any command/ping failure whose text classifies as
//!   connection-lost (see [`reconnect`]) triggers up to
//!   [`reconnect::RECONNECT_ATTEMPTS`] silent reconnects (immediate, then
//!   1s/5s/15s backoff), driven by internal [`ConnectionCommand::InternalReconnect`]
//!   messages so all driver access stays serialized in the actor. While the
//!   link is down, user commands fail fast with a clear error; each such
//!   action additionally triggers one fresh reconnect attempt.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::connections::tx::isolation_sql;
use crate::connections::{IsolationLevel, TxLedger, TxMode, TxPhase};
use crate::connections::DbType;
use crate::connections::mysql::MysqlConnection;
use crate::connections::postgres::PgConnection;
use crate::connections::reconnect::{
    effective_keep_alive_sec, is_connection_lost, RECONNECT_ATTEMPTS, RECONNECT_BACKOFF_SECS,
};
use crate::connections::sqlite::SqliteConnection;
use crate::connections::traits::DbConnection;
use crate::connections::{
    AlterUserRequest, ApplyChangesRequest, ApplyChangesResult, ColumnMeta, ConnInfo,
    CreateUserRequest, DatabaseInfo, DistinctValue, EventMeta, ExecResult, FilterSpec,
    FkRefValues, ForeignKeyMeta, GrantDetail, GrantRequest, ProcessInfo, QueryOutcome,
    QueryPageRequest, QueryPageResult, ResolvedConnectionConfig, RowValue, RowsChunk,
    RoutineKind, RoutineMeta, ServerInfo, ServerVariable, ShowCreateResult, StatusVariable,
    TableDdl, TableMeta, TableSchemaData, TriggerMeta, TxState, UserMeta,
};
use crate::connections::sql::build_fk_ref_sql;
use crate::error::{AppError, Result};
use crate::ssh::SshTunnelManager;

/// Backend event carrying link-state transitions for one connection.
pub const CONN_STATUS_EVENT: &str = "connection://status";

/// Backend event carrying a full transaction-ledger snapshot after every
/// ledger change (Transactions UI Phase 1).
pub const TX_STATE_EVENT: &str = "connection://tx";

/// Link-state value carried by [`ConnStatusEvent`]; serialized as the
/// lowercase wire string the frontend expects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConnStatus {
    Reconnecting,
    Reconnected,
    Lost,
}

/// Payload of [`CONN_STATUS_EVENT`]. Mirrors `ConnStatusEvent` in
/// `src/types/ipc.ts`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnStatusEvent {
    pub conn_id: u32,
    pub status: ConnStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Payload of [`TX_STATE_EVENT`]: the whole ledger snapshot plus an optional
/// human-readable note (e.g. "rolled back by disconnect"). Mirrors
/// `TxStateEvent` in `src/types/ipc.ts`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxStateEvent {
    pub conn_id: u32,
    pub state: TxState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Hard ceiling on one keep-alive ping before it counts as a lost link.
const PING_TIMEOUT: Duration = Duration::from_secs(10);

enum ConnectionCommand {
    ListDatabases {
        reply: oneshot::Sender<Result<Vec<DatabaseInfo>>>,
    },
    ListTables {
        database: String,
        reply: oneshot::Sender<Result<Vec<TableMeta>>>,
    },
    DescribeTable {
        database: String,
        table: String,
        reply: oneshot::Sender<Result<Vec<ColumnMeta>>>,
    },
    QueryPage {
        req: QueryPageRequest,
        reply: oneshot::Sender<Result<QueryPageResult>>,
    },
    ClearSchemaCache {
        reply: oneshot::Sender<Result<()>>,
    },
    ApplyChanges {
        req: ApplyChangesRequest,
        reply: oneshot::Sender<Result<ApplyChangesResult>>,
    },
    CountRows {
        database: String,
        table: String,
        filter: Option<FilterSpec>,
        reply: oneshot::Sender<Result<Option<u64>>>,
    },
    // Phase 9-A: quick-filter "More values…" census.
    DistinctValues {
        database: String,
        table: String,
        column: String,
        limit: u32,
        search: Option<String>,
        reply: oneshot::Sender<Result<Vec<DistinctValue>>>,
    },
    RunScript {
        sql: String,
        stop_on_error: bool,
        reply: oneshot::Sender<Result<Vec<QueryOutcome>>>,
    },
    // Phase 4: object metadata + single-statement execution.
    GetTableDdl {
        database: String,
        table: String,
        reply: oneshot::Sender<Result<TableDdl>>,
    },
    ListReferencingFks {
        database: String,
        table: String,
        reply: oneshot::Sender<Result<Vec<ForeignKeyMeta>>>,
    },
    // ER diagram batch loaders (Phase 11): whole-schema columns + FKs.
    ListSchemaColumns {
        database: String,
        reply: oneshot::Sender<Result<Vec<TableSchemaData>>>,
    },
    ListSchemaForeignKeys {
        database: String,
        reply: oneshot::Sender<Result<Vec<ForeignKeyMeta>>>,
    },
    ListRoutines {
        database: String,
        reply: oneshot::Sender<Result<Vec<RoutineMeta>>>,
    },
    GetRoutineDdl {
        database: String,
        name: String,
        kind: RoutineKind,
        reply: oneshot::Sender<Result<ShowCreateResult>>,
    },
    ListTriggers {
        database: String,
        reply: oneshot::Sender<Result<Vec<TriggerMeta>>>,
    },
    GetTriggerDdl {
        database: String,
        name: String,
        reply: oneshot::Sender<Result<ShowCreateResult>>,
    },
    GetViewDdl {
        database: String,
        name: String,
        reply: oneshot::Sender<Result<ShowCreateResult>>,
    },
    ListEvents {
        database: String,
        reply: oneshot::Sender<Result<Vec<EventMeta>>>,
    },
    GetEventDdl {
        database: String,
        name: String,
        reply: oneshot::Sender<Result<ShowCreateResult>>,
    },
    ExecuteSingle {
        sql: String,
        reply: oneshot::Sender<Result<ExecResult>>,
    },
    // Phase 5: streamed reads for the export engine. Results flow through
    // `tx` (including startup errors); there is no separate reply.
    StreamTableRows {
        database: String,
        table: String,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    },
    StreamQueryRows {
        sql: String,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    },
    // Phase 5: bulk insert used by the CSV importer.
    InsertRows {
        database: String,
        table: String,
        columns: Vec<String>,
        rows: Vec<Vec<RowValue>>,
        ignore: bool,
        upsert_columns: Option<Vec<String>>,
        reply: oneshot::Sender<Result<u64>>,
    },
    // Phase 7: server administration tools.
    ListUsers {
        reply: oneshot::Sender<Result<Vec<UserMeta>>>,
    },
    ShowUserGrants {
        user: String,
        host: Option<String>,
        reply: oneshot::Sender<Result<GrantDetail>>,
    },
    CreateUser {
        req: CreateUserRequest,
        reply: oneshot::Sender<Result<()>>,
    },
    AlterUser {
        user: String,
        host: Option<String>,
        req: AlterUserRequest,
        reply: oneshot::Sender<Result<()>>,
    },
    DropUser {
        user: String,
        host: Option<String>,
        reply: oneshot::Sender<Result<()>>,
    },
    GrantRevoke {
        req: GrantRequest,
        reply: oneshot::Sender<Result<()>>,
    },
    ListProcesses {
        reply: oneshot::Sender<Result<Vec<ProcessInfo>>>,
    },
    KillProcess {
        process_id: i64,
        query_only: bool,
        reply: oneshot::Sender<Result<()>>,
    },
    ListVariables {
        reply: oneshot::Sender<Result<Vec<ServerVariable>>>,
    },
    ListStatus {
        reply: oneshot::Sender<Result<Vec<StatusVariable>>>,
    },
    // Phase 9-B: keep-alive probe (`SELECT 1`); sqlite never schedules these.
    Ping {
        reply: oneshot::Sender<Result<ExecResult>>,
    },
    // Transactions UI Phase 1: explicit ledger control.
    TxCommit {
        reply: oneshot::Sender<Result<u64>>,
    },
    TxRollback {
        reply: oneshot::Sender<Result<u64>>,
    },
    TxSetMode {
        mode: TxMode,
        reply: oneshot::Sender<Result<()>>,
    },
    TxSetIsolation {
        level: IsolationLevel,
        reply: oneshot::Sender<Result<()>>,
    },
    TxGetState {
        reply: oneshot::Sender<Result<TxState>>,
    },
    // Phase 9-B: internal reconnect tick sent by the backoff scheduler.
    InternalReconnect,
    Close {
        reply: oneshot::Sender<()>,
    },
}

struct ConnectionHandle {
    cmd_tx: mpsc::Sender<ConnectionCommand>,
    /// Tunnel this connection dials through, if any. Updated after a
    /// successful silent reconnect so disconnect tears down the new tunnel.
    tunnel_id: Option<u32>,
    /// Identity captured at connect time and served to the frontend.
    server_info: ServerInfo,
}

/// Everything the connection actor needs to perform a silent reconnect
/// (Phase 9-B). `None` for SQLite sessions (local file — nothing to redial).
struct ReconnectContext {
    /// Pre-tunnel session parameters captured at connect time.
    config: ResolvedConnectionConfig,
    tunnels: SshTunnelManager,
    /// Shared handle map, so a successful reconnect can repoint `tunnel_id`.
    conns: Arc<Mutex<HashMap<u32, ConnectionHandle>>>,
    conn_id: u32,
}

/// Per-actor supervision state (kept next to the driver inside the task).
struct ActorState {
    conn_id: u32,
    app: Option<AppHandle>,
    cmd_tx: mpsc::Sender<ConnectionCommand>,
    reconnect: Option<ReconnectContext>,
    /// True between the first classified loss and a successful reconnect.
    lost: bool,
    /// Remaining scheduled attempts in the current episode.
    attempts_left: u32,
    /// Transaction ledger (Transactions UI Phase 1).
    tx: TxLedger,
}

impl ActorState {
    /// Emit a full ledger snapshot after a ledger change (best-effort).
    /// `message` annotates special transitions (e.g. rollback by disconnect).
    fn emit_tx(&self, message: Option<String>) {
        if let Some(app) = &self.app {
            let _ = app.emit(
                TX_STATE_EVENT,
                TxStateEvent {
                    conn_id: self.conn_id,
                    state: self.tx.state(),
                    message,
                },
            );
        }
    }

    /// A silent reconnect succeeded: any open transaction was rolled back
    /// server-side when the old link died. Keep mode/isolation, forget work.
    /// Returns the note for the frontend log when something was dropped.
    fn reset_tx_after_reconnect(&mut self) -> Option<String> {
        if self.tx.phase != TxPhase::Idle {
            let note = "open transaction was rolled back by disconnect".to_string();
            self.tx.reset_after_reconnect();
            return Some(note);
        }
        None
    }

    /// Emit a link-state transition to the frontend (best-effort).
    fn emit(&self, status: ConnStatus, message: Option<String>) {
        if let Some(app) = &self.app {
            let _ = app.emit(
                CONN_STATUS_EVENT,
                ConnStatusEvent {
                    conn_id: self.conn_id,
                    status,
                    message,
                },
            );
        }
    }

    /// Classify one command outcome; on the first transport-level failure it
    /// flips the actor into the lost state, announces "reconnecting" and
    /// arms the backoff scheduler. Returns true when classified as lost.
    fn classify<T>(&mut self, result: &Result<T>) -> bool {
        match result {
            Ok(_) => false,
            Err(err) => self.classify_message(&err.to_string()),
        }
    }

    /// Message-only variant for streaming commands whose error is forwarded
    /// through a chunk channel instead of a oneshot reply.
    fn classify_message(&mut self, message: &str) -> bool {
        if !is_connection_lost(message) {
            return false;
        }
        if !self.lost {
            self.lost = true;
            self.attempts_left = RECONNECT_ATTEMPTS;
            self.emit(ConnStatus::Reconnecting, Some(message.to_string()));
            self.schedule_backoff();
        }
        true
    }

    /// Spawn the detached scheduler that pokes [`ConnectionCommand::InternalReconnect`]
    /// into this very actor: immediately, then after each backoff delay.
    /// Stale messages are ignored by a healthy actor, so no cancellation
    /// channel is needed.
    fn schedule_backoff(&self) {
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            for (i, secs) in std::iter::once(0)
                .chain(RECONNECT_BACKOFF_SECS.iter().copied())
                .enumerate()
            {
                if i > 0 {
                    tokio::time::sleep(Duration::from_secs(secs)).await;
                }
                if tx.send(ConnectionCommand::InternalReconnect).await.is_err() {
                    break; // actor gone (closed / manager dropped)
                }
            }
        });
    }

    /// One silent reconnect attempt against the stored session parameters.
    /// Swaps the driver on success and repoints the registered tunnel id.
    async fn attempt(&self, driver: &mut Box<dyn DbConnection>) -> std::result::Result<(), AppError> {
        let ctx = self
            .reconnect
            .as_ref()
            .ok_or_else(|| AppError::Db("no reconnect parameters for this session".into()))?;

        let mut new_tunnel = None;
        let endpoint = match (&ctx.config.ssh, is_network_engine(ctx.config.engine)) {
            (Some(ssh_cfg), true) => {
                let info = ctx
                    .tunnels
                    .open(ssh_cfg.clone(), &ctx.config.host, ctx.config.port)
                    .await?;
                new_tunnel = Some(info.tunnel_id);
                ("127.0.0.1".to_string(), info.local_port)
            }
            _ => (ctx.config.host.clone(), ctx.config.port),
        };

        let resolved = ResolvedConnectionConfig {
            host: endpoint.0,
            port: endpoint.1,
            ..ctx.config.clone()
        };

        match open_driver(&resolved).await {
            Ok(fresh) => {
                let mut old = std::mem::replace(driver, fresh);
                old.close().await;
                // Repoint the registered tunnel so disconnect() closes the
                // replacement instead of the dead original.
                if let Some(id) = new_tunnel {
                    let mut conns = ctx.conns.lock().await;
                    if let Some(handle) = conns.get_mut(&self.conn_id) {
                        handle.tunnel_id = Some(id);
                    }
                }
                Ok(())
            }
            Err(err) => {
                if let Some(id) = new_tunnel {
                    ctx.tunnels.close(id).await;
                }
                Err(err)
            }
        }
    }

    /// Handle an internal reconnect tick. Healthy actors ignore stale ticks;
    /// lost actors try once per tick until the schedule is exhausted, then
    /// announce "lost" and wait for user actions to retry.
    async fn internal_reconnect(&mut self, driver: &mut Box<dyn DbConnection>) {
        if !self.lost || self.reconnect.is_none() {
            return;
        }
        match self.attempt(driver).await {
            Ok(()) => {
                self.lost = false;
                let note = self.reset_tx_after_reconnect();
                self.emit(ConnStatus::Reconnected, None);
                self.emit_tx(note);
            }
            Err(err) => {
                self.attempts_left = self.attempts_left.saturating_sub(1);
                if self.attempts_left == 0 {
                    let message = format!("reconnect failed: {err}");
                    self.emit(ConnStatus::Lost, Some(message));
                }
            }
        }
    }
}

/// Options for [`ConnectionManager::connect`] beyond the resolved config.
#[derive(Debug, Clone, Copy, Default)]
pub struct ConnectOptions {
    /// Keep-alive ping interval in seconds (`None` = unset → Heidi default,
    /// `Some(0)` = off). Ignored for SQLite regardless of value.
    pub keep_alive_sec: Option<u64>,
    /// Initial transaction mode (Transactions Phase 1); `None` = auto.
    pub tx_mode: Option<TxMode>,
    /// Isolation level applied right after connect via a session SET;
    /// `None` = leave the server default untouched.
    pub isolation: Option<IsolationLevel>,
}

/// Open one driver instance for the configured engine. Shared by
/// [`ConnectionManager::connect`] and the `session_test` probe flow.
///
/// SSH tunnels are meaningful for server engines only; callers pass the
/// already-tunneled endpoint via `host`/`port` (`endpoint_of_config` helps).
pub async fn open_driver(config: &ResolvedConnectionConfig) -> Result<Box<dyn DbConnection>> {
    match config.engine {
        DbType::Mysql => Ok(Box::new(MysqlConnection::open(config).await?)),
        DbType::Postgres => Ok(Box::new(PgConnection::open(config).await?)),
        DbType::Sqlite => Ok(Box::new(SqliteConnection::open(config).await?)),
    }
}

/// True when the engine dials a network endpoint (tunnels apply).
pub fn is_network_engine(engine: DbType) -> bool {
    matches!(engine, DbType::Mysql | DbType::Postgres)
}


/// Shared state of [`ConnectionManager`]; the manager is cheaply cloneable
/// (Arc) so supervision tasks can outlive any single command call.
#[derive(Default)]
struct ManagerInner {
    conns: Arc<Mutex<HashMap<u32, ConnectionHandle>>>,
    next_conn_id: AtomicU32,
}

#[derive(Clone, Default)]
pub struct ConnectionManager {
    inner: Arc<ManagerInner>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Open a new connection, routing through an SSH tunnel when configured.
    /// Spawns the keep-alive pinger and arms silent-reconnect parameters
    /// (network engines only).
    pub async fn connect(
        &self,
        app: AppHandle,
        config: ResolvedConnectionConfig,
        tunnels: &SshTunnelManager,
        opts: ConnectOptions,
    ) -> Result<ConnInfo> {
        // Keep the pre-tunnel parameters around for silent reconnects.
        let original = config.clone();

        let mut tunnel_id = None;
        let endpoint = match (&config.ssh, is_network_engine(config.engine)) {
            (Some(ssh_cfg), true) => {
                let info = tunnels
                    .open(ssh_cfg.clone(), &config.host, config.port)
                    .await?;
                tunnel_id = Some(info.tunnel_id);
                ("127.0.0.1".to_string(), info.local_port)
            }
            _ => (config.host.clone(), config.port),
        };

        let resolved = ResolvedConnectionConfig {
            host: endpoint.0,
            port: endpoint.1,
            ..config
        };

        // Any failure past this point must tear the tunnel back down.
        let opened = open_driver(&resolved).await;
        let mut driver = match opened {
            Ok(driver) => driver,
            Err(err) => {
                if let Some(id) = tunnel_id {
                    tunnels.close(id).await;
                }
                return Err(err);
            }
        };
        let server_info = driver.server_info();

        // Apply the session-level isolation level right after connect (next
        // transactions only — safe to issue outside any transaction).
        if let Some(level) = opts.isolation {
            let sql = isolation_sql(resolved.engine, level);
            if let Err(err) = driver.execute(&sql).await {
                if let Some(id) = tunnel_id {
                    tunnels.close(id).await;
                }
                return Err(err);
            }
        }

        let reconnect = is_network_engine(original.engine).then(|| ReconnectContext {
            config: original,
            tunnels: tunnels.clone(),
            conns: Arc::clone(&self.inner.conns),
            conn_id: 0, // patched below once known
        });

        let (cmd_tx, cmd_rx) = mpsc::channel::<ConnectionCommand>(16);
        let conn_id = self.inner.next_conn_id.fetch_add(1, Ordering::Relaxed);

        let actor = ActorState {
            conn_id,
            app: Some(app),
            cmd_tx: cmd_tx.clone(),
            reconnect: reconnect.map(|mut ctx| {
                ctx.conn_id = conn_id;
                ctx
            }),
            lost: false,
            attempts_left: 0,
            tx: TxLedger::new(opts.tx_mode.unwrap_or_default(), opts.isolation),
        };
        tokio::spawn(connection_task(driver, cmd_rx, actor));

        self.inner.conns.lock().await.insert(
            conn_id,
            ConnectionHandle {
                cmd_tx: cmd_tx.clone(),
                tunnel_id,
                server_info: server_info.clone(),
            },
        );

        // Keep-alive ping loop (Phase 9-B): independent task that feeds Ping
        // commands into the serialized actor; sqlite never gets one.
        if let Some(secs) =
            effective_keep_alive_sec(resolved.engine, opts.keep_alive_sec)
        {
            spawn_keep_alive(cmd_tx, Duration::from_secs(secs));
        }

        Ok(ConnInfo {
            conn_id,
            server_info,
        })
    }

    /// Gracefully close a connection (and its tunnel, when present).
    pub async fn disconnect(&self, conn_id: u32, tunnels: &SshTunnelManager) -> Result<()> {
        let handle = self.inner.conns.lock().await.remove(&conn_id);
        match handle {
            Some(handle) => {
                let (reply_tx, reply_rx) = oneshot::channel();
                if handle
                    .cmd_tx
                    .send(ConnectionCommand::Close { reply: reply_tx })
                    .await
                    .is_ok()
                {
                    let _ = reply_rx.await;
                }
                if let Some(tunnel_id) = handle.tunnel_id {
                    tunnels.close(tunnel_id).await;
                }
                Ok(())
            }
            None => Err(AppError::Db(format!("connection #{conn_id} is not open"))),
        }
    }

    pub async fn list_databases(&self, conn_id: u32) -> Result<Vec<DatabaseInfo>> {
        self.request(conn_id, |reply| ConnectionCommand::ListDatabases { reply })
            .await
    }

    pub async fn list_tables(&self, conn_id: u32, database: &str) -> Result<Vec<TableMeta>> {
        let db = database.to_string();
        self.request(conn_id, |reply| ConnectionCommand::ListTables {
            database: db,
            reply,
        })
        .await
    }

    pub async fn describe_table(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnMeta>> {
        let (db, tbl) = (database.to_string(), table.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::DescribeTable {
                database: db,
                table: tbl,
                reply,
            },
        )
        .await
    }

    /// Read one page of table rows through the owning connection task.
    pub async fn query_page(
        &self,
        conn_id: u32,
        req: QueryPageRequest,
    ) -> Result<QueryPageResult> {
        self.request(conn_id, |reply| ConnectionCommand::QueryPage { req, reply })
            .await
    }

    /// Drop the connection's cached column metadata (tree Refresh, after DDL).
    pub async fn clear_schema_cache(&self, conn_id: u32) -> Result<()> {
        self.request(conn_id, |reply| ConnectionCommand::ClearSchemaCache { reply })
            .await
    }

    /// Apply a batch of grid changes through the owning connection task.
    /// In manual transaction mode with an open transaction the actor joins
    /// the statements to the managed transaction instead of an internal
    /// driver-transaction batch (join_tx is computed inside the actor).
    pub async fn apply_changes(
        &self,
        conn_id: u32,
        req: ApplyChangesRequest,
    ) -> Result<ApplyChangesResult> {
        self.request(conn_id, |reply| ConnectionCommand::ApplyChanges { req, reply })
            .await
    }

    /// Exact row count honouring the optional filter.
    pub async fn count_rows(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
        filter: Option<FilterSpec>,
    ) -> Result<Option<u64>> {
        let (db, tbl) = (database.to_string(), table.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::CountRows {
                database: db,
                table: tbl,
                filter,
                reply,
            },
        )
        .await
    }

    /// Distinct-value census of one column (quick-filter "More values…").
    pub async fn distinct_values(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
        column: &str,
        limit: u32,
        search: Option<&str>,
    ) -> Result<Vec<DistinctValue>> {
        let (db, tbl, col) = (
            database.to_string(),
            table.to_string(),
            column.to_string(),
        );
        self.request(
            conn_id,
            move |reply| ConnectionCommand::DistinctValues {
                database: db,
                table: tbl,
                column: col,
                limit,
                search: search.map(|s| s.to_string()),
                reply,
            },
        )
        .await
    }

    /// Top-N rows of a foreign key's referenced table for the grid editor's
    /// value dropdown. Resolves the FK from the parsed DDL, picks a text-ish
    /// display column and streams `limit` rows ordered by the referenced key.
    pub async fn fk_ref_values(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
        fk_name: &str,
        limit: u32,
    ) -> Result<FkRefValues> {
        let dialect = self.server_info(conn_id).await?.dialect;
        let ddl = self.get_table_ddl(conn_id, database, table).await?;
        let fk = ddl
            .foreign_keys
            .iter()
            .find(|f| f.name == fk_name)
            .ok_or_else(|| {
                AppError::Db(format!("no foreign key named {fk_name:?} on {table}"))
            })?
            .clone();

        let ref_db = fk.ref_db.as_deref().unwrap_or(database);
        let ref_meta = self.describe_table(conn_id, ref_db, &fk.ref_table).await?;
        // Referenced columns must exist on the target table.
        for name in &fk.ref_columns {
            crate::connections::sql::validate_column(&ref_meta, name)?;
        }
        let pk_set: std::collections::HashSet<&str> =
            fk.ref_columns.iter().map(|s| s.as_str()).collect();
        let display = ref_meta
            .iter()
            .find(|c| !pk_set.contains(c.name.as_str()) && is_textish_type(&c.data_type))
            .map(|c| c.name.clone());

        let sql = build_fk_ref_sql(
            dialect,
            &dialect.quote_qualified(&[ref_db, fk.ref_table.as_str()]),
            &fk.ref_columns,
            display.as_deref(),
            limit,
        )?;

        // Collect at most `limit` rows through the streaming read; dropping
        // the sender stops the driver mid-scan.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<crate::error::Result<RowsChunk>>(2);
        self.stream_query_rows(conn_id, sql.sql, limit as usize, tx)
            .await?;
        let mut columns = fk.ref_columns.clone();
        if let Some(display) = &display {
            columns.push(display.clone());
        }
        let mut rows: Vec<Vec<RowValue>> = Vec::new();
        while let Some(msg) = rx.recv().await {
            match msg {
                Ok(chunk) => {
                    for row in chunk.rows {
                        if rows.len() >= limit as usize {
                            break;
                        }
                        rows.push(row);
                    }
                    if rows.len() >= limit as usize {
                        break;
                    }
                }
                Err(err) => return Err(err),
            }
        }

        Ok(FkRefValues { columns, rows })
    }

    /// Execute a multi-statement script on the owning connection task. The
    /// whole script runs inside the serialized actor — long scripts delay
    /// other commands on the same session (accepted for Phase 3; query
    /// cancellation is a later phase).
    pub async fn run_script(
        &self,
        conn_id: u32,
        sql: String,
        stop_on_error: bool,
    ) -> Result<Vec<QueryOutcome>> {
        self.request(conn_id, |reply| ConnectionCommand::RunScript {
            sql,
            stop_on_error,
            reply,
        })
        .await
    }

    /// Full table structure (Phase 4 designer).
    pub async fn get_table_ddl(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
    ) -> Result<TableDdl> {
        let (db, tbl) = (database.to_string(), table.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::GetTableDdl {
                database: db,
                table: tbl,
                reply,
            },
        )
        .await
    }

    /// Foreign keys pointing at `database.table` (reverse view; Phase 10-B).
    pub async fn list_referencing_foreign_keys(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyMeta>> {
        let (db, tbl) = (database.to_string(), table.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::ListReferencingFks {
                database: db,
                table: tbl,
                reply,
            },
        )
        .await
    }

    /// Whole-schema column metadata for the ER diagram batch loader.
    pub async fn list_schema_columns(
        &self,
        conn_id: u32,
        database: &str,
    ) -> Result<Vec<TableSchemaData>> {
        let db = database.to_string();
        self.request(conn_id, move |reply| ConnectionCommand::ListSchemaColumns {
            database: db,
            reply,
        })
        .await
    }

    /// Every foreign key of one schema (ER diagram edges).
    pub async fn list_schema_foreign_keys(
        &self,
        conn_id: u32,
        database: &str,
    ) -> Result<Vec<ForeignKeyMeta>> {
        let db = database.to_string();
        self.request(
            conn_id,
            move |reply| ConnectionCommand::ListSchemaForeignKeys {
                database: db,
                reply,
            },
        )
        .await
    }

    pub async fn list_routines(&self, conn_id: u32, database: &str) -> Result<Vec<RoutineMeta>> {
        let db = database.to_string();
        self.request(conn_id, move |reply| ConnectionCommand::ListRoutines {
            database: db,
            reply,
        })
        .await
    }

    pub async fn get_routine_ddl(
        &self,
        conn_id: u32,
        database: &str,
        name: &str,
        kind: RoutineKind,
    ) -> Result<ShowCreateResult> {
        let (db, n) = (database.to_string(), name.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::GetRoutineDdl {
                database: db,
                name: n,
                kind,
                reply,
            },
        )
        .await
    }

    pub async fn list_triggers(&self, conn_id: u32, database: &str) -> Result<Vec<TriggerMeta>> {
        let db = database.to_string();
        self.request(conn_id, move |reply| ConnectionCommand::ListTriggers {
            database: db,
            reply,
        })
        .await
    }

    pub async fn get_trigger_ddl(
        &self,
        conn_id: u32,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let (db, n) = (database.to_string(), name.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::GetTriggerDdl {
                database: db,
                name: n,
                reply,
            },
        )
        .await
    }

    pub async fn get_view_ddl(
        &self,
        conn_id: u32,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let (db, n) = (database.to_string(), name.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::GetViewDdl {
                database: db,
                name: n,
                reply,
            },
        )
        .await
    }

    pub async fn list_events(&self, conn_id: u32, database: &str) -> Result<Vec<EventMeta>> {
        let db = database.to_string();
        self.request(conn_id, move |reply| ConnectionCommand::ListEvents {
            database: db,
            reply,
        })
        .await
    }

    pub async fn get_event_ddl(
        &self,
        conn_id: u32,
        database: &str,
        name: &str,
    ) -> Result<ShowCreateResult> {
        let (db, n) = (database.to_string(), name.to_string());
        self.request(
            conn_id,
            move |reply| ConnectionCommand::GetEventDdl {
                database: db,
                name: n,
                reply,
            },
        )
        .await
    }

    /// Execute one raw statement without client-side splitting — required
    /// for CREATE PROCEDURE/FUNCTION bodies that contain semicolons.
    pub async fn execute_single(&self, conn_id: u32, sql: String) -> Result<ExecResult> {
        self.request(conn_id, |reply| ConnectionCommand::ExecuteSingle { sql, reply })
            .await
    }

    /// Stream every row of a table through `tx` in chunks (Phase 5 export).
    /// Returns once the scan finishes or the consumer drops `tx`. Startup
    /// errors (bad table, dead connection) arrive as an `Err` chunk.
    pub async fn stream_table_rows(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    ) -> Result<()> {
        let (db, tbl) = (database.to_string(), table.to_string());
        let sender = self.sender_for(conn_id).await?;
        sender
            .send(ConnectionCommand::StreamTableRows {
                database: db,
                table: tbl,
                chunk_size,
                tx,
            })
            .await
            .map_err(|_| connection_dropped())
    }

    /// Stream the rows of an arbitrary SELECT through `tx` in chunks.
    pub async fn stream_query_rows(
        &self,
        conn_id: u32,
        sql: String,
        chunk_size: usize,
        tx: mpsc::Sender<Result<RowsChunk>>,
    ) -> Result<()> {
        let sender = self.sender_for(conn_id).await?;
        sender
            .send(ConnectionCommand::StreamQueryRows { sql, chunk_size, tx })
            .await
            .map_err(|_| connection_dropped())
    }

    /// Bulk-insert one batch of rows (CSV import). Returns affected rows.
    #[allow(clippy::too_many_arguments)] // mirrors the SQL insert shape
    pub async fn insert_rows(
        &self,
        conn_id: u32,
        database: &str,
        table: &str,
        columns: Vec<String>,
        rows: Vec<Vec<RowValue>>,
        ignore: bool,
        upsert_columns: Option<Vec<String>>,
    ) -> Result<u64> {
        let (db, tbl) = (database.to_string(), table.to_string());
        self.request(conn_id, move |reply| ConnectionCommand::InsertRows {
            database: db,
            table: tbl,
            columns,
            rows,
            ignore,
            upsert_columns,
            reply,
        })
        .await
    }

    // -----------------------------------------------------------------------
    // Server tools (Phase 7)
    // -----------------------------------------------------------------------

    pub async fn list_users(&self, conn_id: u32) -> Result<Vec<UserMeta>> {
        self.request(conn_id, |reply| ConnectionCommand::ListUsers { reply })
            .await
    }

    pub async fn show_user_grants(
        &self,
        conn_id: u32,
        user: String,
        host: Option<String>,
    ) -> Result<GrantDetail> {
        self.request(conn_id, move |reply| ConnectionCommand::ShowUserGrants {
            user,
            host,
            reply,
        })
        .await
    }

    pub async fn create_user(&self, conn_id: u32, req: CreateUserRequest) -> Result<()> {
        self.request(conn_id, |reply| ConnectionCommand::CreateUser { req, reply })
            .await
    }

    pub async fn alter_user(
        &self,
        conn_id: u32,
        user: String,
        host: Option<String>,
        req: AlterUserRequest,
    ) -> Result<()> {
        self.request(conn_id, move |reply| ConnectionCommand::AlterUser {
            user,
            host,
            req,
            reply,
        })
        .await
    }

    pub async fn drop_user(
        &self,
        conn_id: u32,
        user: String,
        host: Option<String>,
    ) -> Result<()> {
        self.request(conn_id, move |reply| ConnectionCommand::DropUser {
            user,
            host,
            reply,
        })
        .await
    }

    pub async fn grant_revoke(&self, conn_id: u32, req: GrantRequest) -> Result<()> {
        self.request(conn_id, move |reply| ConnectionCommand::GrantRevoke { req, reply })
            .await
    }

    pub async fn list_processes(&self, conn_id: u32) -> Result<Vec<ProcessInfo>> {
        self.request(conn_id, |reply| ConnectionCommand::ListProcesses { reply })
            .await
    }

    pub async fn kill_process(
        &self,
        conn_id: u32,
        process_id: i64,
        query_only: bool,
    ) -> Result<()> {
        self.request(conn_id, move |reply| ConnectionCommand::KillProcess {
            process_id,
            query_only,
            reply,
        })
        .await
    }

    pub async fn list_variables(&self, conn_id: u32) -> Result<Vec<ServerVariable>> {
        self.request(conn_id, |reply| ConnectionCommand::ListVariables { reply })
            .await
    }

    pub async fn list_status(&self, conn_id: u32) -> Result<Vec<StatusVariable>> {
        self.request(conn_id, |reply| ConnectionCommand::ListStatus { reply })
            .await
    }

    // -----------------------------------------------------------------------
    // Transaction ledger (Transactions UI Phase 1)
    // -----------------------------------------------------------------------

    /// Current ledger snapshot. Fails only when the session is unknown.
    pub async fn tx_get_state(&self, conn_id: u32) -> Result<TxState> {
        self.request(conn_id, |reply| ConnectionCommand::TxGetState { reply })
            .await
    }

    /// COMMIT the open transaction. Returns how many entries were cleared.
    pub async fn tx_commit(&self, conn_id: u32) -> Result<u64> {
        self.request(conn_id, |reply| ConnectionCommand::TxCommit { reply })
            .await
    }

    /// ROLLBACK (allowed from Open or Aborted). Returns entries cleared.
    pub async fn tx_rollback(&self, conn_id: u32) -> Result<u64> {
        self.request(conn_id, |reply| ConnectionCommand::TxRollback { reply })
            .await
    }

    /// Switch auto ↔ manual. Refused manual→auto while a tx is open.
    pub async fn tx_set_mode(&self, conn_id: u32, mode: TxMode) -> Result<()> {
        self.request(conn_id, move |reply| {
            ConnectionCommand::TxSetMode { mode, reply }
        })
        .await
    }

    /// Apply a new session isolation level. Refused while a tx is open.
    pub async fn tx_set_isolation(&self, conn_id: u32, level: IsolationLevel) -> Result<()> {
        self.request(conn_id, move |reply| {
            ConnectionCommand::TxSetIsolation { level, reply }
        })
        .await
    }

    /// Send one command and await its typed reply.
    async fn request<R: Send>(
        &self,
        conn_id: u32,
        make_cmd: impl FnOnce(oneshot::Sender<Result<R>>) -> ConnectionCommand,
    ) -> Result<R> {
        let tx = self.sender_for(conn_id).await?;
        let (reply_tx, reply_rx) = oneshot::channel::<Result<R>>();
        tx.send(make_cmd(reply_tx))
            .await
            .map_err(|_| connection_dropped())?;
        reply_rx.await.map_err(|_| connection_dropped())?
    }

    /// Server identity captured when the connection was established.
    pub async fn server_info(&self, conn_id: u32) -> Result<ServerInfo> {
        self.inner
            .conns
            .lock()
            .await
            .get(&conn_id)
            .map(|h| h.server_info.clone())
            .ok_or_else(|| AppError::Db(format!("connection #{conn_id} is not open")))
    }

    /// Clone the command sender for `conn_id`, failing fast when unknown.
    async fn sender_for(&self, conn_id: u32) -> Result<mpsc::Sender<ConnectionCommand>> {
        self.inner
            .conns
            .lock()
            .await
            .get(&conn_id)
            .map(|h| h.cmd_tx.clone())
            .ok_or_else(|| AppError::Db(format!("connection #{conn_id} is not open")))
    }
}

fn connection_dropped() -> AppError {
    AppError::Db("the connection task has terminated".into())
}

/// True for string-like column types (FK dropdown display candidates).
fn is_textish_type(data_type: &str) -> bool {
    let t = data_type.to_ascii_lowercase();
    t.contains("char") || t.contains("text") || t.contains("enum") || t.contains("uuid")
}

/// Keep-alive ping loop (Phase 9-B). Runs OUTSIDE the actor so a hung ping
/// never blocks user traffic beyond the serialized execution itself: it
/// feeds `Ping` commands into the channel every `interval`. The first
/// failed/timed-out ping ends the loop — loss handling, silent reconnect
/// and status emission live inside the actor.
fn spawn_keep_alive(cmd_tx: mpsc::Sender<ConnectionCommand>, interval: Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // interval fires immediately once — skip that one
        loop {
            ticker.tick().await;
            let (reply_tx, reply_rx) = oneshot::channel();
            if cmd_tx
                .send(ConnectionCommand::Ping { reply: reply_tx })
                .await
                .is_err()
            {
                break; // connection closed
            }
            match reply_rx.await {
                Ok(Ok(_)) => {}
                Ok(Err(_)) | Err(_) => break,
            }
        }
    });
}

/// Open the explicit transaction for manual mode before a mutating command.
/// The actor issues the BEGIN itself (NOT via the ledger's classifier) and
/// only when the ledger is idle; returns the failure for fail-fast replies.
async fn ensure_manual_tx_open(
    driver: &mut Box<dyn DbConnection>,
    st: &mut ActorState,
) -> Option<AppError> {
    if !st.tx.needs_begin() {
        return None;
    }
    // Both MySQL/MariaDB and PostgreSQL accept this spelling.
    match driver.execute("START TRANSACTION").await {
        Ok(_) => {
            st.tx.begin();
            st.emit_tx(None);
            None
        }
        Err(err) => Some(err),
    }
}

/// Feed one `run_script` outcome list into the ledger. Consecutive result
/// sets repeating the same statement text come from ONE statement (a
/// procedure CALL yielding several sets) — only the first feeds an entry.
fn feed_outcomes_to_ledger(
    ledger: &mut TxLedger,
    dialect: crate::connections::dialect::SqlDialect,
    outcomes: &[QueryOutcome],
) {
    let mut last_sql: Option<&str> = None;
    let mut last_was_result_set = false;
    for outcome in outcomes {
        match outcome {
            QueryOutcome::ResultSet { sql: Some(sql), rows, .. } => {
                let duplicate =
                    last_was_result_set && last_sql == Some(sql.as_str());
                if !duplicate {
                    ledger.on_statement_ok(dialect, sql, rows.len() as u64);
                }
                last_sql = Some(sql.as_str());
                last_was_result_set = true;
            }
            QueryOutcome::Exec { affected, sql: Some(sql), .. } => {
                ledger.on_statement_ok(dialect, sql, *affected);
                last_sql = Some(sql.as_str());
                last_was_result_set = false;
            }
            QueryOutcome::Error { aborted_tx, .. } => {
                if *aborted_tx {
                    ledger.on_statement_err(dialect);
                }
                last_sql = None;
                last_was_result_set = false;
            }
            _ => {}
        }
    }
}

/// Message-level fallback for 25P02 on paths that return plain `AppError`
/// (single-statement execute / apply-changes): PostgreSQL's driver error
/// text carries the state or message verbatim.
fn message_aborts_tx(message: &str) -> bool {
    message.contains("25P02")
        || message.contains("current transaction is aborted")
}

/// The per-connection actor loop.
///
/// All driver access stays here (serialized). The macro wraps every
/// reply-bearing command with link supervision: while the link is down it
/// tries ONE silent reconnect per incoming command (a user action), and
/// fails the command fast when the link cannot be revived.
async fn connection_task(
    mut driver: Box<dyn DbConnection>,
    mut rx: mpsc::Receiver<ConnectionCommand>,
    mut st: ActorState,
) {
    // One silent reconnect attempt per user action while lost + fail-fast reply.
    macro_rules! ensure_live {
        () => {
            if st.lost && st.reconnect.is_some() {
                if st.attempt(&mut driver).await.is_ok() {
                    st.lost = false;
                    let tx_note = st.reset_tx_after_reconnect();
                    st.emit(ConnStatus::Reconnected, None);
                    st.emit_tx(tx_note);
                }
            }
            if st.lost {
                continue;
            }
        };
    }
    // Execute `$call` (an awaitable producing Result<R>), classify its error
    // and hand it to `$reply`.
    macro_rules! run_cmd {
        ($reply:expr, $call:expr) => {{
            ensure_live!();
            let result = $call.await;
            st.classify(&result);
            let _ = $reply.send(result);
        }};
    }

    while let Some(command) = rx.recv().await {
        match command {
            ConnectionCommand::ListDatabases { reply } => {
                run_cmd!(reply, driver.list_databases());
            }
            ConnectionCommand::ListTables { database, reply } => {
                run_cmd!(reply, driver.list_tables(&database));
            }
            ConnectionCommand::DescribeTable {
                database,
                table,
                reply,
            } => {
                run_cmd!(reply, driver.describe_table(&database, &table));
            }
            ConnectionCommand::QueryPage { req, reply } => {
                run_cmd!(reply, driver.query_page(&req));
            }
            ConnectionCommand::ClearSchemaCache { reply } => {
                run_cmd!(reply, async {
                    driver.clear_schema_cache();
                    Ok(())
                });
            }
            ConnectionCommand::ApplyChanges { req, reply } => {
                ensure_live!();
                let dialect = driver.server_info().dialect;
                if let Some(err) = ensure_manual_tx_open(&mut driver, &mut st).await {
                    st.classify_message(&err.to_string());
                    let _ = reply.send(Err(err));
                    continue;
                }
                // Manual mode + open tx → the batch joins the managed
                // transaction (no internal BEGIN/COMMIT inside the driver).
                let join_tx = st.tx.mode == TxMode::Manual && st.tx.phase == TxPhase::Open;
                let result = driver.apply_changes(&req, join_tx).await;
                st.classify(&result);
                match &result {
                    Ok(res) => {
                        if join_tx && res.applied > 0 {
                            st.tx.record_dml(
                                &format!("APPLY CHANGES {}.{} (batch)", req.db, req.table),
                                res.applied as u64,
                            );
                            st.emit_tx(None);
                        }
                    }
                    Err(err) => {
                        if message_aborts_tx(&err.to_string()) {
                            st.tx.on_statement_err(dialect);
                            st.emit_tx(None);
                        }
                    }
                }
                let _ = reply.send(result);
            }
            ConnectionCommand::CountRows {
                database,
                table,
                filter,
                reply,
            } => {
                run_cmd!(
                    reply,
                    async { driver.count_rows(&database, &table, filter.as_ref()).await }
                );
            }
            ConnectionCommand::DistinctValues {
                database,
                table,
                column,
                limit,
                search,
                reply,
            } => {
                run_cmd!(
                    reply,
                    async {
                        driver
                            .distinct_values(&database, &table, &column, limit, search.as_deref())
                            .await
                    }
                );
            }
            ConnectionCommand::RunScript {
                sql,
                stop_on_error,
                reply,
            } => {
                ensure_live!();
                let dialect = driver.server_info().dialect;
                if let Some(err) = ensure_manual_tx_open(&mut driver, &mut st).await {
                    st.classify_message(&err.to_string());
                    let _ = reply.send(Err(err));
                    continue;
                }
                let result = driver.run_script(&sql, stop_on_error).await;
                st.classify(&result);
                if let Ok(outcomes) = &result {
                    feed_outcomes_to_ledger(&mut st.tx, dialect, outcomes);
                    if !outcomes.is_empty() {
                        st.emit_tx(None);
                    }
                }
                let _ = reply.send(result);
            }
            ConnectionCommand::GetTableDdl {
                database,
                table,
                reply,
            } => {
                run_cmd!(reply, driver.get_table_ddl(&database, &table));
            }
            ConnectionCommand::ListReferencingFks { database, table, reply } => {
                run_cmd!(reply, driver.list_referencing_foreign_keys(&database, &table));
            }
            ConnectionCommand::ListSchemaColumns { database, reply } => {
                run_cmd!(reply, driver.list_schema_columns(&database));
            }
            ConnectionCommand::ListSchemaForeignKeys { database, reply } => {
                run_cmd!(reply, driver.list_schema_foreign_keys(&database));
            }
            ConnectionCommand::ListRoutines { database, reply } => {
                run_cmd!(reply, driver.list_routines(&database));
            }
            ConnectionCommand::GetRoutineDdl {
                database,
                name,
                kind,
                reply,
            } => {
                run_cmd!(reply, driver.get_routine_ddl(&database, &name, kind));
            }
            ConnectionCommand::ListTriggers { database, reply } => {
                run_cmd!(reply, driver.list_triggers(&database));
            }
            ConnectionCommand::GetTriggerDdl {
                database,
                name,
                reply,
            } => {
                run_cmd!(reply, driver.get_trigger_ddl(&database, &name));
            }
            ConnectionCommand::GetViewDdl {
                database,
                name,
                reply,
            } => {
                run_cmd!(reply, driver.get_view_ddl(&database, &name));
            }
            ConnectionCommand::ListEvents { database, reply } => {
                run_cmd!(reply, driver.list_events(&database));
            }
            ConnectionCommand::GetEventDdl {
                database,
                name,
                reply,
            } => {
                run_cmd!(reply, driver.get_event_ddl(&database, &name));
            }
            ConnectionCommand::ExecuteSingle { sql, reply } => {
                // Routed through the trait's `execute` so other drivers hook
                // in; the MySQL driver maps it to `execute_single` semantics.
                ensure_live!();
                let dialect = driver.server_info().dialect;
                if let Some(err) = ensure_manual_tx_open(&mut driver, &mut st).await {
                    st.classify_message(&err.to_string());
                    let _ = reply.send(Err(err));
                    continue;
                }
                let result = driver.execute(&sql).await;
                st.classify(&result);
                match &result {
                    Ok(exec) => {
                        st.tx.on_statement_ok(dialect, &sql, exec.rows_affected);
                        st.emit_tx(None);
                    }
                    Err(err) => {
                        if message_aborts_tx(&err.to_string()) {
                            st.tx.on_statement_err(dialect);
                            st.emit_tx(None);
                        }
                    }
                }
                let _ = reply.send(result);
            }
            ConnectionCommand::StreamTableRows {
                database,
                table,
                chunk_size,
                tx,
            } => {
                ensure_live!();
                if let Err(err) = driver
                    .stream_table_rows(&database, &table, chunk_size, tx.clone())
                    .await
                {
                    st.classify_message(&err.to_string());
                    let _ = tx.send(Err(err)).await;
                }
            }
            ConnectionCommand::StreamQueryRows { sql, chunk_size, tx } => {
                ensure_live!();
                if let Err(err) = driver.stream_query_rows(&sql, chunk_size, tx.clone()).await {
                    st.classify_message(&err.to_string());
                    let _ = tx.send(Err(err)).await;
                }
            }
            ConnectionCommand::InsertRows {
                database,
                table,
                columns,
                rows,
                ignore,
                upsert_columns,
                reply,
            } => {
                ensure_live!();
                let dialect = driver.server_info().dialect;
                if let Some(err) = ensure_manual_tx_open(&mut driver, &mut st).await {
                    st.classify_message(&err.to_string());
                    let _ = reply.send(Err(err));
                    continue;
                }
                let join_tx = st.tx.mode == TxMode::Manual && st.tx.phase == TxPhase::Open;
                let result = async {
                    driver
                        .insert_rows(
                            &database,
                            &table,
                            &columns,
                            &rows,
                            ignore,
                            upsert_columns.as_deref(),
                        )
                        .await
                }
                .await;
                st.classify(&result);
                match &result {
                    Ok(inserted) => {
                        if join_tx && *inserted > 0 {
                            st.tx.record_dml(
                                &format!("INSERT INTO {database}.{table} (batch)"),
                                *inserted,
                            );
                            st.emit_tx(None);
                        }
                    }
                    Err(err) => {
                        if message_aborts_tx(&err.to_string()) {
                            st.tx.on_statement_err(dialect);
                            st.emit_tx(None);
                        }
                    }
                }
                let _ = reply.send(result);
            }
            ConnectionCommand::ListUsers { reply } => {
                run_cmd!(reply, driver.list_users());
            }
            ConnectionCommand::ShowUserGrants { user, host, reply } => {
                run_cmd!(
                    reply,
                    async { driver.show_user_grants(&user, host.as_deref()).await }
                );
            }
            ConnectionCommand::CreateUser { req, reply } => {
                run_cmd!(reply, driver.create_user(&req));
            }
            ConnectionCommand::AlterUser { user, host, req, reply } => {
                run_cmd!(
                    reply,
                    async { driver.alter_user(&user, host.as_deref(), &req).await }
                );
            }
            ConnectionCommand::DropUser { user, host, reply } => {
                run_cmd!(
                    reply,
                    async { driver.drop_user(&user, host.as_deref()).await }
                );
            }
            ConnectionCommand::GrantRevoke { req, reply } => {
                run_cmd!(reply, driver.grant_revoke(&req));
            }
            ConnectionCommand::ListProcesses { reply } => {
                run_cmd!(reply, driver.list_processes());
            }
            ConnectionCommand::KillProcess {
                process_id,
                query_only,
                reply,
            } => {
                run_cmd!(
                    reply,
                    async { driver.kill_process(process_id, query_only).await }
                );
            }
            ConnectionCommand::ListVariables { reply } => {
                run_cmd!(reply, driver.list_variables());
            }
            ConnectionCommand::ListStatus { reply } => {
                run_cmd!(reply, driver.list_status());
            }
            ConnectionCommand::TxCommit { reply } => {
                ensure_live!();
                if st.tx.phase != TxPhase::Open {
                    let _ = reply.send(Err(AppError::Db(
                        "no open transaction to commit".into(),
                    )));
                    continue;
                }
                let result = driver.execute("COMMIT").await;
                st.classify(&result);
                match result {
                    Ok(_) => {
                        let cleared = st.tx.entries.len() as u64;
                        st.tx.clear_after_tcl();
                        st.emit_tx(None);
                        let _ = reply.send(Ok(cleared));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(err));
                    }
                }
            }
            ConnectionCommand::TxRollback { reply } => {
                ensure_live!();
                // Allowed from Open AND Aborted (the only way out of 25P02).
                if st.tx.phase == TxPhase::Idle {
                    let _ = reply.send(Err(AppError::Db(
                        "no open transaction to roll back".into(),
                    )));
                    continue;
                }
                let result = driver.execute("ROLLBACK").await;
                st.classify(&result);
                match result {
                    Ok(_) => {
                        let cleared = st.tx.entries.len() as u64;
                        st.tx.clear_after_tcl();
                        st.emit_tx(None);
                        let _ = reply.send(Ok(cleared));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(err));
                    }
                }
            }
            ConnectionCommand::TxSetMode { mode, reply } => {
                ensure_live!();
                if mode == TxMode::Auto && st.tx.refuses_switch_to_auto() {
                    let _ = reply.send(Err(AppError::Db(
                        "cannot switch to auto-commit while a transaction is open — commit or roll back first".into(),
                    )));
                    continue;
                }
                if st.tx.mode != mode {
                    st.tx.mode = mode;
                    st.emit_tx(None);
                }
                let _ = reply.send(Ok(()));
            }
            ConnectionCommand::TxSetIsolation { level, reply } => {
                ensure_live!();
                if st.tx.phase != TxPhase::Idle {
                    let _ = reply.send(Err(AppError::Db(
                        "cannot change isolation level while a transaction is open".into(),
                    )));
                    continue;
                }
                let dialect = driver.server_info().dialect;
                let sql = isolation_sql(dialect, level);
                let result = driver.execute(&sql).await;
                st.classify(&result);
                match result {
                    Ok(_) => {
                        st.tx.isolation = Some(level);
                        st.emit_tx(None);
                        let _ = reply.send(Ok(()));
                    }
                    Err(err) => {
                        let _ = reply.send(Err(err));
                    }
                }
            }
            ConnectionCommand::TxGetState { reply } => {
                ensure_live!();
                let _ = reply.send(Ok(st.tx.state()));
            }
            ConnectionCommand::Ping { reply } => {
                ensure_live!();
                // Bounded probe: a half-open socket must not stall the actor
                // forever; timing out counts as a classified loss.
                let result =
                    match tokio::time::timeout(PING_TIMEOUT, driver.execute("SELECT 1")).await {
                        Ok(result) => result,
                        Err(_) => Err(AppError::Db("keep-alive ping timed out".into())),
                    };
                st.classify(&result);
                let _ = reply.send(result);
            }
            ConnectionCommand::InternalReconnect => {
                st.internal_reconnect(&mut driver).await;
            }
            ConnectionCommand::Close { reply } => {
                driver.close().await;
                let _ = reply.send(());
                break;
            }
        }
    }
    // Channel closed without an explicit Close (e.g. manager dropped):
    // still release the underlying socket politely.
    driver.close().await;
}

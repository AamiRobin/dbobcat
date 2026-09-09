//! MCP tool surface (Phase 13) — the read-only database tools.
//!
//! Every tool call re-reads sessions + policy from disk (fail-closed, and
//! GUI edits apply without restarting agents), opens a fresh driver, runs,
//! and drops it. Stateless beats fast here: agents tolerate latency, they
//! do not tolerate a stale policy.
//!
//! Trust contract: NO tool reads row data in v1 except `query`, which is
//! classifier-gated and hard-capped. Everything else is metadata.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::connections::manager::open_driver;
use crate::connections::manager::is_network_engine;
use crate::connections::traits::DbConnection;
use crate::connections::RowValue;
use crate::credentials::CredentialStore;
use crate::error::{AppError, Result};
use crate::mcp::policy::{inspect_read_only, McpPolicy, SqlVerdict};
use crate::mcp::schema_context::build_schema_context;
use crate::ssh::SshTunnelManager;

// -- caps (fail-safe budgets, mirrored in docs/MCP.md) ----------------------

/// Maximum rows any tool returns to the agent.
pub const MAX_ROWS: usize = 100;
/// Maximum characters of one cell value sent to the agent.
const MAX_CELL_CHARS: usize = 120;
/// Maximum serialized characters of ONE tool result.
const MAX_RESULT_CHARS: usize = 64_000;

/// Server context: where the app's settings and credential files live.
#[derive(Clone)]
pub struct McpCtx {
    pub data_dir: PathBuf,
}

impl McpCtx {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    fn credentials(&self) -> Result<CredentialStore> {
        CredentialStore::load(self.data_dir.join(crate::credentials::CREDENTIALS_FILE))
    }

    /// Policy is re-read on every call — GUI edits apply immediately.
    pub fn policy(&self) -> McpPolicy {
        McpPolicy::load(&self.data_dir)
    }

    /// Saved sessions from settings.json (`sessions` key). Element-level
    /// tolerance: one malformed session is skipped with a stderr note
    /// instead of bricking agent access to every other session.
    fn sessions(&self) -> Result<Vec<crate::commands::sessions::SavedSession>> {
        let raw = std::fs::read(self.data_dir.join(crate::mcp::policy::SETTINGS_FILE))
            .map_err(|e| AppError::Config(format!("cannot read settings: {e}")))?;
        let doc: Value = serde_json::from_slice(&raw)?;
        let Some(entries) = doc.get("sessions").and_then(Value::as_array) else {
            return Ok(vec![]);
        };
        let mut sessions = Vec::new();
        for entry in entries {
            match serde_json::from_value(entry.clone()) {
                Ok(session) => sessions.push(session),
                Err(e) => {
                    let name = entry.get("name").and_then(Value::as_str).unwrap_or("?");
                    eprintln!("dbobcat mcp: skipping malformed session {name:?}: {e}");
                }
            }
        }
        Ok(sessions)
    }

    /// Resolve `name_or_id` (session name or id) against the allowlist and
    /// open a fresh driver connection. `database` optionally overrides the
    /// session's default database.
    async fn open(
        &self,
        policy: &McpPolicy,
        name_or_id: &str,
        database: Option<&str>,
    ) -> Result<(
        crate::commands::sessions::SavedSession,
        Box<dyn DbConnection>,
    )> {
        let sessions = self.sessions()?;
        let session = sessions
            .iter()
            .find(|s| s.id == name_or_id || s.name == name_or_id)
            .ok_or_else(|| {
                AppError::Config(format!(
                    "unknown connection {name_or_id:?} — call dbobcat_list_connections"
                ))
            })?
            .clone();

        if !policy.permits(&session.id) {
            return Err(AppError::Config(format!(
                "connection {name_or_id:?} is not allowed by the MCP policy (Settings → Agent access)"
            )));
        }

        let mut config =
            crate::commands::sessions::resolve_config(&session, &self.credentials()?, None, None)?;
        if let Some(db) = database {
            config.database = Some(db.to_string());
        }

        // Mirror ConnectionManager::connect's tunnel handling for SSH
        // sessions: dial a localhost forward, then point the driver at it.
        if config.ssh.is_some() && is_network_engine(config.engine) {
            let tunnels = SshTunnelManager::new();
            let ssh_cfg = config.ssh.clone().expect("checked above");
            let info = tunnels.open(ssh_cfg, &config.host, config.port).await?;
            config.host = "127.0.0.1".into();
            config.port = info.local_port;
        }

        let driver = open_driver(&config).await?;
        Ok((session, driver))
    }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

pub fn tool_defs() -> Vec<ToolDef> {
    let conn_param = json!({
        "connection": {
            "type": "string",
            "description": "Connection name or id from dbobcat_list_connections",
        }
    });
    let db_param = json!({
        "database": { "type": "string", "description": "Database name" }
    });
    vec![
        ToolDef {
            name: "dbobcat_list_connections",
            description: "List DBobcat connections the agent may use (id, name, engine, default database). Secrets are never included.",
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDef {
            name: "dbobcat_list_databases",
            description: "List databases of a connection.",
            input_schema: json!({ "type": "object", "properties": { "connection": conn_param["connection"] }, "required": ["connection"] }),
        },
        ToolDef {
            name: "dbobcat_list_tables",
            description: "List tables and views of one database with row-count estimates.",
            input_schema: json!({ "type": "object", "properties": { "connection": conn_param["connection"], "database": db_param["database"] }, "required": ["connection", "database"] }),
        },
        ToolDef {
            name: "dbobcat_describe_table",
            description: "Describe one table: columns with types, nullability, key flags and comments.",
            input_schema: json!({ "type": "object", "properties": { "connection": conn_param["connection"], "database": db_param["database"], "table": { "type": "string" } }, "required": ["connection", "database", "table"] }),
        },
        ToolDef {
            name: "dbobcat_get_schema_context",
            description: "Compact, AI-friendly schema dump of a database (tables, columns, types, foreign keys). Use this before writing SQL.",
            input_schema: json!({ "type": "object", "properties": { "connection": conn_param["connection"], "database": db_param["database"] }, "required": ["connection", "database"] }),
        },
        ToolDef {
            name: "dbobcat_query",
            description: "Run ONE read-only SQL statement (SELECT/WITH/SHOW/EXPLAIN/DESCRIBE). Writes, DDL and multiple statements are rejected. Results are capped at 100 rows.",
            input_schema: json!({ "type": "object", "properties": { "connection": conn_param["connection"], "database": { "type": "string", "description": "Optional database override" }, "sql": { "type": "string" } }, "required": ["connection", "sql"] }),
        },
    ]
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

/// Execute one tool; returns the text content for the MCP result, or an
/// error message (surfaced as `isError: true` per the MCP convention that
/// tool failures are results, not protocol errors).
pub async fn call_tool(ctx: &McpCtx, name: &str, args: &Value) -> std::result::Result<String, String> {
    match call_tool_inner(ctx, name, args).await {
        Ok(text) => Ok(text),
        Err(e) => Err(e.to_string()),
    }
}

async fn call_tool_inner(ctx: &McpCtx, name: &str, args: &Value) -> Result<String> {
    let policy = ctx.policy();
    let arg = |key: &str| -> Option<String> {
        args.get(key).and_then(Value::as_str).map(str::to_string)
    };

    match name {
        "dbobcat_list_connections" => {
            let sessions = ctx.sessions()?;
            let visible: Vec<Value> = sessions
                .iter()
                .filter(|s| policy.permits(&s.id))
                .map(|s| {
                    json!({
                        "id": s.id,
                        "name": s.name,
                        "engine": s.db_type,
                        "database": s.database,
                        "host": if s.use_ssh { None } else { Some(s.host.clone()) },
                    })
                })
                .collect();
            Ok(pretty(&json!({ "connections": visible })))
        }
        "dbobcat_list_databases" => {
            let conn = require_arg(&arg("connection"), "connection")?;
            let (_, mut driver) = ctx.open(&policy, &conn, None).await?;
            let databases = driver.list_databases().await?;
            Ok(pretty(&json!({ "databases": databases })))
        }
        "dbobcat_list_tables" => {
            let conn = require_arg(&arg("connection"), "connection")?;
            let database = require_arg(&arg("database"), "database")?;
            let (_, mut driver) = ctx.open(&policy, &conn, Some(&database)).await?;
            let tables = driver.list_tables(&database).await?;
            Ok(pretty(&json!({ "tables": tables })))
        }
        "dbobcat_describe_table" => {
            let conn = require_arg(&arg("connection"), "connection")?;
            let database = require_arg(&arg("database"), "database")?;
            let table = require_arg(&arg("table"), "table")?;
            let (_, mut driver) = ctx.open(&policy, &conn, Some(&database)).await?;
            let columns = driver.describe_table(&database, &table).await?;
            Ok(pretty(&json!({ "table": table, "columns": columns })))
        }
        "dbobcat_get_schema_context" => {
            let conn = require_arg(&arg("connection"), "connection")?;
            let database = require_arg(&arg("database"), "database")?;
            let (_, mut driver) = ctx.open(&policy, &conn, Some(&database)).await?;
            let dialect = driver.server_info().dialect.wire_name();
            let tables = driver.list_schema_columns(&database).await?;
            let fks = driver.list_schema_foreign_keys(&database).await?;
            Ok(build_schema_context(&database, dialect, &tables, &fks))
        }
        "dbobcat_query" => {
            let conn = require_arg(&arg("connection"), "connection")?;
            let sql = require_arg(&arg("sql"), "sql")?;
            let database = arg("database");

            // Read-only gate BEFORE anything touches a driver.
            if let SqlVerdict::Rejected(reason) = inspect_read_only(&sql) {
                return Err(AppError::Config(format!("rejected: {reason}. \
                    Ask the user to run write statements themselves in DBobcat.")));
            }

            let (_, mut driver) = ctx.open(&policy, &conn, database.as_deref()).await?;
            let outcomes = driver.run_script(&sql, true).await?;

            let mut statements = Vec::new();
            for outcome in outcomes {
                match outcome {
                    crate::connections::QueryOutcome::ResultSet { columns, rows, elapsed_ms, truncated, .. } => {
                        let shown = rows.len().min(MAX_ROWS);
                        let cells: Vec<Vec<Value>> = rows[..shown]
                            .iter()
                            .map(|row| row.iter().map(cell_to_json).collect())
                            .collect();
                        statements.push(json!({
                            "kind": "result_set",
                            "columns": columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
                            "rows": cells,
                            "rowCount": shown,
                            "truncated": truncated || rows.len() > MAX_ROWS,
                            "elapsedMs": elapsed_ms,
                        }));
                    }
                    crate::connections::QueryOutcome::Exec { affected, elapsed_ms, .. } => {
                        statements.push(json!({
                            "kind": "exec", "affected": affected, "elapsedMs": elapsed_ms,
                        }));
                    }
                    crate::connections::QueryOutcome::Error { message, .. } => {
                        statements.push(json!({ "kind": "error", "message": message }));
                    }
                }
            }
            let mut text = pretty(&json!({ "statements": statements }));
            if text.chars().count() > MAX_RESULT_CHARS {
                let cut: String = text.chars().take(MAX_RESULT_CHARS).collect();
                text = format!("{cut}\n…result truncated by DBobcat (row/cell caps apply)");
            }
            Ok(text)
        }
        other => Err(AppError::Config(format!("unknown tool {other:?}"))),
    }
}

fn require_arg(value: &Option<String>, name: &str) -> Result<String> {
    value
        .clone()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Config(format!("missing required argument {name:?}")))
}

fn pretty(v: &Value) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| "{}".into())
}

/// Cell → JSON with the display caps: nulls stay null, binaries are
/// elided, long strings are cut at [`MAX_CELL_CHARS`].
fn cell_to_json(value: &RowValue) -> Value {
    match value {
        RowValue::Null => Value::Null,
        RowValue::Int(v) => json!(v),
        RowValue::UInt(v) => json!(v),
        RowValue::Float(v) => json!(v),
        RowValue::Str(s) => json!(truncate_chars(s)),
        RowValue::Bytes(b) => json!(format!("<binary {} bytes>", b.len())),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => json!(s),
    }
}

fn truncate_chars(s: &str) -> String {
    if s.chars().count() <= MAX_CELL_CHARS {
        return s.to_string();
    }
    let cut: String = s.chars().take(MAX_CELL_CHARS).collect();
    format!("{cut}…")
}

/// True when `path` looks like a usable data directory (settings exist).
pub fn looks_like_data_dir(path: &Path) -> bool {
    path.join(crate::mcp::policy::SETTINGS_FILE).is_file()
}

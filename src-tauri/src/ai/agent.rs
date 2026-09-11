//! AI agent mode (Phase 13): a bounded tool-use loop over the live
//! database, dbx-inspired but built on DBobcat's stricter defaults.
//!
//! Safety model (three layers, all fail-closed):
//! 1. **AST risk classification** — `sql_risk::assess` decides whether a
//!    statement is provably read-only. `Unknown` is never auto-executed.
//! 2. **Confirmation gating** — writes/DDL pause the agent and surface the
//!    exact SQL to the user. The pause happens BEFORE any history mutation,
//!    so a resume run can replay a coherent assistant turn.
//! 3. **Bound grants** — an approval is valid for ONE statement on ONE
//!    connection + database; the grant is re-verified at execution time,
//!    so a stale confirmation can never fire against another target.
//!
//! The conversation is stateless backend-side: the frontend echoes the
//! message history on every run (same philosophy as the MCP server —
//! agents tolerate latency, they do not tolerate stale state).

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::connections::dialect::SqlDialect;
use crate::connections::manager::ConnectionManager;
use crate::connections::{QueryOutcome, RowValue};

use super::sql_risk::{self, SqlAssessment, SqlRisk};
use super::{dialect_label, StreamOutcome};

/// Hard cap on agent turns per run. Conversations can span runs; this
/// bounds one backend invocation only.
pub const MAX_TURNS: u32 = 12;
/// Mirrors the MCP tool caps: tool results must never flood the context.
const MAX_ROWS: usize = 100;
const MAX_CELL_CHARS: usize = 200;
const MAX_TOOL_CONTENT_CHARS: usize = 64_000;

// ---------------------------------------------------------------------------
// Wire types (mirrored in src/types/ipc.ts)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireToolCall {
    pub id: String,
    /// Strict OpenAI-compatible servers require `"type":"function"`; we
    /// always send it. (Serde default keeps echoed payloads compatible.)
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub call_type: Option<String>,
    pub function: WireFunction,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireFunction {
    pub name: String,
    pub arguments: String,
}

/// One OpenAI-format chat message: plain roles carry `content`, assistant
/// tool-use turns carry `tool_calls`, tool results carry `tool_call_id`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WireMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<WireToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl WireMessage {
    pub fn text(role: &str, content: impl Into<String>) -> Self {
        Self {
            role: role.into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: None,
        }
    }

    pub fn assistant_with_tool_calls(calls: Vec<WireToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: None,
            tool_calls: Some(
                calls
                    .into_iter()
                    .map(|mut call| {
                        call.call_type = Some("function".into());
                        call
                    })
                    .collect(),
            ),
            tool_call_id: None,
        }
    }

    pub fn tool_result(call_id: &str, content: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: Some(content.into()),
            tool_calls: None,
            tool_call_id: Some(call_id.to_string()),
        }
    }
}

/// A user-approved write, bound to the exact target it was confirmed for.
///
/// Trust note: the grant is spatially bound (conn + db + SQL) and
/// re-verified at execution, but it is not single-use — a frontend that
/// re-sends the same resume replays the same approved write. That matches
/// the app's trust model (the webview already holds the user's authority
/// to run any statement) and keeps the backend stateless.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WriteGrant {
    pub sql: String,
    pub conn_id: u32,
    pub db: String,
}

/// The write the agent is paused on, awaiting the user's answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingWrite {
    pub call: WireToolCall,
    pub sql: String,
    /// "write" | "ddl" | "unknown" — display label for the dialog.
    pub risk: String,
    /// Target snapshot taken AT PAUSE TIME. The UI must build the grant
    /// from these, never from current props — a connection/database switch
    /// while the dialog is open would otherwise rebind the approval.
    pub conn_id: u32,
    pub db: String,
}

/// Resume payload after the user answered a confirmation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentResume {
    pub approved: bool,
    pub call: WireToolCall,
    /// Required when `approved`; verified against this run's conn/db/sql.
    pub grant: Option<WriteGrant>,
}

/// Per-run request body.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentRunRequest {
    pub messages: Vec<WireMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume: Option<AgentResume>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    Done,
    AwaitingConfirmation,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunResult {
    pub status: AgentStatus,
    /// Final assistant text on `Done`; empty otherwise.
    pub text: String,
    pub messages: Vec<WireMessage>,
    pub pending: Option<PendingWrite>,
    pub turns_used: u32,
}

/// Events streamed to the UI while the loop runs.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentEvent {
    TextDelta { delta: String },
    ToolStart { name: String },
    ToolEnd { name: String, ok: bool, summary: String },
    Notice { message: String },
}

// ---------------------------------------------------------------------------
// Tool schema (OpenAI function-calling format)
// ---------------------------------------------------------------------------

fn tools_json() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_tables",
                "description": "List tables and views in the current database (name and kind).",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "describe_table",
                "description": "Column details for one table: name, type, nullability, primary key, comments.",
                "parameters": {
                    "type": "object",
                    "properties": { "table": { "type": "string" } },
                    "required": ["table"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "execute_query",
                "description": "Run ONE SQL statement on the live database. Read-only statements run immediately; writes and DDL are paused for the user's confirmation. Add LIMIT for exploratory reads.",
                "parameters": {
                    "type": "object",
                    "properties": { "sql": { "type": "string" } },
                    "required": ["sql"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_current_time",
                "description": "Current local and UTC time (useful for date filters).",
                "parameters": { "type": "object", "properties": {}, "required": [] }
            }
        }
    ])
}

/// The system prompt: persona + dialect + live-DB contract + schema block.
pub fn build_system_prompt(dialect: &str, db: &str, schema: Option<&str>) -> String {
    let mut prompt = format!(
        "You are the DBobcat agent, operating on a LIVE {label} database `{db}`.\n\
         Tools are available to inspect the schema and run queries.\n\
         Rules:\n\
         - `execute_query` runs ONE statement on the live database. Read-only \
          statements run automatically; writes and DDL are shown to the user for \
          approval. Never assume approval, and never retry a write the user \
          declined.\n\
         - Keep exploratory reads bounded (add LIMIT). Use list_tables / \
          describe_table instead of guessing table or column names.\n\
         - One statement per execute_query call — no semicolon-stacked batches.\n\
         Final answer: summarize what you did and put the final SQL in a \
         ```sql code block.",
        label = dialect_label(dialect),
        db = db
    );
    if let Some(schema) = schema.filter(|s| !s.trim().is_empty()) {
        prompt.push_str("\n\nSchema reference (metadata only, may be truncated):\n");
        prompt.push_str(schema);
    }
    prompt
}

// ---------------------------------------------------------------------------
// Execution policy (pure — unit tested)
// ---------------------------------------------------------------------------

/// What the policy says about running an `execute_query` call.
#[derive(Debug, PartialEq)]
pub enum Gate {
    /// Classified read-only — run it without asking.
    Run,
    /// Pause and ask the user; carries the exact SQL and a display label.
    Ask { sql: String, risk: String },
}

/// Gate an `execute_query` call. Reads pass; writes/DDL/unknown need a
/// grant that matches sql + connection + database exactly.
pub fn gate_query(
    sql: &str,
    assessment: &SqlAssessment,
    conn_id: u32,
    db: &str,
    grant: Option<&WriteGrant>,
) -> Gate {
    if assessment.is_read_only() {
        return Gate::Run;
    }
    let risk = match assessment.risk {
        SqlRisk::Ddl => "ddl",
        SqlRisk::Write => "write",
        _ => "unknown",
    };
    let approved = grant
        .map(|g| {
            g.conn_id == conn_id && g.db == db && normalize(&g.sql) == normalize(sql)
        })
        .unwrap_or(false);
    if approved {
        Gate::Run
    } else {
        Gate::Ask { sql: sql.to_string(), risk: risk.to_string() }
    }
}

/// Whitespace-insensitive SQL compare so re-sent SQL still validates.
fn normalize(sql: &str) -> String {
    sql.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Extract the SQL argument from raw tool-call arguments.
fn sql_from_args(arguments: &str) -> Option<String> {
    let value: Value = serde_json::from_str(arguments).ok()?;
    value.get("sql")?.as_str().map(str::to_string)
}

/// Extract the SQL argument from an `execute_query` tool call.
pub fn sql_argument(call: &WireToolCall) -> Option<String> {
    sql_from_args(&call.function.arguments)
}

// -{3,}
// Backends (database access) and providers (model access)
// ---------------------------------------------------------------------------

/// Boxed future type keeping the traits object-safe.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Database access the loop needs. Abstract so the loop is testable.
pub trait AgentBackend {
    fn list_tables<'a>(&'a mut self, database: &'a str) -> BoxFuture<'a, crate::error::Result<String>>;
    fn describe_table<'a>(
        &'a mut self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, crate::error::Result<String>>;
    fn run_sql<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, crate::error::Result<String>>;
    /// The connection's CURRENT default database/schema, if the engine has
    /// one. MySQL sessions can `USE` between schemas; verifying before a
    /// confirmed write keeps the grant's `db` binding honest.
    fn live_database<'a>(&'a mut self) -> BoxFuture<'a, crate::error::Result<Option<String>>>;
    fn current_time(&self) -> String;
}

/// Production backend over the live connection actor.
pub struct ManagerBackend<'a> {
    pub manager: &'a ConnectionManager,
    pub conn_id: u32,
    pub db: String,
    pub dialect: SqlDialect,
}

impl AgentBackend for ManagerBackend<'_> {
    fn live_database<'a>(&'a mut self) -> BoxFuture<'a, crate::error::Result<Option<String>>> {
        Box::pin(async move {
            let sql = match self.dialect {
                SqlDialect::Mysql => "SELECT DATABASE()",
                SqlDialect::Postgres => "SELECT current_database()",
                // SQLite sessions are single-file: the label IS the target.
                SqlDialect::Sqlite => return Ok(None),
            };
            let outcomes = self.manager.run_script(self.conn_id, sql.into(), true).await?;
            let live = outcomes.iter().find_map(|outcome| match outcome {
                QueryOutcome::ResultSet { rows, .. } => {
                    rows.first().and_then(|row| row.first()).map(|cell| {
                        crate::export::formatters::cell_text(cell, "")
                    })
                }
                _ => None,
            });
            Ok(live)
        })
    }

    fn list_tables<'a>(&'a mut self, database: &'a str) -> BoxFuture<'a, crate::error::Result<String>> {
        Box::pin(async move {
            let tables = self.manager.list_tables(self.conn_id, database).await?;
            let mut lines: Vec<String> = tables
                .iter()
                .map(|t| {
                    let kind = match t.kind {
                        crate::connections::TableKind::Table => "table",
                        crate::connections::TableKind::View => "view",
                        crate::connections::TableKind::MaterializedView => "materialized view",
                        crate::connections::TableKind::Sequence => "sequence",
                        crate::connections::TableKind::SystemTable => "system table",
                    };
                    format!("{} ({kind})", t.name)
                })
                .collect();
            if lines.len() > 200 {
                lines.truncate(200);
                lines.push("… (truncated)".into());
            }
            Ok(lines.join("\n"))
        })
    }

    fn describe_table<'a>(
        &'a mut self,
        database: &'a str,
        table: &'a str,
    ) -> BoxFuture<'a, crate::error::Result<String>> {
        Box::pin(async move {
            let columns = self.manager.describe_table(self.conn_id, database, table).await?;
            let mut out = String::new();
            for c in &columns {
                out.push_str(&c.name);
                out.push_str(&format!(
                    " {} {}",
                    c.data_type,
                    if c.nullable { "NULL" } else { "NOT NULL" }
                ));
                if c.key.as_deref() == Some("PRI") {
                    out.push_str(" PRIMARY KEY");
                }
                if let Some(comment) = c.comment.as_deref().filter(|s| !s.is_empty()) {
                    out.push_str(&format!(" -- {comment}"));
                }
                out.push('\n');
            }
            Ok(out)
        })
    }

    fn run_sql<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, crate::error::Result<String>> {
        Box::pin(async move {
            let outcomes = self
                .manager
                .run_script(self.conn_id, sql.to_string(), true)
                .await?;
            Ok(format_outcomes(&outcomes))
        })
    }

    fn current_time(&self) -> String {
        chrono::Utc::now().to_rfc3339()
    }
}

/// Compact, capped result text for the model.
fn format_outcomes(outcomes: &[QueryOutcome]) -> String {
    let mut out = String::new();
    for outcome in outcomes {
        match outcome {
            QueryOutcome::ResultSet { columns, rows, truncated, .. } => {
                let header: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
                out.push_str(&header.join(" | "));
                out.push('\n');
                for row in rows.iter().take(MAX_ROWS) {
                    out.push_str(&render_row(row));
                    out.push('\n');
                }
                if rows.len() > MAX_ROWS || *truncated {
                    out.push_str(&format!("… (result capped at {MAX_ROWS} rows)\n"));
                }
            }
            QueryOutcome::Exec { affected, info, .. } => {
                out.push_str(&format!("OK — {affected} row(s) affected"));
                if let Some(info) = info.as_deref().filter(|s| !s.is_empty()) {
                    out.push_str(&format!(" ({info})"));
                }
                out.push('\n');
            }
            QueryOutcome::Error { message, .. } => {
                out.push_str(&format!("ERROR: {message}\n"));
            }
        }
        out.push('\n');
    }
    if out.chars().count() > MAX_TOOL_CONTENT_CHARS {
        return out.chars().take(MAX_TOOL_CONTENT_CHARS).collect::<String>() + "\n… (truncated)";
    }
    out
}

fn render_row(row: &[RowValue]) -> String {
    row.iter()
        .map(|v| {
            let text = crate::export::formatters::cell_text(v, "NULL");
            if text.chars().count() > MAX_CELL_CHARS {
                format!("{}…", text.chars().take(MAX_CELL_CHARS).collect::<String>())
            } else {
                text
            }
        })
        .collect::<Vec<_>>()
        .join(" | ")
}

/// Model access, abstract for scripted tests.
pub trait ChatProvider {
    fn chat<'a>(
        &'a mut self,
        messages: &'a [WireMessage],
        tools: &'a Value,
        max_tokens: u32,
        cancel: &'a std::sync::atomic::AtomicBool,
        on_text: &'a mut (dyn FnMut(&str) + Send),
    ) -> BoxFuture<'a, crate::error::Result<StreamOutcome>>;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

pub struct AgentContext<'a> {
    pub provider: &'a mut (dyn ChatProvider + Send),
    pub backend: &'a mut (dyn AgentBackend + Send),
    pub cancel: &'a std::sync::atomic::AtomicBool,
    pub conn_id: u32,
    pub dialect: &'a str,
    pub db: &'a str,
    pub schema: Option<&'a str>,
    pub on_event: &'a mut (dyn FnMut(AgentEvent) + Send),
}

/// Run the agent loop. Returns the updated conversation plus either a final
/// answer or a pending write awaiting the user's decision.
pub async fn run_agent(
    mut ctx: AgentContext<'_>,
    mut request: AgentRunRequest,
) -> crate::error::Result<AgentRunResult> {
    const MAX_TOKENS: u32 = 2048;
    let tools = tools_json();
    let mut turns_used: u32 = 0;
    // True once the resume turn (confirmed/declined write) has been folded
    // into the history — from that point provider errors must preserve it.
    let mut resume_replayed = false;

    // Resume replay first: execute the paused write per the user's decision
    // (or record the decline) and append a coherent assistant+tool turn.
    if let Some(resume) = request.resume.take() {
        let result_text = replay_resume(&mut ctx, &resume).await;
        let call_id = resume.call.id.clone();
        request
            .messages
            .push(WireMessage::assistant_with_tool_calls(vec![resume.call]));
        request.messages.push(WireMessage::tool_result(&call_id, result_text));
        resume_replayed = true;
    }
    // Insert-or-refresh the system prompt: schema/dialect may have changed
    // since an earlier run, and stale instructions are worse than none.
    let fresh_system =
        WireMessage::text("system", build_system_prompt(ctx.dialect, ctx.db, ctx.schema));
    match request.messages.first_mut() {
        Some(message) if message.role == "system" => *message = fresh_system,
        _ => request.messages.insert(0, fresh_system),
    }

    while turns_used < MAX_TURNS {
        if ctx.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Ok(AgentRunResult {
                status: AgentStatus::Cancelled,
                text: String::new(),
                messages: request.messages,
                pending: None,
                turns_used,
            });
        }
        turns_used += 1;

        // Text deltas stream straight to the UI as agent events.
        let mut on_text = |delta: &str| {
            (ctx.on_event)(AgentEvent::TextDelta { delta: delta.to_string() });
        };
        let outcome = match ctx
            .provider
            .chat(&request.messages, &tools, MAX_TOKENS, ctx.cancel, &mut on_text)
            .await
        {
            Ok(outcome) => outcome,
            // A provider failure AFTER a replayed confirmed write must not
            // discard the enriched history: the model has to learn the
            // write already ran, or it may propose it again (double-apply).
            Err(e) if resume_replayed => {
                (ctx.on_event)(AgentEvent::Notice { message: e.to_string() });
                return Ok(AgentRunResult {
                    status: AgentStatus::Cancelled,
                    text: String::new(),
                    messages: request.messages,
                    pending: None,
                    turns_used,
                });
            }
            Err(e) => return Err(e),
        };

        if outcome.tool_calls.is_empty() {
            request
                .messages
                .push(WireMessage::text("assistant", outcome.text.clone()));
            return Ok(AgentRunResult {
                status: AgentStatus::Done,
                text: outcome.text,
                messages: request.messages,
                pending: None,
                turns_used,
            });
        }

        // Gate every execute_query call BEFORE mutating history: pausing
        // must leave the conversation exactly as it was before the model
        // spoke, so the resume run can append a coherent turn.
        for streamed in &outcome.tool_calls {
            if streamed.name != "execute_query" {
                continue;
            }
            let Some(sql) = sql_from_args(&streamed.arguments) else {
                continue;
            };
            let assessment = sql_risk::assess(&sql, parse_dialect(ctx.dialect));
            if let Gate::Ask { sql, risk } =
                gate_query(&sql, &assessment, ctx.conn_id, ctx.db, None)
            {
                // The pending call is returned in WIRE form (with a stable
                // id) so the resume run can replay it verbatim.
                let index = outcome
                    .tool_calls
                    .iter()
                    .position(|c| std::ptr::eq(c, streamed))
                    .unwrap_or(0);
                let call = WireToolCall {
                    call_type: Some("function".into()),
                    id: if streamed.id.is_empty()
                        || (streamed.id.starts_with("call_")
                            && streamed.id[5..].chars().all(|c| c.is_ascii_digit()))
                    {
                        // Synthetic assembler ids repeat every turn AND
                        // every run (`turns_used` is run-local). The `call_p`
                        // prefix can never collide with `call_t…` ids that
                        // the resume run's own turns mint.
                        format!("call_p{turns_used}_{index}")
                    } else {
                        streamed.id.clone()
                    },
                    function: WireFunction {
                        name: streamed.name.clone(),
                        arguments: streamed.arguments.clone(),
                    },
                };
                return Ok(AgentRunResult {
                    status: AgentStatus::AwaitingConfirmation,
                    text: String::new(),
                    messages: request.messages,
                    pending: Some(PendingWrite {
                        call,
                        sql,
                        risk,
                        conn_id: ctx.conn_id,
                        db: ctx.db.to_string(),
                    }),
                    turns_used,
                });
            }
        }

        // All calls may run: append the assistant turn, then execute.
        // Streamed calls convert to wire calls; some providers omit ids,
        // so synthesize stable ones from the position.
        let calls: Vec<WireToolCall> = outcome
            .tool_calls
            .iter()
            .enumerate()
            .map(|(index, streamed)| {
                // Id-less providers get `call_{position}` from the SSE
                // assembler every turn — re-id those so echoed history
                // never carries duplicate tool-call ids.
                let synthetic = streamed.id.is_empty()
                    || (streamed.id.starts_with("call_")
                        && streamed.id[5..].chars().all(|c| c.is_ascii_digit()));
                let id = if synthetic {
                    format!("call_t{turns_used}_{index}")
                } else {
                    streamed.id.clone()
                };
                WireToolCall {
                    call_type: Some("function".into()),
                    id,
                    function: WireFunction {
                        name: streamed.name.clone(),
                        arguments: streamed.arguments.clone(),
                    },
                }
            })
            .collect();
        let mut assistant = WireMessage::assistant_with_tool_calls(calls.clone());
        if !outcome.text.trim().is_empty() {
            assistant.content = Some(outcome.text.clone());
        }
        request.messages.push(assistant);

        let mut answered: std::collections::HashSet<String> = std::collections::HashSet::new();
        for call in &calls {
            if ctx.cancel.load(std::sync::atomic::Ordering::Relaxed) {
                // Wire contract: EVERY assistant tool_call needs a tool
                // result before the next request, or strict servers 400 on
                // the echoed history.
                for call in &calls {
                    if answered.insert(call.id.clone()) {
                        request.messages.push(WireMessage::tool_result(
                            &call.id,
                            "Cancelled by user — not executed.",
                        ));
                    }
                }
                return Ok(AgentRunResult {
                    status: AgentStatus::Cancelled,
                    text: String::new(),
                    messages: request.messages,
                    pending: None,
                    turns_used,
                });
            }
            let name = call.function.name.clone();
            (ctx.on_event)(AgentEvent::ToolStart { name: name.clone() });

            let content = match name.as_str() {
                "execute_query" => {
                    let Some(sql) = sql_argument(call) else {
                        (ctx.on_event)(AgentEvent::ToolEnd {
                            name: name.clone(),
                            ok: false,
                            summary: "missing sql argument".into(),
                        });
                        request
                            .messages
                            .push(WireMessage::tool_result(&call.id, "Rejected: the sql argument is required."));
                        answered.insert(call.id.clone());
                        continue;
                    };
                    let result = ctx.backend.run_sql(&sql).await;
                    let (ok, summary) = summarize(&result);
                    (ctx.on_event)(AgentEvent::ToolEnd {
                        name: name.clone(),
                        ok,
                        summary,
                    });
                    // Engine errors are tool RESULTS (the model can fix the
                    // statement) — they must not abort the run.
                    result.unwrap_or_else(|e| format!("ERROR: {e}"))
                }
                "list_tables" => {
                    let result = ctx.backend.list_tables(ctx.db).await;
                    let (ok, summary) = summarize(&result);
                    (ctx.on_event)(AgentEvent::ToolEnd { name: name.clone(), ok, summary });
                    result.unwrap_or_else(|e| format!("ERROR: {e}"))
                }
                "describe_table" => {
                    let Some(table) = arg_string(call, "table") else {
                        let message = "Rejected: the table argument is required.".to_string();
                        (ctx.on_event)(AgentEvent::ToolEnd {
                            name: name.clone(),
                            ok: false,
                            summary: "missing table argument".into(),
                        });
                        request.messages.push(WireMessage::tool_result(&call.id, message));
                        answered.insert(call.id.clone());
                        continue;
                    };
                    let result = ctx.backend.describe_table(ctx.db, &table).await;
                    let (ok, summary) = summarize(&result);
                    (ctx.on_event)(AgentEvent::ToolEnd { name: name.clone(), ok, summary });
                    result.unwrap_or_else(|e| format!("ERROR: {e}"))
                }
                "get_current_time" => {
                    let now = ctx.backend.current_time();
                    (ctx.on_event)(AgentEvent::ToolEnd {
                        name: name.clone(),
                        ok: true,
                        summary: now.clone(),
                    });
                    now
                }
                other => {
                    // Tool result, not Err: an Err would discard the
                    // enriched history (losing the record of a replayed
                    // write); feeding it back lets the model recover.
                    let message = format!("ERROR: unknown tool {other}");
                    (ctx.on_event)(AgentEvent::ToolEnd {
                        name: name.clone(),
                        ok: false,
                        summary: message.chars().take(120).collect(),
                    });
                    message
                }
            };
            request.messages.push(WireMessage::tool_result(&call.id, content));
            answered.insert(call.id.clone());
        }
    }

    (ctx.on_event)(AgentEvent::Notice {
        message: format!("Turn limit reached ({MAX_TURNS})."),
    });
    let text = "I stopped after the turn limit. Ask me to continue if needed.".to_string();
    request.messages.push(WireMessage::text("assistant", text.clone()));
    Ok(AgentRunResult {
        status: AgentStatus::Done,
        text,
        messages: request.messages,
        pending: None,
        turns_used,
    })
}

/// Execute the paused write after the user's decision and produce the tool
/// result text for it. The grant is re-verified against THIS run's
/// connection + database + the exact SQL before anything executes.
async fn replay_resume(ctx: &mut AgentContext<'_>, resume: &AgentResume) -> String {
    // Blocked/declined outcomes share one exit that reports the attempt as
    // FAILED (never a silent or success-looking tool line in the UI).
    fn blocked(ctx: &mut AgentContext<'_>, message: String) -> String {
        // The marker is a protocol token: the model must read that nothing
        // reached the server, and tests pin it.
        let text = if message.starts_with("NOT EXECUTED") {
            message
        } else {
            format!("NOT EXECUTED: {message}")
        };
        (ctx.on_event)(AgentEvent::Notice { message: text.clone() });
        (ctx.on_event)(AgentEvent::ToolEnd {
            name: "execute_query".into(),
            ok: false,
            summary: text.chars().take(120).collect(),
        });
        text
    }

    if !resume.approved {
        return blocked(
            ctx,
            "Write declined — the agent was told not to retry it.".into(),
        );
    }
    let Some(sql) = sql_argument(&resume.call) else {
        return blocked(ctx, "NOT EXECUTED: the call had no sql argument.".into());
    };
    let assessment = sql_risk::assess(&sql, parse_dialect(ctx.dialect));
    if !assessment.is_read_only() {
        let Some(grant) = resume.grant.as_ref() else {
            return blocked(ctx, "NOT EXECUTED: approval is missing its grant.".into());
        };
        let bound = grant.conn_id == ctx.conn_id
            && grant.db == ctx.db
            && normalize(&grant.sql) == normalize(&sql);
        if !bound {
            return blocked(
                ctx,
                "Confirmation did not match the current connection/database target — write blocked."
                    .into(),
            );
        }
        // The grant binds a LABEL; the connection carries a LIVE schema that
        // a `USE` (or the session config) can move under our feet. Verify
        // the two agree before touching the server.
        let live = match ctx.backend.live_database().await {
            Ok(live) => live,
            Err(e) => {
                return blocked(
                    ctx,
                    format!("NOT EXECUTED: could not verify the live database: {e}"),
                )
            }
        };
        if let Some(live) = live.filter(|name| name != ctx.db) {
            return blocked(
                ctx,
                format!(
                    "Live database is `{live}`, but the confirmation targeted `{}` — write blocked.",
                    ctx.db
                ),
            );
        }
    }
    (ctx.on_event)(AgentEvent::ToolStart { name: "execute_query".into() });
    let result = ctx.backend.run_sql(&sql).await;
    let (ok, summary) = summarize(&result);
    (ctx.on_event)(AgentEvent::ToolEnd {
        name: "execute_query".into(),
        ok,
        summary,
    });
    result.unwrap_or_else(|e| format!("ERROR: {e}"))
}

fn arg_string(call: &WireToolCall, key: &str) -> Option<String> {
    let value: Value = serde_json::from_str(&call.function.arguments).ok()?;
    value.get(key)?.as_str().map(str::to_string)
}

fn summarize(result: &crate::error::Result<String>) -> (bool, String) {
    match result {
        Ok(text) => {
            // run_script reports per-statement SQL errors INSIDE the Ok
            // payload (`ERROR: …` lines) — the tool line must reflect that.
            let ok = !text
                .lines()
                .any(|l| l.trim_start().starts_with("ERROR:"));
            let first = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            (ok, first.chars().take(80).collect())
        }
        Err(e) => (false, e.to_string().chars().take(120).collect()),
    }
}

fn parse_dialect(dialect: &str) -> SqlDialect {
    match dialect {
        // ServerInfo uses "postgres"; older payloads said "postgresql".
        "postgres" | "postgresql" => SqlDialect::Postgres,
        "sqlite" => SqlDialect::Sqlite,
        _ => SqlDialect::Mysql,
    }
}

// ---------------------------------------------------------------------------
// Tests: the confirmation protocol end-to-end on scripted fixtures
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::atomic::AtomicBool;

    /// Provider that replays scripted turns.
    struct Scripted {
        turns: VecDeque<crate::error::Result<StreamOutcome>>,
    }

    impl ChatProvider for Scripted {
        fn chat<'a>(
            &'a mut self,
            _messages: &'a [WireMessage],
            _tools: &'a Value,
            _max_tokens: u32,
            _cancel: &'a std::sync::atomic::AtomicBool,
            _on_text: &'a mut (dyn FnMut(&str) + Send),
        ) -> BoxFuture<'a, crate::error::Result<StreamOutcome>> {
            Box::pin(async {
                self.turns
                    .pop_front()
                    .unwrap_or_else(|| Ok(StreamOutcome::default()))
            })
        }
    }

    /// Backend recording executed SQL and returning fixed results.
    struct TestBackend {
        results: VecDeque<String>,
        executed: Vec<String>,
        /// What `live_database` reports (None = engine without schemas).
        live_db: Option<String>,
    }

    impl AgentBackend for TestBackend {
        fn live_database<'a>(
            &'a mut self,
        ) -> BoxFuture<'a, crate::error::Result<Option<String>>> {
            Box::pin(async { Ok(self.live_db.clone()) })
        }

        fn list_tables<'a>(
            &'a mut self,
            _database: &'a str,
        ) -> BoxFuture<'a, crate::error::Result<String>> {
            Box::pin(async { Ok("users (table)".into()) })
        }
        fn describe_table<'a>(
            &'a mut self,
            _database: &'a str,
            _table: &'a str,
        ) -> BoxFuture<'a, crate::error::Result<String>> {
            Box::pin(async { Ok("id int NOT NULL PRIMARY KEY".into()) })
        }
        fn run_sql<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, crate::error::Result<String>> {
            self.executed.push(sql.to_string());
            let result = self.results.pop_front().unwrap_or_else(|| "OK".into());
            Box::pin(async { Ok(result) })
        }
        fn current_time(&self) -> String {
            "2026-01-01T00:00:00Z".into()
        }
    }

    fn call(id: &str, sql: &str) -> WireToolCall {
        WireToolCall {
            call_type: Some("function".into()),
            id: id.into(),
            function: WireFunction {
                name: "execute_query".into(),
                arguments: json!({ "sql": sql }).to_string(),
            },
        }
    }

    fn text_turn(text: &str) -> crate::error::Result<StreamOutcome> {
        Ok(StreamOutcome {
            text: text.into(),
            tool_calls: vec![],
            finish_reason: Some("stop".into()),
        })
    }

    fn tool_turn(calls: Vec<WireToolCall>) -> crate::error::Result<StreamOutcome> {
        Ok(StreamOutcome {
            text: String::new(),
            tool_calls: calls
                .into_iter()
                .map(|c| crate::ai::StreamedToolCall {
                    id: c.id,
                    name: c.function.name,
                    arguments: c.function.arguments,
                })
                .collect(),
            finish_reason: Some("tool_calls".into()),
        })
    }

    #[tokio::test]
    async fn read_query_runs_without_confirmation() {
        let mut provider = Scripted {
            turns: VecDeque::from([
                tool_turn(vec![call("c1", "SELECT * FROM users")]),
                text_turn("Here are the users."),
            ]),
        };
        let mut backend = TestBackend {
            results: VecDeque::from(["id | name".into()]),
            executed: vec![],
            live_db: Some("shop".into()),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let result = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: vec![WireMessage::text("user", "list users")],
                resume: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(result.status, AgentStatus::Done);
        assert_eq!(backend.executed, vec!["SELECT * FROM users"]);
        assert!(result.messages.iter().any(|m| m.role == "tool"));
        assert!(result.text.contains("users"));
    }

    #[tokio::test]
    async fn write_pauses_then_executes_with_bound_grant() {
        let write = "UPDATE users SET name = 'x' WHERE id = 2";
        let mut provider = Scripted {
            turns: VecDeque::from([tool_turn(vec![call("c1", write)]), text_turn("Done.")]),
        };
        let mut backend = TestBackend {
            results: VecDeque::from(["OK — 1 row(s) affected".into()]),
            executed: vec![],
            live_db: Some("shop".into()),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();

        // First run pauses on the write.
        let paused = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: vec![WireMessage::text("user", "rename user 2")],
                resume: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(paused.status, AgentStatus::AwaitingConfirmation);
        assert!(backend.executed.is_empty(), "write must not run before approval");
        assert_eq!(paused.pending.as_ref().unwrap().sql, write);

        // Resume with a grant bound to connection 7 / shop / exact SQL.
        let resumed = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: paused.messages,
                resume: Some(AgentResume {
                    approved: true,
                    call: paused.pending.unwrap().call,
                    grant: Some(WriteGrant {
                        sql: write.into(),
                        conn_id: 7,
                        db: "shop".into(),
                    }),
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(resumed.status, AgentStatus::Done);
        assert_eq!(backend.executed, vec![write]);
    }

    #[tokio::test]
    async fn grant_bound_to_another_database_is_void() {
        let write = "DELETE FROM users WHERE id = 2";
        let mut provider = Scripted {
            turns: VecDeque::from([
                tool_turn(vec![call("c1", write)]),
                text_turn("Understood, not running it."),
            ]),
        };
        let mut backend = TestBackend {
            results: VecDeque::new(),
            executed: vec![],
            live_db: Some("shop".into()),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();

        let paused = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: vec![WireMessage::text("user", "delete user 2")],
                resume: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(paused.status, AgentStatus::AwaitingConfirmation);

        // Grant says database "other" — the write must NOT execute.
        let resumed = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: paused.messages,
                resume: Some(AgentResume {
                    approved: true,
                    call: paused.pending.unwrap().call,
                    grant: Some(WriteGrant {
                        sql: write.into(),
                        conn_id: 7,
                        db: "other".into(),
                    }),
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(resumed.status, AgentStatus::Done);
        assert!(backend.executed.is_empty(), "mismatched grant must void the write");
        assert!(resumed
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.content.as_deref().unwrap_or("").contains("NOT EXECUTED")));
    }

    #[tokio::test]
    async fn decline_tells_the_model_not_to_retry() {
        let write = "UPDATE t SET a = 1 WHERE id = 1";
        let mut provider = Scripted {
            turns: VecDeque::from([tool_turn(vec![call("c1", write)]), text_turn("Okay, I won't.")]),
        };
        let mut backend = TestBackend {
            results: VecDeque::new(),
            executed: vec![],
            live_db: Some("shop".into()),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();

        let paused = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: vec![WireMessage::text("user", "do it")],
                resume: None,
            },
        )
        .await
        .unwrap();

        let declined = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: paused.messages,
                resume: Some(AgentResume {
                    approved: false,
                    call: paused.pending.unwrap().call,
                    grant: None,
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(declined.status, AgentStatus::Done);
        assert!(backend.executed.is_empty());
        assert!(declined
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.content.as_deref().unwrap_or("").contains("declined")));
    }

    #[tokio::test]
    async fn live_database_drift_voids_the_confirmation() {
        let write = "UPDATE users SET name = 'x' WHERE id = 2";
        let mut provider = Scripted {
            turns: VecDeque::from([tool_turn(vec![call("c1", write)]), text_turn("Done.")]),
        };
        // The session's live schema has moved to `analytics` since the
        // confirmation was given for `shop`.
        let mut backend = TestBackend {
            results: VecDeque::new(),
            executed: vec![],
            live_db: Some("analytics".into()),
        };
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();

        let paused = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: vec![WireMessage::text("user", "rename user 2")],
                resume: None,
            },
        )
        .await
        .unwrap();

        let resumed = run_agent(
            AgentContext {
                provider: &mut provider,
                backend: &mut backend,
                cancel: &cancel,
                conn_id: 7,
                dialect: "mysql",
                db: "shop",
                schema: None,
                on_event: &mut |e| events.push(e),
            },
            AgentRunRequest {
                messages: paused.messages,
                resume: Some(AgentResume {
                    approved: true,
                    call: paused.pending.unwrap().call,
                    grant: Some(WriteGrant {
                        sql: write.into(),
                        conn_id: 7,
                        db: "shop".into(),
                    }),
                }),
            },
        )
        .await
        .unwrap();
        assert_eq!(resumed.status, AgentStatus::Done);
        assert!(backend.executed.is_empty(), "drifted live db must void the write");
        assert!(resumed
            .messages
            .iter()
            .any(|m| m.role == "tool" && m.content.as_deref().unwrap_or("").contains("NOT EXECUTED")));
    }

    #[test]
    fn gate_requires_exact_grant_match() {
        let assessment = sql_risk::assess("UPDATE t SET a = 1 WHERE id = 2", SqlDialect::Mysql);
        assert!(matches!(
            gate_query("UPDATE t SET a = 1 WHERE id = 2", &assessment, 1, "shop", None),
            Gate::Ask { .. }
        ));
        // Grant for another connection → ask.
        assert!(matches!(
            gate_query(
                "UPDATE t SET a = 1 WHERE id = 2",
                &assessment,
                1,
                "shop",
                Some(&WriteGrant {
                    sql: "UPDATE t SET a = 1 WHERE id = 2".into(),
                    conn_id: 9,
                    db: "shop".into()
                })
            ),
            Gate::Ask { .. }
        ));
        // Whitespace differences still validate (same statement re-sent).
        let grant = WriteGrant {
            sql: "UPDATE  t SET a = 1  WHERE id = 2".into(),
            conn_id: 1,
            db: "shop".into(),
        };
        assert!(matches!(
            gate_query("UPDATE t SET a = 1 WHERE id = 2", &assessment, 1, "shop", Some(&grant)),
            Gate::Run
        ));
    }
}

#[cfg(test)]
mod resume_id_tests {
    use crate::ai::StreamedToolCall;

    /// Round-7 regression: the paused call is minted `call_p…` so the
    /// resume run's own synthetic ids (`call_t…`) can never share it.
    #[test]
    fn paused_call_prefix_never_collides_with_run_synthetics() {
        let streamed = StreamedToolCall {
            id: String::new(),
            name: "list_tables".into(),
            arguments: "{}".into(),
        };
        let turns_used = 1u32;
        let index = 0usize;
        let synthetic =
            |id: &str| id.starts_with("call_") && id[5..].chars().all(|c| c.is_ascii_digit());

        let paused_id = if streamed.id.is_empty() || synthetic(&streamed.id) {
            format!("call_p{turns_used}_{index}")
        } else {
            streamed.id.clone()
        };
        let resumed_id = if streamed.id.is_empty() || synthetic(&streamed.id) {
            format!("call_t{turns_used}_{index}")
        } else {
            streamed.id.clone()
        };

        assert_eq!(paused_id, "call_p1_0");
        assert_eq!(resumed_id, "call_t1_0");
        assert_ne!(paused_id, resumed_id);
        // And the paused id is NOT itself classified synthetic on resume:
        assert!(!synthetic(&paused_id));
    }
}

//! Query editor commands (Phase 3) — multi-statement script execution plus
//! a persisted, rotating query history.
//!
//! History lives in the settings store under `query_history` as a
//! most-recent-first array capped at [`MAX_HISTORY_ENTRIES`] entries. SQL is
//! truncated to [`MAX_STORED_SQL_CHARS`] before persisting; consecutive
//! identical entries are deduplicated.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, State};

use crate::connections::manager::ConnectionManager;
use crate::connections::dialect::SqlDialect;
use crate::connections::script::split_statements;
use crate::connections::{QueryOutcome, RowValue};
use crate::error::Result;
use crate::settings;

const HISTORY_KEY: &str = "query_history";
const MAX_HISTORY_ENTRIES: usize = 500;
const MAX_STORED_SQL_CHARS: usize = 10_000;

/// One executed script in the query history. Mirrors `HistoryEntry` in
/// `src/types/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub sql: String,
    /// Display name of the session the query ran on.
    pub conn_name: String,
    pub executed_at: DateTime<Utc>,
}

fn next_history_id(now: DateTime<Utc>) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "h-{}-{seq}",
        now.timestamp_nanos_opt().unwrap_or_default()
    )
}

/// Pure history merge used by `query_run_script` (unit-tested).
///
/// - new entry goes to the front,
/// - an entry identical to the current front (same sql + connection) only
///   refreshes the timestamp/id instead of duplicating,
/// - stored SQL is truncated to [`MAX_STORED_SQL_CHARS`],
/// - the list is capped at [`MAX_HISTORY_ENTRIES`].
fn record_history(
    existing: Vec<HistoryEntry>,
    sql: &str,
    conn_name: &str,
    now: DateTime<Utc>,
) -> Vec<HistoryEntry> {
    let normalized = sql.trim();
    let mut entries = existing;

    if let Some(top) = entries.first_mut() {
        if top.sql == normalized && top.conn_name == conn_name {
            top.id = next_history_id(now);
            top.executed_at = now;
            return entries;
        }
    }

    entries.insert(
        0,
        HistoryEntry {
            id: next_history_id(now),
            sql: normalized.chars().take(MAX_STORED_SQL_CHARS).collect(),
            conn_name: conn_name.to_string(),
            executed_at: now,
        },
    );
    entries.truncate(MAX_HISTORY_ENTRIES);
    entries
}

fn read_history(app: &AppHandle) -> Result<Vec<HistoryEntry>> {
    match settings::get_setting(app, HISTORY_KEY) {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value)
            .map_err(|e| crate::error::AppError::Config(format!("stored history is malformed: {e}"))),
    }
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

/// Execute a whole editor script statement-by-statement. Errors are reported
/// per-statement inside the outcome list; the IPC call itself only rejects
/// for transport-level problems (unknown connection, ...).
#[tauri::command]
pub async fn query_run_script(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    sql: String,
    stop_on_error: Option<bool>,
    conn_name: Option<String>,
) -> Result<Vec<QueryOutcome>> {
    let stop = stop_on_error.unwrap_or(true);
    let outcomes = connections.run_script(conn_id, sql.clone(), stop).await?;

    // History recording is best-effort: a settings hiccup must never fail
    // a successfully executed script after the fact.
    let history = record_history(read_history(&app)?, &sql, conn_name.as_deref().unwrap_or(""), Utc::now());
    if let Err(err) = settings::set_setting(&app, HISTORY_KEY, serde_json::to_value(history)?) {
        eprintln!("query history could not be saved: {err}");
    }

    Ok(outcomes)
}

#[tauri::command]
pub async fn query_history_list(app: AppHandle) -> Result<Vec<HistoryEntry>> {
    read_history(&app)
}

#[tauri::command]
pub async fn query_history_clear(app: AppHandle) -> Result<()> {
    settings::set_setting(&app, HISTORY_KEY, serde_json::json!([]))
}

// ---------------------------------------------------------------------------
// EXPLAIN (query profiling — HeidiSQL plan view parity)
// ---------------------------------------------------------------------------

/// One statement's EXPLAIN output. `skipped` marks statement types that have
/// no plan (SET/USE/DDL…); `error` carries per-statement failures.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplainStatement {
    /// The EXPLAIN-wrapped statement actually sent (verbatim when skipped).
    pub sql: String,
    /// The original statement text.
    pub source_sql: String,
    pub skipped: bool,
    /// Why the statement was skipped (only when `skipped`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Plan column names (engine-specific), present on successful plans.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<Vec<String>>,
    /// Plan rows; cells stay tagged [`RowValue`]s so the frontend formats
    /// them with the same renderer as every other grid.
    pub rows: Vec<Vec<RowValue>>,
    pub elapsed_ms: u64,
}

/// Statement keywords that produce a plan when wrapped in EXPLAIN.
fn is_explainable(stmt: &str) -> bool {
    let trimmed = stmt.trim_start();
    let head = trimmed
        .split(|c: char| c.is_whitespace())
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(
        head.as_str(),
        "SELECT" | "WITH" | "INSERT" | "REPLACE" | "UPDATE" | "DELETE" | "TABLE" | "VALUES"
    )
}

/// Dialect-aware EXPLAIN wrapper. SQLite only has `EXPLAIN QUERY PLAN`
/// (bytecode `EXPLAIN` is useless here) and has no ANALYZE form.
fn wrap_explain(dialect: SqlDialect, stmt: &str, analyze: bool) -> (String, Option<String>) {
    match dialect {
        SqlDialect::Mysql | SqlDialect::Postgres => {
            if analyze {
                (format!("EXPLAIN ANALYZE {stmt}"), None)
            } else {
                (format!("EXPLAIN {stmt}"), None)
            }
        }
        SqlDialect::Sqlite => {
            let note = analyze
                .then(|| "SQLite has no EXPLAIN ANALYZE — showing the query plan".to_string());
            (format!("EXPLAIN QUERY PLAN {stmt}"), note)
        }
    }
}

/// Run EXPLAIN (optionally ANALYZE) per statement of the script. Reuses the
/// [`ConnectionManager::run_script`] pipeline: statements are split, wrapped
/// in dialect-appropriate EXPLAIN forms and sent as one script with
/// stop-on-error disabled so every statement reports back.
#[tauri::command]
pub async fn query_explain(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    sql: String,
    analyze: Option<bool>,
) -> Result<Vec<ExplainStatement>> {
    let analyze = analyze.unwrap_or(false);
    let dialect = connections.server_info(conn_id).await?.dialect;

    let mut slots: Vec<ExplainStatement> = Vec::new();
    let mut wrapped: Vec<String> = Vec::new();
    for stmt in split_statements(&sql) {
        if !is_explainable(&stmt) {
            slots.push(ExplainStatement {
                sql: stmt.clone(),
                source_sql: stmt,
                skipped: true,
                note: Some("statement type has no query plan".into()),
                error: None,
                columns: None,
                rows: Vec::new(),
                elapsed_ms: 0,
            });
            continue;
        }
        let (wrapped_sql, note) = wrap_explain(dialect, &stmt, analyze);
        slots.push(ExplainStatement {
            sql: wrapped_sql,
            source_sql: stmt,
            skipped: false,
            note,
            error: None,
            columns: None,
            rows: Vec::new(),
            elapsed_ms: 0,
        });
        wrapped.push(slots.last().unwrap().sql.clone());
    }

    if wrapped.is_empty() {
        return Ok(slots);
    }

    // No stop-on-error: every statement reports back, errors included.
    let outcomes = connections
        .run_script(conn_id, wrapped.join(";\n"), false)
        .await?;

    let mut outcome_iter = outcomes.into_iter();
    for slot in slots.iter_mut().filter(|s| !s.skipped) {
        match outcome_iter.next() {
            None => {
                slot.error = Some("statement was not executed".into());
            }
            Some(QueryOutcome::ResultSet { columns, rows, elapsed_ms, .. }) => {
                slot.columns = Some(columns.into_iter().map(|c| c.name).collect());
                slot.rows = rows;
                slot.elapsed_ms = elapsed_ms;
            }
            Some(QueryOutcome::Exec { elapsed_ms, .. }) => {
                slot.elapsed_ms = elapsed_ms;
                slot.error = Some("statement returned no plan rows".into());
            }
            Some(QueryOutcome::Error { message, .. }) => {
                slot.error = Some(message);
            }
        }
    }
    Ok(slots)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(secs: u64) -> DateTime<Utc> {
        Utc.timestamp_opt(secs as i64, 0).unwrap()
    }

    fn entry(sql: &str, conn: &str, secs: u64) -> HistoryEntry {
        HistoryEntry {
            id: format!("h-{secs}"),
            sql: sql.into(),
            conn_name: conn.into(),
            executed_at: at(secs),
        }
    }

    #[test]
    fn prepends_and_caps() {
        let existing = vec![entry("SELECT 1", "local", 100), entry("SELECT 2", "local", 50)];
        let out = record_history(existing, "SELECT 3", "local", at(150));
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].sql, "SELECT 3");
        assert_eq!(out[0].executed_at, at(150));
        assert_eq!(out[1].sql, "SELECT 1");
    }

    #[test]
    fn consecutive_duplicates_refresh_instead_of_piling_up() {
        let existing = vec![entry("SELECT 1", "local", 100), entry("SELECT 2", "local", 50)];
        let out = record_history(existing.clone(), "SELECT 1", "local", at(175));
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].executed_at, at(175));
        // Same SQL but another connection is NOT a duplicate.
        let other_conn = record_history(existing, "SELECT 1", "other", at(176));
        assert_eq!(other_conn.len(), 3);
        assert_eq!(other_conn[0].conn_name, "other");
    }

    #[test]
    fn trims_sql_and_truncates_long_entries() {
        let long = format!("  {}  ", "x".repeat(MAX_STORED_SQL_CHARS + 500));
        let out = record_history(Vec::new(), &long, "local", at(10));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].sql.chars().count(), MAX_STORED_SQL_CHARS);
        assert!(!out[0].sql.starts_with(' '));
    }

    #[test]
    fn caps_at_max_entries() {
        let mut existing = Vec::new();
        for i in 0..(MAX_HISTORY_ENTRIES + 25) {
            existing = record_history(existing, &format!("Q{i}"), "local", at(i as u64));
        }
        assert_eq!(existing.len(), MAX_HISTORY_ENTRIES);
        assert_eq!(existing[0].sql, format!("Q{}", MAX_HISTORY_ENTRIES + 24));
    }

    // -- EXPLAIN helpers ------------------------------------------------------

    #[test]
    fn explainable_keywords() {
        for stmt in [
            "SELECT 1",
            "  select * from t where x = 1",
            "WITH cte AS (SELECT 1) SELECT * FROM cte",
            "INSERT INTO t VALUES (1)",
            "REPLACE INTO t VALUES (1)",
            "UPDATE t SET x = 1",
            "DELETE FROM t",
            "TABLE t",       // MySQL 8 shorthand
            "VALUES (1, 2)", // MySQL 8 table value constructor
        ] {
            assert!(is_explainable(stmt), "should be explainable: {stmt}");
        }
        for stmt in [
            "SET @x = 1",
            "USE shop",
            "CREATE TABLE t (id INT)",
            "DROP TABLE t",
            "BEGIN",
            "COMMIT",
            "SHOW TABLES",
            "",
        ] {
            assert!(!is_explainable(stmt), "should NOT be explainable: {stmt}");
        }
    }

    #[test]
    fn wrap_mysql_and_postgres_match_analyze() {
        let (sql, note) = wrap_explain(SqlDialect::Mysql, "SELECT 1", false);
        assert_eq!(sql, "EXPLAIN SELECT 1");
        assert!(note.is_none());

        let (sql, _) = wrap_explain(SqlDialect::Postgres, "SELECT 1", true);
        assert_eq!(sql, "EXPLAIN ANALYZE SELECT 1");

        let (sql, _) = wrap_explain(SqlDialect::Mysql, "SELECT 1", true);
        assert_eq!(sql, "EXPLAIN ANALYZE SELECT 1");
    }

    #[test]
    fn wrap_sqlite_uses_query_plan_and_ignores_analyze() {
        let (sql, note) = wrap_explain(SqlDialect::Sqlite, "SELECT 1", false);
        assert_eq!(sql, "EXPLAIN QUERY PLAN SELECT 1");
        assert!(note.is_none());

        let (sql, note) = wrap_explain(SqlDialect::Sqlite, "SELECT 1", true);
        assert_eq!(sql, "EXPLAIN QUERY PLAN SELECT 1");
        assert_eq!(note.as_deref(), Some("SQLite has no EXPLAIN ANALYZE — showing the query plan"));
    }
}

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
use crate::connections::QueryOutcome;
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
}

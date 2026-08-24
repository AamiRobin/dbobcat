//! Reusable SQL snippets (Phase 9-B helpers panel).
//!
//! Snippets live in the settings store under `snippets` as a
//! most-recently-saved-first array, following the same pattern as the query
//! history in `commands/query.rs`. Names are unique — saving with an
//! existing name replaces that snippet in place at the front.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::AppHandle;

use crate::error::{AppError, Result};
use crate::settings;

const SNIPPETS_KEY: &str = "snippets";
const MAX_SNIPPETS: usize = 500;
const MAX_STORED_SQL_CHARS: usize = 20_000;
const MAX_NAME_CHARS: usize = 120;

/// One saved SQL fragment. Mirrors `Snippet` in `src/types/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub sql: String,
    pub updated_at: DateTime<Utc>,
}

fn next_snippet_id(now: DateTime<Utc>) -> String {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!(
        "s-{}-{seq}",
        now.timestamp_nanos_opt().unwrap_or_default()
    )
}

/// Pure merge used by `snippet_save` (unit-tested): an entry with the same
/// name is replaced and moved to the front; the list is capped.
pub fn upsert_snippet(existing: Vec<Snippet>, fresh: Snippet) -> Vec<Snippet> {
    let mut merged: Vec<Snippet> = existing
        .into_iter()
        .filter(|s| s.name != fresh.name)
        .collect();
    merged.insert(0, fresh);
    merged.truncate(MAX_SNIPPETS);
    merged
}

fn read_snippets(app: &AppHandle) -> Result<Vec<Snippet>> {
    match settings::get_setting(app, SNIPPETS_KEY) {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value)
            .map_err(|e| AppError::Config(format!("stored snippets are malformed: {e}"))),
    }
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn snippet_list(app: AppHandle) -> Result<Vec<Snippet>> {
    read_snippets(&app)
}

/// Insert or rename-update one snippet (matched by trimmed name).
#[tauri::command]
pub async fn snippet_save(app: AppHandle, name: String, sql: String) -> Result<Snippet> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppError::Config("snippet name must not be empty".into()));
    }
    let now = Utc::now();
    let fresh = Snippet {
        id: next_snippet_id(now),
        name: trimmed.chars().take(MAX_NAME_CHARS).collect(),
        sql: sql.chars().take(MAX_STORED_SQL_CHARS).collect(),
        updated_at: now,
    };
    let merged = upsert_snippet(read_snippets(&app)?, fresh.clone());
    settings::set_setting(&app, SNIPPETS_KEY, serde_json::to_value(merged)?)?;
    Ok(fresh)
}

#[tauri::command]
pub async fn snippet_delete(app: AppHandle, id: String) -> Result<()> {
    let mut snippets = read_snippets(&app)?;
    snippets.retain(|s| s.id != id);
    settings::set_setting(&app, SNIPPETS_KEY, serde_json::to_value(snippets)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snip(id: &str, name: &str, sql: &str) -> Snippet {
        Snippet {
            id: id.into(),
            name: name.into(),
            sql: sql.into(),
            updated_at: Utc::now(),
        }
    }

    #[test]
    fn upsert_moves_matching_name_to_front_replacing_it() {
        let existing = vec![snip("a", "paginate", "LIMIT 100"), snip("b", "count", "COUNT(*)")];
        let merged = upsert_snippet(existing, snip("c", "count", "COUNT(1)"));
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, "c");
        assert_eq!(merged[0].sql, "COUNT(1)");
        assert_eq!(merged[1].id, "a");
        // Names stay unique.
        assert!(merged.iter().all(|s| s.name != "count" || s.id == "c"));
    }

    #[test]
    fn upsert_appends_new_names_at_front() {
        let existing = vec![snip("a", "one", "1")];
        let merged = upsert_snippet(existing, snip("b", "two", "2"));
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].name, "two");
        assert_eq!(merged[1].name, "one");
    }

    #[test]
    fn upsert_caps_the_list() {
        let mut existing = Vec::new();
        for i in 0..(MAX_SNIPPETS + 10) {
            existing = upsert_snippet(existing, snip(&format!("i{i}"), &format!("n{i}"), "x"));
        }
        assert_eq!(existing.len(), MAX_SNIPPETS);
        assert_eq!(existing[0].name, format!("n{}", MAX_SNIPPETS + 9));
    }

    #[test]
    fn upsert_into_empty_works() {
        let merged = upsert_snippet(Vec::new(), snip("a", "name", "SELECT 1"));
        assert_eq!(merged.len(), 1);
    }
}

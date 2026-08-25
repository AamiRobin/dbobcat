//! App-shell commands (Phase 8): launch-intent handoff and quit.
//!
//! Launch intents let a second process instance (or the OS, via CLI flags)
//! ask the running app to connect to a session and/or open a query tab:
//!
//! ```text
//! murmeli --connect <session-name-or-id>
//! murmeli --new-query [session-name-or-id]
//! ```
//!
//! The intent is parked in managed state; the frontend pulls it once on
//! mount via [`app_take_launch_intent`]. Later intents (single-instance
//! handoff) are also broadcast as an `app://launch-intent` event.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

/// A request from argv to open a session / query tab.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchIntent {
    /// Session id when the flag value matched one exactly.
    pub session_id: Option<String>,
    /// Raw flag value (name or id) for frontend-side resolution.
    pub session_name: Option<String>,
    /// `--new-query`: additionally open a fresh Query tab.
    pub new_query: bool,
}

impl LaunchIntent {
    /// Resolve `session_name` → `session_id`. An exact id always wins; a
    /// name resolves only when unique — ambiguity stays unresolved so the
    /// UI can surface it.
    pub(crate) fn resolve_value(&mut self, sessions: &[crate::commands::sessions::SavedSession]) {
        let Some(target) = self.session_name.clone() else {
            return;
        };
        self.session_id = sessions
            .iter()
            .find(|s| s.id == target)
            .or_else(|| {
                let by_name: Vec<_> = sessions.iter().filter(|s| s.name == target).collect();
                (by_name.len() == 1).then(|| by_name[0])
            })
            .map(|s| s.id.clone());
    }
}

/// Managed slot holding at most one unconsumed launch intent.
pub struct LaunchIntentState(Mutex<Option<LaunchIntent>>);

impl LaunchIntentState {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn set(&self, intent: LaunchIntent) {
        // Recover the guard rather than panicking on poison: a panic in a
        // prior setter leaves the slot consistent (Option is always valid).
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(intent);
    }

    pub fn take(&self) -> Option<LaunchIntent> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).take()
    }
}

/// Parse CLI args into a launch intent. Accepts `--flag value`,
/// `--flag=value`, and the short forms `-c` / `-n`. Returns `None` when no
/// launch-related flag is present.
pub fn parse_launch_intent(args: &[String]) -> Option<LaunchIntent> {
    let mut intent = LaunchIntent::default();
    let mut found = false;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let (flag, inline): (&str, Option<&str>) = match arg.split_once('=') {
            Some((f, v)) => (f, Some(v)),
            None => (arg.as_str(), None),
        };
        let next_value = |i: &mut usize| -> Option<String> {
            if let Some(v) = inline {
                return Some(v.to_string());
            }
            let candidate = args.get(*i + 1);
            match candidate {
                Some(v) if !v.starts_with('-') => {
                    *i += 1;
                    Some(v.clone())
                }
                _ => None,
            }
        };

        match flag {
            "--connect" | "-c" => {
                intent.session_name = next_value(&mut i);
                found = true;
            }
            "--new-query" | "-n" => {
                // The session argument is optional for --new-query.
                intent.session_name = next_value(&mut i);
                intent.new_query = true;
                found = true;
            }
            _ => {}
        }
        i += 1;
    }

    if found { Some(intent) } else { None }
}

/// Hand the pending launch intent (if any) to the webview; consuming clears it.
#[tauri::command]
pub fn app_take_launch_intent(
    state: State<'_, LaunchIntentState>,
    app: tauri::AppHandle,
) -> Result<Option<LaunchIntent>, String> {
    let mut intent = state.take();
    if let Some(inner) = intent.as_mut() {
        // Resolve name → id eagerly so the frontend gets a definitive answer.
        let list = crate::commands::sessions::session_list_impl(&app).unwrap_or_default();
        inner.resolve_value(&list);
    }
    Ok(intent)
}

/// Quit the whole application (Ctrl+Q / File > Exit).
#[tauri::command]
pub fn app_exit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Read the system clipboard as plain text (grid "paste rows" + quick
/// filter by clipboard value). This is an app-defined command that calls
/// the clipboard plugin's Rust API directly, so it is not gated by the
/// webview-side capability ACL — that ACL only applies to plugin commands
/// invoked from JS.
#[tauri::command]
pub fn clipboard_read_text(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .read_text()
        .map_err(|e| format!("clipboard read failed: {e}"))
}

// ---------------------------------------------------------------------------
// Generic settings access (Phase 9-B)
//
// Small UI-owned state (tree favorites per session, ...) persists in the
// settings store without a bespoke command per key. Keys are namespaced by
// convention (`favorites.<sessionId>`); values are arbitrary JSON.
// ---------------------------------------------------------------------------

/// Read one settings-store value; `None` when unset.
#[tauri::command]
pub fn app_settings_get(
    app: tauri::AppHandle,
    key: String,
) -> crate::error::Result<Option<serde_json::Value>> {
    Ok(crate::settings::get_setting(&app, &key))
}

/// Persist one settings-store value (upsert).
#[tauri::command]
pub fn app_settings_set(
    app: tauri::AppHandle,
    key: String,
    value: serde_json::Value,
) -> crate::error::Result<()> {
    crate::settings::set_setting(&app, &key, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn no_flags_yields_none() {
        assert_eq!(parse_launch_intent(&args(&["app"])), None);
        assert_eq!(parse_launch_intent(&args(&["app", "--other", "x"])), None);
    }

    #[test]
    fn connect_space_and_inline() {
        let want = LaunchIntent {
            session_id: None,
            session_name: Some("local".into()),
            new_query: false,
        };
        assert_eq!(parse_launch_intent(&args(&["app", "--connect", "local"])), Some(want.clone()));
        assert_eq!(parse_launch_intent(&args(&["app", "--connect=local"])), Some(want.clone()));
        assert_eq!(parse_launch_intent(&args(&["app", "-c", "local"])), Some(want));
    }

    #[test]
    fn new_query_optional_session() {
        let bare = parse_launch_intent(&args(&["app", "--new-query"])).unwrap();
        assert!(bare.new_query && bare.session_name.is_none());

        let with = parse_launch_intent(&args(&["app", "-n", "prod"])).unwrap();
        assert!(with.new_query);
        assert_eq!(with.session_name.as_deref(), Some("prod"));
    }

    #[test]
    fn flag_like_values_are_not_swallowed() {
        let got = parse_launch_intent(&args(&["app", "--new-query", "--connect", "x"])).unwrap();
        assert_eq!(
            got,
            LaunchIntent {
                session_id: None,
                session_name: Some("x".into()),
                new_query: true,
            }
        );
    }

    #[test]
    fn resolve_matches_id_or_unique_name() {
        let mut intent = LaunchIntent {
            session_id: None,
            session_name: Some("prod".into()),
            new_query: false,
        };
        // SavedSession construction needs full fields; use serde_json round-trip.
        let mk = |id: &str, name: &str| -> crate::commands::sessions::SavedSession {
            serde_json::from_value(serde_json::json!({
                "id": id, "name": name, "dbType": "mysql",
                "host": "h", "port": 3306, "user": "u"
            }))
            .unwrap()
        };
        let list = vec![mk("abc-1", "dev"), mk("abc-2", "prod")];
        intent.resolve_value(&list);
        assert_eq!(intent.session_id.as_deref(), Some("abc-2"));

        intent.session_name = Some("abc-1".into());
        intent.resolve_value(&list);
        assert_eq!(intent.session_id.as_deref(), Some("abc-1"));

        // Ambiguous/unknown names stay unresolved; the UI decides what to do.
        let list2 = vec![mk("a", "dup"), mk("b", "dup")];
        intent.session_name = Some("dup".into());
        intent.resolve_value(&list2);
        assert_eq!(intent.session_id, None);

        intent.session_name = Some("missing".into());
        intent.resolve_value(&list);
        assert_eq!(intent.session_id, None);
    }
}

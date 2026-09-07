//! Session CRUD, testing, connect/disconnect.
//!
//! Sessions live in the settings store WITHOUT any secret material; MySQL
//! and SSH login passwords go to the encrypted credential store keyed by
//! session id (`<id>` / `<id>#ssh` respectively).

use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::async_runtime::spawn_blocking;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;


use crate::connections::manager::{
    open_driver, ConnectionManager, ConnectOptions,
};
use crate::connections::{
    ConnInfo, DbType, IsolationLevel, ResolvedConnectionConfig, SslMode, TxMode,
};
use crate::credentials::{ssh_entry_id, CredentialStore};
use crate::error::{AppError, Result};
use crate::settings;
use crate::ssh::{SshAuth, SshTunnelConfig, SshTunnelManager};

/// Settings-store key holding the `Vec<SavedSession>` JSON array.
const SESSIONS_KEY: &str = "sessions";

/// A saved connection profile. Mirrors `SavedSession` in `src/types/ipc.ts`.
///
/// Invariants: never contains passwords; `port`/`ssh.port` always populated
/// on the wire (defaults applied by the editor UI before saving).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    pub db_type: DbType,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl_mode: SslMode,
    #[serde(default)]
    pub use_ssh: bool,
    #[serde(default)]
    pub ssh: Option<SshTunnelConfig>,
    /// TLS identity/trust files (HeidiSSL parity; server engines only).
    #[serde(default)]
    pub ssl: Option<crate::connections::SslFiles>,
    // Phase 9-B organization + resilience metadata (all optional for
    // backward compatibility with existing settings.json files).
    /// Slash-separated folder path, e.g. "Work/Prod".
    #[serde(default)]
    pub group: Option<String>,
    /// One of the fixed palette hex colors shown as a dot accent.
    #[serde(default)]
    pub color: Option<String>,
    /// Free-form note rendered under the session name.
    #[serde(default)]
    pub comment: Option<String>,
    /// Keep-alive ping interval in seconds; 0 = off, unset = 20 (Heidi).
    #[serde(default)]
    pub keep_alive_sec: Option<u64>,
    // Transactions UI Phase 1: per-connection defaults. Both optional for
    // backward compatibility with existing settings.json files.
    /// Initial transaction mode; unset = auto-commit.
    #[serde(default)]
    pub tx_mode: Option<TxMode>,
    /// Session isolation level applied at connect; unset = server default.
    #[serde(default)]
    pub isolation: Option<IsolationLevel>,
}

/// Outcome of `session_test`; transport-level failures are reported inline
/// instead of rejecting the IPC call, keeping the dialog simple.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub server_version: Option<String>,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

/// Credential-store entry id for a session's SSH *key passphrase*.
fn key_entry_id(session_id: &str) -> String {
    format!("{session_id}#key")
}

/// Best-effort one-time migration: settings.json written by older versions
/// may still carry a plaintext SSH key passphrase inside `ssh.auth`. Move any
/// such secret into the credential store (`<id>#key`) and strip it from the
/// in-memory copy so the next `write_sessions` persists `passphrase: null`.
/// Returns true when at least one profile was scrubbed.
///
/// On a credential-store failure the plaintext is kept so the secret is not
/// lost; migration simply retries on the next session list.
fn migrate_plaintext_passphrases(
    sessions: &mut [SavedSession],
    credentials: &CredentialStore,
) -> bool {
    let mut migrated = false;
    for session in sessions.iter_mut() {
        let Some(ssh) = session.ssh.as_mut() else { continue };
        let SshAuth::Key { passphrase, .. } = &mut ssh.auth else { continue };
        let Some(pw) = passphrase.clone().filter(|p| !p.is_empty()) else { continue };
        if credentials.save_password(&key_entry_id(&session.id), &pw, None).is_ok() {
            *passphrase = None;
            migrated = true;
        }
    }
    migrated
}

fn read_sessions(app: &AppHandle) -> Result<Vec<SavedSession>> {
    match settings::get_setting(app, SESSIONS_KEY) {
        None => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value)
            .map_err(|e| AppError::Config(format!("stored sessions are malformed: {e}"))),
    }
}

fn write_sessions(app: &AppHandle, sessions: &[SavedSession]) -> Result<()> {
    settings::set_setting(app, SESSIONS_KEY, serde_json::to_value(sessions)?)
}

// ---------------------------------------------------------------------------
// Config resolution shared by test/connect flows
// ---------------------------------------------------------------------------

/// Build driver parameters from a session plus stored secrets. When
/// `password_override` is set (Test dialog with unsaved input) it takes
/// precedence over the credential store.
fn resolve_config(
    session: &SavedSession,
    credentials: &CredentialStore,
    password_override: Option<&str>,
    ssh_password_override: Option<&str>,
) -> Result<ResolvedConnectionConfig> {
    if session.host.trim().is_empty() {
        return Err(AppError::Config(match session.db_type {
            DbType::Sqlite => "database file path is required.".to_string(),
            _ => "host is required.".to_string(),
        }));
    }

    // SQLite is a local file session: no password, no SSH, no port.
    if session.db_type == DbType::Sqlite {
        return Ok(ResolvedConnectionConfig {
            engine: DbType::Sqlite,
            host: session.host.trim().to_string(),
            port: 0,
            user: String::new(),
            password: None,
            database: Some(crate::connections::sqlite::SqliteConnection::database_name(&session.host)),
            ssl_mode: SslMode::Disabled,
            ssl_files: None,
            ssh: None,
        });
    }

    let password = match password_override {
        Some(p) => (!p.is_empty()).then(|| p.to_string()),
        None => credentials.get_password(&session.id, None)?,
    };

    let ssh = if session.use_ssh {
        let mut ssh_cfg = session
            .ssh
            .clone()
            .ok_or_else(|| AppError::Config("SSH tunnel enabled but not configured".into()))?;
        match &mut ssh_cfg.auth {
            SshAuth::Password { .. } => {
                let stored = match ssh_password_override {
                    Some(p) => (!p.is_empty()).then(|| p.to_string()),
                    None => credentials.get_password(&ssh_entry_id(&session.id), None)?,
                };
                ssh_cfg.auth = SshAuth::Password {
                    password: stored.unwrap_or_default(),
                };
            }
            // Key passphrases are persisted in the credential store under
            // `<id>#key`; inject the stored one before authenticating.
            SshAuth::Key { passphrase, .. } if passphrase.is_none() => {
                *passphrase = credentials.get_password(&key_entry_id(&session.id), None)?;
            }
            SshAuth::Key { .. } => {}
        }
        Some(ssh_cfg)
    } else {
        None
    };

    Ok(ResolvedConnectionConfig {
        engine: session.db_type,
        host: session.host.clone(),
        port: session.port,
        user: session.user.clone(),
        password,
        database: session.database.clone(),
        ssl_mode: session.ssl_mode,
        ssl_files: session.ssl.clone(),
        ssh,
    })
}

/// Connect once, report the server banner, then tear everything down.
async fn probe_connection(
    config: ResolvedConnectionConfig,
    tunnels: &SshTunnelManager,
) -> Result<(String, u64)> {
    let started = Instant::now();

    let mut tunnel_id = None;
    let endpoint = match &config.ssh {
        Some(ssh_cfg) => {
            let info = tunnels
                .open(ssh_cfg.clone(), &config.host, config.port)
                .await?;
            tunnel_id = Some(info.tunnel_id);
            ("127.0.0.1".to_string(), info.local_port)
        }
        None => (config.host.clone(), config.port),
    };
    let resolved = ResolvedConnectionConfig {
        host: endpoint.0,
        port: endpoint.1,
        ..config
    };

    let outcome = async {
        let mut conn = open_driver(&resolved).await?;
        let version = conn.server_info().version;
        conn.close().await;
        Ok(version)
    }
    .await;

    if let Some(id) = tunnel_id {
        tunnels.close(id).await;
    }

    outcome.map(|version| (version, started.elapsed().as_millis() as u64))
}

// ---------------------------------------------------------------------------
// IPC commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn session_list(app: AppHandle) -> Result<Vec<SavedSession>> {
    session_list_impl(&app)
}

/// Non-command helper shared with the launch-intent resolver (`commands/app.rs`).
///
/// Also runs the best-effort plaintext-passphrase migration (see
/// [`migrate_plaintext_passphrases`]): legacy settings.json entries are moved
/// into the credential store immediately and re-persisted scrubbed.
pub fn session_list_impl(app: &AppHandle) -> Result<Vec<SavedSession>> {
    let mut sessions = read_sessions(app)?;
    if let Some(credentials) = app.try_state::<CredentialStore>() {
        if migrate_plaintext_passphrases(&mut sessions, &credentials) {
            write_sessions(app, &sessions)?;
        }
    }
    Ok(sessions)
}

/// Insert or update a session. Password arguments are optional: `None`
/// leaves previously stored values untouched.
///
/// The SSH *key passphrase* is a secret too: when the editor sends a fresh
/// one inside `session.ssh.auth` (`Key { .. }`), it is stored in the
/// credential store under `<id>#key` and stripped from the profile that is
/// written to settings.json — mirroring how DB/SSH passwords are handled.
#[tauri::command]
pub async fn session_save(
    app: AppHandle,
    credentials: State<'_, CredentialStore>,
    mut session: SavedSession,
    password: Option<String>,
    ssh_password: Option<String>,
) -> Result<()> {
    if session.name.trim().is_empty() {
        return Err(AppError::Config("session name must not be empty".into()));
    }

    // Persist the key passphrase (if freshly supplied) and strip it from the
    // struct BEFORE write_sessions so no secret reaches settings.json.
    if let Some(SshAuth::Key { passphrase, .. }) = session.ssh.as_mut().map(|s| &mut s.auth) {
        match passphrase.take() {
            Some(pw) if !pw.is_empty() => {
                credentials.save_password(&key_entry_id(&session.id), &pw, None)?;
            }
            _ => {}
        }
    }

    let mut sessions = read_sessions(&app)?;
    match sessions.iter_mut().find(|s| s.id == session.id) {
        Some(existing) => *existing = session.clone(),
        None => sessions.push(session.clone()),
    }
    write_sessions(&app, &sessions)?;

    // Persist secrets only when freshly supplied by the editor.
    if let Some(pw) = password.filter(|p| !p.is_empty()) {
        credentials.save_password(&session.id, &pw, None)?;
    }
    if let Some(pw) = ssh_password.filter(|p| !p.is_empty()) {
        credentials.save_password(&ssh_entry_id(&session.id), &pw, None)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_delete(
    app: AppHandle,
    credentials: State<'_, CredentialStore>,
    session_id: String,
) -> Result<()> {
    let mut sessions = read_sessions(&app)?;
    sessions.retain(|s| s.id != session_id);
    write_sessions(&app, &sessions)?;

    credentials.delete_password(&session_id, None)?;
    credentials.delete_password(&ssh_entry_id(&session_id), None)?;
    credentials.delete_password(&key_entry_id(&session_id), None)?;
    Ok(())
}

/// Probe connectivity for either an unsaved form state or a modified saved
/// session. Never hard-fails: errors land in `TestResult.error`.
#[tauri::command]
pub async fn session_test(
    credentials: State<'_, CredentialStore>,
    tunnels: State<'_, SshTunnelManager>,
    session: SavedSession,
    password: Option<String>,
    ssh_password: Option<String>,
) -> Result<TestResult> {
    let config = match resolve_config(
        &session,
        &credentials,
        password.as_deref(),
        ssh_password.as_deref(),
    ) {
        Ok(config) => config,
        Err(err) => {
            return Ok(TestResult {
                ok: false,
                server_version: None,
                elapsed_ms: 0,
                error: Some(err.to_string()),
            })
        }
    };

    match probe_connection(config, &tunnels).await {
        Ok((version, elapsed_ms)) => Ok(TestResult {
            ok: true,
            server_version: Some(version),
            elapsed_ms,
            error: None,
        }),
        Err(err) => Ok(TestResult {
            ok: false,
            server_version: None,
            elapsed_ms: 0,
            error: Some(err.to_string()),
        }),
    }
}

/// Resolve the session's secrets, establish its tunnel (if any) and register
/// a long-lived connection. The frontend keeps one active session for P1 and
/// disconnects it before connecting anew.
#[tauri::command]
pub async fn session_connect(
    app: AppHandle,
    credentials: State<'_, CredentialStore>,
    connections: State<'_, ConnectionManager>,
    tunnels: State<'_, SshTunnelManager>,
    session_id: String,
) -> Result<ConnInfo> {
    let session = read_sessions(&app)?
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| AppError::Config(format!("unknown session '{session_id}'")))?;

    let config = resolve_config(&session, &credentials, None, None)?;
    // Manual transaction mode is a server-engine feature; SQLite sessions
    // keep the defaults regardless of what an edited profile might carry.
    let (tx_mode, isolation) = if session.db_type == DbType::Sqlite {
        (None, None)
    } else {
        (session.tx_mode, session.isolation)
    };
    let opts = ConnectOptions {
        keep_alive_sec: session.keep_alive_sec,
        tx_mode,
        isolation,
    };
    connections.connect(app, config, &tunnels, opts).await
}

#[tauri::command]
pub async fn session_disconnect(
    connections: State<'_, ConnectionManager>,
    tunnels: State<'_, SshTunnelManager>,
    conn_id: u32,
) -> Result<()> {
    connections.disconnect(conn_id, &tunnels).await
}

// ---------------------------------------------------------------------------
// Settings export / import (HeidiSQL "settings file" parity)
//
// Exports the whole settings.json document (sessions + UI settings) WITHOUT
// secret material — passwords live only in the encrypted credential store on
// the originating machine and are never part of the file.
// ---------------------------------------------------------------------------

/// Pure sessions merge used by `settings_import_from_file` (unit-tested).
/// Returns the merged list plus (added, updated) counts.
fn merge_sessions(
    existing: Vec<serde_json::Value>,
    incoming: Vec<serde_json::Value>,
    replace: bool,
) -> (Vec<serde_json::Value>, usize, usize) {
    if replace {
        let n = incoming.len();
        return (incoming, n, 0);
    }
    let mut list = existing;
    let mut added = 0usize;
    let mut updated = 0usize;
    for item in incoming {
        let id = item.get("id").and_then(|v| v.as_str()).map(String::from);
        match id {
            Some(id) => {
                let pos = list
                    .iter()
                    .position(|s| s.get("id").and_then(|v| v.as_str()) == Some(id.as_str()));
                match pos {
                    Some(i) => {
                        list[i] = item;
                        updated += 1;
                    }
                    None => {
                        list.push(item);
                        added += 1;
                    }
                }
            }
            None => {
                list.push(item);
                added += 1;
            }
        }
    }
    (list, added, updated)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsExportSummary {
    pub keys: usize,
    pub sessions: usize,
    pub path: String,
}

/// Serialize the entire settings document to `path` (pretty JSON).
#[tauri::command]
pub async fn settings_export_to_file(
    app: AppHandle,
    path: String,
) -> Result<SettingsExportSummary> {
    spawn_blocking(move || {
        let store = app.store(settings::SETTINGS_FILE)?;
        let mut map = serde_json::Map::new();
        for (key, value) in store.entries() {
            map.insert(key.clone(), value.clone());
        }
        let keys = map.len();
        let sessions = map
            .get(SESSIONS_KEY)
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        let doc = serde_json::Value::Object(map);
        std::fs::write(&path, serde_json::to_vec_pretty(&doc)?)?;
        Ok(SettingsExportSummary { keys, sessions, path })
    })
    .await
    .map_err(|e| AppError::Db(format!("export task failed: {e}")))?
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsImportSummary {
    pub keys_imported: usize,
    pub sessions_added: usize,
    pub sessions_updated: usize,
}

/// Import a settings export file. Sessions merge by id (add new, refresh
/// known) unless `replace_sessions` is true; every other key is imported
/// verbatim.
#[tauri::command]
pub async fn settings_import_from_file(
    app: AppHandle,
    path: String,
    replace_sessions: Option<bool>,
) -> Result<SettingsImportSummary> {
    spawn_blocking(move || {
        let raw = std::fs::read(&path)?;
        let imported: serde_json::Map<String, serde_json::Value> = serde_json::from_slice(&raw)
            .map_err(|e| {
                AppError::Config(format!("not a valid DBobcat settings export: {e}"))
            })?;

        let store = app.store(settings::SETTINGS_FILE)?;
        let mut summary = SettingsImportSummary {
            keys_imported: 0,
            sessions_added: 0,
            sessions_updated: 0,
        };

        for (key, value) in imported {
            if key == SESSIONS_KEY {
                let incoming = value.as_array().cloned().unwrap_or_default();
                let replace = replace_sessions.unwrap_or(false);
                let existing = store
                    .get(SESSIONS_KEY)
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default();
                let (merged, added, updated) = merge_sessions(existing, incoming, replace);
                store.set(SESSIONS_KEY, serde_json::Value::Array(merged));
                summary.sessions_added = added;
                summary.sessions_updated = updated;
            } else {
                store.set(key.clone(), value);
            }
            summary.keys_imported += 1;
        }
        store.save()?;
        Ok(summary)
    })
    .await
    .map_err(|e| AppError::Db(format!("import task failed: {e}")))?
}

#[cfg(test)]
mod settings_transfer_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn merge_adds_new_and_updates_known_by_id() {
        let existing = vec![json!({"id": "a", "name": "Old A"}), json!({"id": "b", "name": "B"})];
        let incoming = vec![
            json!({"id": "a", "name": "New A"}),
            json!({"id": "c", "name": "C"}),
        ];
        let (merged, added, updated) = merge_sessions(existing, incoming, false);
        assert_eq!(merged.len(), 3);
        assert_eq!(added, 1);
        assert_eq!(updated, 1);
        assert_eq!(merged[0], json!({"id": "a", "name": "New A"}));
        assert_eq!(merged[1], json!({"id": "b", "name": "B"}));
        assert_eq!(merged[2], json!({"id": "c", "name": "C"}));
    }

    #[test]
    fn merge_replace_swaps_whole_list() {
        let existing = vec![json!({"id": "a"})];
        let incoming = vec![json!({"id": "x"}), json!({"id": "y"})];
        let (merged, added, updated) = merge_sessions(existing, incoming, true);
        assert_eq!(merged.len(), 2);
        assert_eq!(added, 2);
        assert_eq!(updated, 0);
    }

    #[test]
    fn merge_keeps_entries_without_ids() {
        let incoming = vec![json!({"name": "no id here"})];
        let (merged, added, updated) = merge_sessions(Vec::new(), incoming, false);
        assert_eq!(merged.len(), 1);
        assert_eq!(added, 1);
        assert_eq!(updated, 0);
    }
}

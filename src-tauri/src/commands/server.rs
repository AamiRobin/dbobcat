//! Server-tool commands (Phase 7): user administration, process list +
//! kill, variables/status dashboards and the find-text-on-server scanner.
//!
//! All commands take the owning `conn_id` and route through the
//! [`ConnectionManager`] actor; find-text additionally streams
//! `find://progress` events and supports cooperative cancellation via
//! `find_text_cancel(id)`.

use tauri::{AppHandle, State};

use crate::connections::manager::ConnectionManager;
use crate::connections::{
    AlterUserRequest, CreateUserRequest, FindTextRequest, GrantDetail, GrantRequest,
    ProcessInfo, ServerVariable, StatusVariable, UserMeta,
};
use crate::error::{AppError, Result};
use crate::find_text::{self, FindTextResult};

/// Every account visible on the server.
#[tauri::command]
pub async fn user_list(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<UserMeta>> {
    connections.list_users(conn_id).await
}

/// Raw grant statements plus parsed scopes for one account.
#[tauri::command]
pub async fn user_grants_detail(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    user: String,
    host: Option<String>,
) -> Result<GrantDetail> {
    connections.show_user_grants(conn_id, user, host).await
}

/// Create a new account (MySQL `'u'@'h'`, PostgreSQL role).
#[tauri::command]
pub async fn user_create(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    req: CreateUserRequest,
) -> Result<()> {
    connections.create_user(conn_id, req).await
}

/// Alter an existing account: password/rename/plugin/lock/limits.
#[tauri::command]
pub async fn user_alter(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    user: String,
    host: Option<String>,
    req: AlterUserRequest,
) -> Result<()> {
    connections.alter_user(conn_id, user, host, req).await
}

/// Drop an account.
#[tauri::command]
pub async fn user_drop(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    user: String,
    host: Option<String>,
) -> Result<()> {
    connections.drop_user(conn_id, user, host).await
}

/// Grant or revoke privileges (allowlist-validated).
#[tauri::command]
pub async fn user_grant_revoke(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    req: GrantRequest,
) -> Result<()> {
    connections.grant_revoke(conn_id, req).await
}

/// One snapshot of server activity.
#[tauri::command]
pub async fn process_list(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<ProcessInfo>> {
    connections.list_processes(conn_id).await
}

/// Cancel (`query_only`) or kill a connection/backend.
#[tauri::command]
pub async fn process_kill(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    process_id: i64,
    query_only: bool,
) -> Result<()> {
    if process_id <= 0 {
        return Err(AppError::Db("invalid process id".into()));
    }
    connections.kill_process(conn_id, process_id, query_only).await
}

/// Server configuration variables (`SHOW VARIABLES` / `SHOW ALL`).
#[tauri::command]
pub async fn variables_list(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<ServerVariable>> {
    connections.list_variables(conn_id).await
}

/// Status counters since server start.
#[tauri::command]
pub async fn status_list(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<StatusVariable>> {
    connections.list_status(conn_id).await
}

// ---------------------------------------------------------------------------
// Find text on server
// ---------------------------------------------------------------------------

/// Scan the requested databases/tables for a text. Resolves with all
/// matches once finished (or cancelled — partial results then); progress
/// streams through `find://progress`. The returned id feeds
/// [`find_text_cancel`].
#[tauri::command]
pub async fn find_text_start(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    req: FindTextRequest,
) -> Result<FindTextResult> {
    crate::find_text::find_text(&app, connections.inner(), conn_id, req).await
}

/// Request cooperative cancellation of a running find-text scan; true when
/// the run existed. Shares the export cancellation registry.
#[tauri::command]
pub fn find_text_cancel(id: u32) -> bool {
    find_text::find_request_cancel(id)
}

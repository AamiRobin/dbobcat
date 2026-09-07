//! Server-tool commands (Phase 7): user administration, process list +
//! kill, variables/status dashboards and the find-text-on-server scanner.
//!
//! All commands take the owning `conn_id` and route through the
//! [`ConnectionManager`] actor; find-text additionally streams
//! `find://progress` events and supports cooperative cancellation via
//! `find_text_cancel(id)`.

use tauri::{AppHandle, State};

use crate::connections::manager::ConnectionManager;
use crate::connections::dialect::SqlDialect;
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

/// Validate a system-variable identifier (SET GLOBAL target). Only plain
/// identifiers are accepted — this doubles as injection defense.
fn valid_variable_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Escape a literal value for single-quoted SQL string context.
fn quote_sql_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        match c {
            '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Apply `SET GLOBAL name = value` (MySQL/MariaDB). Other engines have no
/// equivalent single-statement mechanism (PostgreSQL needs ALTER SYSTEM +
/// reload), so they report an explicit unsupported error.
#[tauri::command]
pub async fn server_set_variable(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    name: String,
    value: String,
) -> Result<()> {
    if !valid_variable_name(&name) {
        return Err(AppError::Config(format!(
            "invalid variable name: {name}"
        )));
    }
    let dialect = connections.server_info(conn_id).await?.dialect;
    let sql = match dialect {
        SqlDialect::Mysql => {
            format!(
                "SET GLOBAL {} = {}",
                name,
                quote_sql_string(&value)
            )
        }
        SqlDialect::Postgres | SqlDialect::Sqlite => {
            return Err(AppError::Config(
                "server variable editing is a MySQL/MariaDB feature".into(),
            ));
        }
    };
    let outcomes = connections.run_script(conn_id, sql.clone(), true).await?;
    if let Some(message) = first_error_message(&outcomes) {
        return Err(AppError::Db(format!("{message} — in: {sql}")));
    }
    Ok(())
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

fn first_error_message(outcomes: &[crate::connections::QueryOutcome]) -> Option<String> {
    outcomes.iter().find_map(|o| match o {
        crate::connections::QueryOutcome::Error { message, .. } => Some(message.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod server_variable_tests {
    use super::*;

    #[test]
    fn accepts_plain_identifiers() {
        assert!(valid_variable_name("max_connections"));
        assert!(valid_variable_name("innodb_buffer_pool_size"));
        assert!(valid_variable_name("SQL_MODE"));
        assert!(valid_variable_name("x1_2"));
    }

    #[test]
    fn rejects_injection_and_empty_names() {
        assert!(!valid_variable_name(""));
        assert!(!valid_variable_name("x; DROP TABLE users"));
        assert!(!valid_variable_name("a-b"));
        assert!(!valid_variable_name("`x`"));
        assert!(!valid_variable_name("x'y"));
    }

    #[test]
    fn escapes_quotes_and_backslashes_in_values() {
        assert_eq!(quote_sql_string("500"), "'500'");
        assert_eq!(quote_sql_string("o'clock"), "'o\\'clock'");
        assert_eq!(quote_sql_string("a\\b"), "'a\\\\b'");
        assert_eq!(quote_sql_string(""), "''");
    }
}

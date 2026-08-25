//! Transaction ledger IPC commands (Transactions UI Phase 1).
//!
//! Thin wrappers over the connection actor's `Tx*` commands; all ledger
//! state lives in the per-connection task, so these are safe to call from
//! any window context.

use tauri::State;

use crate::connections::manager::ConnectionManager;
use crate::connections::{IsolationLevel, TxMode, TxState};
use crate::error::Result;

/// Current transaction-ledger snapshot for one connection.
#[tauri::command]
pub async fn tx_get_state(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Option<TxState>> {
    // An unknown/closed session simply reports "no state" instead of an
    // error — the chip hides itself when disconnected anyway.
    Ok(connections.tx_get_state(conn_id).await.ok())
}

/// Switch auto-commit ↔ manual transactions.
#[tauri::command]
pub async fn tx_set_mode(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    mode: TxMode,
) -> Result<()> {
    connections.tx_set_mode(conn_id, mode).await
}

/// COMMIT the open transaction; returns the cleared entry count.
#[tauri::command]
pub async fn tx_commit(connections: State<'_, ConnectionManager>, conn_id: u32) -> Result<u64> {
    connections.tx_commit(conn_id).await
}

/// ROLLBACK (also valid for a PG-aborted transaction); returns entries cleared.
#[tauri::command]
pub async fn tx_rollback(connections: State<'_, ConnectionManager>, conn_id: u32) -> Result<u64> {
    connections.tx_rollback(conn_id).await
}

/// Apply a new session isolation level (next transactions only).
#[tauri::command]
pub async fn tx_set_isolation(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    level: IsolationLevel,
) -> Result<()> {
    connections.tx_set_isolation(conn_id, level).await
}

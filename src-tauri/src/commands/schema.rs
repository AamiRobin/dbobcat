//! Schema browsing commands — all routed through the ConnectionManager to
//! the owning per-connection task.

use tauri::State;

use crate::connections::manager::ConnectionManager;
use crate::connections::{ColumnMeta, DatabaseInfo, TableMeta};
use crate::error::Result;

#[tauri::command]
pub async fn db_list_databases(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<DatabaseInfo>> {
    connections.list_databases(conn_id).await
}

#[tauri::command]
pub async fn db_list_tables(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<TableMeta>> {
    connections.list_tables(conn_id, &db).await
}

#[tauri::command]
pub async fn db_describe_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
) -> Result<Vec<ColumnMeta>> {
    connections.describe_table(conn_id, &db, &table).await
}



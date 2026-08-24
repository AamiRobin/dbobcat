//! Export commands (Phase 5) — grid/data exports, SQL dumps, DDL bundles,
//! native save/open dialogs and export cancellation.
//!
//! Heavy work happens in Rust (streaming writers); only [`ExportResult`]
//! summaries cross IPC. File collisions surface as `AppError::Exists`
//! ("file exists: …") so the frontend can confirm and retry with
//! `overwrite = true`.

use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tokio::task::spawn_blocking;

use crate::connections::manager::ConnectionManager;
use crate::connections::RowValue;
use crate::error::Result;
use crate::export::{
    request_cancel, DdlObjectRequest, ExportDestination, ExportFormat, ExportResult,
    GridExportOptions,
};
use crate::export::sql_dump::SqlDumpOptions;

/// Native-dialog file filter (`name` + allowed `extensions`, no dots).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

// ---------------------------------------------------------------------------
// Native dialogs
// ---------------------------------------------------------------------------

/// Open a native "save file" dialog; `None` when the user cancels.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    default_name: Option<String>,
    filters: Vec<FileDialogFilter>,
) -> Result<Option<String>> {
    spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(name) = &default_name {
            dialog = dialog.set_file_name(name);
        }
        for filter in &filters {
            let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(&filter.name, &exts);
        }
        Ok(dialog.blocking_save_file().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
    })
    .await
    .map_err(|e| crate::error::AppError::Db(format!("dialog task failed: {e}")))?
}

/// Open a native "open file" dialog; `None` when the user cancels.
#[tauri::command]
pub async fn pick_open_path(app: AppHandle, filters: Vec<FileDialogFilter>) -> Result<Option<String>> {
    spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        for filter in &filters {
            let exts: Vec<&str> = filter.extensions.iter().map(|s| s.as_str()).collect();
            dialog = dialog.add_filter(&filter.name, &exts);
        }
        Ok(dialog.blocking_pick_file().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string()))
    })
    .await
    .map_err(|e| crate::error::AppError::Db(format!("dialog task failed: {e}")))?
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/// Export grid rows or a query result. Exactly one source wins:
/// 1. explicit `selection_columns`/`selection_rows` (client-side selection),
/// 2. `table` (whole-table scan),
/// 3. `sql` (arbitrary single SELECT).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn export_grid_data(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: Option<String>,
    table: Option<String>,
    sql: Option<String>,
    selection_columns: Option<Vec<String>>,
    selection_rows: Option<Vec<Vec<RowValue>>>,
    format: ExportFormat,
    destination: ExportDestination,
    options: GridExportOptions,
    overwrite: bool,
) -> Result<ExportResult> {
    let selection = match (selection_columns, selection_rows) {
        (Some(cols), Some(rows)) => Some((cols, rows)),
        _ => None,
    };
    crate::export::export_grid(
        &app,
        connections.inner(),
        conn_id,
        db,
        table,
        sql,
        selection,
        format,
        destination,
        options,
        overwrite,
    )
    .await
}

/// Generate a full SQL dump ("Export database as SQL").
#[tauri::command]
pub async fn export_sql_dump(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    options: SqlDumpOptions,
    destination: ExportDestination,
    overwrite: bool,
) -> Result<ExportResult> {
    crate::export::export_sql_dump(&app, connections.inner(), conn_id, options, destination, overwrite)
        .await
}

/// Copy the CREATE definitions of the requested objects to file/clipboard.
#[tauri::command]
pub async fn export_objects_ddl(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    requests: Vec<DdlObjectRequest>,
    destination: ExportDestination,
    title: Option<String>,
    overwrite: bool,
) -> Result<ExportResult> {
    crate::export::export_objects_ddl(
        &app,
        connections.inner(),
        conn_id,
        requests,
        destination,
        title,
        overwrite,
    )
    .await
}

/// Request cooperative cancellation of a running export.
#[tauri::command]
pub fn export_cancel(id: u32) -> bool {
    request_cancel(id)
}

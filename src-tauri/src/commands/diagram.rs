//! ER diagram commands (Phase 11) — whole-schema batch loaders and the
//! frontend-generated export writer.
//!
//! The diagram needs every table's columns plus every foreign key of one
//! schema up front (batch-first, no per-table fan-out on the happy path);
//! `dia_export_file` persists bytes the WEBVIEW already rendered (PNG/SVG),
//! honoring the `AppError::Exists` confirm-and-overwrite convention used by
//! the export engine.

use tauri::State;

use crate::connections::manager::ConnectionManager;
use crate::connections::{ForeignKeyMeta, TableSchemaData};
use crate::error::{AppError, Result};

#[tauri::command]
pub async fn dia_describe_tables(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<TableSchemaData>> {
    connections.list_schema_columns(conn_id, &db).await
}

#[tauri::command]
pub async fn dia_list_foreign_keys(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<ForeignKeyMeta>> {
    connections.list_schema_foreign_keys(conn_id, &db).await
}

/// Write frontend-generated export bytes to `path`. Unless `overwrite` is
/// set, an existing file yields [`AppError::Exists`] so the UI can confirm
/// first. Returns the number of bytes written.
#[tauri::command]
pub async fn dia_export_file(path: String, bytes: Vec<u8>, overwrite: bool) -> Result<u64> {
    let len = bytes.len() as u64;
    tokio::task::spawn_blocking(move || {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true);
        if overwrite {
            opts.create(true).truncate(true);
        } else {
            opts.create_new(true);
        }
        let file = opts.open(&path).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::Exists(path.clone())
            } else {
                e.into()
            }
        })?;
        std::io::Write::write_all(&mut &file, &bytes)?;
        Ok(len)
    })
    .await
    .map_err(|e| AppError::Db(format!("export task failed: {e}")))?
}

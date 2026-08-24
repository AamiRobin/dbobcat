//! Data grid commands (Phase 2) — paged reads, changeset posting, counts.
//!
//! All commands route through the ConnectionManager to the owning
//! per-connection task, so grid traffic stays serialized with everything
//! else on that session.

use tauri::State;

use crate::connections::manager::ConnectionManager;
use crate::connections::{
    ApplyChangesRequest, ApplyChangesResult, FilterSpec, QueryPageResult,
};
use crate::error::Result;

#[tauri::command]
#[allow(clippy::too_many_arguments)] // flat wire signature (Tauri maps by name)
pub async fn data_query_page(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    page_size: Option<u32>,
    offset: Option<u64>,
    order_by: Option<Vec<crate::connections::SortSpec>>,
    filter: Option<FilterSpec>,
) -> Result<QueryPageResult> {
    let req = crate::connections::QueryPageRequest {
        db,
        table,
        page_size: page_size.unwrap_or(1000),
        offset: offset.unwrap_or(0),
        order_by: order_by.unwrap_or_default(),
        filter,
    };
    connections.query_page(conn_id, req).await
}

#[tauri::command]
pub async fn data_apply_changes(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    req: ApplyChangesRequest,
) -> Result<ApplyChangesResult> {
    connections.apply_changes(conn_id, req).await
}

/// Exact `COUNT(*)` honouring an optional filter; `null` when uncountable.
#[tauri::command]
pub async fn data_count_rows(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    filter: Option<FilterSpec>,
) -> Result<Option<u64>> {
    connections.count_rows(conn_id, &db, &table, filter).await
}

/// Distinct values of one column for the quick-filter "More values…" dialog
/// (most frequent first, NULLs grouped and counted).
#[tauri::command]
pub async fn data_distinct_values(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    column: String,
    limit: Option<u32>,
    search: Option<String>,
) -> Result<Vec<crate::connections::DistinctValue>> {
    connections
        .distinct_values(conn_id, &db, &table, &column, limit.unwrap_or(200), search.as_deref())
        .await
}

/// Top-N rows of a foreign key's referenced table (grid editor dropdown).
#[tauri::command]
pub async fn data_fk_ref_values(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    fk_name: String,
    limit: Option<u32>,
) -> Result<crate::connections::FkRefValues> {
    connections
        .fk_ref_values(conn_id, &db, &table, &fk_name, limit.unwrap_or(100))
        .await
}

//! IPC command registry.
//!
//! Convention: one `#[tauri::command]` per file/module grouped by domain,
//! all registered in [`register_commands`] and named `<domain>_<verb_object>`
//! (snake_case), e.g. `db_list_databases`. See `src/lib/ipc.ts` on the
//! frontend for the JS-side mirror of this convention.
//!
//! Note: the registry is deliberately **not** generic over `Runtime`.
//! Commands take concrete `tauri::AppHandle` (i.e. `AppHandle<Wry>`); a
//! generic `R: Runtime` wrapper would make those trait bounds unprovable
//! inside `generate_handler!` (tauri-apps/tauri#4919).

pub mod app;
pub mod data;
pub mod diagram;
pub mod export;
pub mod import;
pub mod objects;
pub mod query;
pub mod schema;
pub mod server;
pub mod sessions;
pub mod snippets;

/// Health-check command proving the IPC round-trip end to end.
#[tauri::command]
pub fn ping() -> String {
    format!("pong v{}", env!("CARGO_PKG_VERSION"))
}

/// Registers every command with the Tauri builder. Keep this exhaustive —
/// a command missing here is invisible to the frontend.
pub fn register_commands(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.invoke_handler(tauri::generate_handler![
        ping,
        // app shell (Phase 8)
        app::app_take_launch_intent,
        app::app_exit,
        app::clipboard_read_text,
        // generic settings access (Phase 9-B)
        app::app_settings_get,
        app::app_settings_set,
        // sessions
        sessions::session_list,
        sessions::session_save,
        sessions::session_delete,
        sessions::session_test,
        sessions::session_connect,
        sessions::session_disconnect,
        // schema browsing
        schema::db_list_databases,
        schema::db_list_tables,
        schema::db_describe_table,
        // data grid
        data::data_query_page,
        data::data_apply_changes,
        data::data_count_rows,
        data::data_distinct_values,
        data::data_fk_ref_values,
        // query editor
        query::query_run_script,
        query::query_history_list,
        query::query_history_clear,
        // SQL snippets (Phase 9-B helpers panel)
        snippets::snippet_list,
        snippets::snippet_save,
        snippets::snippet_delete,
        // object management (Phase 4)
        objects::obj_get_table_ddl,
        objects::obj_list_indexes,
        objects::obj_list_foreign_keys,
        objects::obj_list_referencing_foreign_keys,
        objects::obj_create_table,
        objects::obj_alter_table,
        objects::obj_drop_objects,
        objects::obj_rename_table,
        objects::obj_empty_clone_table,
        objects::obj_copy_table,
        objects::obj_truncate_tables,
        objects::obj_list_routines,
        objects::obj_get_routine_ddl,
        objects::obj_list_triggers,
        objects::obj_get_trigger_ddl,
        objects::obj_get_view_ddl,
        objects::obj_list_events,
        objects::obj_get_event_ddl,
        objects::obj_execute_sql,
        objects::obj_maintenance,
        // export / import (Phase 5)
        export::export_grid_data,
        export::export_sql_dump,
        export::export_objects_ddl,
        export::export_cancel,
        export::pick_save_path,
        export::pick_open_path,
        import::import_csv_preview,
        import::import_csv_run,
        import::import_sql_file,
        // server tools (Phase 7)
        server::user_list,
        server::user_grants_detail,
        server::user_create,
        server::user_alter,
        server::user_drop,
        server::user_grant_revoke,
        server::process_list,
        server::process_kill,
        server::variables_list,
        server::status_list,
        server::find_text_start,
        server::find_text_cancel,
        // ER diagram (Phase 11)
        diagram::dia_describe_tables,
        diagram::dia_list_foreign_keys,
        diagram::dia_export_file,
    ])
}

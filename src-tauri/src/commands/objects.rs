//! Object management commands (Phase 4) — table designer DDL, object code
//! editors, drops/renames/clones and maintenance.
//!
//! Pure builders (`alter_builder`) generate the SQL; execution reuses the
//! per-connection actor either statement-by-statement through `run_script`
//! (per-object error capture) or as one raw statement via `execute_single`
//! (compound CREATE PROCEDURE bodies).

use tauri::State;

use crate::connections::dialect::SqlDialect;
use crate::connections::manager::ConnectionManager;
use crate::connections::postgres::AlterPlan;
use crate::connections::{
    alter_builder, postgres as pg, sqlite as lite, ForeignKeyMeta, IndexMeta, MaintenanceOp,
    MaintenanceResult, ObjectKind, ObjectOpResult, QueryOutcome, RowValue, RoutineKind,
    RoutineMeta, ShowCreateResult, TableDdl,
};
use crate::connections::{AlterResult, CreateTableRequest, EventMeta, TriggerMeta};
use crate::error::{AppError, Result};

// ---------------------------------------------------------------------------
// Table designer
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn obj_get_table_ddl(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
) -> Result<TableDdl> {
    connections.get_table_ddl(conn_id, &db, &table).await
}

/// Indexes of a table — projected from the parsed DDL so SHOW CREATE TABLE
/// stays the single source of truth.
#[tauri::command]
pub async fn obj_list_indexes(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
) -> Result<Vec<IndexMeta>> {
    Ok(connections.get_table_ddl(conn_id, &db, &table).await?.indexes)
}

/// Foreign keys of a table — same single-source-of-truth projection.
#[tauri::command]
pub async fn obj_list_foreign_keys(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
) -> Result<Vec<ForeignKeyMeta>> {
    Ok(connections
        .get_table_ddl(conn_id, &db, &table)
        .await?
        .foreign_keys)
}

/// Foreign keys pointing AT a table (reverse view; Phase 10-B FK navigation).
#[tauri::command]
pub async fn obj_list_referencing_foreign_keys(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
) -> Result<Vec<ForeignKeyMeta>> {
    connections
        .list_referencing_foreign_keys(conn_id, &db, &table)
        .await
}

/// Create a table from the designer's request; returns the server's final
/// CREATE TABLE text on success.
#[tauri::command]
pub async fn obj_create_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    req: CreateTableRequest,
) -> Result<String> {
    let dialect = connections.server_info(conn_id).await?.dialect;
    let sql = match dialect {
        SqlDialect::Mysql => alter_builder::build_create_table(&db, &req)?,
        SqlDialect::Postgres => pg::pg_create_table(&db, &req)?,
        SqlDialect::Sqlite => lite::lite_create_table(&db, &req)?,
    };
    let outcomes = connections.run_script(conn_id, sql.clone(), true).await?;
    if let Some(message) = first_error_message(&outcomes) {
        return Err(AppError::Db(format!("{message} — in: {sql}")));
    }
    let ddl = connections.get_table_ddl(conn_id, &db, &req.name).await?;
    Ok(ddl.create_sql)
}

/// Preview (`dry_run`) or apply a designer diff. Applying executes the
/// statements sequentially and stops at the first failure; `executed`
/// carries the statements that succeeded before the error.
#[tauri::command]
pub async fn obj_alter_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    desired_ddl: TableDdl,
    dry_run: bool,
) -> Result<AlterResult> {
    let current = connections.get_table_ddl(conn_id, &db, &table).await?;
    let dialect = connections.server_info(conn_id).await?.dialect;
    let plan = match dialect {
        SqlDialect::Mysql => {
            let p =
                alter_builder::build_alter_table(&db, &table, &current, &desired_ddl)?;
            AlterPlan {
                statements: p.statements,
                warnings: p.warnings,
            }
        }
        SqlDialect::Postgres => {
            let p = pg::pg_alter_plan(&db, &current, &desired_ddl)?;
            AlterPlan {
                statements: p.statements,
                warnings: p.warnings,
            }
        }
        SqlDialect::Sqlite => {
            let p = lite::lite_alter_plan(&current, &desired_ddl)?;
            AlterPlan {
                statements: p.statements,
                warnings: p.warnings,
            }
        }
    };

    if dry_run {
        return Ok(AlterResult {
            statements: plan.statements,
            warnings: plan.warnings,
            executed: Vec::new(),
            error: None,
        });
    }

    let mut executed: Vec<String> = Vec::new();
    for stmt in plan.statements {
        let outcomes = connections.run_script(conn_id, stmt.clone(), true).await?;
        if let Some(message) = first_error_message(&outcomes) {
            return Ok(AlterResult {
                statements: Vec::new(),
                warnings: plan.warnings,
                executed,
                error: Some(format!("{message} — in: {stmt}")),
            });
        }
        executed.push(stmt);
    }

    Ok(AlterResult {
        statements: Vec::new(),
        warnings: plan.warnings,
        executed,
        error: None,
    })
}

// ---------------------------------------------------------------------------
// Bulk operations / table CRUD helpers
// ---------------------------------------------------------------------------

fn drop_sql(dialect: SqlDialect, db: &str, kind: ObjectKind, name: &str) -> Result<String> {
    use crate::connections::quote_qualified;
    match dialect {
        SqlDialect::Mysql => {
            let qualified = quote_qualified(&[db, name]);
            Ok(match kind {
                ObjectKind::Table => format!("DROP TABLE {qualified}"),
                ObjectKind::View => format!("DROP VIEW {qualified}"),
                ObjectKind::Routine => format!("DROP PROCEDURE {qualified}"),
                ObjectKind::Trigger => format!("DROP TRIGGER {qualified}"),
                ObjectKind::Event => format!("DROP EVENT {qualified}"),
            })
        }
        SqlDialect::Postgres => pg::pg_drop_sql(db, kind, name),
        SqlDialect::Sqlite => lite::lite_drop_sql(kind, name),
    }
}

/// Extract the message of the first Error outcome, if any.
fn first_error_message(outcomes: &[QueryOutcome]) -> Option<String> {
    outcomes.iter().find_map(|o| match o {
        QueryOutcome::Error { message, .. } => Some(message.clone()),
        _ => None,
    })
}

fn outcome_result_text(outcomes: &[QueryOutcome]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for outcome in outcomes {
        match outcome {
            QueryOutcome::ResultSet { rows, .. } => {
                for row in rows {
                    let cells: Vec<String> =
                        row.iter().map(row_value_text).collect();
                    lines.push(cells.join(" · "));
                }
            }
            QueryOutcome::Exec { affected, info, .. } => {
                let info_text = info.clone().filter(|i| !i.is_empty());
                lines.push(match info_text {
                    Some(info) => format!("{info} ({affected} affected)"),
                    None => format!("OK ({affected} affected)"),
                });
            }
            QueryOutcome::Error { message, .. } => lines.push(format!("ERROR: {message}")),
        }
    }
    if lines.is_empty() {
        "OK".into()
    } else {
        lines.join("\n")
    }
}

fn row_value_text(value: &RowValue) -> String {
    match value {
        RowValue::Null => String::new(),
        RowValue::Int(v) => v.to_string(),
        RowValue::UInt(v) => v.to_string(),
        RowValue::Float(v) => v.to_string(),
        RowValue::Str(s) => s.clone(),
        RowValue::Bytes(_) => "<binary>".into(),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => s.clone(),
    }
}

/// Drop tables/views/routines/triggers/events with a per-object result.
#[tauri::command]
pub async fn obj_drop_objects(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    requests: Vec<crate::connections::DropObjectRequest>,
) -> Result<Vec<ObjectOpResult>> {
    let dialect = connections.server_info(conn_id).await?.dialect;
    let mut results = Vec::with_capacity(requests.len());
    for req in requests {
        let sql = match drop_sql(dialect, &req.db, req.kind, &req.name) {
            Ok(sql) => sql,
            Err(err) => {
                results.push(ObjectOpResult {
                    name: req.name,
                    ok: false,
                    error: Some(err.to_string()),
                });
                continue;
            }
        };
        let outcomes = connections.run_script(conn_id, sql, true).await?;
        match first_error_message(&outcomes) {
            Some(error) => results.push(ObjectOpResult {
                name: req.name,
                ok: false,
                error: Some(error),
            }),
            None => results.push(ObjectOpResult { name: req.name, ok: true, error: None }),
        }
    }
    Ok(results)
}

#[tauri::command]
pub async fn obj_rename_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    new_db: Option<String>,
    new_name: String,
) -> Result<()> {
    use crate::connections::quote_qualified;
    let target_db = new_db.unwrap_or_else(|| db.clone());
    let dialect = connections.server_info(conn_id).await?.dialect;
    let sql = match dialect {
        SqlDialect::Mysql => {
            format!(
                "ALTER TABLE {} RENAME TO {}",
                quote_qualified(&[&db, &table]),
                quote_qualified(&[&target_db, &new_name])
            )
        }
        SqlDialect::Postgres => pg::pg_rename_sql(&db, &table, &target_db, &new_name)?,
        SqlDialect::Sqlite => {
            if target_db != db {
                return Err(AppError::Unsupported(
                    "SQLite tables live in a single database file".into(),
                ));
            }
            lite::lite_rename_sql(&table, &new_name)
        }
    };
    let outcomes = connections.run_script(conn_id, sql, true).await?;
    match first_error_message(&outcomes) {
        Some(message) => Err(AppError::Db(message)),
        None => Ok(()),
    }
}

/// Create a full copy of one table on the same connection (Phase 9-B):
/// CREATE TABLE from the parsed source DDL (honoring the copy flags) plus,
/// optionally, `INSERT INTO dst SELECT * FROM src`. Cross-database copies
/// work on MySQL only — PostgreSQL databases are separate clusters and
/// SQLite sessions open a single file.
///
/// Returns the number of rows copied (0 for structure-only).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // mirrors the dialog's field set
pub async fn obj_copy_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    src_db: String,
    src_table: String,
    dst_db: String,
    dst_name: String,
    copy_data: bool,
    copy_indexes: bool,
    copy_fks: bool,
) -> Result<u64> {
    use crate::connections::alter_builder::build_copy_request;

    let name = dst_name.trim();
    if name.is_empty() {
        return Err(AppError::Config("table name must not be empty".into()));
    }

    let dialect = connections.server_info(conn_id).await?.dialect;
    if dst_db != src_db && dialect != SqlDialect::Mysql {
        return Err(AppError::Unsupported(match dialect {
            SqlDialect::Postgres => {
                "cross-database copies are not supported by PostgreSQL".into()
            }
            _ => "SQLite tables live in a single database file".into(),
        }));
    }

    let ddl = connections.get_table_ddl(conn_id, &src_db, &src_table).await?;
    let request = build_copy_request(&ddl, name, copy_indexes, copy_fks);
    let create_sql = match dialect {
        SqlDialect::Mysql => alter_builder::build_create_table(&dst_db, &request)?,
        SqlDialect::Postgres => pg::pg_create_table(&dst_db, &request)?,
        SqlDialect::Sqlite => lite::lite_create_table(&dst_db, &request)?,
    };

    let create_outcomes = connections
        .run_script(conn_id, create_sql.clone(), true)
        .await?;
    if let Some(message) = first_error_message(&create_outcomes) {
        return Err(AppError::Db(format!("{message} — in: {create_sql}")));
    }

    if !copy_data {
        return Ok(0);
    }

    let insert_sql = format!(
        "INSERT INTO {} SELECT * FROM {}",
        dialect.quote_qualified(&[&dst_db, name]),
        dialect.quote_qualified(&[&src_db, &src_table])
    );
    let insert_outcomes = connections
        .run_script(conn_id, insert_sql.clone(), true)
        .await?;
    if let Some(message) = first_error_message(&insert_outcomes) {
        return Err(AppError::Db(format!("{message} — in: {insert_sql}")));
    }
    Ok(insert_outcomes.iter().filter_map(|o| match o {
        QueryOutcome::Exec { affected, .. } => Some(*affected),
        _ => None,
    }).sum())
}

#[tauri::command]
pub async fn obj_empty_clone_table(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    new_db: String,
    new_name: String,
) -> Result<()> {
    use crate::connections::quote_qualified;
    let dialect = connections.server_info(conn_id).await?.dialect;
    let sql = match dialect {
        SqlDialect::Mysql => format!(
            "CREATE TABLE {} LIKE {}",
            quote_qualified(&[&new_db, &new_name]),
            quote_qualified(&[&db, &table])
        ),
        // LIKE with constraints/indexes is the closest parity to MySQL's clone.
        SqlDialect::Postgres => {
            if new_db != db {
                return Err(AppError::Unsupported(
                    "cross-database clones are not supported by PostgreSQL".into(),
                ));
            }
            pg::pg_empty_clone_sql(&db, &table, &new_name)
        }
        SqlDialect::Sqlite => {
            if new_db != db {
                return Err(AppError::Unsupported(
                    "SQLite tables live in a single database file".into(),
                ));
            }
            format!(
                "CREATE TABLE {} AS SELECT * FROM {} WHERE 0",
                SqlDialect::Sqlite.quote_ident(&new_name),
                SqlDialect::Sqlite.quote_ident(&table)
            )
        }
    };
    let outcomes = connections.run_script(conn_id, sql, true).await?;
    match first_error_message(&outcomes) {
        Some(message) => Err(AppError::Db(message)),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn obj_truncate_tables(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    names: Vec<String>,
) -> Result<Vec<ObjectOpResult>> {
    let dialect = connections.server_info(conn_id).await?.dialect;
    let mut results = Vec::with_capacity(names.len());
    for name in names {
        let sql = match dialect {
            SqlDialect::Mysql => format!(
                "TRUNCATE TABLE {}",
                crate::connections::quote_qualified(&[&db, &name])
            ),
            SqlDialect::Postgres => pg::pg_truncate_sql(&db, &name),
            SqlDialect::Sqlite => lite::lite_truncate_sql(&name),
        };
        let outcomes = connections.run_script(conn_id, sql, true).await?;
        match first_error_message(&outcomes) {
            Some(error) => results.push(ObjectOpResult {
                name,
                ok: false,
                error: Some(error),
            }),
            None => results.push(ObjectOpResult { name, ok: true, error: None }),
        }
    }
    Ok(results)
}

// ---------------------------------------------------------------------------
// Views / routines / triggers / events
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn obj_list_routines(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<RoutineMeta>> {
    connections.list_routines(conn_id, &db).await
}

#[tauri::command]
pub async fn obj_get_routine_ddl(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    name: String,
    kind: RoutineKind,
) -> Result<ShowCreateResult> {
    connections.get_routine_ddl(conn_id, &db, &name, kind).await
}

#[tauri::command]
pub async fn obj_list_triggers(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<TriggerMeta>> {
    connections.list_triggers(conn_id, &db).await
}

#[tauri::command]
pub async fn obj_get_trigger_ddl(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    name: String,
) -> Result<ShowCreateResult> {
    connections.get_trigger_ddl(conn_id, &db, &name).await
}

#[tauri::command]
pub async fn obj_get_view_ddl(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    name: String,
) -> Result<ShowCreateResult> {
    connections.get_view_ddl(conn_id, &db, &name).await
}

#[tauri::command]
pub async fn obj_list_events(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
) -> Result<Vec<EventMeta>> {
    connections.list_events(conn_id, &db).await
}

#[tauri::command]
pub async fn obj_get_event_ddl(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    name: String,
) -> Result<ShowCreateResult> {
    connections.get_event_ddl(conn_id, &db, &name).await
}

/// Execute edited object SQL as ONE raw statement (no client-side splitting,
/// so BEGIN...END bodies survive); used by the object code editors.
#[tauri::command]
pub async fn obj_execute_sql(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    sql: String,
) -> Result<()> {
    connections.execute_single(conn_id, sql).await.map(|_| ())
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/// Run one maintenance operation per table and collect textual output.
#[tauri::command]
pub async fn obj_maintenance(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    tables: Vec<String>,
    op: MaintenanceOp,
) -> Result<Vec<MaintenanceResult>> {
    let dialect = connections.server_info(conn_id).await?.dialect;
    let verb_of = move |table: &str| -> Result<String> {
        match dialect {
            SqlDialect::Mysql => Ok(format!(
                "{} {}",
                op.sql_verb(),
                crate::connections::quote_qualified(&[&db, table])
            )),
            SqlDialect::Postgres => pg::pg_maintenance_sql(op, &db, table),
            SqlDialect::Sqlite => lite::lite_maintenance_sql(op, table),
        }
    };
    let mut results = Vec::with_capacity(tables.len());
    for table in tables {
        let sql = verb_of(&table)?;
        let outcomes = connections.run_script(conn_id, sql, false).await?;
        results.push(MaintenanceResult {
            table,
            result_text: outcome_result_text(&outcomes),
        });
    }
    Ok(results)
}

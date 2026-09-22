//! Schema browsing commands — all routed through the ConnectionManager to
//! the owning per-connection task.

use tauri::State;

use crate::connections::dialect::SqlDialect;
use crate::connections::manager::ConnectionManager;
use crate::connections::{ColumnMeta, DatabaseInfo, TableMeta};
use crate::error::{AppError, Result};

#[tauri::command]
pub async fn db_list_databases(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<Vec<DatabaseInfo>> {
    connections.list_databases(conn_id).await
}

/// Create a database (MySQL/MariaDB, PostgreSQL). SQLite has no container
/// databases — a "new database" there is a new session file — so it is
/// rejected explicitly.
#[tauri::command]
pub async fn db_create_database(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    name: String,
    charset: Option<String>,
    collation: Option<String>,
) -> Result<()> {
    let dialect = connections.server_info(conn_id).await?.dialect;
    let sql = build_create_database_sql(dialect, &name, charset.as_deref(), collation.as_deref())?;
    let outcomes = connections.run_script(conn_id, sql.clone(), true).await?;
    if let Some(message) = first_error_message(&outcomes) {
        return Err(AppError::Db(format!("{message} — in: {sql}")));
    }
    Ok(())
}

/// Pure SQL builder so the dialect shapes stay unit-testable. Charset and
/// collation travel as quoted identifiers, so no free-text can break out.
fn build_create_database_sql(
    dialect: SqlDialect,
    name: &str,
    charset: Option<&str>,
    collation: Option<&str>,
) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::Config("database name is empty".into()));
    }
    let charset = charset.map(str::trim).filter(|s| !s.is_empty());
    let collation = collation.map(str::trim).filter(|s| !s.is_empty());
    match dialect {
        SqlDialect::Mysql => {
            let mut sql = format!("CREATE DATABASE {}", dialect.quote_ident(name));
            if let Some(cs) = charset {
                sql.push_str(&format!(
                    " DEFAULT CHARACTER SET {}",
                    dialect.quote_ident(cs)
                ));
            }
            if let Some(col) = collation {
                sql.push_str(&format!(" COLLATE {}", dialect.quote_ident(col)));
            }
            Ok(sql)
        }
        SqlDialect::Postgres => Ok(format!("CREATE DATABASE {}", dialect.quote_ident(name))),
        // SQLite is file-per-database; the session form creates files.
        SqlDialect::Sqlite => Err(AppError::Config(
            "creating databases is a MySQL/PostgreSQL feature — SQLite is file-per-database".into(),
        )),
    }
}

fn first_error_message(outcomes: &[crate::connections::QueryOutcome]) -> Option<String> {
    outcomes.iter().find_map(|o| match o {
        crate::connections::QueryOutcome::Error { message, .. } => Some(message.clone()),
        _ => None,
    })
}

#[cfg(test)]
mod create_database_tests {
    use super::*;

    #[test]
    fn mysql_plain_create() {
        let sql = build_create_database_sql(SqlDialect::Mysql, "shop", None, None).unwrap();
        assert_eq!(sql, "CREATE DATABASE `shop`");
    }

    #[test]
    fn mysql_charset_and_collation_append_in_order() {
        let sql = build_create_database_sql(
            SqlDialect::Mysql,
            "shop",
            Some("utf8mb4"),
            Some("utf8mb4_0900_ai_ci"),
        )
        .unwrap();
        assert_eq!(
            sql,
            "CREATE DATABASE `shop` DEFAULT CHARACTER SET `utf8mb4` COLLATE `utf8mb4_0900_ai_ci`"
        );
    }

    #[test]
    fn blank_charset_and_collation_are_omitted() {
        let sql =
            build_create_database_sql(SqlDialect::Mysql, "shop", Some("  "), Some("")).unwrap();
        assert_eq!(sql, "CREATE DATABASE `shop`");
    }

    #[test]
    fn names_and_charsets_are_quoted_against_injection() {
        let sql =
            build_create_database_sql(SqlDialect::Mysql, "a`b", Some("x`; DROP DATABASE y"), None)
                .unwrap();
        assert_eq!(
            sql,
            "CREATE DATABASE `a``b` DEFAULT CHARACTER SET `x``; DROP DATABASE y`"
        );
    }

    #[test]
    fn postgres_uses_double_quotes_and_ignores_mysql_options() {
        let sql = build_create_database_sql(SqlDialect::Postgres, "we\"ird", Some("utf8mb4"), None)
            .unwrap();
        assert_eq!(sql, "CREATE DATABASE \"we\"\"ird\"");
    }

    #[test]
    fn empty_name_is_rejected_on_every_dialect() {
        for dialect in [SqlDialect::Mysql, SqlDialect::Postgres, SqlDialect::Sqlite] {
            let err = build_create_database_sql(dialect, "   ", None, None).unwrap_err();
            assert!(err.to_string().contains("empty"));
        }
    }

    #[test]
    fn sqlite_is_rejected() {
        let err = build_create_database_sql(SqlDialect::Sqlite, "shop", None, None).unwrap_err();
        assert!(err.to_string().contains("file-per-database"));
    }
}

/// Drop the connection's cached column metadata. Fired by the tree Refresh
/// so the grid's validated schema can't disagree with the freshly loaded
/// tree after external DDL.
#[tauri::command]
pub async fn db_clear_schema_cache(
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
) -> Result<()> {
    connections.clear_schema_cache(conn_id).await
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



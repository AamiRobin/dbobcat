//! SQLite driver built on `rusqlite` (bundled SQLite) behind a tokio
//! blocking-task bridge (Phase 6).
//!
//! A SQLite "session" opens one database FILE (`host` carries the path).
//! The [`rusqlite::Connection`] lives inside an `Arc<std::sync::Mutex>` so
//! every async trait method can hop onto `spawn_blocking` and run its
//! synchronous queries there; results stream back through the usual chunk
//! channel with `blocking_send`.
//!
//! Deviations (P6 scope, matching the task notes):
//! - ALTER support covers ADD COLUMN / RENAME (table+column) / DROP COLUMN /
//!   index maintenance. Anything else (type/nullability/default/FK changes,
//!   table options) returns a clear Unsupported error — SQLite itself only
//!   supports those via a recreate-and-copy recipe.
//! - Maintenance maps Optimize→`VACUUM` (whole file) and Analyze→`ANALYZE`.

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::Utc;
use rusqlite::types::Value as SqValue;
use rusqlite::types::ValueRef;
use rusqlite::Connection;
use tokio::sync::mpsc;

use crate::connections::dialect::SqlDialect;
use crate::connections::script::split_sqlite;
use crate::connections::sql::{
    build_change_sql, build_distinct_values_sql, build_order_by_clause, build_page_sql,
    build_where_clause, build_where_clause_and, validate_column,
};
use crate::connections::traits::DbConnection;
use crate::connections::{
    ApplyChangesRequest, ApplyChangesResult, ColumnDef, ColumnMeta,
    DatabaseInfo, DefaultKind, DistinctValue, EventMeta, ExecResult, FilterSpec, ForeignKeyMeta,
    IndexKind, IndexMeta, MaintenanceOp, ObjectKind, QueryOutcome, QueryPageRequest,
    QueryPageResult, ResolvedConnectionConfig, ResultColumnMeta, RowError, RowValue, RowsChunk,
    RoutineKind, RoutineMeta, ServerInfo, ShowCreateKind, ShowCreateResult, TableDdl,
    TableKind, TableMeta, TableOptions, TriggerMeta,
};
use crate::error::{AppError, Result};

/// Hard ceiling on a single page read.
const MAX_PAGE_SIZE: u32 = 50_000;
/// Per-result-set fetch ceiling for scripts.
const MAX_SCRIPT_RESULT_ROWS: usize = 100_000;
/// Upper bound on one streamed export chunk.
const MAX_STREAM_CHUNK: usize = 10_000;
/// SQLite's modern default parameter ceiling (bundled >= 3.32).
const MAX_BIND_PARAMS: usize = 32_000;

/// One raw `PRAGMA foreign_key_list` row of a referencing child:
/// `(child_table, fk_id, ref_table, from_col, to_col, on_update, on_delete)`.
pub(crate) type LiteFkRow = (
    String,
    i64,
    String,
    String,
    Option<String>,
    String,
    String,
);

/// Group raw `PRAGMA foreign_key_list` rows that reference `parent_table`
/// into one [`ForeignKeyMeta`] per (child table, FK id). Rows must already
/// be filtered to the parent; `to_col` may be NULL when the child references
/// an implicit parent PK.
pub(crate) fn group_lite_referencing_fks(
    parent_table: &str,
    raw: Vec<LiteFkRow>,
) -> Vec<ForeignKeyMeta> {
    let mut groups: std::collections::BTreeMap<(String, i64), ForeignKeyMeta> =
        std::collections::BTreeMap::new();
    for (child_table, id, _, from_col, to_col, on_update, on_delete) in raw {
        let key = (child_table.clone(), id);
        match groups.get_mut(&key) {
            Some(fk) => {
                fk.columns.push(from_col);
                fk.ref_columns.push(to_col.unwrap_or_default());
            }
            None => {
                groups.insert(
                    key,
                    ForeignKeyMeta {
                        name: format!("FK_{id}_{child_table}"),
                        columns: vec![from_col],
                        ref_db: None,
                        ref_table: parent_table.to_string(),
                        ref_columns: vec![to_col.unwrap_or_default()],
                        on_update: Some(on_update),
                        on_delete: Some(on_delete),
                        table: Some(child_table),
                    },
                );
            }
        }
    }
    groups.into_values().collect()
}

pub struct SqliteConnection {
    conn: Arc<Mutex<Connection>>,
    server_info: ServerInfo,
    /// Pseudo-database name shown in the tree (file stem / "main").
    db_name: String,
}

// ---------------------------------------------------------------------------
// Open + helpers
// ---------------------------------------------------------------------------

impl SqliteConnection {
    /// Open the database file carried in `config.host` (":memory:" works).
    pub async fn open(config: &ResolvedConnectionConfig) -> Result<Self> {
        let path = config.host.trim().to_string();
        if path.is_empty() {
            return Err(AppError::Config(
                "SQLite sessions need a database file path".into(),
            ));
        }
        // File IO can block; do the open off the reactor too.
        let opened = tokio::task::spawn_blocking(move || Connection::open(&path))
            .await
            .map_err(|e| AppError::Db(format!("open task failed: {e}")))?
            .map_err(|e| AppError::Db(format!("cannot open SQLite file: {e}")))?;

        let version = opened.query_row("SELECT sqlite_version()", [], |r| r.get::<_, String>(0))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(opened)),
            server_info: ServerInfo {
                product: "SQLite".into(),
                version,
                dialect: SqlDialect::Sqlite,
                connected_at: Utc::now(),
            },
            db_name: display_name_of(&config.host),
        })
    }

    /// Display name of the pseudo-database: the file stem (or `main`).
    pub fn database_name(path: &str) -> String {
        display_name_of(path)
    }
}

fn display_name_of(path: &str) -> String {
    std::path::Path::new(path.trim())
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

/// Lock the connection, translating poisoning into a clean error.
fn lock_conn(
    conn: &Arc<Mutex<Connection>>,
) -> Result<std::sync::MutexGuard<'_, Connection>> {
    conn.lock()
        .map_err(|_| AppError::Db("SQLite connection lock poisoned".into()))
}

/// Convert neutral binds (mysql_async::Value carriers from sql.rs) into
/// rusqlite values.
fn sq_binds(binds: &[mysql_async::Value]) -> Vec<SqValue> {
    use mysql_async::Value;
    binds
        .iter()
        .map(|v| match v {
            Value::NULL => SqValue::Null,
            Value::Int(i) => SqValue::Integer(*i),
            Value::UInt(u) => SqValue::Integer((*u).min(i64::MAX as u64) as i64),
            Value::Float(f) => SqValue::Real(*f as f64),
            Value::Double(f) => SqValue::Real(*f),
            Value::Bytes(b) => SqValue::Text(String::from_utf8_lossy(b).into_owned()),
            Value::Date(y, mo, d, h, mi, s, us) => SqValue::Text(format!(
                "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{us:06}"
            )),
            Value::Time(neg, days, h, m, s, us) => SqValue::Text(format!(
                "{}{days}d {h:02}:{m:02}:{s:02}.{us:06}",
                if *neg { "-" } else { "" }
            )),
        })
        .collect()
}

/// Grid cell → rusqlite bind value.
fn sq_param(value: &RowValue) -> SqValue {
    match value {
        RowValue::Null => SqValue::Null,
        RowValue::Int(v) => SqValue::Integer(*v),
        RowValue::UInt(v) => SqValue::Integer((*v).min(i64::MAX as u64) as i64),
        RowValue::Float(v) => SqValue::Real(*v),
        RowValue::Str(s) => SqValue::Text(s.clone()),
        RowValue::Bytes(b) => SqValue::Blob(b.clone()),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => SqValue::Text(s.clone()),
    }
}

/// One extracted cell from any statement.
fn cell_value(value: ValueRef<'_>) -> RowValue {
    match value {
        ValueRef::Null => RowValue::Null,
        ValueRef::Integer(i) => RowValue::Int(i),
        ValueRef::Real(f) => RowValue::Float(f),
        ValueRef::Text(t) => RowValue::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => RowValue::Bytes(b.to_vec()),
    }
}

fn looks_like_result_set(sql: &str) -> bool {
    let head = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(head.as_str(), "SELECT" | "VALUES" | "WITH" | "PRAGMA")
}

fn sql_snippet(sql: &str) -> String {
    let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(120).collect();
    if flat.chars().count() > 120 {
        out.push('…');
    }
    out
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// Quote a string literal the SQLite way (only quotes double).
pub(crate) fn lite_quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn is_numeric_literal(s: &str) -> bool {
    let t = s.trim();
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Classify a `PRAGMA table_info.dflt_value` into designer form.
pub(crate) fn classify_lite_default(raw: Option<&str>) -> (DefaultKind, Option<String>) {
    let Some(raw) = raw else {
        return (DefaultKind::None, None);
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return (DefaultKind::None, None);
    }
    if trimmed.eq_ignore_ascii_case("null") {
        return (DefaultKind::Null, None);
    }
    if let Some(rest) = trimmed.strip_prefix('\'') {
        // Scan for the closing quote honouring '' doubling.
        let bytes = rest.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                return (
                    DefaultKind::Value,
                    Some(rest[..i].replace("''", "'")),
                );
            }
            i += 1;
        }
        return (DefaultKind::Expression, Some(trimmed.to_string()));
    }
    if is_numeric_literal(trimmed) {
        return (DefaultKind::Value, Some(trimmed.to_string()));
    }
    (DefaultKind::Expression, Some(trimmed.to_string()))
}

/// Extract `(timing, event, table)` from a CREATE TRIGGER body header.
pub(crate) fn parse_lite_trigger(sql: &str) -> (String, String, String) {
    let upper = sql.to_ascii_uppercase();
    let timing = ["INSTEAD OF", "BEFORE", "AFTER"]
        .iter()
        .find_map(|kw| upper.find(kw).map(|_| (*kw).to_string()))
        .unwrap_or_else(|| "UNKNOWN".into());
    let event = ["INSERT", "UPDATE", "DELETE"]
        .iter()
        .find_map(|kw| upper.find(kw).map(|_| (*kw).to_string()))
        .unwrap_or_else(|| "UNKNOWN".into());
    // Table follows the ON keyword after the event.
    let table = upper
        .find(" ON ")
        .and_then(|pos| {
            upper[pos + 4..]
                .split_whitespace()
                .next()
                .map(|word| {
                    word.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '"')
                        .replace('"', "")
                })
        })
        .unwrap_or_default();
    (timing, event, table)
}

/// One designer column definition line for SQLite DDL.
pub(crate) fn lite_column_definition(d: SqlDialect, col: &ColumnDef) -> String {
    let mut s = d.quote_ident(&col.name);
    let dtype = col.data_type.trim();
    if !dtype.is_empty() {
        s.push(' ');
        s.push_str(dtype);
    }
    if col.generated.is_none() {
        s.push_str(if col.nullable { "" } else { " NOT NULL" });
        match col.default_kind {
            DefaultKind::None => {}
            DefaultKind::Null => s.push_str(" DEFAULT NULL"),
            DefaultKind::Value => {
                if let Some(v) = &col.default_value {
                    s.push_str(" DEFAULT ");
                    if is_numeric_literal(v) {
                        s.push_str(v.trim());
                    } else {
                        s.push_str(&lite_quote_string(v));
                    }
                }
            }
            DefaultKind::Expression => {
                if let Some(v) = &col.default_value {
                    s.push_str(" DEFAULT ");
                    s.push_str(v.trim());
                }
            }
        }
    } else {
        s.push_str(" GENERATED ALWAYS AS ");
        s.push_str(col.generated.as_deref().unwrap_or("").trim());
    }
    s
}

/// CREATE TABLE for new tables (designer).
pub(crate) fn lite_create_table(db: &str, req: &crate::connections::CreateTableRequest) -> Result<String> {
    let d = SqlDialect::Sqlite;
    let _ = db; // SQLite tables live inside the single attached file
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Db("table name is empty".into()));
    }
    if req.columns.is_empty() {
        return Err(AppError::Db("a table needs at least one column".into()));
    }

    let mut body: Vec<String> = req.columns.iter().map(|c| lite_column_definition(d, c)).collect();
    for idx in &req.indexes {
        let cols = idx
            .columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        match idx.kind {
            IndexKind::Primary => body.push(format!("PRIMARY KEY ({cols})")),
            IndexKind::Unique => body.push(format!(
                "CONSTRAINT {} UNIQUE ({cols})",
                d.quote_ident(&idx.name)
            )),
            _ => {} // plain indexes become separate CREATE INDEX statements
        }
    }
    for fk in &req.foreign_keys {
        let cols = fk
            .columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let refs = fk
            .ref_columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let mut clause = format!(
            "CONSTRAINT {} FOREIGN KEY ({cols}) REFERENCES {} ({refs})",
            d.quote_ident(&fk.name),
            d.quote_ident(&fk.ref_table)
        );
        if let Some(action) = &fk.on_delete {
            clause.push_str(&format!(" ON DELETE {action}"));
        }
        if let Some(action) = &fk.on_update {
            clause.push_str(&format!(" ON UPDATE {action}"));
        }
        body.push(clause);
    }

    let mut extra: Vec<String> = Vec::new();
    for idx in req.indexes.iter().filter(|ix| {
        ix.kind == IndexKind::Index || ix.kind == IndexKind::Fulltext || ix.kind == IndexKind::Spatial
    }) {
        let cols = idx
            .columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        extra.push(format!(
            "CREATE INDEX {} ON {} ({});",
            d.quote_ident(&idx.name),
            d.quote_ident(name),
            cols
        ));
    }

    let main = format!(
        "CREATE TABLE {} (\n  {}\n);",
        d.quote_ident(name),
        body.join(",\n  ")
    );
    let mut out = vec![main];
    out.extend(extra);
    Ok(out.join("\n"))
}

/// The generated plan for one designer apply.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct LiteAlterPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

/// Diff two snapshots into SQLite ALTER statements. Supported: ADD COLUMN,
/// RENAME COLUMN/TABLE, DROP COLUMN, plain index create/drop. Everything
/// else (type/default/nullability/FK/options changes) reports Unsupported —
/// SQLite requires a recreate-and-copy recipe for those.
pub(crate) fn lite_alter_plan(
    current: &TableDdl,
    desired: &TableDdl,
) -> Result<LiteAlterPlan> {
    let d = SqlDialect::Sqlite;
    let mut plan = LiteAlterPlan::default();
    let src = d.quote_ident(&current.table);

    let unsupported = |what: &str| -> AppError {
        AppError::Unsupported(format!(
            "{what}: SQLite only supports ADD COLUMN, RENAME and DROP COLUMN \
             through direct ALTER — recreate the table for deeper changes"
        ))
    };

    // Foreign keys are immutable in place.
    if current.foreign_keys != desired.foreign_keys {
        return Err(unsupported("changing foreign keys"));
    }

    // Columns ---------------------------------------------------------------
    for col in &desired.columns {
        let key = col.previous_name.as_deref().unwrap_or(col.name.as_str());
        match current.columns.iter().find(|c| c.name.eq_ignore_ascii_case(key)) {
            None => {
                if col.auto_increment {
                    return Err(unsupported("AUTO_INCREMENT columns"));
                }
                plan.statements.push(format!(
                    "ALTER TABLE {src} ADD COLUMN {}",
                    lite_column_definition(d, col)
                ));
            }
            Some(cur) => {
                if cur.name != col.name {
                    plan.statements.push(format!(
                        "ALTER TABLE {src} RENAME COLUMN {} TO {}",
                        d.quote_ident(&cur.name),
                        d.quote_ident(&col.name)
                    ));
                }
                let content_same = cur.data_type.trim().eq_ignore_ascii_case(col.data_type.trim())
                    && cur.nullable == col.nullable
                    && cur.default_kind == col.default_kind
                    && cur.default_value == col.default_value
                    && cur.auto_increment == col.auto_increment
                    && cur.generated == col.generated;
                if !content_same {
                    return Err(unsupported(format!("modifying column `{}`", col.name).as_str()));
                }
            }
        }
    }
    for col in &current.columns {
        let still_there = desired.columns.iter().any(|c| {
            c.name.eq_ignore_ascii_case(&col.name)
                || c.previous_name.as_deref() == Some(col.name.as_str())
        });
        if !still_there {
            plan.statements.push(format!(
                "ALTER TABLE {src} DROP COLUMN {}",
                d.quote_ident(&col.name)
            ));
        }
    }

    // Indexes ---------------------------------------------------------------
    let index_eq = |a: &IndexMeta, b: &IndexMeta| {
        a.kind == b.kind && a.columns == b.columns && a.name == b.name
    };
    for idx in &current.indexes {
        if idx.kind == IndexKind::Primary {
            continue;
        }
        let kept = desired.indexes.iter().any(|x| index_eq(x, idx));
        if !kept {
            plan.warnings.push(format!(
                "index `{}` cannot be dropped with DROP COLUMN alone — run DROP INDEX explicitly",
                idx.name
            ));
        }
    }
    for idx in &desired.indexes {
        if matches!(idx.kind, IndexKind::Primary | IndexKind::Unique) {
            continue; // inline constraints handled at creation time
        }
        let exists_same = current.indexes.iter().any(|x| index_eq(x, idx));
        if exists_same {
            continue;
        }
        let cols = idx
            .columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        plan.statements.push(format!(
            "CREATE {}INDEX {} ON {src} ({cols})",
            if idx.kind == IndexKind::Unique { "UNIQUE " } else { "" },
            d.quote_ident(&idx.name)
        ));
    }

    // Rename last --------------------------------------------------------------
    if desired.table != current.table {
        plan.statements.push(format!(
            "ALTER TABLE {src} RENAME TO {}",
            d.quote_ident(&desired.table)
        ));
    }
    if desired.db != current.db && !desired.db.is_empty() && !current.db.is_empty() {
        return Err(unsupported("moving a table to another database file"));
    }

    Ok(plan)
}

// ---------------------------------------------------------------------------
// Command-level statement builders (consumed by commands/objects.rs)
// ---------------------------------------------------------------------------

pub(crate) fn lite_drop_sql(kind: ObjectKind, name: &str) -> Result<String> {
    let d = SqlDialect::Sqlite;
    Ok(match kind {
        ObjectKind::Table => format!("DROP TABLE {}", d.quote_ident(name)),
        ObjectKind::View => format!("DROP VIEW {}", d.quote_ident(name)),
        ObjectKind::Trigger => format!("DROP TRIGGER {}", d.quote_ident(name)),
        ObjectKind::Routine => {
            return Err(AppError::Unsupported("SQLite has no stored routines".into()))
        }
        ObjectKind::Event => {
            return Err(AppError::Unsupported("SQLite has no scheduled events".into()))
        }
    })
}

pub(crate) fn lite_rename_sql(table: &str, new_name: &str) -> String {
    format!(
        "ALTER TABLE {} RENAME TO {}",
        SqlDialect::Sqlite.quote_ident(table),
        SqlDialect::Sqlite.quote_ident(new_name)
    )
}

pub(crate) fn lite_truncate_sql(table: &str) -> String {
    format!("DELETE FROM {}", SqlDialect::Sqlite.quote_ident(table))
}

/// Optimize→VACUUM (whole-file), Analyze→ANALYZE [table].
pub(crate) fn lite_maintenance_sql(op: MaintenanceOp, table: &str) -> Result<String> {
    let q = SqlDialect::Sqlite.quote_ident(table);
    Ok(match op {
        MaintenanceOp::Optimize => "VACUUM".to_string(),
        MaintenanceOp::Analyze => format!("ANALYZE {q}"),
        MaintenanceOp::Check => format!("PRAGMA integrity_check({q})"),
        op => {
            return Err(AppError::Unsupported(format!(
                "{op:?} maintenance is not supported by SQLite"
            )))
        }
    })
}

#[async_trait]
impl DbConnection for SqliteConnection {
    fn server_label(&self) -> String {
        format!("SQLite {}", self.server_info.version)
    }

    fn server_info(&self) -> ServerInfo {
        self.server_info.clone()
    }

    async fn close(&mut self) {
        // Dropping the Arc closes the file once the last clone goes away.
    }

    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>> {
        Ok(vec![DatabaseInfo {
            name: self.db_name.clone(),
            charset: Some("UTF-8".into()),
            collation: Some("BINARY".into()),
        }])
    }

    async fn list_tables(&mut self, _database: &str) -> Result<Vec<TableMeta>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT name, type FROM sqlite_master \
                 WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND type IN ('table','view') \
                 ORDER BY name",
            )
            .map_err(rusqlite_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(rusqlite_err)?;
        let mut metas: Vec<TableMeta> = Vec::new();
        for row in rows {
            let (name, kind) = row.map_err(rusqlite_err)?;
            metas.push(TableMeta {
                name,
                kind: if kind == "view" { TableKind::View } else { TableKind::Table },
                rows: None,
                size_bytes: None,
                comment: None,
                engine: None,
            });
        }
        Ok(metas)
    }

    async fn describe_table(&mut self, _database: &str, table: &str) -> Result<Vec<ColumnMeta>> {
        let d = SqlDialect::Sqlite;
        let conn = lock_conn(&self.conn)?;
        ensure_table_exists(&conn, table)?;
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", d.quote_ident(table)))
            .map_err(rusqlite_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ColumnMeta {
                    name: row.get(1)?,
                    data_type: {
                        let t: String = row.get(2)?;
                        if t.is_empty() { "BLOB".to_string() } else { t }
                    },
                    nullable: row.get::<_, i64>(3)? == 0,
                    key: if row.get::<_, i64>(5)? > 0 {
                        Some("PRI".into())
                    } else {
                        None
                    },
                    default_value: row.get::<_, Option<String>>(4)?.filter(|v| !v.is_empty()),
                    extra: None,
                    comment: None,
                })
            })
            .map_err(rusqlite_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(rusqlite_err)
    }

    async fn query_page(&mut self, req: &QueryPageRequest) -> Result<QueryPageResult> {
        let started = std::time::Instant::now();
        let d = SqlDialect::Sqlite;

        let columns = self.describe_table(&req.db, &req.table).await?;
        let where_clause = build_where_clause_and(d, &columns, &req.filters)?;
        let order_clause = build_order_by_clause(d, &columns, &req.order_by)?;
        let page_size = req.page_size.clamp(1, MAX_PAGE_SIZE);

        let sql = build_page_sql(
            d,
            &d.quote_ident(&req.table),
            &columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
            &where_clause,
            &order_clause,
            page_size.saturating_add(1),
            req.offset,
        );

        // Binds come straight from the neutral builder; `in` contributes one
        // parameter per selected value.
        let params: Vec<SqValue> = sq_binds(&where_clause.params);

        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(&sql).map_err(rusqlite_err)?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params.iter()))
            .map_err(rusqlite_err)?;

        let mut collected: Vec<Vec<RowValue>> = Vec::with_capacity(page_size as usize);
        let mut has_more = false;
        while let Some(row) = rows.next().map_err(rusqlite_err)? {
            if collected.len() == page_size as usize {
                has_more = true;
                break;
            }
            let values: Vec<RowValue> = (0..columns.len())
                .map(|i| cell_value(row.get_ref_unwrap(i)))
                .collect();
            collected.push(values);
        }

        Ok(QueryPageResult {
            columns,
            rows: collected,
            total_rows_estimate: None, // exact counts come via count_rows
            elapsed_ms: started.elapsed().as_millis() as u64,
            has_more,
        })
    }

    async fn distinct_values(
        &mut self,
        _database: &str,
        table: &str,
        column: &str,
        limit: u32,
        search: Option<&str>,
    ) -> Result<Vec<DistinctValue>> {
        let d = SqlDialect::Sqlite;
        let columns = self.describe_table(_database, table).await?;
        let meta = validate_column(&columns, column)?;
        let built = build_distinct_values_sql(
            d,
            &d.quote_ident(table),
            meta,
            &d.quote_ident(&meta.name),
            "COUNT(*)",
            search,
            limit,
        );

        let params = sq_binds(&built.params);
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn.prepare(&built.sql).map_err(rusqlite_err)?;
        let mut rows = stmt
            .query(rusqlite::params_from_iter(params.iter()))
            .map_err(rusqlite_err)?;

        let mut out: Vec<DistinctValue> = Vec::new();
        while let Some(row) = rows.next().map_err(rusqlite_err)? {
            let value = cell_value(row.get_ref_unwrap(0));
            let count = match row.get_ref_unwrap(1) {
                ValueRef::Integer(n) if n >= 0 => n as u64,
                _ => 0,
            };
            out.push(DistinctValue { value, count });
        }
        Ok(out)
    }

    async fn apply_changes(&mut self, req: &ApplyChangesRequest) -> Result<ApplyChangesResult> {
        let started = std::time::Instant::now();
        if req.changes.is_empty() {
            return Ok(ApplyChangesResult {
                applied: 0,
                failed: 0,
                errors: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let d = SqlDialect::Sqlite;
        let columns = self.describe_table(&req.db, &req.table).await?;
        let table_q = d.quote_ident(&req.table);

        let mut built: Vec<(usize, String, Vec<SqValue>)> = Vec::new();
        let mut errors: Vec<RowError> = Vec::new();
        for (index, change) in req.changes.iter().enumerate() {
            match build_change_sql(d, &table_q, &columns, change) {
                Ok(stmt) => built.push((index, stmt.sql, sq_binds(&stmt.params))),
                Err(err) => errors.push(RowError {
                    index,
                    message: err.to_string(),
                }),
            }
        }
        let mut applied = 0u32;
        let mut failed = errors.len() as u32;

        let mut conn = lock_conn(&self.conn)?;
        let tx = conn.transaction().map_err(rusqlite_err)?;
        for (index, sql, params) in &built {
            match tx.execute(sql.as_str(), rusqlite::params_from_iter(params.iter())) {
                Ok(_) => applied += 1,
                Err(err) => {
                    failed += 1;
                    errors.push(RowError {
                        index: *index,
                        message: err.to_string(),
                    });
                }
            }
        }
        tx.commit().map_err(rusqlite_err)?;

        Ok(ApplyChangesResult {
            applied,
            failed,
            errors,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn count_rows(
        &mut self,
        _database: &str,
        table: &str,
        filter: Option<&FilterSpec>,
    ) -> Result<Option<u64>> {
        let d = SqlDialect::Sqlite;
        let columns = self.describe_table(_database, table).await?;
        let where_clause = build_where_clause(d, &columns, filter)?;
        let sql = format!(
            "SELECT COUNT(*) FROM {}{}",
            d.quote_ident(table),
            where_clause.sql
        );

        let params: Vec<SqValue> = sq_binds(&where_clause.params);

        let conn = lock_conn(&self.conn)?;
        let count: i64 = conn
            .query_row(&sql, rusqlite::params_from_iter(params.iter()), |r| r.get(0))
            .map_err(rusqlite_err)?;
        Ok(Some(count.max(0) as u64))
    }

    async fn execute(&mut self, sql: &str) -> Result<ExecResult> {
        let started = std::time::Instant::now();
        let conn = lock_conn(&self.conn)?;
        if split_sqlite(sql).len() > 1 {
            // Multi-statement strings and trigger bodies go through batch.
            let executed = conn.execute_batch(sql).map_err(rusqlite_err)?;
            let _ = executed;
            return Ok(ExecResult {
                rows_affected: 0,
                last_insert_id: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        if looks_like_result_set(sql) {
            let mut stmt = conn.prepare(sql).map_err(rusqlite_err)?;
            let mut rows = stmt.query([]).map_err(rusqlite_err)?;
            let mut n: u64 = 0;
            while rows.next().map_err(rusqlite_err)?.is_some() {
                n += 1;
            }
            return Ok(ExecResult {
                rows_affected: n,
                last_insert_id: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        let affected = conn.execute(sql, []).map_err(rusqlite_err)? as u64;
        let last_insert_id = if affected > 0 {
            Some(conn.last_insert_rowid() as u64)
        } else {
            None
        };
        Ok(ExecResult {
            rows_affected: affected,
            last_insert_id,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn run_script(&mut self, sql: &str, stop_on_error: bool) -> Result<Vec<QueryOutcome>> {
        let mut outcomes: Vec<QueryOutcome> = Vec::new();

        for stmt in split_sqlite(sql) {
            let snippet = sql_snippet(&stmt);
            let started = std::time::Instant::now();

            let result = run_script_statement(&self.conn, &stmt, started)
                .map_err(|e| e.to_string());

            match result {
                Ok(outcome) => outcomes.push(outcome),
                Err(message) => {
                    outcomes.push(QueryOutcome::Error {
                        message,
                        sql_snippet: snippet,
                    });
                    if stop_on_error {
                        break;
                    }
                }
            }
        }

        Ok(outcomes)
    }


    // -----------------------------------------------------------------------
    // Object management
    // -----------------------------------------------------------------------

    async fn get_table_ddl(&mut self, _database: &str, table: &str) -> Result<TableDdl> {
        let d = SqlDialect::Sqlite;
        let conn = lock_conn(&self.conn)?;
        ensure_table_exists(&conn, table)?;

        let create_sql: String = conn
            .query_row(
                "SELECT COALESCE(sql,'') FROM sqlite_master WHERE name = ?1",
                [table],
                |r| r.get(0),
            )
            .map_err(rusqlite_err)?;

        // Columns ------------------------------------------------------------
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({})", d.quote_ident(table)))
            .map_err(rusqlite_err)?;
        let raw_cols: Vec<(String, String, i64, Option<String>, i64)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            })
            .map_err(rusqlite_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(rusqlite_err)?;

        let columns: Vec<ColumnDef> = raw_cols
            .iter()
            .map(|(name, dtype, notnull, dflt, _pk)| {
                let (default_kind, default_value) = classify_lite_default(dflt.as_deref());
                ColumnDef {
                    name: name.clone(),
                    previous_name: None,
                    data_type: dtype.clone(),
                    nullable: *notnull == 0,
                    default_kind,
                    default_value,
                    auto_increment: false,
                    on_update: None,
                    generated: None,
                    comment: None,
                    preserved_attrs: Vec::new(),
                }
            })
            .collect();

        // Indexes --------------------------------------------------------------
        let mut idx_stmt = conn
            .prepare(&format!(
                "PRAGMA index_list({})",
                d.quote_ident(table)
            ))
            .map_err(rusqlite_err)?;
        let raw_indexes: Vec<(String, i64, String)> = idx_stmt
            .query_map([], |row| {
                // (seq, name, unique, origin, partial)
                Ok((
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(rusqlite_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(rusqlite_err)?;

        let mut indexes: Vec<IndexMeta> = Vec::new();
        for (name, unique, origin) in raw_indexes {
            let mut info_stmt = conn
                .prepare(&format!("PRAGMA index_info({})", d.quote_ident(&name)))
                .map_err(rusqlite_err)?;
            let cols: Vec<String> = info_stmt
                .query_map([], |row| row.get::<_, Option<String>>(2))
                .map_err(rusqlite_err)?
                .collect::<std::result::Result<Vec<Option<String>>, _>>()
                .map_err(rusqlite_err)?
                .into_iter()
                .flatten()
                .collect();

            if origin == "pk" {
                indexes.push(IndexMeta {
                    name: "PRIMARY".into(),
                    kind: IndexKind::Primary,
                    columns: pk_columns_from(&raw_cols),
                    comment: None,
                });
            } else if !cols.is_empty() {
                indexes.push(IndexMeta {
                    name,
                    kind: if unique == 1 || origin == "u" {
                        IndexKind::Unique
                    } else {
                        IndexKind::Index
                    },
                    columns: cols,
                    comment: None,
                });
            }
        }
        // WITHOUT ROWID tables may have no reported pk index; synthesize one.
        if !indexes.iter().any(|ix| ix.kind == IndexKind::Primary)
            && raw_cols.iter().any(|(_, _, _, _, pk)| *pk > 0)
        {
            indexes.insert(
                0,
                IndexMeta {
                    name: "PRIMARY".into(),
                    kind: IndexKind::Primary,
                    columns: pk_columns_from(&raw_cols),
                    comment: None,
                },
            );
        }

        // Foreign keys ---------------------------------------------------------
        let mut fk_stmt = conn
            .prepare(&format!(
                "PRAGMA foreign_key_list({})",
                d.quote_ident(table)
            ))
            .map_err(rusqlite_err)?;
        let raw_fks: Vec<(i64, i64, String, String, Option<String>, String, String)> = fk_stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(rusqlite_err)?
            .collect::<std::result::Result<_, _>>()
            .map_err(rusqlite_err)?;

        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for group_id in raw_fks.iter().map(|(id, ..)| *id).collect::<std::collections::BTreeSet<_>>() {
            let members: Vec<&_> = raw_fks.iter().filter(|(id, ..)| *id == group_id).collect();
            let (_, _, ref_table, _, _, on_update, on_delete) = members[0];
            foreign_keys.push(ForeignKeyMeta {
                name: format!("FK_{group_id}_{ref_table}"),
                columns: members.iter().map(|m| m.3.clone()).collect(),
                ref_db: None,
                ref_table: ref_table.clone(),
                ref_columns: members
                    .iter()
                    .map(|m| m.4.clone().unwrap_or_default())
                    .collect(),
                on_delete: Some(on_delete.clone()),
                on_update: Some(on_update.clone()),
                table: None,
            });
        }

        Ok(TableDdl {
            db: _database.to_string(),
            table: table.to_string(),
            columns,
            indexes,
            foreign_keys,
            options: TableOptions::default(),
            checks: Vec::new(),
            create_sql,
        })
    }

    async fn list_referencing_foreign_keys(
        &mut self,
        _database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyMeta>> {
        let d = SqlDialect::Sqlite;
        let conn = lock_conn(&self.conn)?;
        let mut table_stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(rusqlite_err)?;
        let tables: Vec<String> = table_stmt
            .query_map([], |row| row.get(0))
            .map_err(rusqlite_err)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(rusqlite_err)?;

        // Same source as the forward listing: PRAGMA foreign_key_list per
        // base table, keeping only entries that reference the queried table.
        let mut raw: Vec<LiteFkRow> = Vec::new();
        for child in tables {
            let mut fk_stmt = conn
                .prepare(&format!(
                    "PRAGMA foreign_key_list({})",
                    d.quote_ident(&child)
                ))
                .map_err(rusqlite_err)?;
            let rows = fk_stmt
                .query_map([], |row| {
                    Ok((
                        child.clone(),
                        row.get(0)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                    ))
                })
                .map_err(rusqlite_err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(rusqlite_err)?;
            raw.extend(rows.into_iter().filter(|(_, _, ref_table, ..)| ref_table == table));
        }
        Ok(group_lite_referencing_fks(table, raw))
    }

    async fn list_routines(&mut self, _database: &str) -> Result<Vec<RoutineMeta>> {
        Ok(Vec::new()) // SQLite has none; the tree hides the group.
    }

    async fn get_routine_ddl(
        &mut self,
        _database: &str,
        _name: &str,
        _kind: RoutineKind,
    ) -> Result<ShowCreateResult> {
        Err(AppError::Unsupported("SQLite has no stored routines".into()))
    }

    async fn list_triggers(&mut self, _database: &str) -> Result<Vec<TriggerMeta>> {
        let conn = lock_conn(&self.conn)?;
        let mut stmt = conn
            .prepare(
                "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
            )
            .map_err(rusqlite_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(rusqlite_err)?;
        let mut triggers = Vec::new();
        for row in rows {
            let (name, sql) = row.map_err(rusqlite_err)?;
            let (timing, event, table) = parse_lite_trigger(&sql);
            triggers.push(TriggerMeta {
                name,
                timing,
                event,
                table,
                definer: None,
                created: None,
            });
        }
        Ok(triggers)
    }

    async fn get_trigger_ddl(&mut self, _database: &str, name: &str) -> Result<ShowCreateResult> {
        let conn = lock_conn(&self.conn)?;
        let sql: String = conn
            .query_row(
                "SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='trigger' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(rusqlite_err)?;
        if sql.is_empty() {
            return Err(AppError::Db(format!("trigger {name} not found")));
        }
        Ok(ShowCreateResult {
            db: _database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::Trigger,
            create_sql: sql,
        })
    }

    async fn get_view_ddl(&mut self, _database: &str, name: &str) -> Result<ShowCreateResult> {
        let conn = lock_conn(&self.conn)?;
        let sql: String = conn
            .query_row(
                "SELECT COALESCE(sql,'') FROM sqlite_master WHERE type='view' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .map_err(rusqlite_err)?;
        if sql.is_empty() {
            return Err(AppError::Db(format!("view {name} not found")));
        }
        Ok(ShowCreateResult {
            db: _database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::View,
            create_sql: sql,
        })
    }

    async fn list_events(&mut self, _database: &str) -> Result<Vec<EventMeta>> {
        Ok(Vec::new())
    }

    // -----------------------------------------------------------------------
    // Streaming reads
    // -----------------------------------------------------------------------

    async fn stream_table_rows(
        &mut self,
        _database: &str,
        table: &str,
        chunk_size: usize,
        tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        let sql = format!(
            "SELECT * FROM {}",
            SqlDialect::Sqlite.quote_ident(table)
        );
        stream_blocking(self.conn.clone(), sql, chunk_size, tx).await
    }

    async fn stream_query_rows(
        &mut self,
        sql: &str,
        chunk_size: usize,
        tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        stream_blocking(self.conn.clone(), sql.to_string(), chunk_size, tx).await
    }

    /// Multi-row INSERT batches honouring SQLite's parameter ceiling.
    #[allow(clippy::too_many_arguments)]
    async fn insert_rows(
        &mut self,
        _database: &str,
        table: &str,
        columns: &[String],
        rows: &[Vec<RowValue>],
        ignore: bool,
        upsert_columns: Option<&[String]>,
    ) -> Result<u64> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        let described = self.describe_table(_database, table).await?;
        for name in columns {
            crate::connections::sql::validate_column(&described, name)?;
        }

        let d = SqlDialect::Sqlite;
        let table_q = d.quote_ident(table);
        let base = crate::connections::sql::build_multirow_insert(
            d,
            &table_q,
            columns,
            0,
            ignore,
            upsert_columns,
        );
        // build_multirow_insert rendered zero row groups; rebuild per batch.
        let head = base.split(" VALUES ").next().expect("insert head").to_string();
        let upsert_tail = base
            .split_once(" ON CONFLICT ")
            .map(|(_, tail)| format!(" ON CONFLICT {tail}"))
            .unwrap_or_default();

        let rows_per_stmt = (MAX_BIND_PARAMS / columns.len()).clamp(1, 10_000);
        let mut affected_total = 0u64;

        let mut conn = lock_conn(&self.conn)?;
        let tx = conn.transaction().map_err(rusqlite_err)?;
        for batch in rows.chunks(rows_per_stmt) {
            let groups = batch
                .iter()
                .map(|_| {
                    format!(
                        "({})",
                        vec!["?"; columns.len()].join(", ")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!("{head} VALUES {groups}{upsert_tail}");

            let params: Vec<SqValue> = batch
                .iter()
                .flat_map(|row| row.iter())
                .map(sq_param)
                .collect();
            affected_total += tx
                .execute(&sql, rusqlite::params_from_iter(params.iter()))
                .map_err(rusqlite_err)? as u64;
        }
        tx.commit().map_err(rusqlite_err)?;
        Ok(affected_total)
    }
}

/// Execute one script statement on the shared connection. Lives outside the
/// trait impl so the borrow of the mutex guard stays inside this function.
fn run_script_statement(
    conn: &Arc<Mutex<Connection>>,
    stmt: &str,
    started: std::time::Instant,
) -> Result<QueryOutcome> {
    let guard = lock_conn(conn)?;
    if looks_like_result_set(stmt) {
        let mut disc_stmt = guard.prepare(stmt)?;
        let names: Vec<ResultColumnMeta> = disc_stmt
            .column_names()
            .into_iter()
            .map(|name: &str| ResultColumnMeta {
                name: name.to_string(),
                data_type: String::new(),
            })
            .collect();
        let mut rows = disc_stmt.query([])?;
        let mut out: Vec<Vec<RowValue>> = Vec::new();
        let mut truncated = false;
        while let Some(row) = rows.next()? {
            if out.len() >= MAX_SCRIPT_RESULT_ROWS {
                truncated = true;
                break;
            }
            out.push(
                (0..names.len())
                    .map(|i| cell_value(row.get_ref_unwrap(i)))
                    .collect(),
            );
        }
        Ok(QueryOutcome::ResultSet {
            columns: names,
            rows: out,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            sql: Some(stmt.to_string()),
        })
    } else {
        let affected = guard.execute(stmt, [])?;
        let last_insert_id = if affected > 0 {
            Some(guard.last_insert_rowid() as u64)
        } else {
            None
        };
        Ok(QueryOutcome::Exec {
            affected: affected as u64,
            last_insert_id,
            info: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
}

// ---------------------------------------------------------------------------
// Blocking-side plumbing
// ---------------------------------------------------------------------------

fn rusqlite_err(err: rusqlite::Error) -> AppError {
    AppError::Db(format!("SQLite error: {err}"))
}

fn pk_columns_from(raw_cols: &[(String, String, i64, Option<String>, i64)]) -> Vec<String> {
    let mut pks: Vec<(i64, String)> = raw_cols
        .iter()
        .filter(|(.., pk)| *pk > 0)
        .map(|(name, .., pk)| (*pk, name.clone()))
        .collect();
    pks.sort_by_key(|(ord, _)| *ord);
    pks.into_iter().map(|(_, name)| name).collect()
}

fn ensure_table_exists(conn: &Connection, table: &str) -> Result<()> {
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE name = ?1 AND type IN ('table','view')",
            [table],
            |r| r.get(0),
        )
        .ok();
    if found.is_none() {
        return Err(AppError::Db(format!("relation {table} not found")));
    }
    Ok(())
}


/// Run a streaming read on the blocking pool, pushing chunks through `tx`
/// (blocking_send). A closed channel stops the scan early.
async fn stream_blocking(
    conn: Arc<Mutex<Connection>>,
    sql: String,
    chunk_size: usize,
    tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
) -> Result<u64> {
    let cap = chunk_size.clamp(1, MAX_STREAM_CHUNK);
    let handle = tokio::task::spawn_blocking(move || -> Result<u64> {
        let guard = lock_conn(&conn)?;
        let mut stmt = guard.prepare(&sql).map_err(rusqlite_err)?;
        let columns: Vec<ResultColumnMeta> = stmt
            .column_names()
            .into_iter()
            .map(|name: &str| ResultColumnMeta {
                name: name.to_string(),
                data_type: String::new(),
            })
            .collect();
        let width = columns.len();
        let mut rows = stmt.query([]).map_err(rusqlite_err)?;

        let mut total: u64 = 0;
        let mut buffer: Vec<Vec<RowValue>> = Vec::with_capacity(cap);
        loop {
            let row = match rows.next() {
                Ok(Some(row)) => row,
                Ok(None) => break,
                Err(err) => return Err(rusqlite_err(err)),
            };
            buffer.push(
                (0..width)
                    .map(|i| cell_value(row.get_ref_unwrap(i)))
                    .collect(),
            );
            if buffer.len() >= cap {
                total += buffer.len() as u64;
                let chunk_rows = std::mem::take(&mut buffer);
                if tx
                    .blocking_send(Ok(RowsChunk {
                        columns: columns.clone(),
                        rows: chunk_rows,
                    }))
                    .is_err()
                {
                    return Ok(total); // consumer cancelled
                }
            }
        }
        if !buffer.is_empty() {
            total += buffer.len() as u64;
            let _ = tx.blocking_send(Ok(RowsChunk { columns, rows: buffer }));
        }
        Ok(total)
    });

    handle
        .await
        .map_err(|e| AppError::Db(format!("stream task failed: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn referencing_fk_pragma_rows_group_per_child_and_id() {
        let fks = group_lite_referencing_fks(
            "products",
            vec![
                (
                    "line_items".into(),
                    0,
                    "products".into(),
                    "product_id".into(),
                    Some("id".into()),
                    "NO ACTION".into(),
                    "CASCADE".into(),
                ),
                (
                    "stock_levels".into(),
                    3,
                    "products".into(),
                    "sku".into(),
                    Some("code".into()),
                    "RESTRICT".into(),
                    "RESTRICT".into(),
                ),
                (
                    "line_items".into(),
                    0,
                    "products".into(),
                    "variant_id".into(),
                    Some("vid".into()),
                    "NO ACTION".into(),
                    "CASCADE".into(),
                ),
            ],
        );
        assert_eq!(fks.len(), 2);

        let line_items = &fks[0];
        assert_eq!(line_items.name, "FK_0_line_items");
        assert_eq!(line_items.table.as_deref(), Some("line_items"));
        assert_eq!(line_items.ref_table, "products");
        assert_eq!(line_items.columns, vec!["product_id", "variant_id"]);
        assert_eq!(line_items.ref_columns, vec!["id", "vid"]);
        assert_eq!(line_items.on_delete.as_deref(), Some("CASCADE"));

        let stock = &fks[1];
        assert_eq!(stock.name, "FK_3_stock_levels");
        assert_eq!(stock.columns, vec!["sku"]);
    }

    #[test]
    fn defaults_classify_like_sqlite_reports_them() {
        assert_eq!(classify_lite_default(None), (DefaultKind::None, None));
        assert_eq!(classify_lite_default(Some("")), (DefaultKind::None, None));
        assert_eq!(
            classify_lite_default(Some("NULL")),
            (DefaultKind::Null, None)
        );
        assert_eq!(
            classify_lite_default(Some("'it''s'")),
            (DefaultKind::Value, Some("it's".into()))
        );
        assert_eq!(
            classify_lite_default(Some("-12.5")),
            (DefaultKind::Value, Some("-12.5".into()))
        );
        assert_eq!(
            classify_lite_default(Some("datetime('now')")),
            (DefaultKind::Expression, Some("datetime('now')".to_string()))
        );
    }

    #[test]
    fn trigger_headers_parse_into_tree_metadata() {
        let (timing, event, table) = parse_lite_trigger(
            "CREATE TRIGGER audit AFTER INSERT ON users FOR EACH ROW BEGIN SELECT 1; END",
        );
        assert_eq!(timing, "AFTER");
        assert_eq!(event, "INSERT");
        assert!(table.contains("USERS"), "{table}");

        let (timing, event, _) = parse_lite_trigger(
            "CREATE TRIGGER t BEFORE UPDATE OF a ON items FOR EACH ROW BEGIN SELECT 1; END",
        );
        assert_eq!(timing, "BEFORE");
        assert_eq!(event, "UPDATE");
    }

    #[test]
    fn column_definitions_render_sqlite_syntax() {
        let d = SqlDialect::Sqlite;
        let col = ColumnDef {
            name: "price".into(),
            previous_name: None,
            data_type: "NUMERIC".into(),
            nullable: false,
            default_kind: DefaultKind::Value,
            default_value: Some("9.99".into()),
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        };
        assert_eq!(
            lite_column_definition(d, &col),
            "\"price\" NUMERIC NOT NULL DEFAULT 9.99"
        );

        let text_col = ColumnDef {
            default_value: Some("it's".into()),
            default_kind: DefaultKind::Value,
            data_type: String::new(),
            nullable: true,
            name: "note".into(),
            ..col
        };
        assert_eq!(
            lite_column_definition(d, &text_col),
            "\"note\" DEFAULT 'it''s'"
        );
    }

    #[test]
    fn alter_plan_supports_only_the_documented_subset() {
        use crate::connections::TableOptions;

        let mk_col = |name: &str, dtype: &str| ColumnDef {
            name: name.into(),
            previous_name: None,
            data_type: dtype.into(),
            nullable: true,
            default_kind: DefaultKind::None,
            default_value: None,
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        };

        let current = TableDdl {
            db: "main".into(),
            table: "users".into(),
            columns: vec![mk_col("id", "INTEGER"), mk_col("old", "TEXT")],
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
            options: TableOptions::default(),
            checks: Vec::new(),
            create_sql: String::new(),
        };

        // Add + rename column.
        let mut desired = current.clone();
        let mut renamed = mk_col("renamed", "TEXT");
        renamed.previous_name = Some("old".into());
        desired.columns = vec![mk_col("id", "INTEGER"), renamed, mk_col("age", "INT")];

        let plan = lite_alter_plan(&current, &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("ADD COLUMN \"age\" INT"), "{joined}");
        assert!(joined.contains("RENAME COLUMN \"old\" TO \"renamed\""), "{joined}");
        assert!(!joined.contains("DROP COLUMN"), "{joined}");

        // Drop column ok.
        let mut desired = current.clone();
        desired.columns.remove(1);
        let plan = lite_alter_plan(&current, &desired).unwrap();
        assert!(plan.statements.join("\n").contains("DROP COLUMN \"old\""));

        // Type modification refused with the documented message.
        let mut desired = current.clone();
        desired.columns[1].data_type = "BLOB".into();
        let err = lite_alter_plan(&current, &desired).unwrap_err();
        assert!(matches!(err, AppError::Unsupported(ref m) if m.contains("ADD COLUMN")));

        // Table rename goes last.
        let mut desired = current.clone();
        desired.table = "people".into();
        let plan = lite_alter_plan(&current, &desired).unwrap();
        assert_eq!(
            plan.statements.last().map(String::as_str),
            Some("ALTER TABLE \"users\" RENAME TO \"people\"")
        );
    }

    #[test]
    fn command_builders_are_dialect_correct() {
        assert_eq!(
            lite_drop_sql(ObjectKind::Table, "users").unwrap(),
            "DROP TABLE \"users\""
        );
        assert_eq!(
            lite_drop_sql(ObjectKind::View, "v").unwrap(),
            "DROP VIEW \"v\""
        );
        assert!(lite_drop_sql(ObjectKind::Routine, "p").is_err());
        assert!(lite_drop_sql(ObjectKind::Event, "e").is_err());

        assert_eq!(
            lite_rename_sql("users", "people"),
            "ALTER TABLE \"users\" RENAME TO \"people\""
        );
        assert_eq!(lite_truncate_sql("users"), "DELETE FROM \"users\"");

        assert_eq!(
            lite_maintenance_sql(MaintenanceOp::Optimize, "users").unwrap(),
            "VACUUM"
        );
        assert_eq!(
            lite_maintenance_sql(MaintenanceOp::Analyze, "users").unwrap(),
            "ANALYZE \"users\""
        );
        assert!(lite_maintenance_sql(MaintenanceOp::Checksum, "users").is_err());
    }

    #[test]
    fn create_table_inlines_constraints_and_defers_plain_indexes() {
        use crate::connections::{CreateTableRequest, ForeignKeyMeta, TableOptions};

        let req = CreateTableRequest {
            name: "orders".into(),
            columns: vec![ColumnDef {
                name: "id".into(),
                previous_name: None,
                data_type: "INTEGER".into(),
                nullable: false,
                default_kind: DefaultKind::None,
                default_value: None,
                auto_increment: false,
                on_update: None,
                generated: None,
                comment: None,
                preserved_attrs: Vec::new(),
            }],
            indexes: vec![
                IndexMeta {
                    name: "PRIMARY".into(),
                    kind: IndexKind::Primary,
                    columns: vec!["id".into()],
                    comment: None,
                },
                IndexMeta {
                    name: "idx_extra".into(),
                    kind: IndexKind::Index,
                    columns: vec!["id".into()],
                    comment: None,
                },
            ],
            foreign_keys: vec![ForeignKeyMeta {
                name: "fk_user".into(),
                columns: vec!["user_id".into()],
                ref_db: None,
                ref_table: "users".into(),
                ref_columns: vec!["id".into()],
                on_update: Some("CASCADE".into()),
                on_delete: Some("SET NULL".into()),
                table: None,
            }],
            options: TableOptions::default(),
        };
        let sql = lite_create_table("main", &req).unwrap();
        assert!(sql.contains("PRIMARY KEY (\"id\")"), "{sql}");
        assert!(sql.contains("CONSTRAINT \"fk_user\" FOREIGN KEY (\"user_id\") REFERENCES \"users\" (\"id\") ON DELETE SET NULL ON UPDATE CASCADE"), "{sql}");
        assert!(sql.contains("CREATE INDEX \"idx_extra\" ON \"orders\" (\"id\");"), "{sql}");
    }

    #[test]
    fn pseudo_database_name_comes_from_the_file_stem() {
        assert_eq!(SqliteConnection::database_name("/data/app.sqlite3"), "app");
        assert_eq!(SqliteConnection::database_name("notes.db"), "notes");
        assert_eq!(SqliteConnection::database_name(":memory:"), ":memory:");
        assert_eq!(SqliteConnection::database_name(""), "main");
    }
}

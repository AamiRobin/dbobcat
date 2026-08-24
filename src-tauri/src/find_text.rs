//! Find text on server (Phase 7) — Heidi's "Search in database" tool.
//!
//! Scans string columns of the requested tables with LIKE / REGEXP
//! predicates and reports matches as [`FindTextMatch`] rows. Design:
//!
//! - Reuses the export engine's streaming + cancellation machinery: row
//!   chunks flow through `stream_query_rows` on the connection actor, and a
//!   shared cancel registry id powers `find_cancel` (the `find://progress`
//!   event mirrors `export://progress`).
//! - The WHERE predicate is authoritative; a Rust-side re-check of every
//!   candidate cell only decides *which* column matched so the preview shows
//!   the right value. Both sides share the same mode semantics from
//!   [`server_admin`].
//! - Values are inlined through the dedicated literal escaper because the
//!   streamed-SELECT path has no bind-parameter channel — same documented
//!   exception as CREATE USER, unit-tested at the source.
//! - PK values are selected first and rendered (`a|b` across PK columns,
//!   ctid on PG tables without one) so results can jump back to the row.

use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::connections::dialect::SqlDialect;
use crate::connections::manager::ConnectionManager;
use crate::connections::server_admin::{compile_regex, sql_literal};
use crate::connections::{ColumnMeta, FindMode, FindTextMatch, FindTextRequest, RowValue};
use crate::error::{AppError, Result};
use crate::export::{begin_export, end_export, request_cancel, stream_rows, CancelToken};

/// Progress/cancel channel for find-text runs.
pub const FIND_PROGRESS_EVENT: &str = "find://progress";

/// Preview cap per match (Heidi truncates similarly).
const PREVIEW_MAX_CHARS: usize = 200;

/// Streaming chunk size per table scan.
const SCAN_CHUNK_ROWS: usize = 500;

/// Hard ceiling for "max matches per table"; 0 from the UI means this cap.
const MAX_MATCHES_CEILING: u32 = 10_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTextProgress {
    pub id: u32,
    /// "scanning" | "table_done" | "done" | "cancelled".
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    pub tables_done: usize,
    pub total_tables: usize,
    pub matches: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindTextResult {
    pub id: u32,
    pub matches: Vec<FindTextMatch>,
    pub cancelled: bool,
    pub tables_scanned: usize,
    pub elapsed_ms: u64,
}

/// Cooperative cancel handle mirroring `export_cancel`.
pub fn find_request_cancel(id: u32) -> bool {
    request_cancel(id)
}

/// Run the whole scan; resolves when finished or cancelled (partial results
/// are returned with `cancelled = true`). SQLite connections never reach
/// here — the command layer gates them out.
pub async fn find_text(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    req: FindTextRequest,
) -> Result<FindTextResult> {
    let dialect = manager.server_info(conn_id).await?.dialect;
    if dialect == SqlDialect::Sqlite {
        return Err(AppError::Unsupported(
            "find text on server requires MySQL or PostgreSQL".into(),
        ));
    }
    let search = req.search.trim().to_string();
    if search.is_empty() {
        return Err(AppError::Db("search text must not be empty".into()));
    }

    // Pre-validate regex before touching any table.
    if req.mode == FindMode::Regex {
        compile_regex(&search, req.case_sensitive)?;
    }

    // Resolve the scan plan up front so progress has a denominator.
    let mut plan: Vec<(String, String)> = Vec::new();
    for db in &req.dbs {
        match &req.tables {
            Some(tables) => plan.extend(tables.iter().map(|t| (db.clone(), t.clone()))),
            None => {
                for meta in manager.list_tables(conn_id, db).await? {
                    // Views would need INSTEAD-of machinery; base tables only.
                    if crate::connections::TableKind::Table == meta.kind {
                        plan.push((db.clone(), meta.name));
                    }
                }
            }
        }
    }
    let total_tables = plan.len();
    let max_per_table =
        (req.max_matches_per_table.clamp(0, MAX_MATCHES_CEILING) as usize).max(1);

    let started = Instant::now();
    let (id, cancel) = begin_export();

    let outcome = scan_all(
        app, manager, conn_id, &req, &search, dialect, plan, total_tables, max_per_table, id,
        &cancel, started,
    )
    .await;

    end_export(id);
    outcome
}

#[allow(clippy::too_many_arguments)]
async fn scan_all(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    req: &FindTextRequest,
    search: &str,
    dialect: SqlDialect,
    plan: Vec<(String, String)>,
    total_tables: usize,
    max_per_table: usize,
    id: u32,
    cancel: &CancelToken,
    started: Instant,
) -> Result<FindTextResult> {
    let mut matches: Vec<FindTextMatch> = Vec::new();
    let mut tables_done = 0usize;
    let mut cancelled = false;

    'plan: for (db, table) in &plan {
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
        emit(app, id, "scanning", Some(db), Some(table), tables_done, total_tables, matches.len());

        // Column metadata drives everything: PK selection order, searchable
        // column set and identifier validation (all quoted afterwards).
        let columns = manager.describe_table(conn_id, db, table).await?;
        let pk_cols: Vec<&ColumnMeta> =
            columns.iter().filter(|c| c.key.as_deref() == Some("PRI")).collect();
        let text_cols: Vec<&ColumnMeta> =
            columns.iter().filter(|c| is_text_column(&c.data_type)).collect();

        if !text_cols.is_empty() {
            let pk_names: Vec<String> = pk_cols.iter().map(|c| c.name.clone()).collect();
            let text_col_names: Vec<String> =
                text_cols.iter().map(|c| c.name.clone()).collect();
            let sql = build_scan_sql(dialect, db, table, &pk_names, &text_cols, req, search, max_per_table);
            let mut table_matches = 0usize;

            let stats = stream_rows(
                manager,
                conn_id,
                &crate::export::RowSource::Sql(sql),
                SCAN_CHUNK_ROWS,
                cancel,
                |_cols, rows, _base| {
                    for row in rows {
                        if table_matches >= max_per_table || matches.len() >= MAX_TOTAL_MATCHES {
                            break;
                        }
                        if let Some(m) = match_row(
                            dialect, db, table, row, &pk_names, &text_col_names, req, search,
                        ) {
                            matches.push(m);
                            table_matches += 1;
                        }
                    }
                    Ok(())
                },
            )
            .await?;

            cancelled |= stats.cancelled;
            if cancelled {
                break 'plan;
            }
        }

        tables_done += 1;
        emit(
            app, id, "table_done", Some(db), Some(table), tables_done, total_tables,
            matches.len(),
        );

        if matches.len() >= MAX_TOTAL_MATCHES {
            break;
        }
    }

    let phase = if cancelled { "cancelled" } else { "done" };
    emit(app, id, phase, None, None, tables_done, total_tables, matches.len());

    Ok(FindTextResult {
        id,
        matches,
        cancelled,
        tables_scanned: tables_done,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Global safety net across all tables (Heidi caps nothing here; we do).
const MAX_TOTAL_MATCHES: usize = 50_000;

#[allow(clippy::too_many_arguments)]
fn emit(
    app: &AppHandle,
    id: u32,
    phase: &str,
    db: Option<&str>,
    table: Option<&str>,
    tables_done: usize,
    total_tables: usize,
    matches: usize,
) {
    let _ = app.emit(
        FIND_PROGRESS_EVENT,
        FindTextProgress {
            id,
            phase: phase.into(),
            db: db.map(|d| d.to_string()),
            table: table.map(|t| t.to_string()),
            tables_done,
            total_tables,
            matches,
        },
    );
}

// ---------------------------------------------------------------------------
// SQL construction (pure, unit-tested)
// ---------------------------------------------------------------------------

/// String-ish column types worth scanning (char/text family, enum/set,
/// JSON/UUID); excludes blobs/binary/numbers/dates.
fn is_text_column(data_type: &str) -> bool {
    let base = data_type.split('(').next().unwrap_or("").trim().to_ascii_lowercase();
    [
        "char",
        "text",
        "enum",
        "set",
        "json",
        "uuid",
        "name",
        "xml",
    ]
    .iter()
    .any(|needle| base.contains(needle))
}

/// Escape LIKE wildcards so user text matches literally, then wrap it into
/// the mode-specific operand. Regex mode never goes through LIKE.
fn like_operand(mode: FindMode, raw: &str) -> String {
    let mut escaped = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c == '\\' || c == '%' || c == '_' {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    match mode {
        FindMode::Contains => format!("%{escaped}%"),
        FindMode::Prefix => format!("{escaped}%"),
        FindMode::Whole => escaped,
        FindMode::Regex => unreachable!("regex handled separately"),
    }
}

/// The comparison operator for one predicate. MySQL LIKE is collation-driven
/// (usually case-insensitive), so case-sensitive searches switch to
/// `LIKE BINARY`; PostgreSQL flips between ILIKE and LIKE instead.
fn like_operator(dialect: SqlDialect, case_sensitive: bool) -> &'static str {
    match dialect {
        SqlDialect::Mysql if case_sensitive => "LIKE BINARY",
        SqlDialect::Postgres if !case_sensitive => "ILIKE",
        _ => "LIKE",
    }
}

/// Regex operator: MySQL `REGEXP [BINARY]`, PG `~*` / `~`.
fn regex_operator(dialect: SqlDialect, case_sensitive: bool) -> &'static str {
    match dialect {
        SqlDialect::Mysql if case_sensitive => "REGEXP BINARY",
        SqlDialect::Mysql => "REGEXP",
        SqlDialect::Postgres if case_sensitive => "~",
        SqlDialect::Postgres => "~*",
        SqlDialect::Sqlite => unreachable!("sqlite gated out"),
    }
}

/// Build the full scan SELECT for one table:
/// `SELECT pk…, text… FROM q WHERE (p1 OR p2 …) LIMIT n`.
#[allow(clippy::too_many_arguments)]
fn build_scan_sql(
    dialect: SqlDialect,
    db: &str,
    table: &str,
    pk_names: &[String],
    text_cols: &[&ColumnMeta],
    req: &FindTextRequest,
    search: &str,
    limit: usize,
) -> String {
    let table_q = dialect.quote_qualified(&[db, table]);
    let mut select_parts: Vec<String> = Vec::new();
    if pk_names.is_empty() && dialect == SqlDialect::Postgres {
        select_parts.push("ctid::text".to_string());
    }
    for name in pk_names {
        select_parts.push(dialect.quote_ident(name));
    }
    for col in text_cols {
        select_parts.push(dialect.quote_ident(&col.name));
    }

    let predicates: Vec<String> = text_cols
        .iter()
        .map(|col| {
            let ident = dialect.quote_ident(&col.name);
            if req.mode == FindMode::Regex {
                let pattern = sql_literal(dialect, search);
                format!("{ident} {} {pattern}", regex_operator(dialect, req.case_sensitive))
            } else {
                let operand = sql_literal(dialect, &like_operand(req.mode, search));
                // MySQL needs the escape char written as '\\' (backslash is
                // a string escape); PostgreSQL's default LIKE escape char is
                // already backslash and an explicit two-char ESCAPE would be
                // invalid — so the clause is emitted for MySQL only.
                let escape_clause = match dialect {
                    SqlDialect::Mysql => " ESCAPE '\\\\'",
                    _ => "",
                };
                format!(
                    "{ident} {} {operand}{escape_clause}",
                    like_operator(dialect, req.case_sensitive)
                )
            }
        })
        .collect();

    let where_clause = predicates.join(" OR ");
    let select_clause = select_parts.join(", ");
    format!("SELECT {select_clause} FROM {table_q} WHERE {where_clause} LIMIT {limit}")
}

/// Decide which column of a candidate row actually matched and render the
/// [`FindTextMatch`] (PK string + truncated preview).
#[allow(clippy::too_many_arguments)]
fn match_row(
    dialect: SqlDialect,
    db: &str,
    table: &str,
    row: &[RowValue],
    pk_names: &[String],
    text_col_names: &[String],
    req: &FindTextRequest,
    search: &str,
) -> Option<FindTextMatch> {
    // PG tables without a PK carry a leading `ctid::text` column instead.
    let leading = if pk_names.is_empty() && dialect == SqlDialect::Postgres {
        1
    } else {
        pk_names.len()
    };

    let row_pk: String = if pk_names.is_empty() && dialect == SqlDialect::Postgres {
        cell_display(&row[0]) // ctid
    } else if pk_names.is_empty() {
        String::new()
    } else {
        row[..leading]
            .iter()
            .map(cell_display)
            .collect::<Vec<_>>()
            .join("|")
    };

    let pk_column = pk_names.first().cloned();

    for (offset, value) in row[leading..leading + text_col_names.len()].iter().enumerate() {
        let rendered = cell_display(value);
        if server_admin_match(req.mode, &rendered, search, req.case_sensitive) {
            let preview: String = rendered.chars().take(PREVIEW_MAX_CHARS).collect();
            return Some(FindTextMatch {
                db: db.to_string(),
                table: table.to_string(),
                column: text_col_names[offset].clone(),
                pk_column,
                row_pk,
                preview,
            });
        }
    }
    None
}

/// Re-exported matcher kept indirection-free for tests.
fn server_admin_match(mode: FindMode, haystack: &str, needle: &str, cs: bool) -> bool {
    use crate::connections::server_admin::text_matches;
    text_matches(mode, haystack, needle, cs)
}

/// Rendered form of one cell for preview/PK strings (NULL → empty).
fn cell_display(value: &RowValue) -> String {
    match value {
        RowValue::Null => String::new(),
        RowValue::Int(v) => v.to_string(),
        RowValue::UInt(v) => v.to_string(),
        RowValue::Float(v) => v.to_string(),
        RowValue::Str(s) => s.clone(),
        RowValue::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => s.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn col(name: &str, dt: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            data_type: dt.into(),
            nullable: true,
            key: None,
            default_value: None,
            extra: None,
            comment: None,
        }
    }

    #[test]
    fn text_column_detection() {
        assert!(is_text_column("varchar(255)"));
        assert!(is_text_column("text"));
        assert!(is_text_column("character varying"));
        assert!(is_text_column("mediumtext"));
        assert!(is_text_column("enum('a','b')"));
        assert!(is_text_column("json"));
        assert!(is_text_column("uuid"));
        assert!(is_text_column("character varying"));
        assert!(!is_text_column("int unsigned"));
        assert!(!is_text_column("bigint"));
        assert!(!is_text_column("varbinary(16)"));
        assert!(!is_text_column("longblob"));
        assert!(!is_text_column("datetime"));
        assert!(!is_text_column("decimal(10,2)"));
        assert!(is_text_column("jsonb"));
    }

    #[test]
    fn like_operands_wrap_and_escape() {
        assert_eq!(like_operand(FindMode::Contains, "a%b_c"), "%a\\%b\\_c%");
        assert_eq!(like_operand(FindMode::Prefix, "50\\off"), "50\\\\off%");
        assert_eq!(like_operand(FindMode::Whole, "x_y"), "x\\_y");
        assert_eq!(like_operand(FindMode::Contains, ""), "%%");
    }

    #[test]
    fn operators_flip_on_case_sensitivity_and_dialect() {
        assert_eq!(like_operator(SqlDialect::Mysql, true), "LIKE BINARY");
        assert_eq!(like_operator(SqlDialect::Mysql, false), "LIKE");
        assert_eq!(like_operator(SqlDialect::Postgres, true), "LIKE");
        assert_eq!(like_operator(SqlDialect::Postgres, false), "ILIKE");

        assert_eq!(regex_operator(SqlDialect::Mysql, true), "REGEXP BINARY");
        assert_eq!(regex_operator(SqlDialect::Mysql, false), "REGEXP");
        assert_eq!(regex_operator(SqlDialect::Postgres, true), "~");
        assert_eq!(regex_operator(SqlDialect::Postgres, false), "~*");
    }

    #[test]
    fn scan_sql_mysql_contains_with_pk_first() {
        let mut id = col("id", "int unsigned");
        id.key = Some("PRI".into());
        let name = col("name", "varchar(40)");
        let note = col("note", "text");
        let text: Vec<&ColumnMeta> = vec![&name, &note];
        let req = FindTextRequest {
            dbs: vec!["shop".into()],
            tables: None,
            search: "hello".into(),
            mode: FindMode::Contains,
            case_sensitive: false,
            max_matches_per_table: 25,
        };
        let sql = build_scan_sql(
            SqlDialect::Mysql,
            "shop",
            "orders",
            &["id".to_string()],
            &text,
            &req,
            "hello",
            25,
        );
        assert_eq!(
            sql,
            "SELECT `id`, `name`, `note` FROM `shop`.`orders` \
             WHERE `name` LIKE '%hello%' ESCAPE '\\\\' OR `note` LIKE '%hello%' ESCAPE '\\\\' \
             LIMIT 25"
        );
    }

    #[test]
    fn scan_sql_pg_regex_case_insensitive_with_ctid_fallback() {
        let name = col("name", "text");
        let text: Vec<&ColumnMeta> = vec![&name];
        let req = FindTextRequest {
            dbs: vec!["public".into()],
            tables: None,
            search: "^ab".into(),
            mode: FindMode::Regex,
            case_sensitive: false,
            max_matches_per_table: 0,
        };
        let sql = build_scan_sql(
            SqlDialect::Postgres,
            "public",
            "events",
            &[],
            &text,
            &req,
            "^ab",
            1, // clamped ceiling applied by caller
        );
        assert_eq!(
            sql,
            "SELECT ctid::text, \"name\" FROM \"public\".\"events\" \
             WHERE \"name\" ~* '^ab' LIMIT 1"
        );
    }

    #[test]
    fn whole_mode_builds_exact_like_predicate_mysql_and_pg() {
        let note = col("note", "varchar(20)");
        let text: Vec<&ColumnMeta> = vec![&note];
        let req = FindTextRequest {
            dbs: vec!["db".into()],
            tables: None,
            search: "a'b".into(),
            mode: FindMode::Whole,
            case_sensitive: true,
            max_matches_per_table: 5,
        };
        let mysql = build_scan_sql(SqlDialect::Mysql, "db", "t", &[], &text, &req, "a'b", 5);
        assert_eq!(
            mysql,
            "SELECT `note` FROM `db`.`t` WHERE `note` LIKE BINARY 'a''b' ESCAPE '\\\\' LIMIT 5"
        );

        let pg = build_scan_sql(SqlDialect::Postgres, "db", "t", &[], &text, &req, "a'b", 5);
        // No PK on PG → leading ctid fallback column.
        assert_eq!(
            pg,
            "SELECT ctid::text, \"note\" FROM \"db\".\"t\" WHERE \"note\" LIKE 'a''b' LIMIT 5"
        );
    }
}

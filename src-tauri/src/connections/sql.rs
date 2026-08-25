//! Pure SQL text builders for the data grid (Phase 2).
//!
//! Everything here is synchronous and side-effect free so it can be unit
//! tested without a database. Rules enforced for every builder:
//!
//! - **Identifiers** (table/column names) are validated against live schema
//!   metadata first, then quoted via [`quote_ident`] — unknown columns never
//!   reach SQL text.
//! - **Values** never enter the SQL string; they come back as positional
//!   bind parameters alongside it.

use mysql_async::Value;

use crate::connections::dialect::{Placeholders, SqlDialect};
use crate::connections::{
    quote_qualified, CellAssign, ColumnMeta, FilterOp, FilterSpec, RowChange, RowValue,
    SortDirection,
};
use crate::error::{AppError, Result};

/// A built statement: SQL text plus its positional bind parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltSql {
    pub sql: String,
    pub params: Vec<Value>,
}

/// Look up a column by name, rejecting anything not present in the table.
pub fn validate_column<'a>(columns: &'a [ColumnMeta], name: &str) -> Result<&'a ColumnMeta> {
    columns
        .iter()
        .find(|c| c.name == name)
        .ok_or_else(|| AppError::Db(format!("unknown column {name:?} for this table")))
}

/// Convert a grid cell into a bind parameter. Text is sent as-is and coerced
/// by the server; explicit NULL binds as SQL NULL.
pub fn bind_value(value: &RowValue) -> Value {
    match value {
        RowValue::Null => Value::NULL,
        RowValue::Int(v) => Value::Int(*v),
        RowValue::UInt(v) => Value::UInt(*v),
        RowValue::Float(v) => Value::Double(*v),
        RowValue::Str(s) => Value::Bytes(s.clone().into_bytes()),
        RowValue::Bytes(b) => Value::Bytes(b.clone()),
        // Date/time strings are already ISO-ish; the server parses them.
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => {
            Value::Bytes(s.clone().into_bytes())
        }
    }
}

fn bind_opt(value: &Option<String>) -> Value {
    match value {
        Some(s) => Value::Bytes(s.clone().into_bytes()),
        None => Value::NULL,
    }
}

/// Build the `ORDER BY` clause (`""` when no sort terms), validating every
/// column against the described schema to block ORDER BY injection.
pub fn build_order_by_clause(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    specs: &[crate::connections::SortSpec],
) -> Result<String> {
    if specs.is_empty() {
        return Ok(String::new());
    }
    let mut out = String::from(" ORDER BY ");
    for (i, spec) in specs.iter().enumerate() {
        let meta = validate_column(columns, &spec.column)?;
        if i > 0 {
            out.push_str(", ");
        }
        out.push_str(&dialect.quote_ident(&meta.name));
        match spec.direction {
            SortDirection::Asc => out.push_str(" ASC"),
            SortDirection::Desc => out.push_str(" DESC"),
        }
    }
    Ok(out)
}

/// SQL operator text for a validated filter op.
fn filter_op_sql(op: FilterOp) -> &'static str {
    match op {
        FilterOp::Eq => "=",
        FilterOp::NotEq => "<>",
        FilterOp::Lt => "<",
        FilterOp::LtE => "<=",
        FilterOp::Gt => ">",
        FilterOp::GtE => ">=",
        FilterOp::Like => "LIKE",
        FilterOp::NotLike => "NOT LIKE",
        FilterOp::IsNull => "IS NULL",
        FilterOp::IsNotNull => "IS NOT NULL",
        // Rendered by the dedicated IN branch in build_where_clause.
        FilterOp::In => "IN",
    }
}

/// True when the operator takes no value operand.
pub fn filter_op_is_predicate(op: FilterOp) -> bool {
    matches!(op, FilterOp::IsNull | FilterOp::IsNotNull)
}

/// Build the `WHERE` clause AND-ing every filter term (`""` when `filters`
/// is empty), validating each column against the schema and binding every
/// value.
///
/// The `in` operator expands [`FilterSpec::values`] into one bound parameter
/// per item; an empty item list renders `1 = 0` (matches nothing) instead of
/// invalid `IN ()` syntax. Placeholder numbering is shared across terms so
/// PostgreSQL's `$n` marks ascend correctly through the whole clause.
pub fn build_where_clause_and(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    filters: &[FilterSpec],
) -> Result<BuiltSql> {
    if filters.is_empty() {
        return Ok(BuiltSql { sql: String::new(), params: Vec::new() });
    }
    let mut marks = Placeholders::new(dialect);
    let mut parts: Vec<String> = Vec::with_capacity(filters.len());
    let mut params = Vec::new();
    for filter in filters {
        let meta = validate_column(columns, &filter.column)?;
        let ident = dialect.quote_ident(&meta.name);
        if filter.op == FilterOp::In {
            if filter.values.is_empty() {
                parts.push("1 = 0".into());
                continue;
            }
            let term_marks = filter
                .values
                .iter()
                .map(|_| marks.mark())
                .collect::<Vec<_>>()
                .join(", ");
            parts.push(format!("{ident} IN ({term_marks})"));
            params.extend(filter.values.iter().map(bind_value));
            continue;
        }
        if filter_op_is_predicate(filter.op) {
            parts.push(format!("{ident} {}", filter_op_sql(filter.op)));
            continue;
        }
        let mark = marks.mark();
        parts.push(format!("{ident} {} {mark}", filter_op_sql(filter.op)));
        params.push(bind_opt(&filter.value));
    }
    Ok(BuiltSql {
        sql: format!(" WHERE {}", parts.join(" AND ")),
        params,
    })
}

/// Build the `WHERE` clause for an optional single-term filter (`""` when
/// absent). Thin wrapper over [`build_where_clause_and`] kept for the
/// `count_rows` trait surface.
pub fn build_where_clause(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    filter: Option<&FilterSpec>,
) -> Result<BuiltSql> {
    match filter {
        Some(f) => build_where_clause_and(dialect, columns, std::slice::from_ref(f)),
        None => Ok(BuiltSql { sql: String::new(), params: Vec::new() }),
    }
}

/// Build a WHERE predicate matching rows by their key cells (PK or full-row
/// fallback). NULL cells render as `IS NULL` so NULL-keyed rows stay
/// addressable.
///
/// Errors when `cells` is empty (would match every row).
pub fn build_key_predicate(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    cells: &[CellAssign],
) -> Result<BuiltSql> {
    let mut marks = Placeholders::new(dialect);
    key_predicate_with(dialect, columns, cells, &mut marks)
}

/// [`build_key_predicate`] continuing a shared placeholder sequence so
/// composite statements (UPDATE … SET $1..$n WHERE pk = $n+1) stay valid
/// for PostgreSQL's numbered marks.
fn key_predicate_with(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    cells: &[CellAssign],
    marks: &mut Placeholders,
) -> Result<BuiltSql> {
    if cells.is_empty() {
        return Err(AppError::Db(
            "cannot build a row predicate without any column values".into(),
        ));
    }
    let mut parts = Vec::with_capacity(cells.len());
    let mut params = Vec::with_capacity(cells.len());
    for cell in cells {
        let meta = validate_column(columns, &cell.column)?;
        let ident = dialect.quote_ident(&meta.name);
        if cell.value.is_null() {
            parts.push(format!("{ident} IS NULL"));
        } else {
            let mark = marks.mark();
            parts.push(format!("{ident} = {mark}"));
            params.push(bind_value(&cell.value));
        }
    }
    Ok(BuiltSql {
        sql: parts.join(" AND "),
        params,
    })
}

/// Validate every assignment and produce the quoted column list + params.
fn prepare_assignments(
    dialect: SqlDialect,
    columns: &[ColumnMeta],
    assigns: &[CellAssign],
    what: &str,
) -> Result<(Vec<String>, Vec<Value>)> {
    if assigns.is_empty() {
        return Err(AppError::Db(format!("no {what} provided")));
    }
    let mut idents = Vec::with_capacity(assigns.len());
    let mut params = Vec::with_capacity(assigns.len());
    for assign in assigns {
        let meta = validate_column(columns, &assign.column)?;
        idents.push(dialect.quote_ident(&meta.name));
        params.push(bind_value(&assign.value));
    }
    Ok((idents, params))
}

/// `INSERT INTO tbl (`a`, ...) VALUES (?, ...)`
pub fn build_insert_sql(
    dialect: SqlDialect,
    table_q: &str,
    columns: &[ColumnMeta],
    values: &[CellAssign],
) -> Result<BuiltSql> {
    let (idents, params) = prepare_assignments(dialect, columns, values, "insert values")?;
    let cols = idents.join(", ");
    let mut marks_gen = Placeholders::new(dialect);
    let marks = (0..idents.len())
        .map(|_| marks_gen.mark())
        .collect::<Vec<_>>()
        .join(", ");
    Ok(BuiltSql {
        sql: format!("INSERT INTO {table_q} ({cols}) VALUES ({marks})"),
        params,
    })
}

/// `UPDATE tbl SET `a` = ?, ... WHERE <pk>`
pub fn build_update_sql(
    dialect: SqlDialect,
    table_q: &str,
    columns: &[ColumnMeta],
    pk: &[CellAssign],
    set: &[CellAssign],
) -> Result<BuiltSql> {
    let (set_idents, mut params) = prepare_assignments(dialect, columns, set, "update assignments")?;
    // One placeholder sequence spans SET and WHERE so PostgreSQL numbering
    // ascends left to right ($1..$n).
    let mut marks = Placeholders::new(dialect);
    let mut set_parts = Vec::with_capacity(set_idents.len());
    for ident in &set_idents {
        let mark = marks.mark();
        set_parts.push(format!("{ident} = {mark}"));
    }
    let predicate = key_predicate_with(dialect, columns, pk, &mut marks)?;
    params.extend(predicate.params);
    Ok(BuiltSql {
        sql: format!("UPDATE {table_q} SET {} WHERE {}", set_parts.join(", "), predicate.sql),
        params,
    })
}

/// `DELETE FROM tbl WHERE <pk>`
pub fn build_delete_sql(
    dialect: SqlDialect,
    table_q: &str,
    columns: &[ColumnMeta],
    pk: &[CellAssign],
) -> Result<BuiltSql> {
    let predicate = build_key_predicate(dialect, columns, pk)?;
    Ok(BuiltSql {
        sql: format!("DELETE FROM {table_q} WHERE {}", predicate.sql),
        params: predicate.params,
    })
}

/// Build one change into its executable statement.
pub fn build_change_sql(
    dialect: SqlDialect,
    table_q: &str,
    columns: &[ColumnMeta],
    change: &RowChange,
) -> Result<BuiltSql> {
    match change {
        RowChange::Insert { values } => build_insert_sql(dialect, table_q, columns, values),
        RowChange::Update { pk, set } => build_update_sql(dialect, table_q, columns, pk, set),
        RowChange::Delete { pk } => build_delete_sql(dialect, table_q, columns, pk),
    }
}

/// Assemble the paged SELECT from validated parts:
/// `SELECT cols FROM db.tbl [WHERE ...] [ORDER BY ...] LIMIT n OFFSET m`
pub fn build_page_sql(
    dialect: SqlDialect,
    table_q: &str,
    select_columns: &[String],
    where_clause: &BuiltSql,
    order_clause: &str,
    limit: u32,
    offset: u64,
) -> String {
    let cols = select_columns
        .iter()
        .map(|c| dialect.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "SELECT {cols} FROM {table_q}{}{order_clause} {}",
        where_clause.sql,
        dialect.limit_clause(limit as u64, offset)
    )
}

/// qualify_table with an explicit dialect.
pub fn qualify_table_dialect(dialect: SqlDialect, db: &str, table: &str) -> String {
    dialect.quote_qualified(&[db, table])
}

/// Fully qualified table identifier for SQL text.
pub fn qualify_table(db: &str, table: &str) -> String {
    quote_qualified(&[db, table])
}

/// Distinct-value census for the quick-filter "More values…" dialog:
/// `SELECT <value_expr> AS col, <count_expr> AS cnt FROM tbl
///  [WHERE col LIKE ?] GROUP BY col ORDER BY cnt DESC LIMIT n OFFSET 0`.
///
/// `value_expr`/`count_expr` let each driver control result typing (e.g.
/// PostgreSQL casts to `::text` so row decoding stays uniform); identifiers
/// inside them are quoted by the caller. NULLs group naturally as one NULL
/// bucket. The optional search binds as a parameter (`%…%` supplied by the
/// caller).
pub fn build_distinct_values_sql(
    dialect: SqlDialect,
    table_q: &str,
    column: &ColumnMeta,
    value_expr: &str,
    count_expr: &str,
    search: Option<&str>,
    limit: u32,
) -> BuiltSql {
    let ident = dialect.quote_ident(&column.name);
    let cnt = dialect.quote_ident("cnt");
    let mut params = Vec::new();
    let where_clause = match search {
        Some(_) => {
            let mark = dialect.placeholder(1);
            params.push(bind_opt(&search.map(|s| s.to_string())));
            format!(" WHERE {ident} LIKE {mark}")
        }
        None => String::new(),
    };
    let limit = dialect.limit_clause(limit as u64, 0);
    BuiltSql {
        sql: format!(
            "SELECT {value_expr} AS {ident}, {count_expr} AS {cnt} \
             FROM {table_q}{where_clause} GROUP BY {ident} ORDER BY {cnt} DESC {limit}"
        ),
        params,
    }
}

/// Top-N read for FK dropdowns: `SELECT pk…[, display] FROM ref
/// ORDER BY pk… LIMIT n OFFSET 0`. Identifiers only — no bind values.
pub fn build_fk_ref_sql(
    dialect: SqlDialect,
    ref_table_q: &str,
    pk_columns: &[String],
    display_column: Option<&str>,
    limit: u32,
) -> Result<BuiltSql> {
    if pk_columns.is_empty() {
        return Err(AppError::Db(
            "foreign key target has no referenced columns".into(),
        ));
    }
    let mut select = Vec::with_capacity(pk_columns.len() + 1);
    let mut order = Vec::with_capacity(pk_columns.len());
    for name in pk_columns {
        let ident = dialect.quote_ident(name);
        select.push(ident.clone());
        order.push(ident);
    }
    if let Some(display) = display_column {
        select.push(dialect.quote_ident(display));
    }
    Ok(BuiltSql {
        sql: format!(
            "SELECT {} FROM {ref_table_q} ORDER BY {} {}",
            select.join(", "),
            order.join(", "),
            dialect.limit_clause(limit as u64, 0),
        ),
        params: Vec::new(),
    })
}

/// Multi-row bulk insert used by the CSV importer (Phase 5):
/// `INSERT [IGNORE] INTO tbl (`a`, ...) VALUES (?, ...), (?, ...)`
/// plus an optional `ON DUPLICATE KEY UPDATE` tail for upserts.
///
/// Contract: every column name was validated against a live `describe`
/// by the caller before reaching this builder.
pub fn build_multirow_insert(
    dialect: SqlDialect,
    table_q: &str,
    columns: &[String],
    row_count: usize,
    ignore: bool,
    upsert_columns: Option<&[String]>,
) -> String {
    let idents: Vec<String> = columns.iter().map(|c| dialect.quote_ident(c)).collect();
    let cols = idents.join(", ");
    let one_row = std::iter::repeat_n("?", columns.len())
        .collect::<Vec<_>>()
        .join(", ");
    let rows = std::iter::repeat_n(format!("({one_row})"), row_count.max(1))
        .collect::<Vec<_>>()
        .join(", ");
    let verb = dialect.insert_verb(ignore);
    let mut sql = format!("{verb} {table_q} ({cols}) VALUES {rows}");
    if upsert_columns.is_some() && dialect == SqlDialect::Mysql {
        // MySQL's ON DUPLICATE KEY fires on any unique violation and cannot
        // be combined with INSERT IGNORE — the caller picks one.
        if ignore {
            return sql;
        }
    }
    sql.push_str(&dialect.upsert_suffix(upsert_columns, ignore, |c| dialect.quote_ident(c)));
    sql
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{SortDirection, SortSpec};

    fn sample_columns() -> Vec<ColumnMeta> {
        vec![
            ColumnMeta {
                name: "id".into(),
                data_type: "int unsigned".into(),
                nullable: false,
                key: Some("PRI".into()),
                default_value: None,
                extra: Some("auto_increment".into()),
                comment: None,
            },
            ColumnMeta {
                name: "name".into(),
                data_type: "varchar(100)".into(),
                nullable: true,
                key: None,
                default_value: None,
                extra: None,
                comment: None,
            },
            ColumnMeta {
                name: "score".into(),
                data_type: "double".into(),
                nullable: true,
                key: None,
                default_value: None,
                extra: None,
                comment: None,
            },
        ]
    }

    fn col(name: &str, value: RowValue) -> CellAssign {
        CellAssign {
            column: name.into(),
            value,
        }
    }

    #[test]
    fn order_by_validates_columns() {
        let cols = sample_columns();
        // Unknown sort column is rejected outright (injection guard).
        let err = build_order_by_clause(
            SqlDialect::Mysql,
            &cols,
            &[SortSpec { column: "evil; DROP".into(), direction: SortDirection::Asc }],
        );
        assert!(err.is_err());

        let ok = build_order_by_clause(
            SqlDialect::Mysql,
            &cols,
            &[
                SortSpec { column: "name".into(), direction: SortDirection::Desc },
                SortSpec { column: "id".into(), direction: SortDirection::Asc },
            ],
        )
        .unwrap();
        assert_eq!(ok, " ORDER BY `name` DESC, `id` ASC");
    }

    #[test]
    fn empty_order_by_is_empty_clause() {
        assert_eq!(build_order_by_clause(SqlDialect::Mysql, &sample_columns(), &[]).unwrap(), "");
    }

    #[test]
    fn filter_ops_render_and_bind() {
        let cols = sample_columns();

        let eq = build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec { column: "name".into(), op: FilterOp::Eq, value: Some("bob".into()), values: Vec::new() }),
        )
        .unwrap();
        assert_eq!(eq.sql, " WHERE `name` = ?");
        assert_eq!(eq.params, vec![Value::Bytes(b"bob".to_vec())]);

        let like = build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec { column: "name".into(), op: FilterOp::Like, value: Some("%a%".into()), values: Vec::new() }),
        )
        .unwrap();
        assert_eq!(like.sql, " WHERE `name` LIKE ?");

        let nulls = build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec { column: "score".into(), op: FilterOp::IsNotNull, value: None, values: Vec::new() }),
        )
        .unwrap();
        assert_eq!(nulls.sql, " WHERE `score` IS NOT NULL");
        assert!(nulls.params.is_empty());

        // Unknown filter column rejected; no filter → empty clause.
        assert!(build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec { column: "nope".into(), op: FilterOp::Eq, value: None, values: Vec::new() }),
        )
        .is_err());
        assert_eq!(build_where_clause(SqlDialect::Mysql, &cols, None).unwrap().sql, "");
    }

    #[test]
    fn insert_builder_produces_expected_sql() {
        let cols = sample_columns();
        let built = build_insert_sql(
            SqlDialect::Mysql,
            "`shop`.`users`",
            &cols,
            &[col("name", RowValue::Str("Ann".into())), col("score", RowValue::Int(9))],
        )
        .unwrap();
        assert_eq!(
            built.sql,
            "INSERT INTO `shop`.`users` (`name`, `score`) VALUES (?, ?)"
        );
        assert_eq!(
            built.params,
            vec![Value::Bytes(b"Ann".to_vec()), Value::Int(9)]
        );

        // Empty inserts make no sense and must be refused.
        assert!(build_insert_sql(SqlDialect::Mysql, "`x`.`y`", &cols, &[]).is_err());
        // Unknown column rejected.
        assert!(build_insert_sql(SqlDialect::Mysql, "`x`.`y`", &cols, &[col("zz", RowValue::Null)]).is_err());
    }

    #[test]
    fn update_builder_sets_then_pk_binds() {
        let cols = sample_columns();
        let built = build_update_sql(
            SqlDialect::Mysql,
            "`shop`.`users`",
            &cols,
            &[col("id", RowValue::UInt(7))],
            &[col("name", RowValue::Str("New".into())), col("score", RowValue::Null)],
        )
        .unwrap();
        assert_eq!(
            built.sql,
            "UPDATE `shop`.`users` SET `name` = ?, `score` = ? WHERE `id` = ?"
        );
        assert_eq!(
            built.params,
            vec![
                Value::Bytes(b"New".to_vec()),
                Value::NULL,
                Value::UInt(7),
            ]
        );

        // Missing PK / missing SET both rejected.
        assert!(build_update_sql(SqlDialect::Mysql, "`x`.`y`", &cols, &[], &[col("name", RowValue::Str("a".into()))]).is_err());
        assert!(build_update_sql(SqlDialect::Mysql, "`x`.`y`", &cols, &[col("id", RowValue::UInt(1))], &[]).is_err());
    }

    #[test]
    fn delete_builder_handles_null_keys() {
        let cols = sample_columns();
        let built = build_delete_sql(
            SqlDialect::Mysql,
            "`t`",
            &cols,
            &[col("id", RowValue::UInt(3)), col("name", RowValue::Null)],
        )
        .unwrap();
        assert_eq!(built.sql, "DELETE FROM `t` WHERE `id` = ? AND `name` IS NULL");
        assert_eq!(built.params, vec![Value::UInt(3)]);

        assert!(build_delete_sql(SqlDialect::Mysql, "`t`", &cols, &[]).is_err());
    }

    #[test]
    fn multirow_insert_builder_scales_and_upserts() {
        let cols = vec!["id".to_string(), "name".to_string()];
        let sql = build_multirow_insert(SqlDialect::Mysql, "`shop`.`users`", &cols, 2, false, None);
        assert_eq!(
            sql,
            "INSERT INTO `shop`.`users` (`id`, `name`) VALUES (?, ?), (?, ?)"
        );

        let ignored = build_multirow_insert(SqlDialect::Mysql, "`d`.`t`", &["a".into()], 1, true, None);
        assert!(ignored.starts_with("INSERT IGNORE INTO `d`.`t` (`a`) VALUES (?)"));

        let upsert = build_multirow_insert(
            SqlDialect::Mysql,
            "`d`.`t`",
            &["pk".into(), "v".into()],
            1,
            false,
            Some(&["v".into()]),
        );
        assert_eq!(
            upsert,
            "INSERT INTO `d`.`t` (`pk`, `v`) VALUES (?, ?) \
             ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)"
        );
    }

    #[test]
    fn page_sql_assembles_validated_parts() {
        let cols = sample_columns();
        let where_clause = build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec { column: "id".into(), op: FilterOp::Gt, value: Some("5".into()), values: Vec::new() }),
        )
        .unwrap();
        let order = build_order_by_clause(
            SqlDialect::Mysql,
            &cols,
            &[SortSpec { column: "id".into(), direction: SortDirection::Desc }],
        )
        .unwrap();
        let sql = build_page_sql(
            SqlDialect::Mysql,
            &qualify_table("shop", "users"),
            &["id".into(), "name".into()],
            &where_clause,
            &order,
            1000,
            2000,
        );
        assert_eq!(
            sql,
            "SELECT `id`, `name` FROM `shop`.`users` WHERE `id` > ? ORDER BY `id` DESC LIMIT 1000 OFFSET 2000"
        );
    }

    // -----------------------------------------------------------------------
    // PostgreSQL / SQLite dialect variants
    // -----------------------------------------------------------------------

    #[test]
    fn postgres_builders_use_numbered_placeholders_and_double_quotes() {
        let cols = sample_columns();

        let where_pg = build_where_clause(
            SqlDialect::Postgres,
            &cols,
            Some(&FilterSpec { column: "name".into(), op: FilterOp::Like, value: Some("%a%".into()), values: Vec::new() }),
        )
        .unwrap();
        assert_eq!(where_pg.sql, " WHERE \"name\" LIKE $1");

        let insert_pg = build_insert_sql(
            SqlDialect::Postgres,
            "\"shop\".\"users\"",
            &cols,
            &[col("name", RowValue::Str("Ann".into())), col("score", RowValue::Int(9))],
        )
        .unwrap();
        assert_eq!(
            insert_pg.sql,
            "INSERT INTO \"shop\".\"users\" (\"name\", \"score\") VALUES ($1, $2)"
        );

        let update_pg = build_update_sql(
            SqlDialect::Postgres,
            "\"t\"",
            &cols,
            &[col("id", RowValue::UInt(7))],
            &[col("name", RowValue::Str("New".into())), col("score", RowValue::Null)],
        )
        .unwrap();
        // One ascending sequence spans SET and WHERE.
        assert_eq!(
            update_pg.sql,
            "UPDATE \"t\" SET \"name\" = $1, \"score\" = $2 WHERE \"id\" = $3"
        );
        assert_eq!(update_pg.params.len(), 3);

        let delete_pg = build_delete_sql(
            SqlDialect::Postgres,
            "\"t\"",
            &cols,
            &[col("id", RowValue::UInt(3)), col("name", RowValue::Null)],
        )
        .unwrap();
        assert_eq!(
            delete_pg.sql,
            "DELETE FROM \"t\" WHERE \"id\" = $1 AND \"name\" IS NULL"
        );
    }

    #[test]
    fn sqlite_builders_reuse_question_marks_with_double_quotes() {
        let cols = sample_columns();
        let built = build_update_sql(
            SqlDialect::Sqlite,
            "\"main\".\"users\"",
            &cols,
            &[col("id", RowValue::UInt(7))],
            &[col("name", RowValue::Str("New".into()))],
        )
        .unwrap();
        assert_eq!(
            built.sql,
            "UPDATE \"main\".\"users\" SET \"name\" = ? WHERE \"id\" = ?"
        );
    }

    #[test]
    fn multirow_insert_per_engine_verbs_and_upsert_tails() {
        let cols = vec!["pk".to_string(), "v".to_string()];

        let pg = build_multirow_insert(
            SqlDialect::Postgres,
            "\"d\".\"t\"",
            &cols,
            2,
            false,
            Some(&["v".into()]),
        );
        assert_eq!(
            pg,
            "INSERT INTO \"d\".\"t\" (\"pk\", \"v\") VALUES (?, ?), (?, ?) \
             ON CONFLICT (\"v\") DO UPDATE SET \"v\" = excluded.\"v\""
        );

        let pg_ignore = build_multirow_insert(SqlDialect::Postgres, "\"d\".\"t\"", &cols, 1, true, None);
        assert!(pg_ignore.ends_with("ON CONFLICT DO NOTHING"), "{pg_ignore}");

        let sqlite_ignore =
            build_multirow_insert(SqlDialect::Sqlite, "\"d\".\"t\"", &cols, 1, true, None);
        assert!(sqlite_ignore.starts_with("INSERT OR IGNORE INTO \"d\".\"t\""));

        // MySQL cannot combine INSERT IGNORE with ON DUPLICATE KEY — ignore wins.
        let my_both = build_multirow_insert(
            SqlDialect::Mysql,
            "`d`.`t`",
            &cols,
            1,
            true,
            Some(&["v".into()]),
        );
        assert!(!my_both.contains("ON DUPLICATE KEY"), "{my_both}");
    }

    #[test]
    fn page_sql_works_for_postgres() {
        let cols = sample_columns();
        let where_clause = build_where_clause(
            SqlDialect::Postgres,
            &cols,
            Some(&FilterSpec { column: "id".into(), op: FilterOp::Gt, value: Some("5".into()), values: Vec::new() }),
        )
        .unwrap();
        let sql = build_page_sql(
            SqlDialect::Postgres,
            "\"shop\".\"users\"",
            &["id".into()],
            &where_clause,
            "",
            50,
            100,
        );
        assert_eq!(
            sql,
            "SELECT \"id\" FROM \"shop\".\"users\" WHERE \"id\" > $1 LIMIT 50 OFFSET 100"
        );
    }

    // -----------------------------------------------------------------------
    // Phase 9-A: IN filters, distinct values, FK reference reads
    // -----------------------------------------------------------------------

    #[test]
    fn in_filter_binds_every_item() {
        let cols = sample_columns();
        let built = build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec {
                column: "name".into(),
                op: FilterOp::In,
                value: None,
                values: vec![
                    RowValue::Str("a".into()),
                    RowValue::Int(3),
                    RowValue::Null,
                ],
            }),
        )
        .unwrap();
        assert_eq!(built.sql, " WHERE `name` IN (?, ?, ?)");
        assert_eq!(
            built.params,
            vec![Value::Bytes(b"a".to_vec()), Value::Int(3), Value::NULL]
        );

        // Unknown column still rejected (injection guard).
        assert!(build_where_clause(
            SqlDialect::Mysql,
            &cols,
            Some(&FilterSpec {
                column: "nope".into(),
                op: FilterOp::In,
                value: None,
                values: vec![RowValue::Int(1)],
            }),
        )
        .is_err());
    }

    #[test]
    fn in_filter_empty_selection_matches_nothing() {
        let built = build_where_clause(
            SqlDialect::Mysql,
            &sample_columns(),
            Some(&FilterSpec {
                column: "name".into(),
                op: FilterOp::In,
                value: None,
                values: Vec::new(),
            }),
        )
        .unwrap();
        assert_eq!(built.sql, " WHERE 1 = 0");
        assert!(built.params.is_empty());
    }

    #[test]
    fn in_filter_postgres_numbers_placeholders() {
        let built = build_where_clause(
            SqlDialect::Postgres,
            &sample_columns(),
            Some(&FilterSpec {
                column: "score".into(),
                op: FilterOp::In,
                value: None,
                values: vec![RowValue::Float(1.5), RowValue::UInt(2)],
            }),
        )
        .unwrap();
        assert_eq!(built.sql, " WHERE \"score\" IN ($1, $2)");
        assert_eq!(built.params.len(), 2);
    }

    #[test]
    fn multi_term_and_builder_joins_and_binds_in_order() {
        let cols = sample_columns();
        let built = build_where_clause_and(
            SqlDialect::Mysql,
            &cols,
            &[
                FilterSpec {
                    column: "name".into(),
                    op: FilterOp::In,
                    value: None,
                    values: vec![RowValue::Str("a".into()), RowValue::Int(3)],
                },
                FilterSpec {
                    column: "score".into(),
                    op: FilterOp::Gt,
                    value: Some("5".into()),
                    values: Vec::new(),
                },
            ],
        )
        .unwrap();
        assert_eq!(built.sql, " WHERE `name` IN (?, ?) AND `score` > ?");
        assert_eq!(
            built.params,
            vec![Value::Bytes(b"a".to_vec()), Value::Int(3), Value::Bytes(b"5".to_vec())]
        );
    }

    #[test]
    fn multi_term_and_builder_empty_list_is_empty_clause() {
        let built =
            build_where_clause_and(SqlDialect::Mysql, &sample_columns(), &[]).unwrap();
        assert_eq!(built.sql, "");
        assert!(built.params.is_empty());
    }

    #[test]
    fn multi_term_and_builder_unknown_column_propagates() {
        let err = build_where_clause_and(
            SqlDialect::Mysql,
            &sample_columns(),
            &[FilterSpec {
                column: "nope".into(),
                op: FilterOp::Eq,
                value: Some("x".into()),
                values: Vec::new(),
            }],
        );
        assert!(err.is_err());
    }

    #[test]
    fn multi_term_and_builder_mixes_predicates_and_pg_numbering() {
        let cols = sample_columns();
        // NULL predicates contribute no bound parameters.
        let built = build_where_clause_and(
            SqlDialect::Postgres,
            &cols,
            &[
                FilterSpec {
                    column: "score".into(),
                    op: FilterOp::IsNull,
                    value: None,
                    values: Vec::new(),
                },
                FilterSpec {
                    column: "id".into(),
                    op: FilterOp::LtE,
                    value: Some("9".into()),
                    values: Vec::new(),
                },
                FilterSpec {
                    column: "name".into(),
                    op: FilterOp::IsNotNull,
                    value: None,
                    values: Vec::new(),
                },
            ],
        )
        .unwrap();
        assert_eq!(built.sql, " WHERE \"score\" IS NULL AND \"id\" <= $1 AND \"name\" IS NOT NULL");
        assert_eq!(built.params.len(), 1);
    }

    #[test]
    fn distinct_values_builder_groups_and_counts() {
        let cols = sample_columns();
        let name = cols.iter().find(|c| c.name == "name").unwrap();

        let plain = build_distinct_values_sql(
            SqlDialect::Mysql,
            "`shop`.`users`",
            name,
            "`name`",
            "COUNT(*)",
            None,
            100,
        );
        assert_eq!(
            plain.sql,
            "SELECT `name` AS `name`, COUNT(*) AS `cnt` FROM `shop`.`users` \
             GROUP BY `name` ORDER BY `cnt` DESC LIMIT 100 OFFSET 0"
        );
        assert!(plain.params.is_empty());

        let searched = build_distinct_values_sql(
            SqlDialect::Mysql,
            "`shop`.`users`",
            name,
            "`name`",
            "COUNT(*)",
            Some("%an%"),
            50,
        );
        assert_eq!(
            searched.sql,
            "SELECT `name` AS `name`, COUNT(*) AS `cnt` FROM `shop`.`users` \
             WHERE `name` LIKE ? GROUP BY `name` ORDER BY `cnt` DESC LIMIT 50 OFFSET 0"
        );
        assert_eq!(searched.params, vec![Value::Bytes(b"%an%".to_vec())]);
    }

    #[test]
    fn distinct_values_builder_dialect_variants() {
        let cols = sample_columns();
        let score = cols.iter().find(|c| c.name == "score").unwrap();

        let pg = build_distinct_values_sql(
            SqlDialect::Postgres,
            "\"shop\".\"users\"",
            score,
            "\"score\"::text",
            "COUNT(*)::text",
            None,
            10,
        );
        assert_eq!(
            pg.sql,
            "SELECT \"score\"::text AS \"score\", COUNT(*)::text AS \"cnt\" \
             FROM \"shop\".\"users\" GROUP BY \"score\" ORDER BY \"cnt\" DESC LIMIT 10 OFFSET 0"
        );
        assert_eq!(pg.params.len(), 0);

        let lite = build_distinct_values_sql(
            SqlDialect::Sqlite,
            "\"users\"",
            score,
            "\"score\"",
            "COUNT(*)",
            Some("%x%"),
            25,
        );
        assert!(lite.sql.contains("\"score\" LIKE ?"));
        assert_eq!(lite.params.len(), 1);
    }

    #[test]
    fn fk_ref_builder_selects_and_orders_by_pk() {
        let built = build_fk_ref_sql(
            SqlDialect::Mysql,
            "`shop`.`countries`",
            &["id".into()],
            Some("label"),
            100,
        )
        .unwrap();
        assert_eq!(
            built.sql,
            "SELECT `id`, `label` FROM `shop`.`countries` \
             ORDER BY `id` LIMIT 100 OFFSET 0"
        );
        assert!(built.params.is_empty());

        let composite = build_fk_ref_sql(
            SqlDialect::Postgres,
            "\"public\".\"items\"",
            &["org_id".into(), "line_no".into()],
            None,
            25,
        )
        .unwrap();
        assert_eq!(
            composite.sql,
            "SELECT \"org_id\", \"line_no\" FROM \"public\".\"items\" \
             ORDER BY \"org_id\", \"line_no\" LIMIT 25 OFFSET 0"
        );
    }

    #[test]
    fn fk_ref_builder_requires_pk_columns() {
        assert!(build_fk_ref_sql(SqlDialect::Mysql, "`t`", &[], None, 10).is_err());
    }
}

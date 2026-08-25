//! Pure CREATE TABLE / ALTER TABLE builders (Phase 4).
//!
//! [`build_create_table`] renders a [`CreateTableRequest`] into one CREATE
//! TABLE statement; [`build_alter_table`] diffs two [`TableDdl`] snapshots
//! into an ordered list of ALTER statements. Both are synchronous pure
//! functions with exhaustive unit tests — no driver or IO involved.
//!
//! Statement ordering matters: foreign keys are dropped before columns are
//! touched, added after indexes exist, and a table rename goes last so every
//! other clause can reference the original name.

use crate::connections::{
    quote_ident, quote_qualified, ColumnDef, CreateTableRequest, DefaultKind, ForeignKeyMeta,
    IndexKind, IndexMeta, TableDdl, TableOptions,
};
use crate::error::{AppError, Result};

/// The generated plan for one designer apply.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AlterPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Shared fragment emitters
// ---------------------------------------------------------------------------

/// Escape a string literal for embedding in DDL text (comments, defaults).
pub fn quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''"))
}

fn is_numeric_literal(s: &str) -> bool {
    let t = s.trim();
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Render a `DEFAULT` value: numeric literals bare, everything else quoted.
fn render_default_value(value: &str) -> String {
    if is_numeric_literal(value) {
        value.to_string()
    } else {
        quote_string(value)
    }
}

fn normalize_type(data_type: &str) -> String {
    data_type.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Full column definition line (without leading comma): `` `id` int unsigned NOT NULL ... ``.
pub fn column_definition(col: &ColumnDef) -> String {
    let mut s = quote_ident(&col.name);
    s.push(' ');
    s.push_str(&normalize_type(&col.data_type));

    if let Some(generated) = &col.generated {
        // Generated columns carry their own AS clause; nullability/defaults
        // are not allowed next to them.
        s.push(' ');
        s.push_str(generated);
        if let Some(comment) = &col.comment {
            s.push_str(" COMMENT ");
            s.push_str(&quote_string(comment));
        }
        return s;
    }

    s.push_str(if col.nullable { " NULL" } else { " NOT NULL" });
    match col.default_kind {
        DefaultKind::None => {}
        DefaultKind::Null => s.push_str(" DEFAULT NULL"),
        DefaultKind::Value => {
            if let Some(v) = &col.default_value {
                s.push_str(" DEFAULT ");
                s.push_str(&render_default_value(v));
            }
        }
        DefaultKind::Expression => {
            if let Some(v) = &col.default_value {
                s.push_str(" DEFAULT ");
                s.push_str(v);
            }
        }
    }
    if col.auto_increment {
        s.push_str(" AUTO_INCREMENT");
    }
    if let Some(on_update) = &col.on_update {
        s.push_str(" ON UPDATE ");
        s.push_str(on_update);
    }
    if let Some(comment) = &col.comment {
        s.push_str(" COMMENT ");
        s.push_str(&quote_string(comment));
    }
    // Attributes the designer does not model but must not lose.
    for attr in &col.preserved_attrs {
        s.push(' ');
        s.push_str(attr);
    }
    s
}

fn quoted_column_list(columns: &[String]) -> String {
    columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ")
}

/// One index as an ADD clause (`PRIMARY KEY (...)`, `KEY ...`, ...).
pub fn index_add_clause(idx: &IndexMeta) -> String {
    let cols = quoted_column_list(&idx.columns);
    match idx.kind {
        IndexKind::Primary => format!("PRIMARY KEY ({cols})"),
        IndexKind::Unique => format!("UNIQUE KEY {} ({})", quote_ident(&idx.name), cols),
        IndexKind::Index => format!("KEY {} ({})", quote_ident(&idx.name), cols),
        IndexKind::Fulltext => format!("FULLTEXT KEY {} ({})", quote_ident(&idx.name), cols),
        IndexKind::Spatial => format!("SPATIAL KEY {} ({})", quote_ident(&idx.name), cols),
    }
}

/// One FK as an ADD CONSTRAINT clause; unqualified ref_db resolves to `db`.
pub fn fk_add_clause(db: &str, fk: &ForeignKeyMeta) -> String {
    let target_db = fk.ref_db.as_deref().unwrap_or(db);
    let mut s = format!(
        "CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({})",
        quote_ident(&fk.name),
        quoted_column_list(&fk.columns),
        quote_qualified(&[target_db, &fk.ref_table]),
        quoted_column_list(&fk.ref_columns)
    );
    if let Some(action) = &fk.on_delete {
        s.push_str(" ON DELETE ");
        s.push_str(action);
    }
    if let Some(action) = &fk.on_update {
        s.push_str(" ON UPDATE ");
        s.push_str(action);
    }
    s
}

/// Table option fragments (`ENGINE=x`, `DEFAULT CHARSET=y`, ...).
fn options_fragments(options: &TableOptions) -> Vec<String> {
    let mut parts = Vec::new();
    if let Some(engine) = &options.engine {
        parts.push(format!("ENGINE={}", engine));
    }
    if let Some(charset) = &options.charset {
        parts.push(format!("DEFAULT CHARSET={charset}"));
    }
    if let Some(collation) = &options.collation {
        parts.push(format!("COLLATE={collation}"));
    }
    if let Some(comment) = &options.comment {
        parts.push(format!("COMMENT={}", quote_string(comment)));
    }
    if let Some(auto_inc) = options.auto_increment {
        parts.push(format!("AUTO_INCREMENT={auto_inc}"));
    }
    if let Some(row_format) = &options.row_format {
        parts.push(format!("ROW_FORMAT={row_format}"));
    }
    for extra in &options.extra {
        parts.push(format!("{}={}", extra.key, extra.value));
    }
    parts
}

// ---------------------------------------------------------------------------
// CREATE TABLE
// ---------------------------------------------------------------------------

/// Build `CREATE TABLE` for a new table from the designer's request.
pub fn build_create_table(db: &str, req: &CreateTableRequest) -> Result<String> {
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Db("table name is empty".into()));
    }
    if req.columns.is_empty() {
        return Err(AppError::Db("a table needs at least one column".into()));
    }

    // Guard against duplicate identifiers — MySQL would reject, but with a
    // much less readable error.
    let mut seen = std::collections::HashSet::new();
    for col in &req.columns {
        if !seen.insert(col.name.to_ascii_lowercase()) {
            return Err(AppError::Db(format!("duplicate column `{}`", col.name)));
        }
    }

    let mut body: Vec<String> = req.columns.iter().map(column_definition).collect();
    for idx in &req.indexes {
        body.push(index_add_clause(idx));
    }
    for fk in &req.foreign_keys {
        body.push(fk_add_clause(db, fk));
    }

    let mut sql = format!(
        "CREATE TABLE {} (\n  {}\n)",
        quote_qualified(&[db, name]),
        body.join(",\n  ")
    );
    let fragments = options_fragments(&req.options);
    if !fragments.is_empty() {

        sql.push(' ');
        sql.push_str(&fragments.join(" "));
    }
    if let Some(partition) = &req.options.partition {

        sql.push(' ');
        sql.push_str(partition);
    }
    Ok(sql)
}

// ---------------------------------------------------------------------------
// ALTER TABLE diffing
// ---------------------------------------------------------------------------

/// Structural equality of columns ignoring rename bookkeeping.
fn column_content_eq(a: &ColumnDef, b: &ColumnDef) -> bool {
    a.name == b.name
        && normalize_type(&a.data_type) == normalize_type(&b.data_type)
        && a.nullable == b.nullable
        && a.default_kind == b.default_kind
        && a.default_value == b.default_value
        && a.auto_increment == b.auto_increment
        && a.on_update == b.on_update
        && a.generated == b.generated
        && a.comment == b.comment
        && a.preserved_attrs == b.preserved_attrs
}

fn index_content_eq(a: &IndexMeta, b: &IndexMeta) -> bool {
    a.kind == b.kind && a.columns == b.columns && a.comment == b.comment
}

/// FK equality normalizing `ref_db` against the working database: an
/// explicit reference to the same db equals an omitted qualifier.
fn fk_content_eq(fk: &ForeignKeyMeta, other: &ForeignKeyMeta, db: &str) -> bool {
    fn norm<'a>(r: &'a Option<String>, db: &str) -> Option<&'a str> {
        r.as_deref().filter(|d| !d.eq_ignore_ascii_case(db))
    }
    fk.columns == other.columns
        && norm(&fk.ref_db, db) == norm(&other.ref_db, db)
        && fk.ref_table == other.ref_table
        && fk.ref_columns == other.ref_columns
        && fk.on_update == other.on_update
        && fk.on_delete == other.on_delete
}

fn options_eq(a: &TableOptions, b: &TableOptions) -> bool {
    a.engine == b.engine
        && a.charset == b.charset
        && a.collation == b.collation
        && a.comment == b.comment
        && a.auto_increment == b.auto_increment
        && a.row_format == b.row_format
        && a.extra == b.extra
        && a.partition == b.partition
}

/// Diff the current and desired structure into ALTER statements.
///
/// Matching rules: desired columns match current ones via
/// `previous_name` (falling back to `name`); indexes and foreign keys match
/// by name. Unmatched desired rows become additions, unmatched current rows
/// become drops.
pub fn build_alter_table(
    db: &str,
    current_table: &str,
    current: &TableDdl,
    desired: &TableDdl,
) -> Result<AlterPlan> {
    let _ = current_table; // source identity comes from `current`
    let mut plan = AlterPlan::default();

    let src = quote_qualified(&[db, &current.table]);
    let renamed = desired.table != current.table;

    // -- column matching -------------------------------------------------------
    let mut current_by_name: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for (i, col) in current.columns.iter().enumerate() {
        current_by_name.insert(col.name.to_ascii_lowercase(), i);
    }
    let mut matched_current: Vec<bool> = vec![false; current.columns.len()];
    struct ColOp<'a> {
        /// None → addition; Some(current index) → change/rename/move candidate.
        current_idx: Option<usize>,
        desired: &'a ColumnDef,
    }
    let mut col_ops: Vec<ColOp> = Vec::new();

    for des in &desired.columns {
        let key = des
            .previous_name
            .as_deref()
            .unwrap_or(des.name.as_str())
            .to_ascii_lowercase();
        match current_by_name.get(&key).copied() {
            Some(idx) if !matched_current[idx] => {
                matched_current[idx] = true;
                col_ops.push(ColOp { current_idx: Some(idx), desired: des });
            }
            _ => col_ops.push(ColOp { current_idx: None, desired: des }),
        }
    }

    let dropped_current: Vec<&ColumnDef> = current
        .columns
        .iter()
        .enumerate()
        .filter(|(i, _)| !matched_current[*i])
        .map(|(_, c)| c)
        .collect();
    let dropped_set: std::collections::HashSet<&str> =
        dropped_current.iter().map(|c| c.name.as_str()).collect();

    // -- index / fk lookups ------------------------------------------------------
    let find_index = |name: &str| current.indexes.iter().find(|ix| ix.name == name);
    let find_fk = |name: &str| current.foreign_keys.iter().find(|f| f.name == name);

    let pk_changed = {
        let cur_pk = current.indexes.iter().find(|ix| ix.kind == IndexKind::Primary);
        let des_pk = desired.indexes.iter().find(|ix| ix.kind == IndexKind::Primary);
        match (cur_pk, des_pk) {
            (None, None) => false,
            (Some(a), Some(b)) => !index_content_eq(a, b),
            _ => true,
        }
    };
    if pk_changed && desired.columns.iter().any(|c| c.auto_increment) {
        plan.warnings.push(
            "the primary key changes while AUTO_INCREMENT columns exist — MySQL requires the \
             auto-increment column to stay indexed; review the generated statements"
                .into(),
        );
    }

    // -- statement 1: drops --------------------------------------------------------
    let mut drop_clauses: Vec<String> = Vec::new();

    for fk in &current.foreign_keys {
        let keep = matches!(
            desired.foreign_keys.iter().find(|d| d.name == fk.name),
            Some(d) if fk_content_eq(fk, d, db)
        );
        if !keep {
            drop_clauses.push(format!("DROP FOREIGN KEY {}", quote_ident(&fk.name)));
        }
    }
    for idx in &current.indexes {
        let keep = matches!(
            desired.indexes.iter().find(|d| d.name == idx.name),
            Some(d) if index_content_eq(idx, d)
        );
        if !keep {
            drop_clauses.push(match idx.kind {
                IndexKind::Primary => "DROP PRIMARY KEY".to_string(),
                _ => format!("DROP INDEX {}", quote_ident(&idx.name)),
            });
        }
    }
    for col in &dropped_current {
        drop_clauses.push(format!("DROP COLUMN {}", quote_ident(&col.name)));
        warn_dangling_index(&mut plan.warnings, col, desired);
    }
    if !drop_clauses.is_empty() {
        plan.statements
            .push(format!("ALTER TABLE {} {}", src, drop_clauses.join(", ")));
    }

    // -- statement 2: column additions / modifications -------------------------------
    let mut col_clauses: Vec<String> = Vec::new();
    for (i, op) in col_ops.iter().enumerate() {
        let desired_prev = col_ops[..i].last().map(|prev| prev.desired.name.clone());
        match op.current_idx {
            Some(cur_idx) => {
                let cur = &current.columns[cur_idx];
                let des = op.desired;
                let content_changed = !column_content_eq(cur, des);

                // Effective current previous sibling: walk backwards past
                // columns that are being dropped.
                let current_prev = cur
                    .previous_position(current)
                    .and_then(|pos| {
                        current.columns[..pos]
                            .iter()
                            .rev()
                            .find(|c| !dropped_set.contains(c.name.as_str()))
                            .map(|c| c.name.clone())
                    });
                let suffix = position_suffix(
                    desired_prev.clone(),
                    current_prev,
                    false,
                    false,
                );

                if !content_changed && suffix.is_empty() {
                    continue;
                }
                if !des.preserved_attrs.is_empty() && content_changed {
                    plan.warnings.push(format!(
                        "column `{}` carries preserved attributes ({}) — verify they still apply after the change",
                        des.name,
                        des.preserved_attrs.join(", ")
                    ));
                }
                let definition = column_definition(des);
                let core = if cur.name != des.name {
                    format!("CHANGE {} {}", quote_ident(&cur.name), definition)
                } else {
                    format!("MODIFY {definition}")
                };
                col_clauses.push(format!("{core}{suffix}"));
            }
            None => {
                let suffix = position_suffix(
                    desired_prev.clone(),
                    None,
                    true,
                    i == col_ops.len() - 1,
                );
                col_clauses.push(format!("ADD COLUMN {}{}", column_definition(op.desired), suffix));
            }
        }
    }
    if !col_clauses.is_empty() {
        plan.statements
            .push(format!("ALTER TABLE {} {}", src, col_clauses.join(", ")));
    }

    // -- statement 3: index additions --------------------------------------------------
    let mut index_clauses: Vec<String> = Vec::new();
    for idx in &desired.indexes {
        // A changed PK was dropped above, so content-equality against the
        // *current* snapshot decides whether the add is needed.
        if matches!(find_index(&idx.name), Some(c) if index_content_eq(c, idx)) {
            continue;
        }
        index_clauses.push(format!("ADD {}", index_add_clause(idx)));
    }
    if !index_clauses.is_empty() {
        plan.statements
            .push(format!("ALTER TABLE {} {}", src, index_clauses.join(", ")));
    }

    // -- statement 4: FK additions -------------------------------------------------------
    let mut fk_clauses: Vec<String> = Vec::new();
    for fk in &desired.foreign_keys {
        if matches!(find_fk(&fk.name), Some(c) if fk_content_eq(c, fk, db)) {
            continue;
        }
        fk_clauses.push(format!("ADD {}", fk_add_clause(db, fk)));
    }
    if !fk_clauses.is_empty() {
        plan.statements
            .push(format!("ALTER TABLE {} {}", src, fk_clauses.join(", ")));
    }

    // -- statement 5: table options ---------------------------------------------------------
    if !options_eq(&current.options, &desired.options) {
        let mut fragments = options_diff_fragments(&current.options, &desired.options);
        if desired.options.partition != current.options.partition {
            // Partitioning cannot share the option list safely.
            if let Some(partition) = &desired.options.partition {
                plan.statements
                    .push(format!("ALTER TABLE {} {partition}", src));
            } else {
                plan.warnings.push(
                    "removing partitioning requires ALTER TABLE ... REMOVE PARTITIONING which \
                     this preview does not generate"
                        .into(),
                );
            }
            fragments.retain(|f| !f.starts_with("PARTITION"));
        }
        if !fragments.is_empty() {
            plan.statements
                .push(format!("ALTER TABLE {} {}", src, fragments.join(" ")));
        }
    }

    // -- statement 6: rename (always last) ----------------------------------------------------
    if renamed {
        let target_db = if desired.db.is_empty() { db } else { &desired.db };
        plan.statements.push(format!(
            "ALTER TABLE {} RENAME TO {}",
            src,
            quote_qualified(&[target_db, &desired.table])
        ));
        plan.warnings.insert(
            0,
            format!(
                "table will be renamed to `{}` — open data/query tabs may need refreshing",
                desired.table
            ),
        );
    }

    Ok(plan)
}

trait ColumnPosition {
    fn previous_position<'a>(&'a self, table: &'a TableDdl) -> Option<usize>;
}
impl ColumnPosition for ColumnDef {
    fn previous_position<'a>(&'a self, table: &'a TableDdl) -> Option<usize> {
        table.columns.iter().position(|c| c.name == self.name)
    }
}

/// Decide the FIRST / AFTER suffix for one column operation.
///
/// - Existing columns move only when their effective neighbour changes.
/// - Added columns need a clause unless appended at the very end.
fn position_suffix(
    desired_prev: Option<String>,
    current_prev: Option<String>,
    is_add: bool,
    added_at_end: bool,
) -> String {
    if is_add {
        if added_at_end {
            return String::new(); // natural append
        }
    } else if desired_prev == current_prev {
        return String::new(); // position unchanged
    }
    match desired_prev {
        None => " FIRST".to_string(),
        Some(prev) => format!(" AFTER {}", quote_ident(&prev)),
    }
}

/// Warn when dropping a column that some surviving index still references.
fn warn_dangling_index(warnings: &mut Vec<String>, dropped: &ColumnDef, desired: &TableDdl) {
    for idx in &desired.indexes {
        if idx.columns.iter().any(|c| c == &dropped.name) {
            warnings.push(format!(
                "column `{}` remains part of index `{}` — MySQL will trim or reject that index",
                dropped.name, idx.name
            ));
        }
    }
}

/// Fragments for options whose values differ between the two snapshots.
fn options_diff_fragments(current: &TableOptions, desired: &TableOptions) -> Vec<String> {
    let mut parts = Vec::new();
    if current.engine != desired.engine {
        if let Some(engine) = &desired.engine {
            parts.push(format!("ENGINE={engine}"));
        }
    }
    if current.charset != desired.charset {
        if let Some(charset) = &desired.charset {
            parts.push(format!("DEFAULT CHARSET={charset}"));
        }
    }
    if current.collation != desired.collation {
        if let Some(collation) = &desired.collation {
            parts.push(format!("COLLATE={collation}"));
        }
    }
    if current.comment != desired.comment {
        match &desired.comment {
            Some(comment) => parts.push(format!("COMMENT={}", quote_string(comment))),
            // MySQL has no "drop comment" — reset to the empty string.
            None => parts.push("COMMENT=''".to_string()),
        }
    }
    if current.auto_increment != desired.auto_increment {
        if let Some(auto_inc) = desired.auto_increment {
            parts.push(format!("AUTO_INCREMENT={auto_inc}"));
        }
    }
    if current.row_format != desired.row_format {
        match &desired.row_format {
            Some(row_format) => parts.push(format!("ROW_FORMAT={row_format}")),
            None => parts.push("ROW_FORMAT=DEFAULT".to_string()),
        }
    }
    // Extra options: emit union by key where value changed or new.
    for extra in &desired.extra {
        let same = current
            .extra
            .iter()
            .any(|c| c.key == extra.key && c.value == extra.value);
        if !same {
            parts.push(format!("{}={}", extra.key, extra.value));
        }
    }
    for old in &current.extra {
        if !desired.extra.iter().any(|d| d.key == old.key) {
            parts.push(format!("{}=DEFAULT", old.key));
        }
    }
    parts
}

// ---------------------------------------------------------------------------
// Table copy (Phase 9-B)
// ---------------------------------------------------------------------------

/// Build the [`CreateTableRequest`] for "Create table copy…" from a source
/// table's parsed DDL.
///
/// Flag semantics (Heidi parity):
/// - `copy_indexes = false` drops every non-PK index; **the primary key is
///   always kept** so data copies stay insertable.
/// - `copy_fks = false` drops all FOREIGN KEY constraints.
///
/// The AUTO_INCREMENT counter is reset (a copy starts empty/its own life);
/// everything else in the tail options is carried over verbatim.
pub fn build_copy_request(
    src: &TableDdl,
    dst_name: &str,
    copy_indexes: bool,
    copy_fks: bool,
) -> CreateTableRequest {
    let indexes = if copy_indexes {
        src.indexes.clone()
    } else {
        src.indexes
            .iter()
            .filter(|idx| idx.kind == IndexKind::Primary)
            .cloned()
            .collect()
    };
    let foreign_keys = if copy_fks {
        src.foreign_keys.clone()
    } else {
        Vec::new()
    };

    let mut options = src.options.clone();
    options.auto_increment = None;

    CreateTableRequest {
        name: dst_name.to_string(),
        columns: src.columns.clone(),
        indexes,
        foreign_keys,
        options,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::ddl_parse::parse_create_table;
    use crate::connections::{ExtraTableOption, TableOptions};

    fn ddl_from(sql: &str) -> TableDdl {
        let parsed = parse_create_table(sql).unwrap();
        TableDdl {
            db: "shop".into(),
            table: parsed.table,
            columns: parsed.columns,
            indexes: parsed.indexes,
            foreign_keys: parsed.foreign_keys,
            options: parsed.options,
            checks: parsed.checks,
            create_sql: sql.into(),
        }
    }

    const BASE_SQL: &str = r#"CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `email` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#;

    #[test]
    fn identical_snapshots_produce_no_statements() {
        let current = ddl_from(BASE_SQL);
        let desired = current.clone();
        let plan = build_alter_table("shop", "users", &current, &desired).unwrap();
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
        assert!(plan.warnings.is_empty());
    }

    #[test]
    fn adds_column_with_after_position() {
        let base = ddl_from(BASE_SQL);
        let mut desired = base.clone();
        let age = ColumnDef {
            name: "age".into(),
            previous_name: None,
            data_type: "int unsigned".into(),
            nullable: true,
            default_kind: DefaultKind::Null,
            default_value: None,
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        };
        desired.columns.insert(1, age);

        let plan = build_alter_table("shop", "users", &base, &desired).unwrap();
        assert_eq!(plan.statements.len(), 1);
        let stmt = &plan.statements[0];
        assert!(
            stmt.contains("ADD COLUMN `age` int unsigned NULL DEFAULT NULL AFTER `id`"),
            "{stmt}"
        );
        // The displaced neighbour moves down with an explicit AFTER.
        assert!(stmt.contains("MODIFY `name` varchar(100) NOT NULL AFTER `age`"), "{stmt}");
    }

    #[test]
    fn appends_last_column_without_position() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns.push(ColumnDef {
            name: "age".into(),
            previous_name: None,
            data_type: "smallint".into(),
            nullable: true,
            default_kind: DefaultKind::None,
            default_value: None,
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        });
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let stmt = &plan.statements[0];
        assert!(stmt.contains("ADD COLUMN `age` smallint NULL"), "{stmt}");
        assert!(!stmt.contains(" AFTER "), "{stmt}");
        assert!(!stmt.contains(" FIRST"), "{stmt}");
    }

    #[test]
    fn drops_column() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns.remove(2); // email
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        assert!(plan.statements[0].contains("DROP COLUMN `email`"));
    }

    #[test]
    fn modifies_column_type_via_modify() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns[1].data_type = "varchar(80)".into();
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        assert!(plan
            .statements
            .iter()
            .any(|s| s.contains("MODIFY `name` varchar(80) NOT NULL")));
    }

    #[test]
    fn renames_column_via_change() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns[1].name = "full_name".into();
        desired.columns[1].previous_name = Some("name".into());
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        assert!(plan
            .statements
            .iter()
            .any(|s| s.contains("CHANGE `name` `full_name` varchar(100) NOT NULL")));
        // The index on the old column keeps working but references stay valid.
    }

    #[test]
    fn replacing_column_definition_edits_in_place() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns[2] = ColumnDef {
            name: "email".into(),
            previous_name: None,
            data_type: "varchar(320)".into(),
            nullable: false,
            default_kind: DefaultKind::None,
            default_value: None,
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        };
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let joined = plan.statements.join("\n");
        // Same-name edits become MODIFY, not DROP+ADD.
        assert!(joined.contains("MODIFY `email` varchar(320) NOT NULL"), "{joined}");
        assert!(!joined.contains("DROP COLUMN"), "{joined}");
    }

    #[test]
    fn primary_key_change_drop_then_add() {
        let mut desired = ddl_from(BASE_SQL);
        desired.columns[1].data_type = "bigint unsigned".into();
        desired.indexes.clear();
        desired.indexes.push(IndexMeta {
            name: "PRIMARY".into(),
            kind: IndexKind::Primary,
            columns: vec!["id".into(), "name".into()],
            comment: None,
        });
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("DROP PRIMARY KEY"), "{joined}");
        assert!(joined.contains("ADD PRIMARY KEY (`id`, `name`)"), "{joined}");
        // Drops come before adds so PK replacement stays ordered.
        let drop_pos = joined.find("DROP PRIMARY KEY").unwrap();
        let add_pos = joined.find("ADD PRIMARY KEY").unwrap();
        assert!(drop_pos < add_pos);
    }

    #[test]
    fn adds_and_drops_secondary_index_by_name() {
        let mut desired = ddl_from(BASE_SQL);
        desired.indexes.remove(1); // drop idx_name
        desired.indexes.push(IndexMeta {
            name: "idx_email".into(),
            kind: IndexKind::Unique,
            columns: vec!["email".into()],
            comment: None,
        });
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("DROP INDEX `idx_name`"), "{joined}");
        assert!(joined.contains("ADD UNIQUE KEY `idx_email` (`email`)"), "{joined}");
    }

    #[test]
    fn foreign_key_drop_and_add_with_actions() {
        let base = r#"CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_user` (`user_id`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#;
        let mut desired = ddl_from(base);
        desired.foreign_keys.clear();
        desired.foreign_keys.push(ForeignKeyMeta {
            name: "fk_orders_user".into(),
            columns: vec!["user_id".into()],
            ref_db: None,
            ref_table: "customers".into(),
            ref_columns: vec!["cid".into()],
            on_update: Some("CASCADE".into()),
            on_delete: Some("SET NULL".into()),
            table: None,
        });
        let plan = build_alter_table("shop", "orders", &ddl_from(base), &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("DROP FOREIGN KEY `fk_orders_user`"), "{joined}");
        assert!(joined.contains(
            "ADD CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `shop`.`customers` (`cid`) ON DELETE SET NULL ON UPDATE CASCADE"
        ), "{joined}");
    }

    #[test]
    fn unchanged_foreign_key_is_left_alone() {
        let base = r#"CREATE TABLE `orders` (
  `id` int NOT NULL,
  `user_id` int NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `fk_u` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#;
        let current = ddl_from(base);
        let desired = current.clone();
        let plan = build_alter_table("shop", "orders", &current, &desired).unwrap();
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    }

    #[test]
    fn table_options_emit_only_changed_values() {
        let mut desired = ddl_from(BASE_SQL);
        desired.options.engine = Some("MyISAM".into());
        desired.options.comment = Some("legacy".into());
        desired.options.auto_increment = Some(7);
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        assert_eq!(plan.statements.len(), 1, "{:?}", plan.statements);
        let stmt = &plan.statements[0];
        assert!(stmt.ends_with("ALTER TABLE `shop`.`users` ENGINE=MyISAM COMMENT='legacy' AUTO_INCREMENT=7") ||
                stmt.contains("ENGINE=MyISAM COMMENT='legacy' AUTO_INCREMENT=7"), "{stmt}");
        assert!(!stmt.contains("CHARSET"), "{stmt}");
    }

    #[test]
    fn rename_goes_last_and_warns() {
        let mut desired = ddl_from(BASE_SQL);
        desired.table = "members".into();
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let last = plan.statements.last().unwrap();
        assert_eq!(last, "ALTER TABLE `shop`.`users` RENAME TO `shop`.`members`");
        assert!(plan.warnings.iter().any(|w| w.contains("renamed")));
    }

    #[test]
    fn full_round_trip_preserves_exotic_attributes() {
        let exotic = r#"CREATE TABLE `weird` (
  `g` point NOT NULL SRID 4326 COMMENT 'geo',
  `n` varchar(10) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `v` int GENERATED ALWAYS AS ((g IS NOT NULL)) STORED,
  CHECK ((`n` <> ''))
) ENGINE=Aria PAGE_CHECKSUM=1 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci"#;
        let current = ddl_from(exotic);
        let desired = current.clone();
        let plan = build_alter_table("shop", "weird", &current, &desired).unwrap();
        assert!(plan.statements.is_empty(), "{:?}", plan.statements);
    }

    #[test]
    fn create_table_builds_complete_statement() {
        let req = CreateTableRequest {
            name: "items".into(),
            columns: vec![
                ColumnDef {
                    name: "id".into(),
                    previous_name: None,
                    data_type: "int unsigned".into(),
                    nullable: false,
                    default_kind: DefaultKind::None,
                    default_value: None,
                    auto_increment: true,
                    on_update: None,
                    generated: None,
                    comment: None,
                    preserved_attrs: Vec::new(),
                },
                ColumnDef {
                    name: "label".into(),
                    previous_name: None,
                    data_type: "varchar(40)".into(),
                    nullable: false,
                    default_kind: DefaultKind::Value,
                    default_value: Some("new item".into()),
                    auto_increment: false,
                    on_update: None,
                    generated: None,
                    comment: Some("it's fine".into()),
                    preserved_attrs: Vec::new(),
                },
            ],
            indexes: vec![IndexMeta {
                name: "PRIMARY".into(),
                kind: IndexKind::Primary,
                columns: vec!["id".into()],
                comment: None,
            }],
            foreign_keys: vec![],
            options: TableOptions {
                engine: Some("InnoDB".into()),
                charset: Some("utf8mb4".into()),
                collation: None,
                comment: None,
                auto_increment: None,
                row_format: None,
                extra: vec![ExtraTableOption { key: "PAGE_CHECKSUM".into(), value: "1".into() }],
                partition: None,
            },
        };
        let sql = build_create_table("shop", &req).unwrap();
        assert!(sql.starts_with("CREATE TABLE `shop`.`items` ("), "{sql}");
        assert!(sql.contains("`id` int unsigned NOT NULL AUTO_INCREMENT"));
        assert!(sql.contains("`label` varchar(40) NOT NULL DEFAULT 'new item' COMMENT 'it''s fine'"));
        assert!(sql.contains("PRIMARY KEY (`id`)"));
        assert!(sql.ends_with("ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 PAGE_CHECKSUM=1"), "{sql}");
    }

    #[test]
    fn create_table_rejects_duplicates_and_empty_names() {
        let req = CreateTableRequest {
            name: "".into(),
            columns: vec![ColumnDef {
                name: "x".into(),
                previous_name: None,
                data_type: "int".into(),
                nullable: true,
                default_kind: DefaultKind::None,
                default_value: None,
                auto_increment: false,
                on_update: None,
                generated: None,
                comment: None,
                preserved_attrs: Vec::new(),
            }],
            indexes: vec![],
            foreign_keys: vec![],
            options: TableOptions::default(),
        };
        assert!(build_create_table("db", &req).is_err());

        let dup = CreateTableRequest {
            name: "t".into(),
            columns: vec![
                ColumnDef {
                    name: "x".into(),
                    ..req.columns[0].clone()
                },
                ColumnDef {
                    name: "X".into(),
                    ..req.columns[0].clone()
                },
            ],
            ..req.clone()
        };
        assert!(build_create_table("db", &dup).is_err());
    }

    #[test]
    fn reordered_existing_column_gets_position_clause() {
        let mut desired = ddl_from(BASE_SQL);
        // Current: id, name, email → desired: id, email, name.
        desired.columns.swap(1, 2);
        let plan = build_alter_table("shop", "users", &ddl_from(BASE_SQL), &desired).unwrap();
        let stmt = &plan.statements[0];
        // Both movers need explicit positions: email now follows `id`, and
        // `name` slides below `email`.
        assert!(stmt.contains("MODIFY `email` varchar(255) NULL DEFAULT NULL AFTER `id`"), "{stmt}");
        assert!(stmt.contains("MODIFY `name` varchar(100) NOT NULL AFTER `email`"), "{stmt}");
        assert_eq!(plan.statements.len(), 1);
    }

    const COPY_SQL: &str = r#"
        CREATE TABLE `shop`.`orders` (
          `id` int unsigned NOT NULL AUTO_INCREMENT,
          `customer_id` int unsigned NOT NULL,
          `note` varchar(200) DEFAULT NULL,
          PRIMARY KEY (`id`),
          UNIQUE KEY `customer_id` (`customer_id`),
          KEY `idx_note` (`note`),
          CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)
        ) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4
    "#;

    #[test]
    fn copy_request_keeps_everything_by_default() {
        let src = ddl_from(COPY_SQL);
        let req = build_copy_request(&src, "orders_copy", true, true);
        assert_eq!(req.name, "orders_copy");
        assert_eq!(req.columns.len(), src.columns.len());
        assert_eq!(req.indexes.len(), 3); // PK + unique + key
        assert_eq!(req.foreign_keys.len(), 1);
        // The counter resets for the copy.
        assert_eq!(req.options.auto_increment, None);
        assert_eq!(req.options.engine.as_deref(), Some("InnoDB"));
    }

    #[test]
    fn copy_request_without_indexes_keeps_only_primary() {
        let src = ddl_from(COPY_SQL);
        let req = build_copy_request(&src, "orders_copy", false, true);
        assert_eq!(req.indexes.len(), 1);
        assert_eq!(req.indexes[0].kind, IndexKind::Primary);
        assert_eq!(req.foreign_keys.len(), 1);
    }

    #[test]
    fn copy_request_without_fks_drops_constraints_only() {
        let src = ddl_from(COPY_SQL);
        let req = build_copy_request(&src, "orders_copy", true, false);
        assert_eq!(req.indexes.len(), 3);
        assert!(req.foreign_keys.is_empty());
    }

    #[test]
    fn copy_of_pk_less_table_stays_insertable_without_indexes() {
        let src = ddl_from(
            r#"CREATE TABLE `d`.`t` (
                 `a` int NOT NULL,
                 KEY `idx_a` (`a`)
               ) ENGINE=InnoDB"#,
        );
        let req = build_copy_request(&src, "t2", false, false);
        assert!(req.indexes.is_empty());
        assert_eq!(req.columns.len(), 1);
    }
}

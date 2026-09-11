//! Compact schema serialization for AI agents (Phase 13).
//!
//! Rust port of the in-app assistant's `ai-context.ts` (same output format,
//! so prompts stay consistent across both surfaces). Trust contract made
//! concrete: this emits METADATA only — table/column names, types,
//! nullability, keys, FK shape, comments — never row data.

use crate::connections::{ForeignKeyMeta, TableSchemaData};

/// Hard cap on the serialized schema (~15k tokens).
pub const MAX_SCHEMA_CHARS: usize = 60_000;

const MAX_COLUMNS_PER_TABLE: usize = 120;

pub fn dialect_label(dialect: &str) -> &str {
    match dialect {
        "postgres" | "postgresql" => "PostgreSQL",
        "sqlite" => "SQLite",
        _ => "MySQL/MariaDB",
    }
}

/// FK lookup: `table.column` → `refTable(refColumn)`.
fn fk_index(fks: &[ForeignKeyMeta]) -> std::collections::HashMap<String, String> {
    let mut index = std::collections::HashMap::new();
    for fk in fks {
        let Some(owner) = fk.table.as_deref() else {
            continue;
        };
        for (i, col) in fk.columns.iter().enumerate() {
            let ref_col = fk.ref_columns.get(i).or_else(|| fk.ref_columns.first());
            if let Some(ref_col) = ref_col {
                index.insert(format!("{owner}.{col}"), format!("{}({})", fk.ref_table, ref_col));
            }
        }
    }
    index
}

fn column_line(column: &crate::connections::ColumnMeta, fk_ref: Option<&String>) -> String {
    let mut parts = vec![
        format!("  {} {}", column.name, column.data_type),
        (if column.nullable { "NULL" } else { "NOT NULL" }).to_string(),
    ];
    if column.key.as_deref() == Some("PRI") {
        parts.push("PRIMARY KEY".into());
    }
    if column
        .extra
        .as_deref()
        .is_some_and(|e| e.to_ascii_lowercase().contains("auto_increment"))
    {
        parts.push("AUTO_INCREMENT".into());
    }
    if let Some(fk_ref) = fk_ref {
        parts.push(format!("REFERENCES {fk_ref}"));
    }
    let line = parts.join(" ");
    match &column.comment {
        Some(comment) if !comment.is_empty() => format!("{line}, -- {comment}"),
        _ => format!("{line},"),
    }
}

/// Serialize one database's schema for the model; truncates at
/// [`MAX_SCHEMA_CHARS`] with an explicit note.
pub fn build_schema_context(
    db: &str,
    dialect: &str,
    tables: &[TableSchemaData],
    fks: &[ForeignKeyMeta],
) -> String {
    let mut out = String::new();
    out.push_str(&format!("-- Database: {db} ({})\n", dialect_label(dialect)));
    out.push_str("-- Metadata only: no row data is included or sent.\n");
    let references = fk_index(fks);

    let mut size = out.len();
    let mut truncated = false;
    for table in tables {
        let mut text = format!("TABLE {} (\n", table.table);
        let shown = table.columns.len().min(MAX_COLUMNS_PER_TABLE);
        for column in &table.columns[..shown] {
            text.push_str(&column_line(
                column,
                references.get(&format!("{}.{}", table.table, column.name)),
            ));
            text.push('\n');
        }
        if table.columns.len() > shown {
            text.push_str(&format!(
                "  -- {} more columns omitted),\n",
                table.columns.len() - shown
            ));
        } else {
            text.push_str(");\n");
        }

        if size + text.len() > MAX_SCHEMA_CHARS {
            truncated = true;
            break;
        }
        out.push_str(&text);
        size += text.len();
    }

    if truncated {
        out.push_str("-- …schema truncated: only these tables were shared with the model.\n");
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{ColumnMeta, ForeignKeyMeta};

    fn col(name: &str, data_type: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            data_type: data_type.into(),
            nullable: false,
            key: None,
            default_value: None,
            extra: None,
            comment: None,
        }
    }

    fn fk(owner: &str, column: &str, ref_table: &str, ref_column: &str) -> ForeignKeyMeta {
        ForeignKeyMeta {
            name: format!("fk_{owner}_{column}"),
            columns: vec![column.into()],
            ref_db: None,
            ref_table: ref_table.into(),
            ref_columns: vec![ref_column.into()],
            on_update: None,
            on_delete: None,
            table: Some(owner.into()),
        }
    }

    #[test]
    fn serializes_pk_fk_and_comments() {
        let mut id = col("id", "int unsigned");
        id.key = Some("PRI".into());
        id.extra = Some("auto_increment".into());
        let mut email = col("email", "varchar(255)");
        email.comment = Some("login email".into());
        let mut nullable = col("nickname", "varchar(100)");
        nullable.nullable = true;

        let text = build_schema_context(
            "shop",
            "mysql",
            &[TableSchemaData {
                table: "users".into(),
                columns: vec![id, email, nullable],
            }],
            &[],
        );
        assert!(text.contains("-- Database: shop (MySQL/MariaDB)"));
        assert!(text.contains("id int unsigned NOT NULL PRIMARY KEY AUTO_INCREMENT,"));
        assert!(text.contains("email varchar(255) NOT NULL, -- login email"));
        assert!(text.contains("nickname varchar(100) NULL,"));
        assert!(text.trim_end().ends_with(");"));
    }

    #[test]
    fn maps_foreign_keys() {
        let text = build_schema_context(
            "shop",
            "mysql",
            &[
                TableSchemaData { table: "orders".into(), columns: vec![col("user_id", "int")] },
                TableSchemaData { table: "users".into(), columns: vec![col("id", "int")] },
            ],
            &[fk("orders", "user_id", "users", "id")],
        );
        assert!(text.contains("user_id int NOT NULL REFERENCES users(id),"), "{text}");
    }

    #[test]
    fn truncates_oversized_schemas() {
        let mut tables = vec![TableSchemaData {
            table: "huge".into(),
            columns: (0..30).map(|i| col(&format!("c{i}"), "varchar(2000)")).collect(),
        }];
        for i in 0..40 {
            tables.push(TableSchemaData {
                table: format!("filler_{i}"),
                columns: (0..60).map(|c| col(&format!("c{c}"), "varchar(2000)")).collect(),
            });
        }
        let text = build_schema_context("db", "mysql", &tables, &[]);
        assert!(text.contains("…schema truncated"));
        assert!(text.contains("TABLE huge ("));
        assert!(!text.contains("TABLE filler_39 ("));
    }
}

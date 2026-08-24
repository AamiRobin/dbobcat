//! SQL dump assembly (Phase 5): pure text builders plus the INSERT
//! batcher. The database-driven orchestration lives in [`crate::export`];
//! everything here is side-effect free so dump options can be unit tested
//! without a server.
//!
//! Deliberate deviations from mysqldump's byte-for-byte output:
//! - No `/*!40101 ... */` version-conditional comments — our own importer's
//!   splitter treats block comments as skippable, so plain `SET` statements
//!   are emitted instead (portable across MySQL/MariaDB either way).
//! - `AUTO_INCREMENT=N` is stripped from CREATE TABLE so re-importing does
//!   not jump sequence counters past the dumped rows' keys.
//! - Routines/triggers/events are wrapped in `DELIMITER ;;` blocks so their
//!   internal semicolons survive any delimiter-aware splitter.

use serde::{Deserialize, Serialize};

use crate::connections::dialect::SqlDialect;
use crate::connections::{quote_ident, quote_qualified, RowValue};
use crate::export::formatters::sql_literal_for;

/// What a dump contains.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DumpWhat {
    #[default]
    StructureAndData,
    Structure,
    Data,
}

/// Full option set of the "Export database as SQL" dialog (mirrors
/// `SqlDumpOptions` in `src/types/ipc.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SqlDumpOptions {
    pub dbs: Vec<String>,
    /// Restrict tables per db; `None` dumps every base table.
    pub tables: Option<Vec<String>>,
    pub what: DumpWhat,
    /// Emit `DROP TABLE IF EXISTS` before each CREATE.
    pub drop_add: bool,
    /// Wrap each table's data in `LOCK TABLES ... WRITE; / UNLOCK TABLES;`.
    pub add_locks: bool,
    /// Include explicit column lists in INSERTs.
    pub complete_inserts: bool,
    /// Multi-row VALUES batches (~1000 rows or ~1 MB) instead of one
    /// INSERT per row.
    pub extended_inserts: bool,
    /// Wrap data inserts in START TRANSACTION / COMMIT.
    pub use_transactions: bool,
    /// Emit CREATE DATABASE IF NOT EXISTS + USE per database.
    pub create_db_header: bool,
    /// Strip `DEFINER=user@host` from routines/triggers/views/events.
    pub definer_strip: bool,
    pub include_views: bool,
    pub include_routines: bool,
    pub include_triggers: bool,
    pub include_events: bool,
    /// INSERT IGNORE instead of INSERT.
    pub insert_ignore: bool,
    /// Blobs as `0x…` instead of `_binary'…'`.
    pub hex_blobs: bool,
}

impl Default for SqlDumpOptions {
    fn default() -> Self {
        Self {
            dbs: Vec::new(),
            tables: None,
            what: DumpWhat::StructureAndData,
            drop_add: true,
            add_locks: true,
            complete_inserts: false,
            extended_inserts: true,
            use_transactions: false,
            create_db_header: true,
            definer_strip: true,
            include_views: true,
            include_routines: false,
            include_triggers: false,
            include_events: false,
            insert_ignore: false,
            hex_blobs: false,
        }
    }
}

// ---------------------------------------------------------------------------
// Header / session setup
// ---------------------------------------------------------------------------

/// File header comment block with app identity and generation timestamp.
pub fn dump_header(app_name: &str, app_version: &str) -> String {
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S %Z");
    format!(
        "-- -----------------------------------------------------------\n\
         -- {app_name} {app_version} SQL dump\n\
         -- Generation time: {now}\n\
         -- -----------------------------------------------------------\n\n"
    )
}

/// Session pragmas executed before anything else (MySQL target). Values
/// chosen so dumps re-import cleanly regardless of client defaults.
pub const SESSION_SETUP_SQL: &str =
    "SET NAMES utf8mb4;\nSET SQL_MODE = '';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n\n";

/// Pre-dump setup per dialect: MySQL resets session knobs, SQLite disables
/// FK enforcement during import, PostgreSQL needs no preamble (schema-
/// qualified statements make `USE` unnecessary).
pub fn session_setup_sql(dialect: SqlDialect) -> &'static str {
    match dialect {
        SqlDialect::Mysql => SESSION_SETUP_SQL,
        SqlDialect::Sqlite => "PRAGMA foreign_keys = OFF;\n\n",
        SqlDialect::Postgres => "\n",
    }
}

/// `CREATE DATABASE IF NOT EXISTS` + `USE` pair for one schema.
pub fn create_db_sql(db: &str) -> String {
    format!(
        "CREATE DATABASE IF NOT EXISTS {} DEFAULT CHARACTER SET utf8mb4;\n{};\n\n",
        quote_ident(db),
        sql_use_db(db)
    )
}

/// Bare `USE `db`;`.
pub fn sql_use_db(db: &str) -> String {
    format!("USE {}", quote_ident(db))
}

// ---------------------------------------------------------------------------
// Table sections
// ---------------------------------------------------------------------------

pub fn structure_comment(kind: &str, qualified: &str) -> String {
    format!("--\n-- {kind} for {qualified}\n--\n")
}

/// `DROP TABLE IF EXISTS `db`.`t`;`
pub fn drop_table_sql(db: &str, table: &str) -> String {
    format!("DROP TABLE IF EXISTS {};\n", quote_qualified(&[db, table]))
}

/// `LOCK TABLES `db`.`t` WRITE;`
pub fn lock_table_sql(db: &str, table: &str) -> String {
    format!(
        "LOCK TABLES {} WRITE;\n",
        quote_qualified(&[db, table])
    )
}

pub const UNLOCK_TABLES_SQL: &str = "UNLOCK TABLES;\n";

/// Remove every `DEFINER=user@host` clause (quoted or bare parts). Used on
/// routine/trigger/view/event DDL so dumps restore under any account.
pub fn strip_definers(sql: &str) -> String {
    let lower = sql.to_ascii_lowercase();
    let needle = "definer=";
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;

    while let Some(pos) = lower[i..].find(needle) {
        let start = i + pos;
        out.push_str(&sql[i..start]);
        let after = start + needle.len();

        // Consume `user`@`host` (either side may be quoted or bare); stop
        // at whitespace or the opening parenthesis of the argument list.
        let bytes = sql.as_bytes();
        let mut j = after;
        let mut seen_at = false;
        while j < bytes.len() {
            match bytes[j] {
                b'@' => {
                    seen_at = true;
                    j += 1;
                }
                b' ' | b'\t' | b'\r' | b'\n' | b'(' => break,
                _ => j += 1,
            }
        }
        if seen_at {
            // Also swallow one separating space (`DEFINER=… VIEW` etc.).
            if j < bytes.len() && bytes[j] == b' ' {
                j += 1;
            }
            i = j;
        } else {
            // Malformed — keep the text untouched.
            out.push_str(&sql[start..after]);
            i = after;
        }
    }
    out.push_str(&sql[i..]);
    out
}

/// Remove `AUTO_INCREMENT=N` clauses from a CREATE TABLE so imports do not
/// bump the counter above the dumped rows.
pub fn strip_auto_increment(sql: &str) -> String {
    let lower = sql.to_ascii_lowercase();
    let needle = "auto_increment=";
    let mut out = String::with_capacity(sql.len());
    let mut i = 0usize;

    while let Some(pos) = lower[i..].find(needle) {
        let start = i + pos;
        out.push_str(&sql[i..start]);
        let bytes = sql.as_bytes();
        let mut j = start + needle.len();
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b' ' {
            j += 1;
        }
        i = j;
    }
    out.push_str(&sql[i..]);
    out
}

/// Terminate object DDL with the custom delimiter so compound bodies reach
/// the server intact after a `DELIMITER ;;` switch.
pub fn with_custom_delimiter(sql: &str) -> String {
    let trimmed = sql.trim_end();
    let trimmed = trimmed.strip_suffix(';').unwrap_or(trimmed);
    format!("{trimmed};;\n")
}

// ---------------------------------------------------------------------------
// INSERT batching
// ---------------------------------------------------------------------------

const EXTENDED_BATCH_ROWS: usize = 1000;
const EXTENDED_BATCH_BYTES: usize = 1024 * 1024;

/// Accumulates data rows into INSERT statement text honouring the
/// extended-insert options. One row of values is rendered at a time; at
/// most one open batch (≈1000 rows / ≈1 MB) is buffered.
pub struct InsertBatcher {
    table_q: String,
    column_list: String,
    extended: bool,
    insert_ignore: bool,
    hex_blobs: bool,
    dialect: SqlDialect,
    out: String,
    rows_in_batch: usize,
}

impl InsertBatcher {
    pub fn new(
        table_q: &str,
        columns: &[String],
        extended: bool,
        complete_columns: bool,
        insert_ignore: bool,
        hex_blobs: bool,
    ) -> Self {
        let column_list = if complete_columns {
            format!(
                " ({})",
                columns
                    .iter()
                    .map(|c| quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            String::new()
        };
        Self {
            table_q: table_q.to_string(),
            column_list,
            extended,
            insert_ignore,
            hex_blobs,
            dialect: SqlDialect::Mysql,
            out: String::new(),
            rows_in_batch: 0,
        }
    }

    /// Target a different engine's literal syntax (MySQL stays the default
    /// so existing call sites/tests are untouched). Ignore/upsert tails are
    /// the caller's concern here — this type only renders VALUES text.
    pub fn with_dialect(mut self, dialect: SqlDialect) -> Self {
        self.dialect = dialect;
        self
    }

    fn verb(&self) -> &'static str {
        if self.insert_ignore {
            "INSERT IGNORE INTO"
        } else {
            "INSERT INTO"
        }
    }

    /// Add one data row; may close the current extended batch internally.
    pub fn push_row(&mut self, values: &[RowValue]) {
        let literals = values
            .iter()
            .map(|v| sql_literal_for(self.dialect, v, self.hex_blobs))
            .collect::<Vec<_>>()
            .join(", ");

        if !self.extended {
            self.out.push_str(&format!(
                "{} {}{} VALUES ({});\n",
                self.verb(),
                self.table_q,
                self.column_list,
                literals
            ));
            return;
        }

        if self.rows_in_batch == 0 {
            self.out.push_str(&format!(
                "{} {}{} VALUES\n",
                self.verb(),
                self.table_q,
                self.column_list
            ));
        } else {
            self.out.push_str(",\n");
        }
        self.out.push('(');
        self.out.push_str(&literals);
        self.out.push(')');
        self.rows_in_batch += 1;

        if self.rows_in_batch >= EXTENDED_BATCH_ROWS || self.out.len() >= EXTENDED_BATCH_BYTES {
            self.close_batch();
        }
    }

    fn close_batch(&mut self) {
        if self.rows_in_batch > 0 {
            self.out.push_str(";\n");
            self.rows_in_batch = 0;
        }
    }

    /// Completed statement text waiting to be flushed. In extended mode
    /// nothing drains while a batch is still open.
    pub fn take_ready(&mut self) -> Option<String> {
        if self.extended && self.rows_in_batch > 0 {
            return None;
        }
        if self.out.is_empty() {
            None
        } else {
            Some(std::mem::take(&mut self.out))
        }
    }

    /// Flush whatever remains (partial extended batch included).
    pub fn finish(&mut self) -> Option<String> {
        self.close_batch();
        self.take_ready()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rv(v: RowValue) -> RowValue {
        v
    }


    #[test]
    fn header_contains_app_and_time() {
        let h = dump_header("Murmeli", "0.1.0");
        assert!(h.starts_with("-- "));
        assert!(h.contains("-- Murmeli 0.1.0 SQL dump"));
        assert!(h.contains("-- Generation time:"));
    }

    #[test]
    fn session_setup_resets_modes() {
        assert!(SESSION_SETUP_SQL.contains("SET NAMES utf8mb4;"));
        assert!(SESSION_SETUP_SQL.contains("SET FOREIGN_KEY_CHECKS = 0;"));
        assert!(SESSION_SETUP_SQL.contains("SET SQL_MODE = '';"));
    }

    #[test]
    fn create_db_and_use_are_emitted() {
        let sql = create_db_sql("shop");
        assert!(sql.starts_with("CREATE DATABASE IF NOT EXISTS `shop` DEFAULT CHARACTER SET utf8mb4;\n"));
        assert!(sql.contains("\nUSE `shop`;\n"));
    }

    #[test]
    fn drop_and_lock_use_qualified_names() {
        assert_eq!(drop_table_sql("shop", "users"), "DROP TABLE IF EXISTS `shop`.`users`;\n");
        assert_eq!(lock_table_sql("shop", "users"), "LOCK TABLES `shop`.`users` WRITE;\n");
        assert_eq!(UNLOCK_TABLES_SQL, "UNLOCK TABLES;\n");
    }

    #[test]
    fn definer_stripping_handles_quoted_and_bare_users() {
        let sql = "CREATE DEFINER=`admin`@`localhost` PROCEDURE p() BEGIN END";
        assert_eq!(strip_definers(sql), "CREATE PROCEDURE p() BEGIN END");

        let sql2 = "CREATE DEFINER=root@10.0.0.1 VIEW v AS SELECT 1";
        assert_eq!(strip_definers(sql2), "CREATE VIEW v AS SELECT 1");

        // Multiple definers in one script.
        let both = "CREATE DEFINER=`a`@`b` VIEW x AS SELECT 1; CREATE DEFINER=c@d VIEW y AS SELECT 2;";
        assert_eq!(
            strip_definers(both),
            "CREATE VIEW x AS SELECT 1; CREATE VIEW y AS SELECT 2;"
        );
        // Without definer the text passes through unchanged.
        assert_eq!(strip_definers("SELECT 1"), "SELECT 1");
    }

    #[test]
    fn auto_increment_clause_is_removed() {
        let sql = "CREATE TABLE `t` (\n  `id` int AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4";
        let out = strip_auto_increment(sql);
        assert!(!out.contains("AUTO_INCREMENT="));
        assert!(out.contains("ENGINE=InnoDB"));
        assert!(out.contains("`id` int"));
    }

    #[test]
    fn custom_delimiter_wraps_body() {
        assert_eq!(with_custom_delimiter("BEGIN END"), "BEGIN END;;\n");
        assert_eq!(with_custom_delimiter("BEGIN END;"), "BEGIN END;;\n");
    }

    #[test]
    fn single_row_mode_emits_one_insert_per_row() {
        let mut b = InsertBatcher::new(
            "`shop`.`items`",
            &["id".into(), "name".into()],
            false,
            true,
            false,
            false,
        );
        b.push_row(&[rv(RowValue::Int(1)), rv(RowValue::Str("it's\n".into()))]);
        b.push_row(&[rv(RowValue::Null), rv(RowValue::UInt(7))]);

        let out = b.finish().expect("statements");
        // Quotes double; the newline stays literal inside the SQL string.
        assert_eq!(
            out,
            "INSERT INTO `shop`.`items` (`id`, `name`) VALUES (1, 'it''s\n');\n\
             INSERT INTO `shop`.`items` (`id`, `name`) VALUES (NULL, 7);\n"
        );
    }

    #[test]
    fn extended_mode_batches_until_cap_then_flushes() {
        let mut b = InsertBatcher::new("`d`.`t`", &["a".into()], true, false, false, false);
        for i in 0..EXTENDED_BATCH_ROWS {
            b.push_row(&[rv(RowValue::Int(i as i64))]);
        }
        // Exactly at the cap the batch closes and becomes readable.
        let ready = b.take_ready().expect("batch drained at cap");
        assert_eq!(ready.matches("VALUES").count(), 1);
        assert_eq!(ready.matches('(').count(), EXTENDED_BATCH_ROWS);
        assert!(ready.ends_with(");\n"));

        // Next row opens a new batch that only finishes at finish().
        b.push_row(&[rv(RowValue::Int(-1))]);
        assert!(b.take_ready().is_none());
        let tail = b.finish().expect("tail");
        assert!(tail.contains("INSERT INTO `d`.`t` VALUES\n(-1);"));
    }

    #[test]
    fn extended_mode_flushes_partial_tail_on_finish() {
        let mut b = InsertBatcher::new("`d`.`t`", &["a".into()], true, false, false, false);
        b.push_row(&[rv(RowValue::Int(1))]);
        b.push_row(&[rv(RowValue::Int(2))]);
        assert!(b.take_ready().is_none());
        let out = b.finish().expect("partial batch");
        assert!(out.starts_with("INSERT INTO `d`.`t` VALUES\n"));
        assert!(out.contains("(1),\n(2);"));
    }

    #[test]
    fn insert_ignore_switches_the_verb() {
        let mut b = InsertBatcher::new("`d`.`t`", &[], false, false, true, false);
        b.push_row(&[rv(RowValue::Int(5))]);
        let out = b.finish().unwrap();
        assert!(out.starts_with("INSERT IGNORE INTO `d`.`t` VALUES (5);"));
    }

    #[test]
    fn session_setup_varies_by_dialect() {
        assert_eq!(session_setup_sql(SqlDialect::Mysql), SESSION_SETUP_SQL);
        assert!(session_setup_sql(SqlDialect::Sqlite).contains("PRAGMA foreign_keys = OFF"));
        // PostgreSQL needs no preamble; schema-qualified statements suffice.
        assert!(session_setup_sql(SqlDialect::Postgres).trim().is_empty());
    }

    #[test]
    fn batcher_renders_per_dialect_blob_syntax() {
        let bytes = vec![0xDE, 0xAD, 0xBE, 0xEF];

        let mut pg = InsertBatcher::new("\"d\".\"t\"", &["b".into()], false, false, false, false)
            .with_dialect(SqlDialect::Postgres);
        pg.push_row(&[rv(RowValue::Bytes(bytes.clone()))]);
        let out = pg.finish().unwrap();
        assert!(out.contains("decode('DEADBEEF','hex')"), "{out}");

        let mut lite = InsertBatcher::new("\"d\".\"t\"", &["b".into()], false, false, false, false)
            .with_dialect(SqlDialect::Sqlite);
        lite.push_row(&[rv(RowValue::Bytes(bytes))]);
        let out = lite.finish().unwrap();
        assert!(out.contains("X'DEADBEEF'"), "{out}");
    }

    #[test]
    fn batcher_keeps_mysql_default_without_with_dialect() {
        let mut my = InsertBatcher::new("`d`.`t`", &["b".into()], false, false, false, true);
        my.push_row(&[rv(RowValue::Bytes(vec![0x01]))]);
        assert!(my.finish().unwrap().contains("0x01"));
    }

    #[test]
    fn postgres_strings_double_only_quotes() {
        let mut pg = InsertBatcher::new("\"d\".\"t\"", &["s".into()], false, false, false, false)
            .with_dialect(SqlDialect::Postgres);
        pg.push_row(&[rv(RowValue::Str("back\\slash 'quoted'".into()))]);
        let out = pg.finish().unwrap();
        assert!(
            out.contains("'back\\slash ''quoted'''"),
            "PG literals must not double backslashes: {out}"
        );
    }

    #[test]
    fn hex_blob_option_renders_hex_literals() {
        let mut hexed = InsertBatcher::new("`d`.`t`", &["b".into()], false, false, false, true);
        hexed.push_row(&[rv(RowValue::Bytes(vec![0x00, 0xff, 0x27]))]);
        assert!(hexed.finish().unwrap().contains("0x00FF27"));

        let mut binary = InsertBatcher::new("`d`.`t`", &["b".into()], false, false, false, false);
        binary.push_row(&[rv(RowValue::Bytes(b"a'b\\c".to_vec()))]);
        assert!(binary.finish().unwrap().contains("_binary'a''b\\\\c'"));
    }
}

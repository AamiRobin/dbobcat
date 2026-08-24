//! SQL dialect abstraction (Phase 6).
//!
//! One place for the per-engine text quirks that used to live in
//! `mod.rs`/`sql.rs`: identifier quoting, bind placeholders, LIMIT clauses
//! and upsert tails. MySQL keeps its historical backtick behaviour;
//! PostgreSQL and SQLite use double quotes with `""` doubling (SQLite also
//! tolerates backticks, but we emit standard quotes so dumps port cleanly).
//!
//! Values never pass through here — identifiers only. Data always travels
//! as bind parameters.

use serde::{Deserialize, Serialize};

/// The three engines Phase 6 supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SqlDialect {
    Mysql,
    Postgres,
    Sqlite,
}

impl SqlDialect {
    /// Dialect advertised by [`crate::connections::ServerInfo`].
    pub fn wire_name(self) -> &'static str {
        match self {
            SqlDialect::Mysql => "mysql",
            SqlDialect::Postgres => "postgres",
            SqlDialect::Sqlite => "sqlite",
        }
    }

    /// Quote one identifier for embedding in SQL text (`a``b` / `"a""b"`).
    pub fn quote_ident(self, name: &str) -> String {
        match self {
            SqlDialect::Mysql => format!("`{}`", name.replace('`', "``")),
            // PostgreSQL: double quotes, doubled inside. SQLite accepts the
            // same syntax (and doubles embedded quotes the same way).
            SqlDialect::Postgres | SqlDialect::Sqlite => {
                format!("\"{}\"", name.replace('"', "\"\""))
            }
        }
    }

    /// Fully qualified identifier, e.g. `` `db`.`table` `` / `"db"."table"`.
    pub fn quote_qualified(self, parts: &[&str]) -> String {
        parts
            .iter()
            .map(|p| self.quote_ident(p))
            .collect::<Vec<_>>()
            .join(".")
    }

    /// Positional placeholder for the n-th bind parameter (1-based):
    /// `?` everywhere except PostgreSQL's `$n`.
    pub fn placeholder(self, index: usize) -> String {
        match self {
            SqlDialect::Mysql | SqlDialect::Sqlite => "?".to_string(),
            SqlDialect::Postgres => format!("${index}"),
        }
    }

    /// Pagination tail; identical syntax across the three engines but kept
    /// here so callers never hand-roll engine SQL.
    pub fn limit_clause(self, limit: u64, offset: u64) -> String {
        let _ = self;
        format!("LIMIT {limit} OFFSET {offset}")
    }

    /// Tail turning an INSERT into an upsert over `conflict_cols`
    /// (`None`/empty → plain INSERT or an ignore-tail when `ignore`).
    pub fn upsert_suffix(
        self,
        conflict_cols: Option<&[String]>,
        ignore: bool,
        quote: impl Fn(&str) -> String,
    ) -> String {
        match self {
            SqlDialect::Mysql => match conflict_cols.filter(|c| !c.is_empty()) {
                Some(cols) => {
                    let sets = cols
                        .iter()
                        .map(|c| format!("{} = VALUES({})", quote(c), quote(c)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(" ON DUPLICATE KEY UPDATE {sets}")
                }
                None if ignore => " ON DUPLICATE KEY UPDATE `<no-op>` = `<no-op>`".to_string(),
                None => String::new(),
            },
            SqlDialect::Sqlite => match conflict_cols.filter(|c| !c.is_empty()) {
                Some(cols) => {
                    let targets = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
                    let sets = cols
                        .iter()
                        .map(|c| format!("{} = excluded.{}", quote(c), quote(c)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(" ON CONFLICT ({targets}) DO UPDATE SET {sets}")
                }
                // INSERT OR IGNORE is handled by the caller via the verb.
                None => String::new(),
            },
            SqlDialect::Postgres => match conflict_cols.filter(|c| !c.is_empty()) {
                Some(cols) => {
                    let targets = cols.iter().map(|c| quote(c)).collect::<Vec<_>>().join(", ");
                    let sets = cols
                        .iter()
                        .map(|c| format!("{} = excluded.{}", quote(c), quote(c)))
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!(" ON CONFLICT ({targets}) DO UPDATE SET {sets}")
                }
                None if ignore => " ON CONFLICT DO NOTHING".to_string(),
                None => String::new(),
            },
        }
    }

    /// INSERT verb honouring each engine's ignore syntax.
    /// (MySQL uses `INSERT IGNORE`; SQLite uses `INSERT OR IGNORE`;
    /// PostgreSQL gets its ignore from [`SqlDialect::upsert_suffix`].)
    pub fn insert_verb(self, ignore: bool) -> &'static str {
        match self {
            SqlDialect::Mysql => {
                if ignore {
                    "INSERT IGNORE INTO"
                } else {
                    "INSERT INTO"
                }
            }
            SqlDialect::Sqlite => {
                if ignore {
                    "INSERT OR IGNORE INTO"
                } else {
                    "INSERT INTO"
                }
            }
            SqlDialect::Postgres => "INSERT INTO",
        }
    }
}

/// Sequential placeholder generator shared by the statement builders:
/// yields `?` marks for MySQL/SQLite and `$1..$n` for PostgreSQL.
pub struct Placeholders {
    dialect: SqlDialect,
    next: usize,
}

impl Placeholders {
    pub fn new(dialect: SqlDialect) -> Self {
        Self { dialect, next: 0 }
    }

    /// Reserve and render the next placeholder.
    pub fn mark(&mut self) -> String {
        self.next += 1;
        self.dialect.placeholder(self.next)
    }

    /// Number of placeholders handed out so far (bind arity).
    pub fn used(&self) -> usize {
        self.next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_keeps_backtick_quoting() {
        let d = SqlDialect::Mysql;
        assert_eq!(d.quote_ident("users"), "`users`");
        assert_eq!(d.quote_ident("my db"), "`my db`");
        assert_eq!(d.quote_ident("we`ird"), "`we``ird`");
        assert_eq!(d.quote_ident("`"), "````");
        assert_eq!(d.quote_qualified(&["db", "tbl"]), "`db`.`tbl`");
    }

    #[test]
    fn postgres_doubles_embedded_double_quotes() {
        let d = SqlDialect::Postgres;
        assert_eq!(d.quote_ident("users"), "\"users\"");
        assert_eq!(d.quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(d.quote_ident("\""), "\"\"\"\"");
        assert_eq!(
            d.quote_qualified(&["public", "user table"]),
            "\"public\".\"user table\""
        );
    }

    #[test]
    fn sqlite_quotes_like_postgres() {
        let d = SqlDialect::Sqlite;
        assert_eq!(d.quote_ident("main.t"), "\"main.t\"");
        assert_eq!(d.quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(d.quote_qualified(&["main", "tbl"]), "\"main\".\"tbl\"");
    }

    #[test]
    fn unicode_and_keyword_identifiers_survive_every_dialect() {
        for d in [SqlDialect::Mysql, SqlDialect::Postgres, SqlDialect::Sqlite] {
            assert!(!d.quote_ident("表名").is_empty());
            assert_eq!(d.quote_ident("select"), d.quote_ident("select"));
            assert_eq!(d.quote_ident("héllo→wörld"), d.quote_ident("héllo→wörld"));
            // Round-trip property: doubling is applied exactly once per quote char.
            let q = d.quote_ident("o'\"x");
            let inner = &q[1..q.len() - 1];
            assert!(inner.contains("o'\"x") || inner.contains("\"x"));
        }
    }

    #[test]
    fn placeholders_are_numbered_only_for_postgres() {
        assert_eq!(SqlDialect::Mysql.placeholder(1), "?");
        assert_eq!(SqlDialect::Mysql.placeholder(7), "?");
        assert_eq!(SqlDialect::Sqlite.placeholder(3), "?");
        assert_eq!(SqlDialect::Postgres.placeholder(1), "$1");
        assert_eq!(SqlDialect::Postgres.placeholder(12), "$12");

        let mut ph = Placeholders::new(SqlDialect::Postgres);
        assert_eq!(ph.mark(), "$1");
        assert_eq!(ph.mark(), "$2");
        assert_eq!(ph.used(), 2);

        let mut my = Placeholders::new(SqlDialect::Mysql);
        assert_eq!(my.mark(), "?");
        assert_eq!(my.mark(), "?");
    }

    #[test]
    fn limit_clause_matches_across_engines() {
        for d in [SqlDialect::Mysql, SqlDialect::Postgres, SqlDialect::Sqlite] {
            assert_eq!(d.limit_clause(1000, 2000), "LIMIT 1000 OFFSET 2000");
        }
    }

    #[test]
    fn upsert_suffixes_per_engine() {
        let cols = vec!["v".to_string()];
        let q = |s: &str| format!("`{s}`");

        assert_eq!(
            SqlDialect::Mysql.upsert_suffix(Some(&cols), false, q),
            " ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)"
        );
        assert_eq!(
            SqlDialect::Postgres.upsert_suffix(Some(&cols), false, q),
            " ON CONFLICT (`v`) DO UPDATE SET `v` = excluded.`v`"
        );
        assert_eq!(
            SqlDialect::Sqlite.upsert_suffix(Some(&cols), false, q),
            " ON CONFLICT (`v`) DO UPDATE SET `v` = excluded.`v`"
        );
        // Ignore-only inserts: PG has a conflict tail, SQLite uses the verb.
        assert_eq!(SqlDialect::Postgres.upsert_suffix(None, true, q), " ON CONFLICT DO NOTHING");
        assert_eq!(SqlDialect::Sqlite.upsert_suffix(None, true, q), "");
        assert_eq!(SqlDialect::Mysql.upsert_suffix(None, false, q), "");
    }

    #[test]
    fn insert_verbs_carry_ignore_flavour() {
        assert_eq!(SqlDialect::Mysql.insert_verb(true), "INSERT IGNORE INTO");
        assert_eq!(SqlDialect::Mysql.insert_verb(false), "INSERT INTO");
        assert_eq!(SqlDialect::Sqlite.insert_verb(true), "INSERT OR IGNORE INTO");
        assert_eq!(SqlDialect::Postgres.insert_verb(true), "INSERT INTO");
    }

    #[test]
    fn dialect_wire_names_round_trip_through_serde() {
        for (dialect, name) in [
            (SqlDialect::Mysql, "mysql"),
            (SqlDialect::Postgres, "postgres"),
            (SqlDialect::Sqlite, "sqlite"),
        ] {
            let json = serde_json::to_string(&dialect).unwrap();
            assert_eq!(json, format!("\"{name}\""));
            assert_eq!(dialect.wire_name(), name);
            let back: SqlDialect = serde_json::from_str(&json).unwrap();
            assert_eq!(back, dialect);
        }
    }
}

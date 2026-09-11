//! AST-based SQL risk classification (Agent Phase 13).
//!
//! Classifies a statement as read-only, write, DDL or transaction-control
//! so the AI agent can decide what may execute without the user's explicit
//! confirmation. Built on `sqlparser`'s AST — far harder to fool than a
//! keyword scan (a CTE wrapping a DELETE, a sneaky `EXPLAIN ANALYZE`, a
//! write hidden after a semicolon) — with a conservative fallback for
//! dialect syntax the parser rejects.
//!
//! Contract: `Unknown` is the failure mode. Anything the classifier cannot
//! prove safe is gated behind user confirmation by the agent's policy.

use sqlparser::ast::{Query, Select, SetExpr, Statement, Visit, Visitor};
use std::ops::ControlFlow;
use sqlparser::dialect::{MySqlDialect, PostgreSqlDialect, SQLiteDialect};
use sqlparser::parser::Parser;

use crate::connections::dialect::SqlDialect;

/// How a statement can affect the database.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlRisk {
    /// Proven read-only by AST analysis — the agent may run it unattended.
    ReadOnly,
    /// Mutates rows (INSERT / UPDATE / DELETE / REPLACE).
    Write,
    /// Schema changes (CREATE / ALTER / DROP / TRUNCATE / RENAME …).
    Ddl,
    /// Transaction control (BEGIN / COMMIT / SAVEPOINT …).
    Transaction,
    /// Utility or unparseable — never auto-executed.
    Unknown,
}

/// Worst-of-all-statements assessment of one SQL input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlAssessment {
    pub risk: SqlRisk,
    /// UPDATE/DELETE with no WHERE clause — matches every row.
    pub unbounded_write: bool,
    pub statements: usize,
}

impl SqlAssessment {
    pub fn is_read_only(&self) -> bool {
        self.risk == SqlRisk::ReadOnly && !self.unbounded_write
    }
}

/// Classify `sql` (which may contain several statements) for `dialect`.
pub fn assess(sql: &str, dialect: SqlDialect) -> SqlAssessment {
    let parser_dialect = match dialect {
        SqlDialect::Mysql => &MySqlDialect {} as &dyn sqlparser::dialect::Dialect,
        SqlDialect::Postgres => &PostgreSqlDialect {},
        SqlDialect::Sqlite => &SQLiteDialect {},
    };
    let statements = match Parser::parse_sql(parser_dialect, sql) {
        Ok(stmts) if !stmts.is_empty() => stmts,
        // Parse failure: fall back to a conservative keyword scan so valid
        // but dialect-quirky reads (SHOW / SET / vendor verbs) still
        // classify, and everything else lands on Unknown.
        _ => return fallback_scan(sql),
    };

    // Floor: a write/DDL/INTO node ANYWHERE in the tree (subqueries, CTEs,
    // derived tables, expression subqueries) forces at least Write, no
    // matter how benign the top-level statement looks.
    let mut worst = if tree_contains_write(&statements) {
        SqlRisk::Write
    } else {
        SqlRisk::ReadOnly
    };
    let mut unbounded = false;
    for stmt in &statements {
        let (risk, stmt_unbounded) = assess_statement(stmt);
        unbounded |= stmt_unbounded;
        if risk_rank(risk) > risk_rank(worst) {
            worst = risk;
        }
    }
    // A parsed-but-unclassified statement (SHOW variants, vendor verbs…)
    // may still be a plain read: the keyword fallback downgrades all-Unknown
    // inputs to ReadOnly, anything else stays Unknown (fail-closed). NEVER
    // downgrade multi-statement input: the scan reads the FIRST statement's
    // shape, so `SELECT 1; SET GLOBAL …` would otherwise launder the second
    // statement into a read.
    if worst == SqlRisk::Unknown && statements.len() == 1 {
        worst = fallback_scan(sql).risk;
    }
    SqlAssessment { risk: worst, unbounded_write: unbounded, statements: statements.len() }
}

/// Higher wins when merging several statements.
fn risk_rank(risk: SqlRisk) -> u8 {
    match risk {
        SqlRisk::ReadOnly => 0,
        SqlRisk::Transaction => 1,
        SqlRisk::Write => 2,
        SqlRisk::Ddl => 3,
        SqlRisk::Unknown => 4,
    }
}

fn assess_statement(stmt: &Statement) -> (SqlRisk, bool) {
    match stmt {
        // Plain read (SELECT / WITH … SELECT / table expressions).
        Statement::Query(query) => (assess_query(query), false),

        // EXPLAIN executes its inner statement only with ANALYZE.
        Statement::Explain { statement, analyze, .. } => {
            if *analyze {
                (SqlRisk::Write, false)
            } else {
                let (risk, unbounded) = assess_statement(statement);
                (risk, unbounded)
            }
        }

        Statement::Update(update) => (SqlRisk::Write, update.selection.is_none()),
        Statement::Delete(delete) => (SqlRisk::Write, delete.selection.is_none()),
        Statement::Insert { .. } => (SqlRisk::Write, false), // includes MySQL REPLACE INTO

        Statement::CreateTable { .. }
        | Statement::CreateView { .. }
        | Statement::CreateIndex { .. }
        | Statement::CreateSchema { .. }
        | Statement::CreateDatabase { .. }
        | Statement::AlterTable { .. }
        | Statement::AlterIndex { .. }
        | Statement::AlterView { .. }
        | Statement::Drop { .. }
        | Statement::Truncate { .. }
        | Statement::RenameTable { .. } => (SqlRisk::Ddl, false),

        Statement::StartTransaction { .. }
        | Statement::Commit { .. }
        | Statement::Rollback { .. }
        | Statement::Savepoint { .. }
        | Statement::ReleaseSavepoint { .. } => (SqlRisk::Transaction, false),

        // SET / USE / SHOW variants / vendor verbs we can't vouch for.
        _ => (SqlRisk::Unknown, false),
    }
}

/// Read-until proven otherwise: the visitor floor already catches every
/// hidden write, so what remains is the union-chain shape check — any arm
/// that is not a plain SELECT is unclassifiable (fail-closed).
fn assess_query(query: &Query) -> SqlRisk {
    let mut body: &SetExpr = query.body.as_ref();
    loop {
        match body {
            SetExpr::Select(_) => return SqlRisk::ReadOnly,
            SetExpr::SetOperation { left, .. } => body = left.as_ref(),
            _ => return SqlRisk::Unknown,
        }
    }
}

/// Visitor that flags writes and DDL anywhere in a statement tree:
/// top level, CTEs at any depth, derived tables, and expression
/// subqueries (the round-2 bypass family).
#[derive(Default)]
struct WriteScanner {
    found: bool,
}

impl Visitor for WriteScanner {
    type Break = ();

    fn pre_visit_statement(&mut self, statement: &Statement) -> ControlFlow<()> {
        match statement {
            // Reads recurse further; EXPLAIN's own arm assesses the inner
            // statement (and ANALYZE itself is Write).
            Statement::Query(_) | Statement::Explain { .. } => {}
            _ => {
                let (risk, _) = assess_statement(statement);
                if matches!(risk, SqlRisk::Write | SqlRisk::Ddl) {
                    self.found = true;
                    return ControlFlow::Break(());
                }
            }
        }
        ControlFlow::Continue(())
    }

    fn pre_visit_select(&mut self, select: &Select) -> ControlFlow<()> {
        // `SELECT … INTO OUTFILE / INTO table` anywhere in the tree —
        // including set-operation arms that never fire pre_visit_query
        // (INTERSECT binds tighter than UNION).
        if select.into.is_some() {
            self.found = true;
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }
}

/// True when any statement in the tree hides a write/DDL/INTO node.
fn tree_contains_write(statements: &[Statement]) -> bool {
    let mut scanner = WriteScanner::default();
    for statement in statements {
        if statement.visit(&mut scanner).is_break() {
            return true;
        }
    }
    scanner.found
}

/// Keyword fallback for inputs the parser rejects. Returns ReadOnly only
/// for statements that look like plain reads; everything else is Unknown.
fn fallback_scan(sql: &str) -> SqlAssessment {
    let trimmed = sql.trim();
    let first = trimmed
        .split(|c: char| c.is_whitespace() || c == '(')
        .find(|w| !w.is_empty())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !READ_VERBS.contains(&first.as_str()) {
        return SqlAssessment { risk: SqlRisk::Unknown, unbounded_write: false, statements: 1 };
    }
    // Scan word-by-word OUTSIDE string literals for write verbs — covers
    // `WITH x AS (DELETE …)` shapes the parser bailed on, while a quoted
    // 'drop table' in a SELECT must not trip it.
    const WRITE_VERBS: [&str; 21] = [
        "insert", "update", "delete", "merge", "replace", "drop", "alter", "create", "truncate",
        "rename", "grant", "revoke", "flush", "kill", "shutdown", "analyze", "call", "load",
        // SELECT … INTO OUTFILE / INTO @var: the parser may bail on the
        // dialect shape, so the fallback must catch these on its own.
        "into", "outfile", "dumpfile",
    ];
    let mut in_string: Option<char> = None;
    // MySQL default mode: a backslash escapes the next character inside a
    // string (`'''`). Without parity tracking, one escaped quote flips the
    // scanner's view and the real tail (e.g. INTO OUTFILE) is skipped.
    let mut escaped = false;
    let mut word = String::new();
    let mut saw_write = false;
    let mut saw_select_into = false;
    for ch in trimmed.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if let Some(quote) = in_string {
            if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => in_string = Some(ch),
            c if c.is_ascii_alphabetic() || c == '_' => word.push(c.to_ascii_lowercase()),
            _ => {
                if WRITE_VERBS.contains(&word.as_str()) {
                    saw_write = true;
                }
                if word == "into" || word == "outfile" || word == "dumpfile" {
                    saw_select_into = true;
                }
                word.clear();
            }
        }
    }
    if WRITE_VERBS.contains(&word.as_str()) {
        saw_write = true;
    }
    if word == "into" || word == "outfile" || word == "dumpfile" {
        saw_select_into = true;
    }
    let risk = if saw_select_into {
        SqlRisk::Write
    } else if saw_write {
        SqlRisk::Unknown
    } else {
        SqlRisk::ReadOnly
    };
    SqlAssessment { risk, unbounded_write: false, statements: 1 }
}

const READ_VERBS: [&str; 6] = ["select", "with", "show", "explain", "describe", "desc"];

#[cfg(test)]
mod tests {
    use super::*;

    fn assess_mysql(sql: &str) -> SqlAssessment {
        assess(sql, SqlDialect::Mysql)
    }

    #[test]
    fn plain_reads_classify_read_only() {
        for sql in [
            "SELECT * FROM users",
            "WITH recent AS (SELECT * FROM orders) SELECT * FROM recent",
            "SELECT 'delete' AS word, 'drop table' AS hint",
        ] {
            let a = assess_mysql(sql);
            assert!(a.is_read_only(), "{sql} → {a:?}");
        }
    }

    #[test]
    fn writes_and_ddl_classify() {
        assert_eq!(assess_mysql("INSERT INTO t VALUES (1)").risk, SqlRisk::Write);
        assert_eq!(assess_mysql("UPDATE t SET a = 1 WHERE id = 2").risk, SqlRisk::Write);
        assert_eq!(assess_mysql("DELETE FROM t WHERE id = 2").risk, SqlRisk::Write);
        assert_eq!(assess_mysql("DROP TABLE t").risk, SqlRisk::Ddl);
        assert_eq!(assess_mysql("TRUNCATE t").risk, SqlRisk::Ddl);
        assert_eq!(assess_mysql("ALTER TABLE t ADD c int").risk, SqlRisk::Ddl);
    }

    #[test]
    fn cte_wrapped_write_is_not_read_only() {
        let a = assess_mysql("WITH x AS (DELETE FROM t) SELECT * FROM x");
        assert_eq!(a.risk, SqlRisk::Write);
    }

    #[test]
    fn nested_cte_writes_are_caught_recursively() {
        let a = assess_mysql("WITH x AS (WITH y AS (DELETE FROM t) SELECT * FROM y) SELECT * FROM x");
        assert_eq!(a.risk, SqlRisk::Write);
    }

    #[test]
    fn subquery_hidden_writes_are_caught() {
        // Derived table wrapping a data-modifying CTE (round-2 bypass).
        let a = assess_mysql("SELECT * FROM (WITH y AS (DELETE FROM t) SELECT * FROM y) d");
        assert_eq!(a.risk, SqlRisk::Write, "{a:?}");
        // Expression subquery containing a derived-table write.
        let b = assess_mysql(
            "SELECT (WITH y AS (DELETE FROM t) SELECT COUNT(*) FROM y) AS n",
        );
        assert_eq!(b.risk, SqlRisk::Write, "{b:?}");
        // PG data-modifying CTE behind a derived table.
        let c = assess(
            "SELECT * FROM (WITH y AS (DELETE FROM t RETURNING *) SELECT * FROM y) d",
            SqlDialect::Postgres,
        );
        assert_eq!(c.risk, SqlRisk::Write, "{c:?}");
    }

    #[test]
    fn select_into_outfile_and_table_are_writes() {
        // MySQL SELECT ... INTO OUTFILE (dialect shape the parser rejects →
        // the keyword fallback must catch it).
        let a = assess_mysql("SELECT * FROM users INTO OUTFILE '/tmp/pwn'");
        assert_eq!(a.risk, SqlRisk::Write, "outfile escape via fallback: {a:?}");
        // Parsed shape: SELECT ... INTO new_table (MySQL + Postgres).
        let b = assess("SELECT * INTO copy_of_users FROM users", SqlDialect::Mysql);
        assert_eq!(b.risk, SqlRisk::Write, "SELECT INTO table: {b:?}");
        let c = assess("SELECT * INTO copy_of_users FROM users", SqlDialect::Postgres);
        assert_eq!(c.risk, SqlRisk::Write);
        // Session-variable write via INTO @var.
        let d = assess_mysql("SELECT COUNT(*) INTO @c FROM users");
        assert_eq!(d.risk, SqlRisk::Write);
    }

    #[test]
    fn unbounded_update_delete_is_flagged() {
        assert!(assess_mysql("UPDATE t SET a = 1").unbounded_write);
        assert!(assess_mysql("DELETE FROM t").unbounded_write);
        assert!(!assess_mysql("UPDATE t SET a = 1 WHERE id = 2").unbounded_write);
    }

    #[test]
    fn explain_analyze_executes_and_is_gated() {
        assert!(assess_mysql("EXPLAIN SELECT * FROM t").is_read_only());
        assert_eq!(assess_mysql("EXPLAIN ANALYZE SELECT * FROM t").risk, SqlRisk::Write);
    }

    #[test]
    fn multi_statement_takes_the_worst_risk() {
        let a = assess_mysql("SELECT 1; DROP TABLE t");
        assert_eq!(a.risk, SqlRisk::Ddl);
        assert_eq!(a.statements, 2);
    }

    #[test]
    fn parse_failure_falls_back_conservatively() {
        // Vendor verb that sqlparser's MySQL dialect may not parse → scans as read.
        assert!(assess_mysql("SHOW FULL PROCESSLIST").is_read_only());
        // A quoted 'drop table' must not trip the fallback scan.
        assert!(assess_mysql("SELECT 'drop table t'").is_read_only());
        // Garbage → Unknown, never ReadOnly.
        assert_eq!(assess_mysql("GRANT ALL ON *.* TO u").risk, SqlRisk::Unknown);
    }

    #[test]
    fn escaped_quote_parity_does_not_hide_writes() {
        // A backslash-escaped quote flips naive quote tracking; the scan
        // must still see INTO OUTFILE in the real tail.
        for sql in [
            "SELECT \"a \\\" b\", 1 INTO OUTFILE '/tmp/pwn' FROM t",
            "SELECT 'a', CONCAT('x \\' ', name) INTO OUTFILE '/tmp/pwn' FROM t",
        ] {
            let a = assess_mysql(sql);
            assert!(matches!(a.risk, SqlRisk::Write | SqlRisk::Unknown), "{sql} → {a:?}");
        }
    }

    #[test]
    fn multi_statement_unknown_never_downgrades() {
        // First statement reads; the second mutates server state. The
        // single-statement fallback must not launder it into a read.
        let a = assess_mysql("SELECT 1; SET GLOBAL max_connections = 1");
        assert_eq!(a.risk, SqlRisk::Unknown);
        let b = assess_mysql("SELECT 1; USE production");
        assert_eq!(b.risk, SqlRisk::Unknown);
    }

    #[test]
    fn dialect_specific_syntax_stays_gated() {
        // `PRAGMA` outside its dialect fails to parse → Unknown.
        assert_eq!(
            assess("PRAGMA foreign_keys = ON", SqlDialect::Mysql).risk,
            SqlRisk::Unknown
        );
    }

    #[test]
    fn transaction_control_classifies() {
        assert_eq!(assess_mysql("START TRANSACTION").risk, SqlRisk::Transaction);
        assert_eq!(assess_mysql("COMMIT").risk, SqlRisk::Transaction);
    }

    #[test]
    fn generic_dialect_covers_cross_engine_inputs() {
        // The classifier is fed the run's dialect, but sanity-check that a
        // generic parse path exists for PostgreSQL identifiers too.
        assert!(assess("SELECT * FROM \"users\"", SqlDialect::Postgres).is_read_only());
    }
}

#[cfg(test)]
mod intersect_tests {
    use super::*;

    fn assess_mysql(sql: &str) -> SqlAssessment {
        assess(sql, SqlDialect::Mysql)
    }

    /// Round-3 bypass: INTERSECT binds tighter than UNION, so an
    /// `INTO`-carrying arm sits in a nested set-operation that the
    /// left-spine walk never reaches. `pre_visit_select` must catch it.
    #[test]
    fn intersect_arm_with_into_is_a_write() {
        for dialect in [SqlDialect::Mysql, SqlDialect::Postgres] {
            let a = assess(
                "SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 INTO t2",
                dialect,
            );
            assert_eq!(a.risk, SqlRisk::Write, "{dialect:?}: {a:?}");
            let b = assess(
                "SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 INTO @c",
                dialect,
            );
            assert_eq!(b.risk, SqlRisk::Write, "{dialect:?}: {b:?}");
        }
        // Same shape nested inside a CTE and a derived table.
        let c = assess_mysql(
            "WITH w AS (SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 INTO t2) SELECT * FROM w",
        );
        assert_eq!(c.risk, SqlRisk::Write);
        let d = assess(
            "SELECT * FROM (SELECT 1 UNION SELECT 2 INTERSECT SELECT 3 INTO t2) x",
            SqlDialect::Postgres,
        );
        assert_eq!(d.risk, SqlRisk::Write);
    }
}

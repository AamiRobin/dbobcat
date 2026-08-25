//! Pure transaction-ledger model (Transactions UI Phase 1).
//!
//! No I/O and no driver access: this module only *classifies* statements and
//! keeps the per-connection ledger state that the connection actor feeds.
//! The actor (`manager.rs`) owns the actual `START TRANSACTION` / `COMMIT` /
//! `ROLLBACK` execution; everything here is bookkeeping + classification so
//! it can be unit-tested without a server.
//!
//! Wire shapes mirror `src/types/ipc.ts` (`rename_all = "camelCase"`); the
//! statement classifier is mirrored by `src/lib/tx-classify.ts` on the
//! frontend ("will this implicitly commit?" warning) — keep both in sync
//! (dual-maintenance discipline, like `script.rs` ↔ `sql-splitter.ts`).
//!
//! Known gaps, documented deliberately (out of Phase 1 scope):
//! - MySQL `LOCK TABLES` / `UNLOCK TABLES`: LOCK implicitly commits the open
//!   transaction, but the classifier reports `Other`, so the ledger misses
//!   the implicit commit.
//! - `SET autocommit = 0/1` is classified `Other`; toggling autocommit via
//!   script is therefore not reflected in the mode/phase model.
//! - Admin statements (`FLUSH`, `ANALYZE`, ...): some force implicit commits
//!   on MySQL but are reported as `Other`.

use serde::{Deserialize, Serialize};

use crate::connections::dialect::SqlDialect;

/// Hard cap on one ledger entry's stored SQL text (display only).
pub const ENTRY_SQL_CAP: usize = 500;
/// Hard cap on tracked entries; older statements are evicted first.
pub const MAX_ENTRIES: usize = 200;

/// Transaction mode of one connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TxMode {
    /// Every statement commits immediately (server default).
    #[default]
    Auto,
    /// Statements run inside an explicit transaction opened by Murmeli.
    Manual,
}

/// Ledger phase. `Aborted` models PostgreSQL's "current transaction is
/// aborted" state (25P02), where every further statement fails until a
/// ROLLBACK is issued.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TxPhase {
    #[default]
    Idle,
    Open,
    Aborted,
}

/// Transaction isolation level, applied via
/// `SET SESSION TRANSACTION ISOLATION LEVEL <X>` (MySQL) or
/// `SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL <X>` (PG).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationLevel {
    ReadUncommitted,
    ReadCommitted,
    RepeatableRead,
    Serializable,
}

impl IsolationLevel {
    /// Uppercase SQL keyword used inside the SET statements.
    pub fn sql_keyword(self) -> &'static str {
        match self {
            IsolationLevel::ReadUncommitted => "READ UNCOMMITTED",
            IsolationLevel::ReadCommitted => "READ COMMITTED",
            IsolationLevel::RepeatableRead => "REPEATABLE READ",
            IsolationLevel::Serializable => "SERIALIZABLE",
        }
    }
}

/// Build the session-level isolation statement for one dialect.
pub fn isolation_sql(dialect: SqlDialect, level: IsolationLevel) -> String {
    match dialect {
        SqlDialect::Mysql => format!(
            "SET SESSION TRANSACTION ISOLATION LEVEL {}",
            level.sql_keyword()
        ),
        SqlDialect::Postgres | SqlDialect::Sqlite => format!(
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL {}",
            level.sql_keyword()
        ),
    }
}

/// First-keyword statement class produced by [`classify`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StmtClass {
    Select,
    Dml,
    /// Transaction control: BEGIN / START TRANSACTION / COMMIT / END /
    /// ROLLBACK / SAVEPOINT family.
    Tcl,
    /// Data definition. `implicit_commit` = executing this statement
    /// successfully force-commits an open transaction (MySQL DDL).
    Ddl { implicit_commit: bool },
    Other,
}

impl StmtClass {
    /// Entry label recorded in [`TxEntry::kind`]. Tcl statements are tracked
    /// as `"other"` — the phase column already tells their story.
    pub fn entry_kind(self) -> &'static str {
        match self {
            StmtClass::Select => "select",
            StmtClass::Dml => "dml",
            StmtClass::Ddl { .. } => "ddl",
            StmtClass::Tcl | StmtClass::Other => "other",
        }
    }

    fn from_keyword(keyword: &str) -> Option<Self> {
        Some(match keyword {
            // CTE prologue: overwhelmingly SELECT-shaped (`WITH … INSERT/
            // UPDATE/DELETE` is mis-classified — accepted classifier limit).
            "SELECT" | "WITH" => StmtClass::Select,
            "INSERT" | "UPDATE" | "DELETE" | "REPLACE" | "MERGE" => StmtClass::Dml,
            "BEGIN" | "START" | "COMMIT" | "END" | "ROLLBACK" | "ABORT" | "SAVEPOINT"
            | "RELEASE" => StmtClass::Tcl,
            _ => return None,
        })
    }

    fn ddl_keyword(keyword: &str) -> bool {
        matches!(keyword, "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE")
    }
}

/// One significant (non-comment) keyword of the statement, uppercased.
/// `index` counts from zero across ALL leading comments/whitespace, so
/// `/* c */ CREATE TEMPORARY TABLE …` yields ["CREATE", "TEMPORARY", "TABLE"].
fn keywords(sql: &str, count: usize) -> Vec<String> {
    let bytes = sql.as_bytes();
    let n = bytes.len();
    let mut out = Vec::with_capacity(count);
    let mut i = 0usize;
    while i < n && out.len() < count {
        let b = bytes[i];
        if b.is_ascii_whitespace() {
            i += 1;
        } else if b == b'#' {
            while i < n && bytes[i] != b'\n' {
                i += 1;
            }
        } else if b == b'-' && i + 1 < n && bytes[i + 1] == b'-' {
            let next = bytes.get(i + 2).copied();
            if next.is_none() || next.is_some_and(|c| c.is_ascii_whitespace()) {
                while i < n && bytes[i] != b'\n' {
                    i += 1;
                }
            } else {
                // `--x` is not a comment; consume as code below.
                out.push(read_word(bytes, &mut i));
            }
        } else if b == b'/' && i + 1 < n && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < n && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i = (i + 2).min(n);
        } else if b.is_ascii_alphabetic() || b == b'_' {
            out.push(read_word(bytes, &mut i));
        } else {
            break; // non-word code char — classifier stops here
        }
    }
    out
}

fn read_word(bytes: &[u8], i: &mut usize) -> String {
    let start = *i;
    while *i < bytes.len() && (bytes[*i].is_ascii_alphanumeric() || bytes[*i] == b'_') {
        *i += 1;
    }
    String::from_utf8_lossy(&bytes[start..*i]).to_ascii_uppercase()
}

/// Classify a statement by its first significant keyword(s). Case-,
/// whitespace- and leading-comment tolerant. Comment-only input is `Other`.
///
/// DDL handling:
/// - MySQL/MariaDB: CREATE / ALTER / DROP / RENAME / TRUNCATE implicitly
///   commit an open transaction — EXCEPT `CREATE TEMPORARY TABLE` /
///   `DROP TEMPORARY TABLE` (and `ALTER TEMPORARY`, which does not exist as
///   syntax but would commit if it did; treated as committing on purpose).
/// - PostgreSQL: all DDL is transactional → never an implicit commit.
pub fn classify(dialect: SqlDialect, sql: &str) -> StmtClass {
    let words = keywords(sql, 2);
    let Some(first) = words.first() else {
        return StmtClass::Other;
    };

    if let Some(class) = StmtClass::from_keyword(first) {
        return class;
    }
    if StmtClass::ddl_keyword(first) {
        let temporary = words.get(1).map(|w| w.as_str()) == Some("TEMPORARY");
        let exception = dialect == SqlDialect::Mysql && temporary && first != "ALTER";
        let implicit_commit = dialect == SqlDialect::Mysql && !exception;
        return StmtClass::Ddl { implicit_commit };
    }
    StmtClass::Other
}

/// One executed statement recorded in the ledger.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxEntry {
    /// Source SQL, hard-truncated to [`ENTRY_SQL_CAP`] chars (display only).
    pub sql: String,
    pub rows_affected: u64,
    /// Wall-clock ms since the Unix epoch (the chip renders relative time).
    pub started_ms: u64,
    /// `"select" | "dml" | "ddl" | "other"`.
    pub kind: String,
}

impl TxEntry {
    fn new(sql: &str, rows_affected: u64, started_ms: u64, kind: &'static str) -> Self {
        let mut text = sql.trim().to_string();
        if text.chars().count() > ENTRY_SQL_CAP {
            text = text.chars().take(ENTRY_SQL_CAP).collect::<String>() + "…";
        }
        TxEntry {
            sql: text,
            rows_affected,
            started_ms,
            kind: kind.to_string(),
        }
    }
}

/// Per-connection transaction ledger owned by the connection actor.
#[derive(Debug, Clone, Default)]
pub struct TxLedger {
    pub mode: TxMode,
    pub phase: TxPhase,
    pub isolation: Option<IsolationLevel>,
    pub entries: Vec<TxEntry>,
}

impl TxLedger {
    /// Ledger starting state derived from connect options.
    pub fn new(mode: TxMode, isolation: Option<IsolationLevel>) -> Self {
        TxLedger {
            mode,
            phase: TxPhase::Idle,
            isolation,
            entries: Vec::new(),
        }
    }

    /// Serializable snapshot for IPC events / `tx_get_state`.
    pub fn state(&self) -> super::TxState {
        super::TxState {
            mode: self.mode,
            phase: self.phase,
            isolation: self.isolation,
            dml_count: self.dml_count(),
            entries: self.entries.clone(),
        }
    }

    /// True when the actor should open the explicit transaction before the
    /// next mutating command (manual mode, nothing open yet).
    pub fn needs_begin(&self) -> bool {
        self.mode == TxMode::Manual && self.phase == TxPhase::Idle
    }

    /// Refuse switching back to auto while a transaction still exists.
    /// `Open` obviously; `Aborted` too — the underlying transaction is still
    /// open server-side (PG 25P02) and only ROLLBACK may end it.
    pub fn refuses_switch_to_auto(&self) -> bool {
        self.mode == TxMode::Manual && self.phase != TxPhase::Idle
    }

    /// Number of uncommitted DML statements currently tracked.
    pub fn dml_count(&self) -> u64 {
        self.entries
            .iter()
            .filter(|e| e.kind == "dml")
            .count() as u64
    }

    /// Record an aggregate DML entry for batch operations whose per-row SQL
    /// is not surfaced (grid apply-changes, CSV insert batches). No phase
    /// rules apply — grid edits never commit implicitly.
    pub fn record_dml(&mut self, sql_label: &str, rows_affected: u64) {
        let started_ms = now_ms();
        self.push_entry(TxEntry::new(sql_label, rows_affected, started_ms, "dml"));
    }

    /// Feed one successful statement: append its entry and apply the
    /// Tcl/DD phase rules. Auto-BEGIN issued by the actor itself must NOT go
    /// through here (the actor calls [`TxLedger::begin`] directly).
    pub fn on_statement_ok(&mut self, dialect: SqlDialect, sql: &str, rows_affected: u64) {
        let class = classify(dialect, sql);
        let started_ms = now_ms();
        self.push_entry(TxEntry::new(sql, rows_affected, started_ms, class.entry_kind()));
        self.apply_class(dialect, class, sql);
    }

    /// Feed a failed statement. MySQL keeps transactions usable after a
    /// failed statement; PostgreSQL poisons them (25P02) → phase `Aborted`.
    /// Failed statements are NOT appended to the ledger.
    pub fn on_statement_err(&mut self, dialect: SqlDialect) {
        if dialect == SqlDialect::Postgres && self.phase == TxPhase::Open {
            self.phase = TxPhase::Aborted;
        }
    }

    /// Explicit BEGIN issued by the actor (manual-mode auto-BEGIN or a
    /// script's own BEGIN routed through [`TxLedger::apply_class`]).
    pub fn begin(&mut self) {
        if self.phase == TxPhase::Idle {
            self.phase = TxPhase::Open;
        }
    }

    /// COMMIT/ROLLBACK succeeded on the wire — clear the trail.
    pub fn clear_after_tcl(&mut self) {
        self.phase = TxPhase::Idle;
        self.entries.clear();
    }

    /// A disconnect rolled the open transaction back server-side; keep the
    /// user's mode choice but forget the vanished work.
    pub fn reset_after_reconnect(&mut self) {
        self.phase = TxPhase::Idle;
        self.entries.clear();
    }

    fn push_entry(&mut self, entry: TxEntry) {
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.remove(0);
        }
        self.entries.push(entry);
    }

    fn apply_class(&mut self, dialect: SqlDialect, class: StmtClass, sql: &str) {
        match class {
            StmtClass::Tcl => {
                // BEGIN/START TRANSACTION opens when idle; COMMIT/END and
                // ROLLBACK clear. SAVEPOINT-family leaves the phase alone —
                // nested savepoints are not modelled (no savepoint UI).
                match keywords(sql, 1).first().map(String::as_str) {
                    Some("BEGIN" | "START") => self.begin(),
                    Some("COMMIT" | "END" | "ROLLBACK") => self.clear_after_tcl(),
                    _ => {}
                }
            }
            StmtClass::Ddl {
                implicit_commit: true,
            } if dialect == SqlDialect::Mysql => {
                // MySQL force-committed the open transaction.
                self.clear_after_tcl();
            }
            StmtClass::Ddl { .. } => {}
            _ => {}
        }
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MY: SqlDialect = SqlDialect::Mysql;
    const PG: SqlDialect = SqlDialect::Postgres;

    #[test]
    fn classify_is_case_and_whitespace_tolerant() {
        assert_eq!(classify(MY, "  select 1"), StmtClass::Select);
        assert_eq!(classify(MY, "\n\tINSERT INTO t VALUES (1)"), StmtClass::Dml);
        assert_eq!(classify(PG, "commit"), StmtClass::Tcl);
    }

    #[test]
    fn classify_skips_leading_comments() {
        assert_eq!(
            classify(MY, "-- note\n# hash\n/* block */ SELECT 1"),
            StmtClass::Select
        );
        assert_eq!(
            classify(MY, " /* c */ UPDATE t SET x = 1"),
            StmtClass::Dml
        );
    }

    #[test]
    fn classify_comment_only_and_empty_are_other() {
        assert_eq!(classify(MY, "-- nothing"), StmtClass::Other);
        assert_eq!(classify(MY, "   "), StmtClass::Other);
        assert_eq!(classify(MY, ""), StmtClass::Other);
    }

    #[test]
    fn classify_transaction_control() {
        assert_eq!(classify(MY, "START TRANSACTION"), StmtClass::Tcl);
        assert_eq!(classify(MY, "BEGIN"), StmtClass::Tcl);
        assert_eq!(classify(MY, "BEGIN WORK"), StmtClass::Tcl);
        assert_eq!(classify(PG, "END"), StmtClass::Tcl);
        assert_eq!(classify(PG, "ROLLBACK"), StmtClass::Tcl);
        assert_eq!(classify(PG, "ABORT"), StmtClass::Tcl);
        assert_eq!(classify(MY, "SAVEPOINT sp1"), StmtClass::Tcl);
    }

    #[test]
    fn mysql_ddl_implies_commit() {
        assert_eq!(classify(MY, "CREATE TABLE t (id int)"), StmtClass::Ddl { implicit_commit: true });
        assert_eq!(classify(MY, "alter table t add c int"), StmtClass::Ddl { implicit_commit: true });
        assert_eq!(classify(MY, "DROP INDEX ix ON t"), StmtClass::Ddl { implicit_commit: true });
        assert_eq!(classify(MY, "RENAME TABLE a TO b"), StmtClass::Ddl { implicit_commit: true });
        assert_eq!(classify(MY, "truncate table t"), StmtClass::Ddl { implicit_commit: true });
    }

    #[test]
    fn mysql_temporary_exceptions() {
        assert_eq!(
            classify(MY, "CREATE TEMPORARY TABLE t (id int)"),
            StmtClass::Ddl { implicit_commit: false }
        );
        assert_eq!(
            classify(MY, "DROP TEMPORARY TABLE IF EXISTS t"),
            StmtClass::Ddl { implicit_commit: false }
        );
        // ALTER TEMPORARY does not exist as valid syntax; if it appears it is
        // treated as committing like any other ALTER.
        assert_eq!(
            classify(MY, "ALTER TEMPORARY TABLE t ADD x int"),
            StmtClass::Ddl { implicit_commit: true }
        );
    }

    #[test]
    fn postgres_ddl_never_commits_implicitly() {
        assert_eq!(classify(PG, "CREATE TABLE t (id int)"), StmtClass::Ddl { implicit_commit: false });
        assert_eq!(classify(PG, "CREATE TEMPORARY TABLE t (id int)"), StmtClass::Ddl { implicit_commit: false });
        assert_eq!(classify(PG, "TRUNCATE t"), StmtClass::Ddl { implicit_commit: false });
        assert_eq!(classify(PG, "drop table t"), StmtClass::Ddl { implicit_commit: false });
    }

    #[test]
    fn misc_statements_classify_other() {
        assert_eq!(classify(MY, "SET autocommit = 0"), StmtClass::Other);
        assert_eq!(classify(MY, "SHOW TABLES"), StmtClass::Other);
        assert_eq!(classify(MY, "USE shop"), StmtClass::Other);
        assert_eq!(classify(MY, "LOCK TABLES t WRITE"), StmtClass::Other);
        assert_eq!(classify(MY, "CALL do_stuff()"), StmtClass::Other);
    }

    #[test]
    fn with_leading_cte_counts_as_select() {
        assert_eq!(classify(MY, "WITH x AS (SELECT 1) SELECT * FROM x"), StmtClass::Select);
    }

    #[test]
    fn entry_kind_mapping() {
        assert_eq!(StmtClass::Select.entry_kind(), "select");
        assert_eq!(StmtClass::Dml.entry_kind(), "dml");
        assert_eq!(StmtClass::Ddl { implicit_commit: false }.entry_kind(), "ddl");
        assert_eq!(StmtClass::Tcl.entry_kind(), "other");
        assert_eq!(StmtClass::Other.entry_kind(), "other");
    }

    #[test]
    fn isolation_sql_mysql_shape() {
        assert_eq!(
            isolation_sql(MY, IsolationLevel::RepeatableRead),
            "SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ"
        );
    }

    #[test]
    fn isolation_sql_postgres_shape() {
        assert_eq!(
            isolation_sql(PG, IsolationLevel::Serializable),
            "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE"
        );
    }

    #[test]
    fn ledger_begin_commit_roundtrip() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        assert!(led.needs_begin());
        led.begin();
        assert_eq!(led.phase, TxPhase::Open);
        assert!(!led.needs_begin());
        led.on_statement_ok(MY, "UPDATE t SET x = 1", 3);
        assert_eq!(led.dml_count(), 1);
        led.on_statement_ok(MY, "COMMIT", 0);
        assert_eq!(led.phase, TxPhase::Idle);
        assert!(led.entries.is_empty());
        assert!(led.dml_count() == 0);
    }

    #[test]
    fn ledger_script_begin_opens_and_rollback_clears() {
        let mut led = TxLedger::new(TxMode::Auto, None);
        led.on_statement_ok(MY, "BEGIN", 0);
        assert_eq!(led.phase, TxPhase::Open);
        led.on_statement_ok(MY, "INSERT INTO t VALUES (1)", 1);
        led.on_statement_ok(MY, "ROLLBACK", 0);
        assert_eq!(led.phase, TxPhase::Idle);
        assert!(led.entries.is_empty());
    }

    #[test]
    fn ledger_mysql_ddl_success_clears_open_tx() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        led.on_statement_ok(MY, "UPDATE t SET x = 1", 1);
        led.on_statement_ok(MY, "CREATE TABLE t2 (id int)", 0);
        assert_eq!(led.phase, TxPhase::Idle, "implicit commit clears the tx");
        assert!(led.entries.is_empty());
    }

    #[test]
    fn ledger_pg_ddl_keeps_open_tx() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        led.on_statement_ok(PG, "CREATE TABLE t2 (id int)", 0);
        assert_eq!(led.phase, TxPhase::Open, "PG DDL is transactional");
        assert!(!led.entries.is_empty());
    }

    #[test]
    fn ledger_pg_error_aborts_but_mysql_error_does_not() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        led.on_statement_err(PG);
        assert_eq!(led.phase, TxPhase::Aborted);

        let mut led_my = TxLedger::new(TxMode::Manual, None);
        led_my.begin();
        led_my.on_statement_err(MY);
        assert_eq!(led_my.phase, TxPhase::Open);
    }

    #[test]
    fn ledger_error_outside_tx_is_inert() {
        let mut led = TxLedger::new(TxMode::Auto, None);
        led.on_statement_err(PG);
        assert_eq!(led.phase, TxPhase::Idle);
    }

    #[test]
    fn ledger_entries_cap_at_max() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        for i in 0..(MAX_ENTRIES + 50) {
            led.on_statement_ok(MY, &format!("SELECT {i}"), 0);
        }
        assert_eq!(led.entries.len(), MAX_ENTRIES);
        // Oldest entries were evicted first.
        assert_eq!(led.entries[0].kind, "select");
        assert!(led.entries.last().unwrap().sql.contains("249"));
    }

    #[test]
    fn ledger_entry_sql_truncated_to_cap() {
        let long = format!("SELECT '{})", "x".repeat(ENTRY_SQL_CAP * 2));
        let mut led = TxLedger::default();
        led.begin();
        led.on_statement_ok(MY, &long, 0);
        let stored = &led.entries[0].sql;
        assert!(stored.chars().count() <= ENTRY_SQL_CAP + 1);
        assert!(stored.ends_with('…'));
    }

    #[test]
    fn ledger_mode_switch_refusal() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        assert!(!led.refuses_switch_to_auto(), "idle manual may switch");
        led.begin();
        assert!(led.refuses_switch_to_auto());
        led.phase = TxPhase::Aborted;
        assert!(led.refuses_switch_to_auto(), "aborted still holds the tx");

        let auto = TxLedger::new(TxMode::Auto, None);
        assert!(!auto.refuses_switch_to_auto());
    }

    #[test]
    fn ledger_reset_after_reconnect_keeps_mode() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        led.on_statement_ok(MY, "DELETE FROM t", 7);
        led.reset_after_reconnect();
        assert_eq!(led.mode, TxMode::Manual);
        assert_eq!(led.phase, TxPhase::Idle);
        assert!(led.entries.is_empty());
    }

    #[test]
    fn ledger_state_snapshot_carries_dto_fields() {
        let mut led = TxLedger::new(TxMode::Manual, Some(IsolationLevel::ReadCommitted));
        led.begin();
        led.on_statement_ok(MY, "UPDATE t SET x = 1", 4);
        let snap = led.state();
        assert_eq!(snap.mode, TxMode::Manual);
        assert_eq!(snap.phase, TxPhase::Open);
        assert_eq!(snap.isolation, Some(IsolationLevel::ReadCommitted));
        assert_eq!(snap.dml_count, 1);
        assert_eq!(snap.entries.len(), 1);
        assert_eq!(snap.entries[0].rows_affected, 4);

        // camelCase wire names round-trip through serde_json.
        let json = serde_json::to_value(&snap).unwrap();
        assert!(json.get("dmlCount").is_some());
        assert!(json["entries"][0].get("rowsAffected").is_some());
        assert_eq!(json["mode"], "manual");
        assert_eq!(json["isolation"], "read_committed");
    }

    #[test]
    fn savepoint_does_not_close_the_transaction() {
        let mut led = TxLedger::new(TxMode::Manual, None);
        led.begin();
        led.on_statement_ok(PG, "SAVEPOINT sp1", 0);
        led.on_statement_ok(PG, "RELEASE SAVEPOINT sp1", 0);
        assert_eq!(led.phase, TxPhase::Open);
    }
}

//! MCP access policy (Phase 13).
//!
//! The single authoritative gate for everything the MCP server exposes.
//! Fail-closed by construction: an absent, unreadable, or malformed policy
//! means *nothing* is exposed, and there is deliberately no CLI/env override
//! that can widen it (flags may only narrow — see [`McpPolicy::load`]).
//!
//! The policy lives in the app's `settings.json` under the `"mcp"` key so
//! the GUI (Settings → Agent access) and the headless server share one
//! source of truth. It is re-read on every request: edits apply without
//! restarting MCP clients.
//!
//! ```json
//! { "mcp": { "enabled": true, "allowed": ["<session-id>", "..."] } }
//! ```

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

pub const SETTINGS_FILE: &str = "settings.json";
pub const SETTINGS_KEY: &str = "mcp";

/// Who may use the MCP server, and with which sessions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPolicy {
    /// Master switch. `false` (or absence) = server answers `initialize`
    /// but every tool call is refused.
    #[serde(default)]
    pub enabled: bool,
    /// Session ids the agent may touch. Names are deliberately NOT allowed
    /// here: ids are stable, names are not.
    #[serde(default)]
    pub allowed: Vec<String>,
}

impl McpPolicy {
    /// Strictly-closed default.
    pub fn closed() -> Self {
        Self::default()
    }

    /// Load the policy from `data_dir/settings.json`. Any problem — missing
    /// file, bad JSON, wrong shape — yields the closed policy. Never errors.
    pub fn load(data_dir: &Path) -> Self {
        (|| -> Result<Self> {
            let raw = std::fs::read(data_dir.join(SETTINGS_FILE))
                .map_err(|e| AppError::Config(e.to_string()))?;
            let doc: serde_json::Value = serde_json::from_slice(&raw)
                .map_err(|e| AppError::Config(e.to_string()))?;
            let value = doc.get(SETTINGS_KEY).cloned().unwrap_or(serde_json::Value::Null);
            if value.is_null() {
                return Ok(Self::closed());
            }
            serde_json::from_value(value).map_err(|e| AppError::Config(e.to_string()))
        })()
        .unwrap_or_else(|_| Self::closed())
    }

    /// Is `session_id` callable right now?
    pub fn permits(&self, session_id: &str) -> bool {
        self.enabled && self.allowed.iter().any(|id| id == session_id)
    }
}

/// Maximum accepted SQL length — a runaway prompt should not become a
/// runaway statement.
pub const MAX_SQL_CHARS: usize = 100_000;

/// Verdict of the read-only classifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlVerdict {
    /// Safe to run under the read-only policy.
    ReadOnly,
    /// Refused, with a reason safe to show the agent.
    Rejected(String),
}

/// Classify one SQL string for read-only execution.
///
/// Belt-and-braces over the connection-level guarantees: the statement must
/// start with a read-only keyword, contain no data-modifying keyword
/// anywhere outside quotes/comments (catches `WITH x AS (DELETE …)` CTEs
/// and `SELECT … INTO OUTFILE`), and be a single statement (no stacked
/// `;` payloads). Unknown shapes are rejected, never guessed.
pub fn inspect_read_only(sql: &str) -> SqlVerdict {
    let sql = sql.trim();
    if sql.is_empty() {
        return SqlVerdict::Rejected("statement is empty".into());
    }
    if sql.chars().count() > MAX_SQL_CHARS {
        return SqlVerdict::Rejected(format!(
            "statement exceeds the {MAX_SQL_CHARS} character limit"
        ));
    }

    let scan = scan_outside_literals(sql);
    if scan.multiple_statements {
        return SqlVerdict::Rejected(
            "only a single statement is allowed (no ';' separated scripts)".into(),
        );
    }

    let first = scan.first_word.to_ascii_lowercase();
    if first.is_empty() {
        return SqlVerdict::Rejected("statement has no readable keyword".into());
    }
    const READ_KEYWORDS: [&str; 6] = ["select", "with", "show", "explain", "describe", "desc"];
    if !READ_KEYWORDS.contains(&first.as_str()) {
        return SqlVerdict::Rejected(format!(
            "statement must start with SELECT, WITH, SHOW, EXPLAIN, or DESCRIBE (got {first:?})"
        ));
    }

    // Data-modifying or side-effecting keywords anywhere outside literals.
    // This is what stops `WITH x AS (DELETE FROM t …) SELECT …`,
    // `SELECT … INTO OUTFILE`, locking reads, and `EXPLAIN ANALYZE`
    // (which actually executes the statement). `replace` is exempt when
    // used as a function call — MySQL's `REPLACE(…)` string function.
    const BLOCKED: [&str; 17] = [
        "insert", "update", "delete", "merge", "replace", "drop", "alter", "create", "truncate",
        "rename", "grant", "revoke", "flush", "kill", "shutdown", "into", "analyze",
    ];
    for word in &scan.words {
        let lower = word.text.to_ascii_lowercase();
        if !BLOCKED.contains(&lower.as_str()) {
            continue;
        }
        if lower == "replace" && word.call_like {
            continue; // REPLACE(…) the string function, not the statement
        }
        return SqlVerdict::Rejected(format!(
            "read-only policy forbids the keyword {lower:?}"
        ));
    }

    SqlVerdict::ReadOnly
}

/// Scan SQL with quote/comment awareness.
struct Scan {
    /// First bare word of the statement (whitespace-trimmed prefix).
    first_word: String,
    /// Every bare word outside string literals and comments.
    words: Vec<Word>,
    /// `;` found outside literals anywhere except the final character.
    multiple_statements: bool,
}

/// One bare word plus whether it was immediately followed by `(` —
/// call syntax, which distinguishes the `REPLACE(…)` function from the
/// `REPLACE` statement.
struct Word {
    text: String,
    call_like: bool,
}

/// Quote-aware lexical pass. Handles `'...'` (with `''` escapes),
/// `"..."`, backticks, `-- line` and `/* block */` comments.
fn scan_outside_literals(sql: &str) -> Scan {
    let chars: Vec<char> = sql.chars().collect();
    let mut words: Vec<Word> = Vec::new();
    let mut current = String::new();
    let mut multiple = false;

    fn flush(current: &mut String, words: &mut Vec<Word>) {
        if !current.is_empty() {
            words.push(Word { text: std::mem::take(current), call_like: false });
        }
    }

    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\'' => {
                // Single-quoted string with '' escaping.
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                flush(&mut current, &mut words);
            }
            '"' | '`' => {
                let quote = c;
                i += 1;
                while i < chars.len() && chars[i] != quote {
                    i += 1;
                }
                flush(&mut current, &mut words);
            }
            '-' if chars.get(i + 1) == Some(&'-') => {
                flush(&mut current, &mut words);
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                flush(&mut current, &mut words);
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 1; // skip the '*' of the closer (the loop's tail adds 1)
            }
            ';' => {
                flush(&mut current, &mut words);
                let rest: String = chars[i + 1..].iter().collect();
                if !rest.trim().is_empty() {
                    multiple = true;
                }
            }
            '(' => {
                flush(&mut current, &mut words);
                if let Some(last) = words.last_mut() {
                    last.call_like = true;
                }
            }
            c if c.is_whitespace() => {
                flush(&mut current, &mut words);
            }
            c if c.is_alphanumeric() || c == '_' => {
                current.push(c);
            }
            _ => {
                flush(&mut current, &mut words);
            }
        }
        i += 1;
    }
    flush(&mut current, &mut words);

    let first_word = words.first().map(|w| w.text.clone()).unwrap_or_default();
    Scan { first_word, words, multiple_statements: multiple }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejected(sql: &str) -> String {
        match inspect_read_only(sql) {
            SqlVerdict::Rejected(reason) => reason,
            SqlVerdict::ReadOnly => panic!("expected rejection for {sql}"),
        }
    }

    fn ok(sql: &str) {
        assert_eq!(inspect_read_only(sql), SqlVerdict::ReadOnly, "{sql}");
    }

    #[test]
    fn plain_reads_pass() {
        ok("SELECT * FROM users");
        ok("  select id, name from t where x > 1  ");
        ok("WITH recent AS (SELECT * FROM t) SELECT * FROM recent");
        ok("SHOW TABLES");
        ok("EXPLAIN SELECT * FROM t");
        ok("DESCRIBE users");
        ok("SELECT * FROM t;");
        ok("select * from t -- trailing comment with DELETE inside\n");
        ok("SELECT ';' ; ");
        ok("/* delete from t */ SELECT 1");
        ok("SELECT REPLACE(name, 'delete', 'x') FROM t");
        ok("SELECT 'insert into t' AS note");
    }

    #[test]
    fn writes_and_ddl_rejected() {
        assert!(rejected("DELETE FROM users").contains("must start with"));
        assert!(rejected("INSERT INTO t VALUES (1)").contains("must start with"));
        assert!(rejected("UPDATE t SET x = 1").contains("must start with"));
        assert!(rejected("TRUNCATE TABLE t").contains("must start with"));
        assert!(rejected("CREATE TABLE t (id int)").contains("must start with"));
    }

    #[test]
    fn smuggled_writes_rejected() {
        // Data-modifying CTE — the classic first-keyword bypass.
        assert!(rejected("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x").contains("forbids"));
        // SELECT ... INTO OUTFILE writes server-side files.
        assert!(rejected("SELECT * FROM t INTO OUTFILE '/tmp/x'").contains("forbids"));
        // Locking read.
        assert!(rejected("SELECT * FROM t FOR UPDATE").contains("forbids"));
        // EXPLAIN ANALYZE actually executes the statement.
        assert!(rejected("EXPLAIN ANALYZE SELECT * FROM t").contains("forbids"));
    }

    #[test]
    fn stacked_statements_rejected() {
        assert!(rejected("SELECT 1; DELETE FROM users").contains("single statement"));
        assert!(rejected("SELECT 1; SELECT 2").contains("single statement"));
        ok("SELECT ';'"); // semicolon inside a string literal is fine
        ok("SELECT 1;"); // single trailing separator is fine
    }

    #[test]
    fn empty_and_huge_rejected() {
        assert!(rejected("").contains("empty"));
        assert!(rejected("   ").contains("empty"));
        let huge = format!("SELECT '{}'", "x".repeat(MAX_SQL_CHARS + 1));
        assert!(rejected(&huge).contains("character limit"));
    }

    #[test]
    fn quoted_identifiers_are_scanned_as_words() {
        // A quoted identifier named "delete" is hidden from the scanner —
        // and thereby allowed; that is the correct fail-open direction for
        // identifiers (the statement is still a SELECT).
        ok("SELECT `delete` FROM t");
    }

    #[test]
    fn policy_permits_only_listed_sessions_when_enabled() {
        let mut p = McpPolicy::closed();
        assert!(!p.permits("s1"));
        p.enabled = true;
        assert!(!p.permits("s1"), "enabled without allowlist still closed");
        p.allowed = vec!["s1".into()];
        assert!(p.permits("s1"));
        assert!(!p.permits("s2"));
    }

    #[test]
    fn policy_load_fails_closed() {
        let dir = std::env::temp_dir().join(format!("dbobcat-mcp-policy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Missing file.
        assert!(!McpPolicy::load(&dir).enabled);
        // Garbage file.
        std::fs::write(dir.join(SETTINGS_FILE), b"{ not json").unwrap();
        assert!(!McpPolicy::load(&dir).enabled);
        // Well-formed but wrong shape.
        std::fs::write(dir.join(SETTINGS_FILE), b"{\"mcp\": 42}").unwrap();
        assert!(!McpPolicy::load(&dir).enabled);
        // Valid policy round-trips.
        std::fs::write(
            dir.join(SETTINGS_FILE),
            br#"{"mcp": {"enabled": true, "allowed": ["a"]}}"#,
        )
        .unwrap();
        let p = McpPolicy::load(&dir);
        assert!(p.permits("a"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

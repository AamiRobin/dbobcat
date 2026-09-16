//! Pure server-administration logic (Phase 7) — no I/O, fully unit-tested.
//!
//! Contents:
//! - [`sql_literal`]: strict single-quote literal escaping for the few
//!   statements where bind parameters are impossible (`CREATE USER ... BY`,
//!   `GRANT`, find-text predicates streamed through `stream_query_rows`).
//!   This is the one documented exception to the "values bind-only" rule;
//!   every use site must route through here.
//! - [`validate_privileges`]: allowlist check before privilege names may
//!   appear in SQL text.
//! - [`parse_grant_statements`]: tolerant `SHOW GRANTS` parser (MySQL 5.x
//!   and 8.x spellings, quoted identifiers, proxy grants skipped).
//! - [`build_like_pattern`] / [`text_matches`]: shared search semantics so
//!   the SQL predicate and the Rust-side matched-column detection agree.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use crate::connections::dialect::SqlDialect;
use crate::connections::{FindMode, GrantRequest, GrantScope};
use crate::error::{AppError, Result};

// ---------------------------------------------------------------------------
// Literal escaping
// ---------------------------------------------------------------------------

/// Escape `value` as a single-quoted string literal for `dialect`, assuming
/// the server's default literal parsing. Prefer [`sql_literal_ex`] wherever
/// the MySQL session's `NO_BACKSLASH_ESCAPES` state is known.
pub fn sql_literal(dialect: SqlDialect, value: &str) -> String {
    sql_literal_ex(dialect, value, true)
}

/// Escape `value` as a single-quoted string literal for `dialect` under a
/// known `backslash_escapes` posture.
///
/// MySQL/MariaDB treat backslash as an escape character inside strings by
/// default, so backslashes are doubled as well; a session running
/// `NO_BACKSLASH_ESCAPES` must skip the doubling. PostgreSQL literals are
/// spelled as escape strings (`E'…'`) so backslash doubling is correct
/// whether `standard_conforming_strings` is on or off. SQLite never
/// processes backslashes and has no escape-string syntax. The result is
/// safe to embed in DDL/GRANT statements and streamed SELECT predicates.
pub fn sql_literal_ex(dialect: SqlDialect, value: &str, backslash_escapes: bool) -> String {
    let doubled = value.replace('\\', "\\\\").replace('\'', "''");
    match dialect {
        SqlDialect::Mysql if backslash_escapes => format!("'{doubled}'"),
        SqlDialect::Mysql => format!("'{}'", value.replace('\'', "''")),
        // E'' processes backslash escapes regardless of the server's
        // standard_conforming_strings setting, making one spelling correct
        // for both.
        SqlDialect::Postgres => format!("E'{doubled}'"),
        SqlDialect::Sqlite => format!("'{}'", value.replace('\'', "''")),
    }
}

/// The SQL clause declaring [`LIKE_ESCAPE`] — append to every LIKE whose
/// pattern was built by [`escape_like_wildcards`].
pub const LIKE_ESCAPE_CLAUSE: &str = " ESCAPE '!'";

/// The escape character for LIKE patterns this app builds. Backslash is the
/// traditional choice but drags string-literal parsing into it — MySQL
/// spells it `'\\'` unless the session runs `NO_BACKSLASH_ESCAPES`,
/// PostgreSQL's `'\'` depends on `standard_conforming_strings`. `!` is a
/// plain one-character literal in every engine and mode, and patterns
/// escaped with it contain no backslashes at all.
pub const LIKE_ESCAPE: char = '!';

/// Escape LIKE wildcards (`%`, `_`) and the escape character itself so the
/// user's text matches literally. Every pattern built from this must carry
/// [`LIKE_ESCAPE_CLAUSE`]; a bare backslash escape is not portable across
/// engines or sql_modes.
pub fn escape_like_wildcards(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c == '%' || c == '_' || c == LIKE_ESCAPE {
            out.push(LIKE_ESCAPE);
        }
        out.push(c);
    }
    out
}

/// Build the LIKE operand for a find-text mode around the raw user text.
/// Regex mode returns `None` — it never goes through LIKE.
pub fn build_like_pattern(mode: FindMode, search: &str) -> Option<String> {
    let escaped = escape_like_wildcards(search);
    match mode {
        FindMode::Contains => Some(format!("%{escaped}%")),
        FindMode::Prefix => Some(format!("{escaped}%")),
        // Whole-field equality expressed through LIKE keeps the same
        // escape/case handling as the other modes.
        FindMode::Whole => Some(escaped),
        FindMode::Regex => None,
    }
}

/// Rust-side mirror of the SQL predicate: does `haystack` match under the
/// given mode? Used to pick which column of a row produced the hit (the
/// WHERE clause remains the authority for row inclusion).
///
/// Regex patterns are memoized by `(pattern, case-insensitive)` so a scan
/// compiles the user's expression once, not once per candidate cell.
/// Invalid patterns fall back to "no match" here (the pipeline already
/// rejected them up front via [`compile_regex`]).
pub fn text_matches(mode: FindMode, haystack: &str, needle: &str, case_sensitive: bool) -> bool {
    let fold = |s: &str| if case_sensitive { s.to_string() } else { s.to_lowercase() };

    match mode {
        FindMode::Contains => fold(haystack).contains(&fold(needle)),
        FindMode::Prefix => fold(haystack).starts_with(&fold(needle)),
        FindMode::Whole => fold(haystack) == fold(needle),
        FindMode::Regex => cached_regex(needle, case_sensitive)
            .map(|re| re.is_match(haystack))
            .unwrap_or(false),
    }
}

/// Memoized compiled user regexes keyed by `(pattern, case-insensitive)`.
type RegexCache = HashMap<(String, bool), Option<regex::Regex>>;
static REGEX_CACHE: LazyLock<Mutex<RegexCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cached_regex(pattern: &str, case_sensitive: bool) -> Option<regex::Regex> {
    let mut cache = REGEX_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .entry((pattern.to_string(), !case_sensitive))
        .or_insert_with(|| compile_regex(pattern, case_sensitive).ok())
        .clone()
}

/// Compile a user regex honouring the case flag; invalid patterns become
/// friendly errors before any table is scanned.
pub fn compile_regex(pattern: &str, case_sensitive: bool) -> Result<regex::Regex> {
    if case_sensitive {
        regex::Regex::new(pattern)
    } else {
        regex::RegexBuilder::new(pattern)
            .case_insensitive(true)
            .build()
    }
    .map_err(|e| AppError::Db(format!("invalid regular expression: {e}")))
}

// ---------------------------------------------------------------------------
// Privilege validation
// ---------------------------------------------------------------------------

/// Privileges MySQL/MariaDB accept at global/table level (+ role verbs).
const MYSQL_PRIVILEGES: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "CREATE",
    "DROP",
    "RELOAD",
    "SHUTDOWN",
    "PROCESS",
    "FILE",
    "REFERENCES",
    "INDEX",
    "ALTER",
    "SHOW DATABASES",
    "SUPER",
    "CREATE TEMPORARY TABLES",
    "LOCK TABLES",
    "EXECUTE",
    "REPLICATION SLAVE",
    "REPLICATION CLIENT",
    "CREATE VIEW",
    "SHOW VIEW",
    "CREATE ROUTINE",
    "ALTER ROUTINE",
    "CREATE USER",
    "EVENT",
    "TRIGGER",
    "CREATE TABLESPACE",
    "CREATE ROLE",
    "DROP ROLE",
    "ALL PRIVILEGES",
    "ALL",
    "USAGE",
    "PROXY",
];

/// Privileges PostgreSQL accepts on tables/schemas/databases.
const POSTGRES_PRIVILEGES: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "CREATE",
    "CONNECT",
    "TEMPORARY",
    "TEMP",
    "EXECUTE",
    "USAGE",
    "SET",
    "ALTER SYSTEM",
    "ALL PRIVILEGES",
];

/// Reject anything outside the engine's known privilege vocabulary. Every
/// token must match exactly (case-insensitive) after trimming; this blocks
/// statement smuggling through crafted "privilege" strings because no
/// punctuation or whitespace survives validation.
pub fn validate_privileges(dialect: SqlDialect, privileges: &[String]) -> Result<()> {
    if privileges.is_empty() {
        return Err(AppError::Db("no privileges requested".into()));
    }
    let allowlist: &[&str] = match dialect {
        SqlDialect::Mysql => MYSQL_PRIVILEGES,
        SqlDialect::Postgres | SqlDialect::Sqlite => POSTGRES_PRIVILEGES,
    };
    for priv_raw in privileges {
        let name = priv_raw.trim();
        if name.is_empty() {
            return Err(AppError::Db("empty privilege name".into()));
        }
        let known = allowlist.iter().any(|p| p.eq_ignore_ascii_case(name));
        if !known {
            return Err(AppError::Db(format!(
                "unknown privilege \"{name}\" for {}",
                dialect.wire_name()
            )));
        }
    }
    Ok(())
}

/// Uppercased, trimmed privilege list ready for statement building.
pub fn normalized_privileges(privileges: &[String]) -> Vec<String> {
    privileges.iter().map(|p| p.trim().to_ascii_uppercase()).collect()
}

// ---------------------------------------------------------------------------
// SHOW GRANTS parsing
// ---------------------------------------------------------------------------

/// Split a comma list on top-level commas only (parentheses and quotes
/// protected), returning trimmed parts.
fn split_top_level(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut current = String::new();
    for c in text.chars() {
        match quote {
            Some(q) => {
                current.push(c);
                if c == q {
                    // Doubled quotes stay inside the literal.
                    quote = None;
                }
            }
            None => match c {
                '\'' | '`' | '"' => {
                    quote = Some(c);
                    current.push(c);
                }
                '(' => {
                    depth += 1;
                    current.push(c);
                }
                ')' => {
                    depth = depth.saturating_sub(1);
                    current.push(c);
                }
                ',' if depth == 0 => parts.push(std::mem::take(&mut current).trim().to_string()),
                _ => current.push(c),
            },
        }
    }
    if !current.trim().is_empty() {
        parts.push(current.trim().to_string());
    }
    parts
}

/// Strip one balanced trailing `(col, col)` column list from a privilege
/// token (`SELECT (id, name)` → `SELECT`). Column-level grants collapse to
/// the table-level privilege in the scope view.
fn strip_column_list(token: &str) -> &str {
    let trimmed = token.trim();
    if let Some(open) = trimmed.find('(') {
        if trimmed.ends_with(')') && open > 0 {
            return trimmed[..open].trim();
        }
    }
    trimmed
}

/// Parse `SHOW GRANTS FOR ...` output into structured scopes. Tolerant by
/// design: unrecognized shapes (proxy grants, role memberships, partial
/// revokes) contribute their raw statement but no bogus scope.
pub fn parse_grant_statements(statements: &[String]) -> Vec<GrantScope> {
    let mut scopes = Vec::new();
    for stmt in statements {
        let Some((grant_part, _)) = split_on_keyword(stmt, " TO ") else {
            continue; // not a GRANT ... TO statement (e.g. proxy target form)
        };
        let grant_part = grant_part.trim();
        let Some(rest) = grant_part.strip_prefix("GRANT ").map(str::trim) else {
            continue;
        };

        let grant_option = contains_grant_option(stmt);

        // Separate the privilege list from the ON clause. Column lists make
        // naive splitting dangerous → always split via split_top_level-aware
        // scan for the ON keyword outside parentheses/quotes.
        let Some((priv_text, on_text)) = split_on_keyword_ci(rest, " ON ") else {
            continue;
        };

        let (db_opt, table_opt) = parse_on_target(on_text.trim());
        // Proxy grants / unparseable targets contribute no scope.
        let Some(db) = db_opt else {
            continue;
        };

        for token in split_top_level(priv_text) {
            let privilege = strip_column_list(&token).trim().to_ascii_uppercase();
            if privilege.is_empty() {
                continue;
            }
            scopes.push(GrantScope {
                privilege,
                db: Some(db.clone()),
                table: table_opt.clone(),
                grant_option,
            });
        }
    }
    scopes
}

/// True when the statement carries `WITH GRANT OPTION` (or MariaDB's
/// equivalent spelling) outside any quotes.
fn contains_grant_option(stmt: &str) -> bool {
    let lower = stmt.to_ascii_lowercase();
    lower.contains("with grant option") || lower.contains("with admin option")
}

/// Split at the first top-level occurrence of `keyword` (case-insensitive,
/// surrounded by whitespace). Returns `(before, after)` without the keyword.
fn split_on_keyword_ci<'a>(text: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    let bytes = text.as_bytes();
    let kw = keyword.to_ascii_lowercase();
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'`' | b'"' => skip_quoted(text, &mut i),
            b'(' => skip_parens(text, &mut i),
            _ => {
                let tail = text[i..].to_ascii_lowercase();
                if tail.starts_with(&kw) {
                    let before = &text[..i];
                    let after = &text[i + kw.len()..];
                    // Keyword must be bracketed by spaces (already included).
                    return Some((before, after));
                }
                i += 1;
            }
        }
    }
    None
}

/// Alias kept for readability at the GRANT/TO boundary (TO is upper-case
/// insensitive too).
fn split_on_keyword<'a>(text: &'a str, keyword: &str) -> Option<(&'a str, &'a str)> {
    split_on_keyword_ci(text, keyword)
}

fn skip_quoted(text: &str, i: &mut usize) {
    let quote = text.as_bytes()[*i];
    *i += 1;
    while *i < text.len() {
        let c = text.as_bytes()[*i];
        *i += 1;
        if c == b'\\' && quote == b'\'' && *i < text.len() {
            *i += 1; // MySQL backslash escape inside literals
            continue;
        }
        if c == quote {
            if *i < text.len() && text.as_bytes()[*i] == quote {
                *i += 1; // doubled quote stays inside
                continue;
            }
            return;
        }
    }
}

fn skip_parens(text: &str, i: &mut usize) {
    let mut depth = 0usize;
    while *i < text.len() {
        match text.as_bytes()[*i] {
            b'\'' | b'`' | b'"' => skip_quoted(text, i),
            b'(' => {
                depth += 1;
                *i += 1;
            }
            b')' => {
                depth = depth.saturating_sub(1);
                *i += 1;
                if depth == 0 {
                    return;
                }
            }
            _ => *i += 1,
        }
    }
}

/// Parse the target after `ON`: `` `db`.`tbl` `` / `db.tbl` / `*.*` /
/// `*` / `` `db`.*`` / `[TABLE] db.tbl` (MySQL 8 prefixes TABLE/FUNCTION/
/// PROCEDURE). Returns `(Some(db), Option(table))`; `None` when the target
/// cannot be represented as db/table (proxy grants, bare users).
fn parse_on_target(target: &str) -> (Option<String>, Option<String>) {
    let mut t = target.trim();
    // MySQL 8 object-type prefixes (case-insensitive, ASCII-safe).
    for prefix in ["TABLE", "FUNCTION", "PROCEDURE"] {
        if t.is_char_boundary(prefix.len())
            && t.len() >= prefix.len()
            && t[..prefix.len()].eq_ignore_ascii_case(prefix)
        {
            t = t[prefix.len()..].trim_start();
            break;
        }
    }

    // Proxy grants look like ON 'user'@'host' — not a db/table scope.
    if t.starts_with('\'') {
        return (None, None);
    }

    let parts = split_qualified(t);
    match parts.len() {
        1 => {
            let part = unquote_ident(&parts[0]);
            if part == "*" {
                (Some("*".into()), None)
            } else {
                // Bare identifier: ambiguous (schema vs table); treat as db.
                (Some(part), None)
            }
        }
        2 => {
            let db = unquote_ident(&parts[0]);
            let tbl = unquote_ident(&parts[1]);
            // `db.*` is a database-level scope, not a table named "*".
            (Some(db), (!tbl.is_empty() && tbl != "*").then_some(tbl))
        }
        _ => (None, None),
    }
}

/// Split `a.b` respecting backtick quoting and backtick doubling.
fn split_qualified(text: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut chars = text.chars().peekable();
    let mut in_backticks = false;
    while let Some(c) = chars.next() {
        if in_backticks {
            if c == '`' {
                if chars.peek() == Some(&'`') {
                    current.push('`');
                    chars.next();
                } else {
                    in_backticks = false;
                }
            } else {
                current.push(c);
            }
        } else {
            match c {
                '`' => in_backticks = true,
                '.' => parts.push(std::mem::take(&mut current)),
                _ => current.push(c),
            }
        }
    }
    parts.push(current);
    parts
}

/// Remove surrounding backticks/double quotes from one identifier token.
fn unquote_ident(token: &str) -> String {
    let t = token.trim();
    for (open, close) in [('\u{60}', '\u{60}'), ('"', '"')] {
        if let Some(inner) = t.strip_prefix(open).and_then(|s| s.strip_suffix(close)) {
            return inner.to_string();
        }
    }
    t.to_string()
}

// ---------------------------------------------------------------------------
// GRANT/REVOKE statement building (shared shape, per-dialect quoting)
// ---------------------------------------------------------------------------

/// Validate then render the scope part of a GRANT/REVOKE. Returns the ON
/// clause text (without the ON keyword).
pub fn grant_scope_sql(dialect: SqlDialect, req: &GrantRequest) -> Result<String> {
    validate_privileges(dialect, &req.privileges)?;
    if req.db.as_deref() == Some("*") {
        return Err(AppError::Db(
            "use an empty database for global (*.*) privileges instead of \"*\"".into(),
        ));
    }
    match (&req.table, &req.db) {
        (Some(table), Some(db)) => Ok(dialect.quote_qualified(&[db, table])),
        (Some(_), None) => Err(AppError::Db(
            "table-scoped grants require a database scope".into(),
        )),
        (None, Some(db)) => match dialect {
            SqlDialect::Mysql => Ok(format!("{}.{}", dialect.quote_ident(db), "*")),
            SqlDialect::Postgres => Ok(format!("SCHEMA {}", dialect.quote_ident(db))),
            SqlDialect::Sqlite => Err(AppError::Unsupported("sqlite has no grants".into())),
        },
        (None, None) => match dialect {
            SqlDialect::Mysql => Ok("*.*".to_string()),
            _ => Err(AppError::Db(
                "global grants need a database/schema scope on this engine".into(),
            )),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- literal escaping ---------------------------------------------------

    #[test]
    fn mysql_literal_escapes_backslashes_and_quotes() {
        assert_eq!(sql_literal(SqlDialect::Mysql, "o'brien"), "'o''brien'");
        assert_eq!(sql_literal(SqlDialect::Mysql, "a\\b"), "'a\\\\b'");
        assert_eq!(sql_literal(SqlDialect::Mysql, "x'y\\z"), "'x''y\\\\z'");
        assert_eq!(sql_literal(SqlDialect::Mysql, ""), "''");
    }

    #[test]
    fn mysql_literal_skips_backslash_doubling_under_no_backslash_escapes() {
        // A NO_BACKSLASH_ESCAPES session parses \\ literally, so doubling
        // would corrupt the value instead of protecting it.
        assert_eq!(sql_literal_ex(SqlDialect::Mysql, "a\\b", false), "'a\\b'");
        assert_eq!(sql_literal_ex(SqlDialect::Mysql, "o'b", false), "'o''b'");
    }

    #[test]
    fn pg_literal_uses_escape_strings() {
        // E'' processes backslash escapes regardless of the server's
        // standard_conforming_strings setting — one spelling fits both.
        assert_eq!(sql_literal(SqlDialect::Postgres, "o'brien"), "E'o''brien'");
        assert_eq!(sql_literal(SqlDialect::Postgres, "a\\b"), "E'a\\\\b'");
        assert_eq!(
            sql_literal(SqlDialect::Postgres, "'); DROP TABLE x; --"),
            "E'''); DROP TABLE x; --'"
        );
        assert_eq!(sql_literal(SqlDialect::Postgres, ""), "E''");
    }

    #[test]
    fn sqlite_literal_only_doubles_quotes() {
        assert_eq!(sql_literal(SqlDialect::Sqlite, "a\\b"), "'a\\b'");
        assert_eq!(sql_literal(SqlDialect::Sqlite, "o'b"), "'o''b'");
    }

    // -- LIKE pattern building ----------------------------------------------

    #[test]
    fn like_patterns_escape_wildcards_per_mode() {
        // `!` is the escape char: %, _ and ! itself get prefixed; backslash
        // is not special in LIKE patterns and passes through untouched.
        assert_eq!(
            build_like_pattern(FindMode::Contains, "50%_off\\").as_deref(),
            Some("%50!%!_off\\%")
        );
        assert_eq!(
            build_like_pattern(FindMode::Prefix, "abc").as_deref(),
            Some("abc%")
        );
        assert_eq!(
            build_like_pattern(FindMode::Whole, "a_b").as_deref(),
            Some("a!_b")
        );
        assert_eq!(
            build_like_pattern(FindMode::Contains, "100!").as_deref(),
            Some("%100!!%")
        );
        assert_eq!(build_like_pattern(FindMode::Regex, "^ab"), None);
    }

    #[test]
    fn text_matches_mirrors_the_sql_predicates() {
        assert!(text_matches(FindMode::Contains, "Hello World", "lo w", false));
        assert!(!text_matches(FindMode::Contains, "Hello World", "lo w", true));
        assert!(text_matches(FindMode::Prefix, "index.php", "INDEX", false));
        assert!(text_matches(FindMode::Whole, "admin", "ADMIN", false));
        assert!(!text_matches(FindMode::Whole, "administrator", "admin", false));
        assert!(text_matches(FindMode::Regex, "Foo123", "foo\\d+", false));
        assert!(!text_matches(FindMode::Regex, "Foo123", "foo\\d+", true));
    }

    #[test]
    fn invalid_regex_is_a_friendly_error() {
        assert!(compile_regex("(unclosed", true).is_err());
        assert!(compile_regex("^ok$", true).is_ok());
    }

    // -- privilege validation -------------------------------------------------

    #[test]
    fn known_privileges_pass_and_smuggles_fail() {
        validate_privileges(SqlDialect::Mysql, &["select".into(), "ALL PRIVILEGES".into()])
            .expect("mysql basics");
        validate_privileges(SqlDialect::Postgres, &["Truncate".into(), "usage".into()])
            .expect("pg basics");

        for evil in [
            "SELECT; DROP TABLE mysql.user",
            "SELECT FROM mysql.user",
            "ALL, GRANT OPTION",
            "(SELECT)",
            "",
        ] {
            assert!(
                validate_privileges(SqlDialect::Mysql, &[evil.into()]).is_err(),
                "should reject {evil:?}"
            );
        }
        // Engine mismatch is rejected (TRUNCATE is not a MySQL privilege).
        assert!(validate_privileges(SqlDialect::Mysql, &["truncate".into()]).is_err());
        assert!(validate_privileges(SqlDialect::Postgres, &["super".into()]).is_err());
        assert!(validate_privileges(SqlDialect::Mysql, &[]).is_err());
    }

    #[test]
    fn normalization_uppercases_and_trims() {
        assert_eq!(
            normalized_privileges(&[" select ".into(), "Create View".into()]),
            vec!["SELECT".to_string(), "CREATE VIEW".to_string()]
        );
    }

    // -- SHOW GRANTS parsing --------------------------------------------------

    fn scopes_of(sql: &str) -> Vec<GrantScope> {
        parse_grant_statements(&[sql.to_string()])
    }

    #[test]
    fn parses_global_mysql5_grant() {
        let s = scopes_of(
            "GRANT SELECT, INSERT, UPDATE ON *.* TO 'app'@'%' WITH GRANT OPTION",
        );
        assert_eq!(s.len(), 3);
        assert!(s.iter().all(|g| g.db.as_deref() == Some("*") && g.grant_option));
        assert_eq!(s[0].privilege, "SELECT");
        assert_eq!(s[2].privilege, "UPDATE");
    }

    #[test]
    fn parses_quoted_db_table_scope() {
        let s = scopes_of(
            "GRANT SELECT ON `shop`.`orders` TO 'reader'@'10.0.0.%'",
        );
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].db.as_deref(), Some("shop"));
        assert_eq!(s[0].table.as_deref(), Some("orders"));
        assert!(!s[0].grant_option);
    }

    #[test]
    fn parses_mysql8_syntax_with_column_lists_and_prefixes() {
        // Column-list grant collapses to table-level SELECT.
        let s = scopes_of(
            "GRANT SELECT (id, `name`), INSERT ON `shop`.`orders` TO 'app'@'%';",
        );
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].privilege, "SELECT");
        assert_eq!(s[1].privilege, "INSERT");

        // MySQL 8 emits an explicit TABLE keyword after ON.
        let s8 = scopes_of("GRANT DELETE ON TABLE `db 1`.`t 2` TO 'u'@'h'");
        assert_eq!(s8[0].db.as_deref(), Some("db 1"));
        assert_eq!(s8[0].table.as_deref(), Some("t 2"));
    }

    #[test]
    fn parses_db_only_scope_and_admin_statements() {
        let s = scopes_of("GRANT ALL PRIVILEGES ON `mydb`.* TO 'owner'@'localhost'");
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].privilege, "ALL PRIVILEGES");
        assert_eq!(s[0].db.as_deref(), Some("mydb"));
        assert_eq!(s[0].table, None);

        let admin = scopes_of("GRANT BACKUP_ADMIN, ENCRYPTION_KEY_ADMIN ON *.* TO 'dba'@'%'");
        assert_eq!(admin.len(), 2);
        assert_eq!(admin[0].privilege, "BACKUP_ADMIN");
    }

    #[test]
    fn skips_proxy_grants_without_inventing_scopes() {
        let s = scopes_of(
            "GRANT PROXY ON 'target'@'host' TO 'agent'@'%' WITH GRANT OPTION",
        );
        assert!(s.is_empty());

        // Garbage input yields nothing rather than panicking.
        assert!(parse_grant_statements(&["CREATE USER 'x'@'%'" .to_string()]).is_empty());
        assert!(parse_grant_statements(&[]).is_empty());
    }

    #[test]
    fn multiple_statements_collect_all_scopes() {
        let stmts = vec![
            "GRANT USAGE ON *.* TO 'u'@'%'".to_string(),
            "GRANT SELECT ON `a`.`t1` TO 'u'@'%'".to_string(),
            "GRANT UPDATE ON `a`.`t1` TO 'u'@'%'".to_string(),
        ];
        let scopes = parse_grant_statements(&stmts);
        assert_eq!(scopes.len(), 3);
        assert_eq!(scopes[0].privilege, "USAGE");
        assert_eq!(scopes[1].db.as_deref(), Some("a"));
        assert_eq!(scopes[2].table.as_deref(), Some("t1"));
    }

    // -- scope rendering --------------------------------------------------------

    fn req(privs: &[&str], db: Option<&str>, table: Option<&str>) -> GrantRequest {
        GrantRequest {
            user: "u".into(),
            host: Some("%".into()),
            privileges: privs.iter().map(|s| s.to_string()).collect(),
            db: db.map(|s| s.to_string()),
            table: table.map(|s| s.to_string()),
            grant_option: false,
            revoke: false,
        }
    }

    #[test]
    fn scope_sql_covers_global_db_and_table_levels() {
        let my = SqlDialect::Mysql;
        assert_eq!(
            grant_scope_sql(my, &req(&["SELECT"], None, None)).unwrap(),
            "*.*"
        );
        assert_eq!(
            grant_scope_sql(my, &req(&["SELECT"], Some("shop"), None)).unwrap(),
            "`shop`.*"
        );
        assert_eq!(
            grant_scope_sql(my, &req(&["SELECT"], Some("shop"), Some("orders"))).unwrap(),
            "`shop`.`orders`"
        );

        let pg = SqlDialect::Postgres;
        assert_eq!(
            grant_scope_sql(pg, &req(&["SELECT"], Some("public"), None)).unwrap(),
            "SCHEMA \"public\""
        );
        assert_eq!(
            grant_scope_sql(pg, &req(&["SELECT"], Some("public"), Some("orders"))).unwrap(),
            "\"public\".\"orders\""
        );

        // Global scope is MySQL-only; table scope needs a database.
        assert!(grant_scope_sql(pg, &req(&["SELECT"], None, None)).is_err());
        assert!(grant_scope_sql(my, &req(&["SELECT"], None, Some("orders"))).is_err());
        assert!(grant_scope_sql(my, &req(&["SELECT"], Some("*"), None)).is_err());
    }
}

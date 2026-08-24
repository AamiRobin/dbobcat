//! Pure SQL script splitting (Phase 3).
//!
//! Splits a multi-statement script into individual statements on `;`,
//! respecting MySQL lexical rules:
//!
//! - single-quoted strings with `''` and `\` escapes,
//! - double-quoted strings with `""` and `\` escapes,
//! - backtick identifiers with ``` `` ``` doubling (no backslash escapes),
//! - line comments (`-- ` with the mandatory following whitespace, and `#`),
//! - non-nested block comments (`/* ... */`).
//!
//! Statement text is preserved verbatim apart from outer whitespace. Chunks
//! that contain only comments/whitespace are dropped so the driver never
//! receives an effectively empty query.
//!
//! This module must stay behaviourally identical to `src/lib/sql-splitter.ts`
//! on the frontend ("run current statement" needs the same boundaries).

/// Split a script into executable statements (trimmed, in order).
pub fn split_statements(sql: &str) -> Vec<String> {
    split_statements_with(sql, ";")
}

/// Same lexer with a custom statement delimiter (mysqldump-style
/// `DELIMITER ;;` blocks around routine bodies need `;;`). The delimiter is
/// matched as a raw token; quotes/comments inside statements behave exactly
/// as in [`split_statements`].
pub fn split_statements_with(sql: &str, delimiter: &str) -> Vec<String> {
    let delim = delimiter.as_bytes();
    let b = sql.as_bytes();
    let n = b.len();
    let mut statements: Vec<String> = Vec::new();
    let mut start = 0usize;
    // True once the current chunk contains a non-comment code character.
    let mut has_code = false;
    let mut i = 0usize;

    while i < n {
        match b[i] {
            // '...' string literal: \' escapes, '' doubles.
            b'\'' => {
                has_code = true;
                i = scan_quoted(b, i, b'\'', true);
            }
            // "..." quoted string: \" escapes, "" doubles.
            b'"' => {
                has_code = true;
                i = scan_quoted(b, i, b'"', true);
            }
            // `...` identifier: `` doubles; backslashes are literal here.
            b'`' => {
                has_code = true;
                i = scan_quoted(b, i, b'`', false);
            }
            b'#' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'-' if i + 1 < n && b[i + 1] == b'-' => {
                match b.get(i + 2) {
                    // "--" starts a comment only when followed by whitespace
                    // or EOL; otherwise it is two minus operators.
                    None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => {
                        while i < n && b[i] != b'\n' {
                            i += 1;
                        }
                    }
                    Some(_) => {
                        has_code = true;
                        i += 1;
                    }
                }
            }
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            c if c.is_ascii_whitespace() => i += 1,
            _ => {
                if starts_with_at(b, delim, i) {
                    if has_code {
                        statements.push(sql[start..i].trim().to_string());
                    }
                    has_code = false;
                    i += delim.len();
                    start = i;
                } else {
                    has_code = true;
                    i += 1;
                }
            }
        }
    }

    if has_code {
        let tail = sql[start..].trim();
        if !tail.is_empty() {
            statements.push(tail.to_string());
        }
    }
    statements
}

/// True when `b[offset..]` begins with `token`.
fn starts_with_at(b: &[u8], token: &[u8], offset: usize) -> bool {
    offset + token.len() <= b.len() && &b[offset..offset + token.len()] == token
}

/// Parse one `DELIMITER x` directive line (case-insensitive keyword).
pub(crate) fn delimiter_directive(line: &str) -> Option<String> {
    let t = line.trim_start();
    let head = t.get(..9)?;
    if !head.eq_ignore_ascii_case("delimiter") {
        return None;
    }
    let d = t[9..].trim();
    (!d.is_empty()).then(|| d.to_string())
}

/// Split a mysqldump-style script honouring inline `DELIMITER x` directives
/// (used around routine/trigger/event bodies). Directive lines themselves
/// are dropped; each segment splits with the delimiter active at that point.
pub fn split_script_with_delimiters(sql: &str) -> Vec<String> {
    let mut statements: Vec<String> = Vec::new();
    let mut delimiter = String::from(";");
    // Start of the not-yet-flushed statement region…
    let mut segment_start = 0usize;
    // …and start of the line currently being scanned.
    let mut line_start = 0usize;

    let bytes = sql.as_bytes();
    let mut i = 0usize;
    while i <= bytes.len() {
        let at_end = i == bytes.len();
        if at_end || bytes[i] == b'\n' {
            let line = &sql[line_start..i];
            if let Some(next) = delimiter_directive(line) {
                // Flush everything before the directive line with the old
                // delimiter, drop the directive itself, continue after it.
                statements
                    .extend(split_statements_with(&sql[segment_start..line_start], &delimiter));
                delimiter = next;
                segment_start = i + 1;
            }
            line_start = i + 1;
        }
        if at_end {
            break;
        }
        i += 1;
    }

    if segment_start < bytes.len() {
        statements.extend(split_statements_with(&sql[segment_start..], &delimiter));
    }
    statements
}

/// Consume one quoted region starting at `open` (the quote byte itself).
///
/// `backslash_escapes` is false for backticks — inside identifiers a
/// backslash is an ordinary character per MySQL rules.
fn scan_quoted(b: &[u8], open: usize, quote: u8, backslash_escapes: bool) -> usize {
    let n = b.len();
    let mut i = open + 1;
    while i < n {
        if backslash_escapes && b[i] == b'\\' && i + 1 < n {
            i += 2;
            continue;
        }
        if b[i] == quote {
            if i + 1 < n && b[i + 1] == quote {
                i += 2; // doubled quote stays inside the literal
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    n // unterminated literal swallows the rest
}

// ---------------------------------------------------------------------------
// PostgreSQL / SQLite splitting (Phase 6)
// ---------------------------------------------------------------------------

/// Lexer knobs where PostgreSQL and SQLite differ from MySQL.
#[derive(Debug, Clone, Copy)]
struct LexRules {
    /// `$$body$$` and `$tag$body$tag$` dollar-quoted strings (PostgreSQL).
    dollar_quotes: bool,
    /// `#` starts a line comment (MySQL only).
    hash_comments: bool,
    /// `--` needs a following space (MySQL); otherwise it always comments.
    dashdash_needs_space: bool,
    /// Backslash escapes inside `'…'` strings. Only honoured in PostgreSQL
    /// when the quote is prefixed with `E`/`e` (standard_conforming_strings).
    e_string_backslash: bool,
    /// `[bracket]` identifiers (SQL Server heritage, supported by SQLite).
    bracket_idents: bool,
    /// ``` `` ``` backtick identifiers (MySQL native; also valid SQLite).
    backtick_idents: bool,
}

const POSTGRES_RULES: LexRules = LexRules {
    dollar_quotes: true,
    hash_comments: false,
    dashdash_needs_space: false,
    e_string_backslash: true,
    bracket_idents: false,
    backtick_idents: false,
};

const SQLITE_RULES: LexRules = LexRules {
    dollar_quotes: false,
    hash_comments: false,
    dashdash_needs_space: false,
    e_string_backslash: false,
    bracket_idents: true,
    backtick_idents: true,
};

fn split_with_rules(sql: &str, rules: LexRules) -> Vec<String> {
    let b = sql.as_bytes();
    let n = b.len();
    let mut statements: Vec<String> = Vec::new();
    let mut start = 0usize;
    // True once the current chunk contains a non-comment code character.
    let mut has_code = false;
    let mut i = 0usize;

    while i < n {
        match b[i] {
            b'\'' => {
                has_code = true;
                // E'…' honours backslash escapes; plain '…' does not
                // (standard_conforming_strings = on).
                let escaped = rules.e_string_backslash && is_e_prefixed(b, i);
                i = scan_quoted(b, i, b'\'', escaped);
            }
            b'"' => {
                has_code = true;
                i = scan_quoted(b, i, b'"', false);
            }
            b'`' if rules.backtick_idents => {
                has_code = true;
                i = scan_quoted(b, i, b'`', false);
            }
            b'[' if rules.bracket_idents => {
                has_code = true;
                while i < n && b[i] != b']' {
                    i += 1;
                }
                i = (i + 1).min(n);
            }
            b'$' if rules.dollar_quotes => {
                if let Some(end) = scan_dollar_quote(b, i) {
                    has_code = true;
                    i = end;
                } else {
                    has_code = true;
                    i += 1;
                }
            }
            b';' => {
                if has_code {
                    let text = sql[start..i].trim();
                    if !text.is_empty() {
                        statements.push(text.to_string());
                    }
                }
                has_code = false;
                start = i + 1;
                i += 1;
            }
            b'-' if i + 1 < n && b[i + 1] == b'-' => {
                match b.get(i + 2) {
                    None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') => comment_to_eol(b, &mut i),
                    // PostgreSQL/SQLite treat any `--` as a comment opener.
                    Some(_) if !rules.dashdash_needs_space => comment_to_eol(b, &mut i),
                    Some(_) => {
                        has_code = true;
                        i += 1;
                    }
                }
            }
            b'#' if rules.hash_comments => comment_to_eol(b, &mut i),
            b'/' if i + 1 < n && b[i + 1] == b'*' => {
                i += 2;
                while i + 1 < n && !(b[i] == b'*' && b[i + 1] == b'/') {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            c if c.is_ascii_whitespace() => i += 1,
            _ => {
                has_code = true;
                i += 1;
            }
        }
    }

    if has_code {
        let tail = sql[start..].trim();
        if !tail.is_empty() {
            statements.push(tail.to_string());
        }
    }
    statements
}

/// Consume up to (not including) the next newline starting at `*i`.
fn comment_to_eol(b: &[u8], i: &mut usize) {
    let n = b.len();
    while *i < n && b[*i] != b'\n' {
        *i += 1;
    }
}

/// True when the single quote at `open` belongs to an `E'…'` escape string:
/// preceded by E/e that itself is not part of a longer identifier.
fn is_e_prefixed(b: &[u8], open: usize) -> bool {
    if open == 0 {
        return false;
    }
    matches!(b[open - 1], b'E' | b'e')
        && (open < 2 || !b[open - 2].is_ascii_alphanumeric() && b[open - 2] != b'_')
}

/// Scan a PostgreSQL dollar-quoted region starting at `$`.
/// Returns the index just past the closing delimiter, or `None` when this
/// `$` does not open a dollar quote (no matching `$` within the tag).
fn scan_dollar_quote(b: &[u8], open: usize) -> Option<usize> {
    let n = b.len();
    // Opening delimiter: `$` [tag chars] `$`
    let mut close = open + 1;
    while close < n && (b[close].is_ascii_alphanumeric() || b[close] == b'_') {
        close += 1;
    }
    if close >= n || b[close] != b'$' {
        return None;
    }
    let delimiter = &b[open..=close];
    // Find the closing occurrence after the opening one.
    let mut i = close + 1;
    while i + delimiter.len() <= n {
        if &b[i..i + delimiter.len()] == delimiter {
            return Some(i + delimiter.len());
        }
        i += 1;
    }
    None
}

/// Split a PostgreSQL script into statements: `'…'` strings (with `E'…'`
/// escapes), `"…"` identifiers, `$$…$$` / `$tag$…$tag$` bodies (function
/// definitions keep their internal semicolons), `--` comments and
/// `/* … */` block comments.
pub fn split_postgres(sql: &str) -> Vec<String> {
    split_with_rules(sql, POSTGRES_RULES)
}

/// Split a SQLite script: `'…'` strings (`''` doubling, no backslash
/// escapes), `"…"`, `` `…` `` and `[…]` identifiers, `--` and `/* */`
/// comments.
pub fn split_sqlite(sql: &str) -> Vec<String> {
    split_with_rules(sql, SQLITE_RULES)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(s: &str) -> Vec<String> {
        split_statements(s)
    }

    #[test]
    fn splits_on_semicolons_and_keeps_text() {
        assert_eq!(
            split("SELECT 1; SELECT 2 ;"),
            vec!["SELECT 1".to_string(), "SELECT 2".to_string()]
        );
    }

    #[test]
    fn trailing_statement_without_semicolon_is_kept() {
        assert_eq!(split("SELECT 1"), vec!["SELECT 1"]);
        assert_eq!(split("SELECT 1;\nSELECT 'a'"), vec!["SELECT 1", "SELECT 'a'"]);
    }

    #[test]
    fn semicolons_inside_strings_do_not_split() {
        assert_eq!(
            split(r#"SELECT 'a;b'; SELECT "x;y";"#),
            vec!["SELECT 'a;b'", "SELECT \"x;y\""]
        );
    }

    #[test]
    fn escaped_quotes_and_doubled_quotes_stay_in_literal() {
        assert_eq!(
            split(r"SELECT 'it\'s; ok'); SELECT 'a''b';"),
            vec![r"SELECT 'it\'s; ok')", "SELECT 'a''b'"]
        );
    }

    #[test]
    fn backtick_identifiers_with_semicolons_do_not_split() {
        assert_eq!(
            split("SELECT `we;ird` FROM `t``x`;"),
            vec!["SELECT `we;ird` FROM `t``x`"]
        );
        // Backslashes are literal inside backticks: the identifier ends at
        // the backtick right after `\`, so a real statement boundary follows.
        assert_eq!(split("SELECT `a\\`; SELECT 1"), vec!["SELECT `a\\`", "SELECT 1"]);
    }

    #[test]
    fn line_comments_are_not_executed() {
        assert_eq!(
            split("SELECT 1 -- comment; with semicolon\n; SELECT 2"),
            vec!["SELECT 1 -- comment; with semicolon", "SELECT 2"]
        );
        assert_eq!(
            split("# whole line;\nSELECT 3"),
            vec!["# whole line;\nSELECT 3"]
        );
    }

    #[test]
    fn double_dash_without_space_is_an_operator() {
        assert_eq!(split("SELECT 5--2;"), vec!["SELECT 5--2"]);
    }

    #[test]
    fn block_comments_never_split() {
        assert_eq!(
            split("SELECT /* a;b;c */ 1;"),
            vec!["SELECT /* a;b;c */ 1"]
        );
        // Unterminated block comment swallows everything (MySQL errors too).
        assert_eq!(split("SELECT 1; /* open"), vec!["SELECT 1"]);
    }

    #[test]
    fn comment_only_chunks_are_dropped() {
        assert_eq!(split("-- nothing\n; /* also nothing */ ;;"), Vec::<String>::new());
        assert!(split("").is_empty());
        assert!(split("   \n\t ").is_empty());
    }

    #[test]
    fn empty_statements_between_semicolons_skipped() {
        assert_eq!(split(";;SELECT 1;; ;SELECT 2;"), vec!["SELECT 1", "SELECT 2"]);
    }

    #[test]
    fn utf8_body_survives_splitting() {
        assert_eq!(
            split("SELECT 'héllo → wörld';"),
            vec!["SELECT 'héllo → wörld'"]
        );
    }

    #[test]
    fn custom_delimiter_keeps_inner_semicolons() {
        let script = "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;;\nSELECT 3;";
        assert_eq!(
            split_statements_with(script, ";;"),
            vec![
                "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
                // The trailing ';' is ordinary text under the ;; delimiter.
                "SELECT 3;"
            ]
        );
    }

    #[test]
    fn custom_delimiter_respects_strings() {
        assert_eq!(
            split_statements_with("SELECT 'a;;b';; SELECT 2", ";;"),
            vec!["SELECT 'a;;b'", "SELECT 2"]
        );
    }

    #[test]
    fn delimiter_directives_switch_splitting() {
        let script = "SET NAMES utf8;\nDELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; END;;\nDELIMITER ;\nSELECT 2;";
        assert_eq!(
            split_script_with_delimiters(script),
            vec![
                "SET NAMES utf8",
                "CREATE PROCEDURE p() BEGIN SELECT 1; END",
                "SELECT 2"
            ]
        );
        // Directive on the last line (no trailing newline) must not panic.
        assert_eq!(
            split_script_with_delimiters("SELECT 1"),
            vec!["SELECT 1"]
        );
        assert!(split_script_with_delimiters("DELIMITER $$").is_empty());
    }
}

#[cfg(test)]
mod pg_sqlite_tests {
    use super::{split_postgres, split_sqlite};

    #[test]
    fn postgres_splits_simple_scripts() {
        assert_eq!(
            split_postgres("SELECT 1; SELECT 2;"),
            vec!["SELECT 1", "SELECT 2"]
        );
        assert_eq!(split_postgres("SELECT 1"), vec!["SELECT 1"]);
        assert!(split_postgres("").is_empty());
    }

    #[test]
    fn postgres_dollar_quoted_bodies_keep_inner_semicolons() {
        let script = "CREATE FUNCTION f() RETURNS void AS $$\n\
                      BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM t WHERE b = 2;\nEND\n\
                      $$ LANGUAGE plpgsql; SELECT 3;";
        assert_eq!(
            split_postgres(script),
            vec![
                "CREATE FUNCTION f() RETURNS void AS $$\nBEGIN\n  UPDATE t SET a = 1;\n  \
                 DELETE FROM t WHERE b = 2;\nEND\n$$ LANGUAGE plpgsql",
                "SELECT 3"
            ]
        );
    }

    #[test]
    fn postgres_tagged_dollar_quotes_and_nested_dollars() {
        let script = "$fn$ INSERT INTO log VALUES ('a$$b'); SELECT $1;$fn$ SELECT 2;";
        assert_eq!(
            split_postgres(script),
            vec!["$fn$ INSERT INTO log VALUES ('a$$b'); SELECT $1;$fn$ SELECT 2"]
        );
        // A lone `$` is ordinary code, not an opener.
        assert_eq!(split_postgres("SELECT $1;"), vec!["SELECT $1"]);
    }

    #[test]
    fn postgres_strings_comments_and_e_escapes() {
        // '' doubling keeps semicolons inside literals.
        assert_eq!(
            split_postgres("SELECT 'a;b''c';"),
            vec!["SELECT 'a;b''c'"]
        );
        // E'…' honours \' escapes.
        assert_eq!(
            split_postgres(r"E'a\'; SELECT';"),
            vec![r"E'a\'; SELECT'"]
        );
        // `--` comments without a space; double-quote idents protect `;`.
        assert_eq!(
            split_postgres("SELECT 1 --note; ignored\n; SELECT \"x;y\""),
            vec!["SELECT 1 --note; ignored", "SELECT \"x;y\""]
        );
        // Block comments never split.
        assert_eq!(split_postgres("SELECT /* ; */ 1;"), vec!["SELECT /* ; */ 1"]);
    }

    #[test]
    fn comment_only_chunks_are_dropped_for_new_engines() {
        assert_eq!(split_postgres("-- nothing; here\n;;"), Vec::<String>::new());
        assert_eq!(split_sqlite("-- x; -- y; /* z; */"), Vec::<String>::new());
    }

    #[test]
    fn sqlite_splits_with_doubled_quotes_brackets_and_backticks() {
        // '' doubling, no backslash escapes (backslash is literal).
        assert_eq!(
            split_sqlite(r"INSERT INTO t VALUES ('it''s; fine', 'a\b');"),
            vec![r"INSERT INTO t VALUES ('it''s; fine', 'a\b')"]
        );
        // Double-quoted and bracketed identifiers with semicolons.
        assert_eq!(
            split_sqlite("SELECT \"we;ird\", [br;acket], `ti;ck` FROM t;"),
            vec!["SELECT \"we;ird\", [br;acket], `ti;ck` FROM t"]
        );
        assert_eq!(
            split_sqlite("PRAGMA foreign_keys=ON; CREATE TABLE a(x);"),
            vec!["PRAGMA foreign_keys=ON", "CREATE TABLE a(x)"]
        );
    }

    #[test]
    fn sqlite_trigger_body_needs_manual_handling_but_lexer_is_correct() {
        // SQLite has no DELIMITER directive: CREATE TRIGGER bodies must be
        // sent via execute-single. The lexer still respects string quoting
        // so plain multi-statement scripts split correctly.
        let script = "CREATE TABLE t(a); INSERT INTO t VALUES ('x;y');";
        assert_eq!(
            split_sqlite(script),
            vec!["CREATE TABLE t(a)", "INSERT INTO t VALUES ('x;y')"]
        );
    }
}

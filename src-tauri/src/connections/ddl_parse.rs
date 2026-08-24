//! Pure `SHOW CREATE TABLE` parser (Phase 4).
//!
//! Turns the server's CREATE TABLE text into the structured [`ParsedTable`]
//! used by the designer and the ALTER builder. Everything here is
//! synchronous, allocation-based and unit-tested against realistic MySQL /
//! MariaDB output samples; no driver code involved.
//!
//! Fidelity strategy: fields the designer edits are parsed into structured
//! form; anything exotic (column charsets, SRID, INVISIBLE, table-level
//! CHECKs, unknown table options, partitioning) is preserved verbatim so a
//! load → apply round-trip never silently rewrites what the user did not
//! touch.

use crate::connections::{
    ColumnDef, DefaultKind, ForeignKeyMeta, IndexKind, IndexMeta, TableOptions,
};
use crate::error::{AppError, Result};

/// Structured parse of one SHOW CREATE TABLE payload.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedTable {
    pub table: String,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexMeta>,
    pub foreign_keys: Vec<ForeignKeyMeta>,
    pub options: TableOptions,
    /// Table-level CHECK constraints, verbatim.
    pub checks: Vec<String>,
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

/// One lexical token of a definition item.
#[derive(Debug, Clone, PartialEq)]
enum Tok {
    /// Bare keyword / number / word.
    Word(String),
    /// `` `quoted` `` identifier (decoded).
    Ident(String),
    /// `'string'` literal (decoded).
    Str(String),
    /// `( ... )` group — inner text preserved raw.
    Parens(String),
}

fn is_word_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'$' || b == b'.' || b >= 0x80
}

/// Decode a MySQL single-quoted string body: `''` doubling plus backslash
/// escapes. `\%` and `\_` stay two characters per MySQL rules.
fn decode_string(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\'' => {
                // Doubled quote inside the body → one literal quote.
                if chars.peek() == Some(&'\'') {
                    out.push('\'');
                    chars.next();
                }
            }
            '\\' => match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('0') => out.push('\0'),
                Some('b') => out.push('\u{8}'),
                Some('\\') => out.push('\\'),
                Some('\'') => out.push('\''),
                Some('"') => out.push('"'),
                // \% and \_ keep the backslash (LIKE escapes); \c → c otherwise.
                Some(other) => {
                    if other == '%' || other == '_' {
                        out.push('\\');
                    }
                    out.push(other);
                }
                None => {}
            },
            other => out.push(other),
        }
    }
    out
}

/// Tokenize a definition fragment into [`Tok`]s. Comments are stripped,
/// strings/idents decoded, parens captured as balanced groups.
fn tokenize(text: &str) -> Vec<Tok> {
    let b = text.as_bytes();
    let n = b.len();
    let mut toks = Vec::new();
    let mut i = 0usize;

    while i < n {
        match b[i] {
            c if c.is_ascii_whitespace() => i += 1,
            b'\'' | b'"' => {
                // Collect the raw literal body (keeping doubled quotes and
                // backslashes), then decode exactly once.
                let quote = b[i];
                i += 1;
                let start = i;
                let mut end = n;
                while i < n {
                    let c = b[i];
                    if c == b'\\' && quote == b'\'' {
                        i += 2;
                        continue;
                    }
                    if c == quote {
                        if b.get(i + 1) == Some(&quote) {
                            i += 2;
                            continue;
                        }
                        end = i;
                        i += 1;
                        break;
                    }
                    i += 1;
                }
                toks.push(Tok::Str(decode_string(
                    std::str::from_utf8(&b[start..end]).unwrap_or(""),
                )));
            }
            b'`' => {
                let mut out = String::new();
                i += 1;
                while i < n {
                    if b[i] == b'`' {
                        if b.get(i + 1) == Some(&b'`') {
                            out.push('`');
                            i += 2;
                        } else {
                            i += 1;
                            break;
                        }
                    } else {
                        let start = i;
                        while i < n && b[i] != b'`' {
                            i += 1;
                        }
                        out.push_str(std::str::from_utf8(&b[start..i]).unwrap_or(""));
                    }
                }
                toks.push(Tok::Ident(out));
            }
            b'(' => {
                let mut depth = 0usize;
                let start = i + 1;
                let mut in_str = 0u8; // 0 none, b'\'' , b'"'
                while i < n {
                    let c = b[i];
                    if in_str != 0 {
                        if c == b'\\' && in_str == b'\'' {
                            i += 2;
                            continue;
                        }
                        if c == in_str {
                            if b.get(i + 1) == Some(&in_str) {
                                i += 2;
                                continue;
                            }
                            in_str = 0;
                        }
                    } else if c == b'\'' || c == b'"' {
                        in_str = c;
                    } else if c == b'`' {
                        i += 1;
                        while i < n && b[i] != b'`' {
                            i += 1;
                        }
                    } else if c == b'(' {
                        depth += 1;
                    } else if c == b')' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    i += 1;
                }
                toks.push(Tok::Parens(
                    std::str::from_utf8(&b[start..i.min(n)]).unwrap_or("").to_string(),
                ));
                i += 1;
            }
            b'#' => {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'-' if b.get(i + 1) == Some(&b'-')
                && matches!(b.get(i + 2), None | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r')) =>
            {
                while i < n && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < n && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i = (i + 2).min(n);
            }
            c if is_word_byte(c) => {
                let start = i;
                while i < n && is_word_byte(b[i]) {
                    i += 1;
                }
                toks.push(Tok::Word(
                    std::str::from_utf8(&b[start..i]).unwrap_or("").to_string(),
                ));
            }
            _ => i += 1, // stray punctuation inside items is ignored
        }
    }
    toks
}

// ---------------------------------------------------------------------------
// Helpers over token slices
// ---------------------------------------------------------------------------

fn upper(s: &str) -> String {
    s.to_ascii_uppercase()
}

fn tok_word(toks: &[Tok], i: usize) -> Option<String> {
    match toks.get(i) {
        Some(Tok::Word(w)) => Some(w.clone()),
        _ => None,
    }
}

fn expect_word(toks: &[Tok], i: usize, want: &str) -> bool {
    tok_word(toks, i).map(|w| upper(&w) == want).unwrap_or(false)
}

/// Type-extension words that belong to the data type text.
fn type_extension_word(u: &str) -> bool {
    matches!(u, "UNSIGNED" | "SIGNED" | "ZEROFILL" | "BINARY")
}

fn is_numeric_literal(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    if let Some(hex) = body.strip_prefix("0x").or_else(|| body.strip_prefix("0X")) {
        return !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit());
    }
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Split index/FK column list text into plain column names, dropping prefix
/// lengths and ASC/DESC markers.
fn parse_index_columns(inner: &str) -> Vec<String> {
    split_top_level(inner, b',')
        .into_iter()
        .filter_map(|part| {
            tokenize(&part)
                .into_iter()
                .find_map(|t| match t {
                    Tok::Ident(name) | Tok::Word(name) => Some(name),
                    _ => None,
                })
        })
        .collect()
}

/// Split `text` on `sep` at nesting depth 0 (parens/strings/comments aware).
pub fn split_top_level(text: &str, sep: u8) -> Vec<String> {
    let b = text.as_bytes();
    let n = b.len();
    let mut parts = Vec::new();
    let mut start = 0usize;
    let mut depth = 0i32;
    let mut in_str = 0u8;
    let mut i = 0usize;

    while i < n {
        let c = b[i];
        if in_str != 0 {
            if c == b'\\' && in_str == b'\'' {
                i += 2;
                continue;
            }
            if c == in_str {
                if b.get(i + 1) == Some(&in_str) {
                    i += 2;
                    continue;
                }
                in_str = 0;
            }
        } else if c == b'\'' || c == b'"' {
            in_str = c;
        } else if c == b'`' {
            i += 1;
            while i < n && b[i] != b'`' {
                i += 1;
            }
        } else if (c == b'-' && b.get(i + 1) == Some(&b'-')) || c == b'#' {
            // `--` line comment or MySQL `#` comment — both run to EOL.
            while i < n && b[i] != b'\n' {
                i += 1;
            }
        } else if c == b'/' && b.get(i + 1) == Some(&b'*') {
            i += 2;
            while i < n && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                i += 1;
            }
            i += 1;
        } else if c == b'(' {
            depth += 1;
        } else if c == b')' {
            depth -= 1;
        } else if c == sep && depth == 0 {
            parts.push(text[start..i].trim().to_string());
            start = i + 1;
        }
        i += 1;
    }
    let tail = text[start..].trim();
    if !tail.is_empty() {
        parts.push(tail.to_string());
    }
    parts
}

/// Extract the last backtick identifier from the CREATE TABLE head
/// (`db`.`tbl` → tbl); falls back to the last bare word.
fn extract_table_name(head: &str) -> Result<String> {
    let toks = tokenize(head);
    let mut name: Option<String> = None;
    for t in toks {
        match t {
            Tok::Ident(s) | Tok::Word(s) => name = Some(s),
            _ => {}
        }
    }
    name.filter(|n| !n.is_empty())
        .ok_or_else(|| AppError::Db("SHOW CREATE output has no table name".into()))
}

// ---------------------------------------------------------------------------
// Column parsing
// ---------------------------------------------------------------------------

struct ColumnParse {
    def: ColumnDef,
}

fn parse_column_item(toks: &[Tok]) -> Result<ColumnParse> {
    let name = match toks.first() {
        Some(Tok::Ident(s)) => s.clone(),
        other => {
            return Err(AppError::Db(format!(
                "cannot parse column name from {other:?}"
            )))
        }
    };

    let mut i = 1usize;
    // -- data type -----------------------------------------------------------
    let mut data_type = String::new();
    match toks.get(i) {
        Some(Tok::Word(w)) => {
            data_type.push_str(w);
            i += 1;
        }
        _ => return Err(AppError::Db(format!("column `{name}` has no type"))),
    }
    // A paren group directly attached to the base word stays attached
    // (`varchar(40)`), extension words join with spaces (`int unsigned`).
    if let Some(Tok::Parens(p)) = toks.get(i) {
        data_type.push_str(&format!("({p})"));
        i += 1;
    }
    while let Some(Tok::Word(w)) = toks.get(i) {
        if type_extension_word(&upper(w)) {
            data_type.push(' ');
            data_type.push_str(w);
            i += 1;
        } else {
            break;
        }
    }

    let mut col = ColumnDef {
        name,
        previous_name: None,
        data_type,
        nullable: true,
        default_kind: DefaultKind::None,
        default_value: None,
        auto_increment: false,
        on_update: None,
        generated: None,
        comment: None,
        preserved_attrs: Vec::new(),
    };
    let mut preserved: Vec<String> = Vec::new();

    // -- attribute walk ------------------------------------------------------
    while i < toks.len() {
        let word = match toks.get(i) {
            Some(Tok::Word(w)) => w.clone(),
            Some(other) => {
                // Stray literal/group outside any keyword context: preserve.
                preserved.push(tok_display(other));
                i += 1;
                continue;
            }
            None => break,
        };
        match upper(&word).as_str() {
            "NOT" => {
                if expect_word(toks, i + 1, "NULL") {
                    col.nullable = false;
                    i += 2;
                } else {
                    preserved.push(word);
                    i += 1;
                }
            }
            "NULL" => {
                col.nullable = true;
                i += 1;
            }
            "DEFAULT" => {
                let (kind, value, next) = parse_default_literal(toks, i + 1);
                col.default_kind = kind;
                col.default_value = value;
                i = next;
            }
            "AUTO_INCREMENT" => {
                col.auto_increment = true;
                i += 1;
            }
            "ON" => {
                if expect_word(toks, i + 1, "UPDATE") {
                    let mut expr = String::new();
                    let mut j = i + 2;
                    // CURRENT_TIMESTAMP[(n)] or another function-ish expression.
                    if let Some(w) = tok_word(toks, j) {
                        expr.push_str(&w);
                        j += 1;
                        if let Some(Tok::Parens(p)) = toks.get(j) {
                            expr.push_str(&format!("({p})"));
                            j += 1;
                        }
                    }
                    col.on_update = (!expr.is_empty()).then_some(expr);
                    i = j;
                } else {
                    preserved.push("ON".into());
                    i += 1;
                }
            }
            "COMMENT" => {
                if let Some(Tok::Str(s)) = toks.get(i + 1) {
                    col.comment = Some(s.clone());
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "CHARACTER" => {
                // CHARACTER SET <name>
                let mut frag = String::from("CHARACTER");
                let mut j = i + 1;
                if expect_word(toks, j, "SET") {
                    frag.push_str(&format!(" {}", tok_word(toks, j).unwrap()));
                    j += 1;
                }
                if let Some(w) = tok_word(toks, j) {
                    frag.push_str(&format!(" {w}"));
                    j += 1;
                }
                preserved.push(frag);
                i = j;
            }
            "CHARSET" => {
                let mut frag = String::from("CHARACTER SET");
                if let Some(w) = tok_word(toks, i + 1) {
                    frag.push_str(&format!(" {w}"));
                    preserved.push(frag);
                    i += 2;
                } else {
                    preserved.push("CHARSET".into());
                    i += 1;
                }
            }
            "COLLATE" | "COLLATION" => {
                let key: String =
                    if upper(&word) == "COLLATION" { "COLLATE".into() } else { word.clone() };
                if let Some(w) = tok_word(toks, i + 1) {
                    preserved.push(format!("{key} {w}"));
                    i += 2;
                } else {
                    preserved.push(key);
                    i += 1;
                }
            }
            "GENERATED" => {
                // GENERATED ALWAYS AS (expr) [VIRTUAL|STORED]
                let mut j = i + 1;
                let mut frag = String::from("GENERATED ALWAYS AS");
                if expect_word(toks, j, "ALWAYS") {
                    j += 1;
                }
                if expect_word(toks, j, "AS") {
                    j += 1;
                }
                if let Some(Tok::Parens(p)) = toks.get(j) {
                    frag.push_str(&format!(" ({p})"));
                    j += 1;
                }
                if let Some(Tok::Word(w)) = toks.get(j) {
                    let u = upper(w);
                    if u == "VIRTUAL" || u == "STORED" {
                        frag.push_str(&format!(" {u}"));
                        j += 1;
                    }
                }
                col.generated = Some(frag);
                i = j;
            }
            "AS" => {
                // MariaDB shorthand: AS (expr) [VIRTUAL|STORED]
                let mut j = i + 1;
                let mut frag = String::from("GENERATED ALWAYS AS");
                if let Some(Tok::Parens(p)) = toks.get(j) {
                    frag.push_str(&format!(" ({p})"));
                    j += 1;
                }
                if let Some(Tok::Word(w)) = toks.get(j) {
                    let u = upper(w);
                    if u == "VIRTUAL" || u == "STORED" {
                        frag.push_str(&format!(" {u}"));
                        j += 1;
                    }
                }
                col.generated = Some(frag);
                i = j;
            }
            "PRIMARY" => {
                // inline PRIMARY KEY never survives SHOW CREATE normalization;
                // consume defensively.
                let mut j = i + 1;
                if expect_word(toks, j, "KEY") {
                    j += 1;
                }
                i = j;
            }
            "REFERENCES" | "UNIQUE" | "KEY" => {
                // Not emitted by SHOW CREATE for columns; consume defensively.
                i += 1;
            }
            "CHECK" => {
                if let Some(Tok::Parens(p)) = toks.get(i + 1) {
                    preserved.push(format!("CHECK ({p})"));
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "SRID" => {
                if let Some(w) = tok_word(toks, i + 1) {
                    preserved.push(format!("SRID {w}"));
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "INVISIBLE" | "VISIBLE" => {
                preserved.push(word.to_uppercase());
                i += 1;
            }
            "CONSTRAINT" => {
                // Named inline check: CONSTRAINT `c` CHECK (...) [ENFORCED]
                let mut j = i + 1;
                if let Some(Tok::Ident(_)) = toks.get(j) {
                    j += 1;
                }
                if expect_word(toks, j, "CHECK") {
                    j += 1;
                    if let Some(Tok::Parens(p)) = toks.get(j) {
                        preserved.push(format!("CONSTRAINT CHECK ({p})"));
                        j += 1;
                    }
                }
                i = j;
            }
            _ => {
                // Unknown attribute: preserve this word plus an immediately
                // attached paren group (e.g. custom syntax), then continue.
                let mut frag = word.clone();
                i += 1;
                if let Some(Tok::Parens(p)) = toks.get(i) {
                    frag.push_str(&format!(" ({p})"));
                    i += 1;
                }
                preserved.push(frag);
            }
        }
    }

    if !preserved.is_empty() {
        col.preserved_attrs = preserved;
    }
    Ok(ColumnParse { def: col })
}

fn tok_display(t: &Tok) -> String {
    match t {
        Tok::Word(w) => w.clone(),
        Tok::Ident(s) => format!("`{s}`"),
        Tok::Str(s) => format!("'{s}'"),
        Tok::Parens(p) => format!("({p})"),
    }
}

/// Parse the tokens after DEFAULT into (kind, value, next_index).
fn parse_default_literal(toks: &[Tok], i: usize) -> (DefaultKind, Option<String>, usize) {
    match toks.get(i) {
        Some(Tok::Word(w)) if upper(w) == "NULL" => (DefaultKind::Null, None, i + 1),
        Some(Tok::Str(s)) => (DefaultKind::Value, Some(s.clone()), i + 1),
        Some(Tok::Parens(p)) => (DefaultKind::Expression, Some(format!("({p})")), i + 1),
        Some(Tok::Word(w)) => {
            let mut value = w.clone();
            let mut next = i + 1;
            // Function-style literal: CURRENT_TIMESTAMP(3)
            if let Some(Tok::Parens(p)) = toks.get(next) {
                value.push_str(&format!("({p})"));
                next += 1;
            }
            let kind = if is_numeric_literal(&value) {
                DefaultKind::Value
            } else {
                DefaultKind::Expression
            };
            (kind, Some(value), next)
        }
        // Nothing consumable after DEFAULT — always make progress.
        _ => (DefaultKind::None, None, i + 1),
    }
}

// ---------------------------------------------------------------------------
// Constraint parsing
// ---------------------------------------------------------------------------

/// Parse one top-level constraint item (indexes, FKs, checks).
fn parse_constraint_item(toks: &[Tok], parsed: &mut ParsedTable) {
    let mut i = 0usize;

    // Optional CONSTRAINT [name] prefix.
    let mut explicit_name: Option<String> = None;
    if expect_word(toks, 0, "CONSTRAINT") {
        i = 1;
        if let Some(Tok::Ident(n)) = toks.get(i) {
            explicit_name = Some(n.clone());
            i += 1;
        }
    }

    let kind_word = tok_word(toks, i).map(|w| upper(&w)).unwrap_or_default();
    match kind_word.as_str() {
        "PRIMARY" => {
            let mut j = i + 1;
            if expect_word(toks, j, "KEY") {
                j += 1;
            }
            // Optional USING <method> either before or after the column list.
            if expect_word(toks, j, "USING") {
                j += 2;
            }
            let columns = match toks.get(j) {
                Some(Tok::Parens(inner)) => parse_index_columns(inner),
                _ => Vec::new(),
            };
            parsed.indexes.push(IndexMeta {
                name: "PRIMARY".into(),
                kind: IndexKind::Primary,
                columns,
                comment: None,
            });
        }
        "UNIQUE" => {
            let mut j = i + 1;
            if expect_word(toks, j, "KEY") || expect_word(toks, j, "INDEX") {
                j += 1;
            }
            let mut name = match toks.get(j) {
                Some(Tok::Ident(n)) => {
                    j += 1;
                    n.clone()
                }
                _ => String::new(),
            };
            // Optional USING BTREE before or after the column list.
            if expect_word(toks, j, "USING") {
                j += 2;
            }
            let columns = match toks.get(j) {
                Some(Tok::Parens(inner)) => {
                    let cols = parse_index_columns(inner);
                    j += 1;
                    cols
                }
                _ => Vec::new(),
            };
            if name.is_empty() {
                name = explicit_name.unwrap_or_else(|| columns.first().cloned().unwrap_or_default());
            }
            let comment = parse_trailing_index_comment(toks, &mut j);
            parsed.indexes.push(IndexMeta {
                name,
                kind: IndexKind::Unique,
                columns,
                comment,
            });
        }
        "KEY" | "INDEX" => {
            let mut j = i + 1;
            let name = match toks.get(j) {
                Some(Tok::Ident(n)) => {
                    j += 1;
                    n.clone()
                }
                _ => String::new(),
            };
            if expect_word(toks, j, "USING") {
                j += 2;
            }
            let columns = match toks.get(j) {
                Some(Tok::Parens(inner)) => {
                    let cols = parse_index_columns(inner);
                    j += 1;
                    cols
                }
                _ => Vec::new(),
            };
            let comment = parse_trailing_index_comment(toks, &mut j);
            parsed.indexes.push(IndexMeta {
                name,
                kind: IndexKind::Index,
                columns,
                comment,
            });
        }
        "FULLTEXT" | "SPATIAL" => {
            let kind = if kind_word == "FULLTEXT" {
                IndexKind::Fulltext
            } else {
                IndexKind::Spatial
            };
            let mut j = i + 1;
            if expect_word(toks, j, "KEY") || expect_word(toks, j, "INDEX") {
                j += 1;
            }
            let name = match toks.get(j) {
                Some(Tok::Ident(n)) => {
                    j += 1;
                    n.clone()
                }
                _ => String::new(),
            };
            let columns = match toks.get(j) {
                Some(Tok::Parens(inner)) => parse_index_columns(inner),
                _ => Vec::new(),
            };
            parsed.indexes.push(IndexMeta {
                name,
                kind,
                columns,
                comment: None,
            });
        }
        "FOREIGN" => {
            let mut j = i + 1;
            if expect_word(toks, j, "KEY") {
                j += 1;
            }
            let columns = match toks.get(j) {
                Some(Tok::Parens(inner)) => {
                    let cols = parse_index_columns(inner);
                    j += 1;
                    cols
                }
                _ => Vec::new(),
            };
            let fk = parse_fk_tail(explicit_name, columns, toks, j);
            parsed.foreign_keys.push(fk);
        }
        "CHECK" => {
            let mut j = i + 1;
            if let Some(Tok::Parens(p)) = toks.get(j) {
                let mut text = format!("CHECK ({p})");
                j += 1;
                // [NOT] ENFORCED / [NOT] ENFORCED flags are ignored but kept.
                if expect_word(toks, j, "NOT") {
                    text.push_str(" NOT");
                    j += 1;
                }
                if expect_word(toks, j, "ENFORCED") {
                    text.push_str(" ENFORCED");
                }
                parsed.checks.push(text);
            }
        }
        _ => {
            // Unknown constraint shape — nothing structured to record.
        }
    }
}

/// Index comment after the column list: `COMMENT 'text'`.
fn parse_trailing_index_comment(toks: &[Tok], j: &mut usize) -> Option<String> {
    // Skip optional USING <method>.
    if expect_word(toks, *j, "USING") {
        *j += 2;
    }
    if expect_word(toks, *j, "COMMENT") {
        if let Some(Tok::Str(s)) = toks.get(*j + 1) {
            *j += 2;
            return Some(s.clone());
        }
    }
    None
}

/// Parse `REFERENCES tbl (cols) [MATCH x] [ON DELETE act] [ON UPDATE act]`
/// starting at token index `j`. The tokenizer drops the `.` separator, so
/// two adjacent identifiers mean `db`.`table`.
fn parse_fk_tail(name: Option<String>, columns: Vec<String>, toks: &[Tok], mut j: usize) -> ForeignKeyMeta {
    let mut ref_db: Option<String> = None;
    let mut ref_table = String::new();

    if expect_word(toks, j, "REFERENCES") {
        j += 1;
        match toks.get(j).cloned() {
            Some(Tok::Ident(first)) | Some(Tok::Word(first)) => {
                // Bare `db.tbl` (no backticks) arrives as one dotted word.
                if let Some((d, t)) = first.split_once('.') {
                    ref_db = Some(d.to_string());
                    ref_table = t.to_string();
                    j += 1;
                } else {
                    let mut first = first;
                    j += 1;
                    // Skip an explicit "." separator token if present.
                    if matches!(toks.get(j), Some(Tok::Word(w)) if w == ".") {
                        j += 1;
                    }
                    match toks.get(j).cloned() {
                        Some(Tok::Ident(second)) | Some(Tok::Word(second)) => {
                            ref_db = Some(std::mem::take(&mut first));
                            ref_table = second;
                            j += 1;
                        }
                        _ => ref_table = first,
                    }
                }
            }
            _ => {}
        }
    }

    let ref_columns = match toks.get(j) {
        Some(Tok::Parens(inner)) => {
            let cols = parse_index_columns(inner);
            j += 1;
            cols
        }
        _ => Vec::new(),
    };

    let mut on_delete = None;
    let mut on_update = None;
    while j < toks.len() {
        if expect_word(toks, j, "ON")
            && (expect_word(toks, j + 1, "DELETE") || expect_word(toks, j + 1, "UPDATE"))
        {
            let is_delete = expect_word(toks, j + 1, "DELETE");
            let mut action = String::new();
            let mut k = j + 2;
            // Action words until the next ON or end: CASCADE / SET NULL /
            // RESTRICT / NO ACTION / SET DEFAULT.
            while k < toks.len() {
                match toks.get(k) {
                    Some(Tok::Word(w)) if upper(w) != "ON" => {
                        if !action.is_empty() {
                            action.push(' ');
                        }
                        action.push_str(&upper(w));
                        k += 1;
                    }
                    _ => break,
                }
            }
            if is_delete {
                on_delete = Some(action);
            } else {
                on_update = Some(action);
            }
            j = k;
        } else {
            j += 1; // MATCH ... and friends are skipped
        }
    }

    ForeignKeyMeta {
        name: name.unwrap_or_else(|| "fk_unnamed".into()),
        columns,
        ref_db,
        ref_table,
        ref_columns,
        on_update,
        on_delete,
    }
}

// ---------------------------------------------------------------------------
// Table options tail
// ---------------------------------------------------------------------------

/// Byte offset of a case-insensitive whole word in `text` (quote-aware enough
/// for option tails), used to split off the trailing PARTITION clause.
fn find_word_offset(text: &str, word: &str) -> Option<usize> {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0usize;
    while i + word.len() <= bytes.len() {
        if &lower[i..i + word.len()] == word {
            let before_ok = i == 0 || !is_word_byte(bytes[i - 1]);
            let after = bytes.get(i + word.len()).copied();
            let after_ok = after.map(|c| !is_word_byte(c)).unwrap_or(true);
            if before_ok && after_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

fn parse_options_tail(tail: &str) -> TableOptions {
    let mut opts = TableOptions::default();
    // Everything from PARTITION on is preserved verbatim (partitioning is
    // not editable yet but must survive an apply).
    let working = match find_word_offset(tail.trim(), "partition") {
        Some(pos) => {
            opts.partition = Some(tail.trim()[pos..].trim_end_matches(';').trim().to_string());
            &tail.trim()[..pos]
        }
        None => tail.trim(),
    };
    let toks = tokenize(working);
    let mut i = 0usize;

    while i < toks.len() {
        // The tokenizer drops '=' characters, so KEY=VALUE pairs are matched
        // positionally: every key word is followed by its value token.
        let key_tok = match toks.get(i) {
            Some(Tok::Word(w)) => w.clone(),
            _ => {
                i += 1;
                continue;
            }
        };
        i += 1;
        let key_upper = upper(&key_tok);

        // "DEFAULT CHARSET=x" / "DEFAULT CHARACTER SET=x" / "DEFAULT COLLATE=x"
        let (key_norm, value_i): (String, usize) = if key_upper == "DEFAULT" {
            match toks.get(i) {
                Some(Tok::Word(next)) => {
                    let nu = upper(next);
                    let skip = if nu == "CHARACTER"
                        && matches!(toks.get(i + 1), Some(Tok::Word(w)) if upper(w) == "SET")
                    {
                        2 // CHARACTER SET
                    } else {
                        1
                    };
                    let norm = if nu.starts_with("CHAR") {
                        "charset".to_string()
                    } else if nu == "COLLATE" || nu == "COLLATION" {
                        "collation".to_string()
                    } else {
                        next.clone()
                    };
                    (norm, i + skip)
                }
                _ => ("default".into(), i),
            }
        } else if key_upper == "CHARACTER" {
            if matches!(toks.get(i), Some(Tok::Word(w)) if upper(w) == "SET") {
                ("charset".into(), i + 1)
            } else {
                (key_tok.to_ascii_lowercase(), i)
            }
        } else if key_upper == "CHARSET" {
            ("charset".into(), i)
        } else if key_upper == "COLLATE" || key_upper == "COLLATION" {
            ("collation".into(), i)
        } else {
            (key_tok.to_ascii_lowercase(), i)
        };

        let value_raw: String = match toks.get(value_i) {
            Some(Tok::Word(w)) => w.clone(),
            Some(Tok::Str(s)) => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
            _ => continue, // key with no value — re-sync after it
        };
        i = value_i + 1;

        match key_norm.as_str() {
            "engine" => opts.engine = Some(value_raw.trim_matches('\'').to_string()),
            "charset" => opts.charset = Some(value_raw.trim_matches('\'').to_string()),
            "collation" => opts.collation = Some(value_raw.trim_matches('\'').to_string()),
            "comment" => {
                // Re-decode the escaped literal we just re-encoded.
                let inner = value_raw.trim_matches('\'');
                opts.comment = Some(decode_string(inner));
            }
            "auto_increment" => opts.auto_increment = value_raw.parse::<u64>().ok(),
            "row_format" => opts.row_format = Some(value_raw.to_ascii_uppercase()),
            _ => opts.extra.push(crate::connections::ExtraTableOption {
                key: key_tok,
                value: value_raw,
            }),
        }
    }

    opts
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/// Parse a SHOW CREATE TABLE statement body into a [`ParsedTable`].
pub fn parse_create_table(sql: &str) -> Result<ParsedTable> {
    let trimmed = sql.trim();
    let bytes = trimmed.as_bytes();
    let n = bytes.len();

    // Locate the opening paren of the column body (first '(' outside quotes).
    let open = {
        let mut i = 0usize;
        let mut found = None;
        while i < n {
            match bytes[i] {
                b'\'' | b'"' => {
                    let q = bytes[i];
                    i += 1;
                    while i < n {
                        if bytes[i] == b'\\' && q == b'\'' {
                            i += 2;
                            continue;
                        }
                        if bytes[i] == q {
                            if bytes.get(i + 1) == Some(&q) {
                                i += 2;
                                continue;
                            }
                            break;
                        }
                        i += 1;
                    }
                }
                b'`' => {
                    i += 1;
                    while i < n && bytes[i] != b'`' {
                        i += 1;
                    }
                }
                b'(' => {
                    found = Some(i);
                    break;
                }
                _ => {}
            }
            i += 1;
        }
        found.ok_or_else(|| AppError::Db("SHOW CREATE output has no column body".into()))?
    };

    // Matching close paren (same quoting rules).
    let close = {
        let mut depth = 0i32;
        let mut i = open;
        let mut in_str = 0u8;
        let mut found = None;
        while i < n {
            let c = bytes[i];
            if in_str != 0 {
                if c == b'\\' && in_str == b'\'' {
                    i += 2;
                    continue;
                }
                if c == in_str {
                    if bytes.get(i + 1) == Some(&in_str) {
                        i += 2;
                        continue;
                    }
                    in_str = 0;
                }
            } else if c == b'\'' || c == b'"' {
                in_str = c;
            } else if c == b'`' {
                i += 1;
                while i < n && bytes[i] != b'`' {
                    i += 1;
                }
            } else if (c == b'-' && bytes.get(i + 1) == Some(&b'-')) || c == b'#' {
                // `--` line comment or MySQL `#` comment — both run to EOL.
                while i < n && bytes[i] != b'\n' {
                    i += 1;
                }
                continue;
            } else if c == b'/' && bytes.get(i + 1) == Some(&b'*') {
                i += 2;
                while i < n && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 1;
            } else if c == b'(' {
                depth += 1;
            } else if c == b')' {
                depth -= 1;
                if depth == 0 {
                    found = Some(i);
                    break;
                }
            }
            i += 1;
        }
        found.ok_or_else(|| AppError::Db("unbalanced parentheses in SHOW CREATE output".into()))?
    };

    let table = extract_table_name(&trimmed[..open])?;
    let body = &trimmed[open + 1..close];
    let tail = &trimmed[close + 1..];

    let mut parsed = ParsedTable {
        table,
        ..ParsedTable::default()
    };

    for item in split_top_level(body, b',') {
        if item.is_empty() {
            continue;
        }
        let toks = tokenize(&item);
        if toks.is_empty() {
            continue;
        }
        match toks.first() {
            Some(Tok::Ident(_)) => {
                parsed.columns.push(parse_column_item(&toks)?.def);
            }
            Some(Tok::Word(w)) => {
                let u = upper(w);
                if matches!(
                    u.as_str(),
                    "PRIMARY"
                        | "UNIQUE"
                        | "KEY"
                        | "INDEX"
                        | "FULLTEXT"
                        | "SPATIAL"
                        | "CONSTRAINT"
                        | "FOREIGN"
                        | "CHECK"
                        | "PERIOD"
                ) {
                    if u == "PERIOD" {
                        continue; // application time periods: unsupported, skip
                    }
                    parse_constraint_item(&toks, &mut parsed);
                } else {
                    return Err(AppError::Db(format!(
                        "unexpected token `{w}` at item start — cannot parse column"
                    )));
                }
            }
            _ => {}
        }
    }

    parsed.options = parse_options_tail(tail);
    Ok(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    const INNODB_SAMPLE: &str = r#"CREATE TABLE `users` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL COMMENT 'display name',
  `email` varchar(255) DEFAULT NULL,
  `status` enum('active','inactive','banned') NOT NULL DEFAULT 'active',
  `score` double DEFAULT '0',
  `bio` text COMMENT 'user''s bio',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_name` (`name`) USING BTREE,
  FULLTEXT KEY `ft_bio` (`bio`)
) ENGINE=InnoDB AUTO_INCREMENT=42 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='users table'"#;

    #[test]
    fn parses_innodb_sample_with_indexes_and_options() {
        let t = parse_create_table(INNODB_SAMPLE).unwrap();
        assert_eq!(t.table, "users");
        assert_eq!(t.columns.len(), 8);

        let id = &t.columns[0];
        assert_eq!(id.name, "id");
        assert_eq!(id.data_type, "int unsigned");
        assert!(!id.nullable);
        assert!(id.auto_increment);

        let name = &t.columns[1];
        assert_eq!(name.data_type, "varchar(100)");
        assert_eq!(name.comment.as_deref(), Some("display name"));

        let email = &t.columns[2];
        assert!(email.nullable);
        assert_eq!(email.default_kind, DefaultKind::Null);

        let status = &t.columns[3];
        assert_eq!(status.data_type, "enum('active','inactive','banned')");
        assert_eq!(status.default_kind, DefaultKind::Value);
        assert_eq!(status.default_value.as_deref(), Some("active"));

        let score = &t.columns[4];
        assert_eq!(score.default_kind, DefaultKind::Value);
        assert_eq!(score.default_value.as_deref(), Some("0"));

        // Escaped quotes decode correctly.
        assert_eq!(t.columns[5].comment.as_deref(), Some("user's bio"));

        let created = &t.columns[6];
        assert_eq!(created.default_kind, DefaultKind::Expression);
        assert_eq!(created.default_value.as_deref(), Some("CURRENT_TIMESTAMP"));

        let updated = &t.columns[7];
        assert!(updated.nullable);
        assert_eq!(updated.on_update.as_deref(), Some("CURRENT_TIMESTAMP(3)"));

        // Indexes.
        assert_eq!(t.indexes.len(), 4);
        assert_eq!(t.indexes[0].kind, IndexKind::Primary);
        assert_eq!(t.indexes[0].columns, vec!["id"]);
        assert_eq!(t.indexes[1].kind, IndexKind::Unique);
        assert_eq!(t.indexes[2].kind, IndexKind::Index);
        assert_eq!(t.indexes[3].kind, IndexKind::Fulltext);

        // Options.
        assert_eq!(t.options.engine.as_deref(), Some("InnoDB"));
        assert_eq!(t.options.auto_increment, Some(42));
        assert_eq!(t.options.charset.as_deref(), Some("utf8mb4"));
        assert_eq!(t.options.collation.as_deref(), Some("utf8mb4_0900_ai_ci"));
        assert_eq!(t.options.comment.as_deref(), Some("users table"));
        assert!(t.options.extra.is_empty());
    }

    #[test]
    fn parses_myisam_with_zerofill_and_prefix_keys() {
        let sql = r#"CREATE TABLE `logs` (
  `id` bigint(20) unsigned zerofill NOT NULL DEFAULT 00000000000000000000,
  `msg` varchar(40) DEFAULT NULL,
  `code` int(11) NOT NULL DEFAULT '0',
  KEY `k1` (`id`(10),`msg` DESC),
  KEY `k2` USING BTREE (`msg`)
) ENGINE=MyISAM DEFAULT CHARSET=latin1 PACK_KEYS=0"#;
        let t = parse_create_table(sql).unwrap();
        assert_eq!(t.columns[0].data_type, "bigint(20) unsigned zerofill");
        assert_eq!(t.columns[1].data_type, "varchar(40)");
        assert_eq!(t.columns[2].default_value.as_deref(), Some("0"));

        // Prefix lengths and sort orders are dropped, names kept, order stable.
        assert_eq!(t.indexes[0].columns, vec!["id", "msg"]);
        // USING before the parens is tolerated.
        assert_eq!(t.indexes[1].name, "k2");

        assert_eq!(t.options.engine.as_deref(), Some("MyISAM"));
        assert_eq!(t.options.charset.as_deref(), Some("latin1"));
        // Unmodelled option preserved verbatim.
        assert_eq!(t.options.extra[0].key, "PACK_KEYS");
        assert_eq!(t.options.extra[0].value, "0");
    }

    #[test]
    fn parses_foreign_keys_with_actions_and_db_qualifier() {
        let sql = r#"CREATE TABLE `orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `product_id` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_user` (`user_id`),
  KEY `fk_product` (`product_id`),
  CONSTRAINT `fk_orders_user` FOREIGN KEY (`user_id`) REFERENCES `shop`.`users` (`id`) ON DELETE CASCADE ON UPDATE SET NULL,
  CONSTRAINT `orders_ibfk_2` FOREIGN KEY (`product_id`) REFERENCES `products` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3"#;
        let t = parse_create_table(sql).unwrap();
        assert_eq!(t.foreign_keys.len(), 2);

        let fk = &t.foreign_keys[0];
        assert_eq!(fk.name, "fk_orders_user");
        assert_eq!(fk.columns, vec!["user_id"]);
        assert_eq!(fk.ref_db.as_deref(), Some("shop"));
        assert_eq!(fk.ref_table, "users");
        assert_eq!(fk.ref_columns, vec!["id"]);
        assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
        assert_eq!(fk.on_update.as_deref(), Some("SET NULL"));

        let fk2 = &t.foreign_keys[1];
        assert!(fk2.ref_db.is_none());
        assert_eq!(fk2.ref_table, "products");
        assert_eq!(fk2.on_delete.as_deref(), Some("RESTRICT"));
        assert!(fk2.on_update.is_none());
    }

    #[test]
    fn parses_generated_columns_virtual_and_stored() {
        let sql = r#"CREATE TABLE `t2` (
  `a` int NOT NULL,
  `b` int GENERATED ALWAYS AS ((a * 2)) VIRTUAL,
  `c` int GENERATED ALWAYS AS (((a + 1))) STORED COMMENT 'sum',
  PRIMARY KEY (`a`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#;
        let t = parse_create_table(sql).unwrap();
        let b = &t.columns[1];
        assert!(b.generated.as_deref().unwrap_or("").starts_with("GENERATED ALWAYS AS"));
        assert!(b.generated.as_deref().unwrap_or("").contains("(a * 2)"));
        assert!(b.generated.as_deref().unwrap_or("").ends_with("VIRTUAL"));
        let c = &t.columns[2];
        assert!(c.generated.as_deref().unwrap_or("").ends_with("STORED"));
        assert_eq!(c.comment.as_deref(), Some("sum"));
    }

    #[test]
    fn parses_mariadb_style_with_extras_and_check() {
        let sql = r#"CREATE TABLE `aria_t` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `price` decimal(10,2) unsigned NOT NULL DEFAULT 0.00,
  `geom` point NOT NULL COMMENT 'geo' SRID 4326,
  CHECK ((`price` >= 0)) ENFORCED,
  PRIMARY KEY (`id`)
) ENGINE=Aria PAGE_CHECKSUM=1 TRANSACTIONAL=0 DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci PARTITION BY HASH (`id`) PARTITIONS 4"#;
        let t = parse_create_table(sql).unwrap();
        assert_eq!(t.columns[0].data_type, "int(11)");
        assert_eq!(t.columns[1].data_type, "decimal(10,2) unsigned");
        assert_eq!(t.columns[1].default_value.as_deref(), Some("0.00"));
        // Exotic column attribute preserved verbatim.
        assert_eq!(t.columns[2].preserved_attrs, vec!["SRID 4326"]);

        assert_eq!(t.checks.len(), 1);
        assert!(t.checks[0].contains("price"));

        assert_eq!(t.options.engine.as_deref(), Some("Aria"));
        assert_eq!(t.options.extra[0].key, "PAGE_CHECKSUM");
        // Partition clause preserved verbatim from the word PARTITION onward.
        let partition = t.options.partition.as_deref().unwrap_or_default();
        assert!(partition.starts_with("PARTITION BY HASH"));
        assert!(partition.contains("PARTITIONS 4"));
    }

    #[test]
    fn parses_expression_defaults_and_set_types() {
        let sql = r#"CREATE TABLE `modern` (
  `uid` binary(16) NOT NULL DEFAULT (UUID_TO_BIN(UUID())),
  `tags` set('a','b','c') NOT NULL DEFAULT 'a,b',
  `flag` tinyint(1) NOT NULL DEFAULT 1,
  `nick` varchar(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC"#;
        let t = parse_create_table(sql).unwrap();
        let uid = &t.columns[0];
        assert_eq!(uid.default_kind, DefaultKind::Expression);
        assert_eq!(uid.default_value.as_deref(), Some("(UUID_TO_BIN(UUID()))"));

        let tags = &t.columns[1];
        assert_eq!(tags.data_type, "set('a','b','c')");
        assert_eq!(tags.default_value.as_deref(), Some("a,b"));

        assert_eq!(t.columns[2].default_value.as_deref(), Some("1"));

        let nick = &t.columns[3];
        assert!(nick
            .preserved_attrs
            .iter()
            .any(|a| a.contains("CHARACTER SET utf8mb4")));
        assert!(nick.preserved_attrs.iter().any(|a| a.contains("utf8mb4_bin")));

        assert_eq!(t.options.row_format.as_deref(), Some("DYNAMIC"));
    }

    /// Round-trip invariant: parsing twice yields identical structure, and a
    /// table parsed from qualified output keeps only its own name.
    #[test]
    fn handles_qualified_names_and_is_stable() {
        let sql = r#"CREATE TABLE `shop`.`items` (
  `sku` varchar(32) NOT NULL,
  PRIMARY KEY (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"#;
        let first = parse_create_table(sql).unwrap();
        assert_eq!(first.table, "items");
        let again = parse_create_table(sql).unwrap();
        assert_eq!(first, again);
    }
}

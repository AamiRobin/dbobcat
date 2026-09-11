//! Pure row formatters for the grid/data exporters (Phase 5).
//!
//! Every [`RowFormatter`] receives cells as wire [`RowValue`]s and writes
//! its target syntax into any `io::Write` sink — no database access, fully
//! unit-testable. Formatting is streamed row by row so exports of huge
//! tables never hold more than one row of output text in memory.
//!
//! Escaping notes shared by all formats:
//! - Binary values render as `0x`-prefixed lowercase hex in textual formats.
//! - SQL literals go through [`sql_literal`]: `NULL`, bare numbers, `'`
//!   doubling plus backslash doubling for strings, `_binary'...'` / `0x…`
//!   for blobs. Doubling both quote kinds stays correct under the default
//!   server sql_mode (the dump header resets SQL_MODE explicitly); under an
//!   exotic `NO_BACKSLASH_ESCAPES` session the backslash doubling would be
//!   visible — accepted trade-off, same choice mysqldump makes.

use std::io;

use crate::connections::dialect::SqlDialect;
use crate::connections::RowValue;

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/// Lowercase hex for binary cells (`0x` prefix), used by textual formats.
pub fn bytes_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("0x");
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Plain-text rendering of one cell (CSV/TSV/Markdown/HTML/...).
pub fn cell_text(value: &RowValue, null_text: &str) -> String {
    match value {
        RowValue::Null => null_text.to_string(),
        RowValue::Int(v) => v.to_string(),
        RowValue::UInt(v) => v.to_string(),
        RowValue::Float(v) => format_float(*v),
        RowValue::Str(s) => s.clone(),
        RowValue::Bytes(b) => bytes_hex(b),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => s.clone(),
    }
}

/// Stable float rendering; non-finite floats become their SQL-ish names.
pub fn format_float(v: f64) -> String {
    if v.is_finite() {
        format!("{v}")
    } else if v.is_nan() {
        "NaN".into()
    } else {
        if v > 0.0 { "+Inf".into() } else { "-Inf".into() }
    }
}

/// JSON token for one cell (numbers raw, everything else quoted/null).
fn json_value(value: &RowValue) -> String {
    match value {
        RowValue::Null => "null".into(),
        RowValue::Int(v) => v.to_string(),
        RowValue::UInt(v) => v.to_string(),
        RowValue::Float(v) if v.is_finite() => v.to_string(),
        RowValue::Float(_) => "null".into(),
        RowValue::Bytes(b) => serde_json::to_string(&bytes_hex(b)).unwrap_or_else(|_| "\"\"".into()),
        other @ (RowValue::Str(_) | RowValue::Date(_) | RowValue::Time(_) | RowValue::Datetime(_)) => {
            serde_json::to_string(&cell_text(other, "")).unwrap_or_else(|_| "\"\"".into())
        }
    }
}

/// Escape XML/HTML entities.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            '&' => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
    out
}

/// LaTeX special-character escaping (tabular body).
fn latex_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\textbackslash{}"),
            '~' => out.push_str("\\textasciitilde{}"),
            '^' => out.push_str("\\textasciicircum{}"),
            '&' | '%' | '$' | '#' | '_' | '{' | '}' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

/// Single-quoted SQL string body: doubles `'` and `\`.
fn sql_quote_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        match c {
            '\'' => out.push_str("''"),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Escape raw bytes for embedding inside `_binary'...'`: quotes, backslash
/// and NUL get backslash escapes (valid whenever backslash escapes are on).
fn sql_quote_binary(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() + 16);
    out.push('_');
    out.push_str("binary'");
    for b in bytes {
        match b {
            b'\'' => out.push_str("''"),
            b'\\' => out.push_str("\\\\"),
            0 => out.push_str("\\0"),
            _ => out.push(*b as char),
        }
    }
    out.push('\'');
    out
}

/// Render one cell as a plain single-quoted string (PostgreSQL/SQLite):
/// only quotes double; backslashes stay literal under
/// standard_conforming_strings / SQLite's default lexing.
fn sql_quote_string_plain(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// [`sql_literal`] per engine family. PostgreSQL renders bytea as
/// `decode('…','hex')`; SQLite as `X'…'`; MySQL keeps its historical
/// `_binary'…'` / `0x…` forms.
pub fn sql_literal_for(
    dialect: SqlDialect,
    value: &RowValue,
    hex_blobs: bool,
) -> String {
    match dialect {
        SqlDialect::Mysql => sql_literal(value, hex_blobs),
        _ => match value {
            RowValue::Null => "NULL".into(),
            RowValue::Int(v) => v.to_string(),
            RowValue::UInt(v) => v.to_string(),
            RowValue::Float(v) if v.is_finite() => format!("{v}"),
            RowValue::Float(_) => "NULL".into(),
            RowValue::Str(s) | RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => {
                sql_quote_string_plain(s)
            }
            RowValue::Bytes(b) => {
                let mut hex = String::with_capacity(b.len() * 2);
                for byte in b {
                    hex.push_str(&format!("{byte:02X}"));
                }
                match dialect {
                    SqlDialect::Sqlite => format!("X'{hex}'"),
                    // decode('hex','hex') needs no extension and round-trips.
                    _ => format!("decode('{hex}','hex')"),
                }
            }
        },
    }
}

/// Render one cell as a MySQL SQL literal (shared by SqlInserts and the
/// SQL dump data writer). `hex_blobs` switches blobs between `0x…` and
/// `_binary'…'`.
pub fn sql_literal(value: &RowValue, hex_blobs: bool) -> String {
    match value {
        RowValue::Null => "NULL".into(),
        RowValue::Int(v) => v.to_string(),
        RowValue::UInt(v) => v.to_string(),
        // Non-finite floats cannot round-trip; NULL keeps imports working.
        RowValue::Float(v) if v.is_finite() => format!("{v}"),
        RowValue::Float(_) => "NULL".into(),
        RowValue::Str(s) => sql_quote_string(s),
        RowValue::Bytes(b) => {
            if hex_blobs || b.is_empty() {
                let mut out = String::with_capacity(2 + b.len() * 2);
                out.push_str("0x");
                for byte in b {
                    out.push_str(&format!("{byte:02X}"));
                }
                out
            } else {
                sql_quote_binary(b)
            }
        }
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => sql_quote_string(s),
    }
}

// ---------------------------------------------------------------------------
// Formatter contract
// ---------------------------------------------------------------------------

/// Streams formatted rows into a writer. `cols` is fixed after `begin`;
/// `row_idx`/`total` let formats manage separators (commas, footers).
pub trait RowFormatter: Send {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()>;
    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()>;
    fn finish(&mut self, w: &mut dyn io::Write, total: usize) -> io::Result<()>;
}

/// Options controlling the CSV family.
#[derive(Debug, Clone)]
pub struct CsvConfig {
    pub delimiter: char,
    pub quote: char,
    /// Text for NULL cells (empty string keeps spreadsheet parity).
    pub null_text: String,
}

impl Default for CsvConfig {
    fn default() -> Self {
        Self {
            delimiter: ',',
            quote: '"',
            null_text: String::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// CSV / TSV
// ---------------------------------------------------------------------------

/// RFC-4180-style CSV with configurable delimiter/quote. Fields are quoted
/// only when they contain the delimiter, the quote, CR or LF.
pub struct CsvFormatter {
    cfg: CsvConfig,
}

impl CsvFormatter {
    pub fn new(cfg: CsvConfig) -> Self {
        Self { cfg }
    }

    fn write_field(&self, w: &mut dyn io::Write, value: &RowValue) -> io::Result<()> {
        let text = cell_text(value, &self.cfg.null_text);
        let delim = self.cfg.delimiter;
        let quote = self.cfg.quote;
        let needs_quoting = text.contains(delim)
            || text.contains(quote)
            || text.contains('\r')
            || text.contains('\n');
        if needs_quoting {
            write!(w, "{}{}{}", quote, text.replace(quote, &quote.to_string().repeat(2)), quote)
        } else {
            w.write_all(text.as_bytes())
        }
    }
}

impl RowFormatter for CsvFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        let header = cols
            .iter()
            .map(|c| {
                let q = self.cfg.quote;
                let needs = c.contains(self.cfg.delimiter)
                    || c.contains(q)
                    || c.contains('\r')
                    || c.contains('\n');
                if needs {
                    format!("{q}{}{q}", c.replace(q, &q.to_string().repeat(2)))
                } else {
                    c.clone()
                }
            })
            .collect::<Vec<_>>()
            .join(&self.cfg.delimiter.to_string());
        writeln!(w, "{header}")
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        for (i, value) in values.iter().enumerate() {
            if i > 0 {
                write!(w, "{}", self.cfg.delimiter)?;
            }
            self.write_field(w, value)?;
        }
        writeln!(w)
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

/// Tab-separated values; embedded tabs/newlines collapse to spaces so the
/// output stays pasteable into spreadsheets.
pub struct TsvFormatter {
    null_text: String,
}

impl TsvFormatter {
    pub fn new(null_text: impl Into<String>) -> Self {
        Self { null_text: null_text.into() }
    }
}

fn tsv_clean(text: &str) -> String {
    text.replace(['\t', '\n', '\r'], " ")
}

impl RowFormatter for TsvFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        writeln!(w, "{}", cols.iter().map(|c| tsv_clean(c)).collect::<Vec<_>>().join("\t"))
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let line = values
            .iter()
            .map(|v| tsv_clean(&cell_text(v, &self.null_text)))
            .collect::<Vec<_>>()
            .join("\t");
        writeln!(w, "{line}")
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/// Array-of-objects JSON, one object per line (easy to tail/diff).
pub struct JsonFormatter;

impl JsonFormatter {
    fn object(cols: &[String], values: &[RowValue]) -> String {
        let parts = cols
            .iter()
            .zip(values.iter())
            .map(|(c, v)| {
                let key = serde_json::to_string(c).unwrap_or_else(|_| "\"\"".into());
                format!("{key}: {}", json_value(v))
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("{{{parts}}}")
    }
}

impl RowFormatter for JsonFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        writeln!(w, "[")
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let comma = if row_idx == 0 { "" } else { "," };
        writeln!(w, "{comma}  {}", Self::object(cols, values))
    }

    fn finish(&mut self, w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        writeln!(w, "]")
    }
}

// ---------------------------------------------------------------------------
// XML (Heidi-style resultset document)
// ---------------------------------------------------------------------------

pub struct XmlFormatter {
    statement: String,
}

impl XmlFormatter {
    pub fn new(statement: impl Into<String>) -> Self {
        Self { statement: statement.into() }
    }
}

impl RowFormatter for XmlFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        writeln!(w, r#"<?xml version="1.0" encoding="UTF-8"?>"#)?;
        writeln!(
            w,
            r#"<resultset statement="{}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">"#,
            xml_escape(&self.statement)
        )
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        writeln!(w, "  <row>")?;
        for (col, value) in cols.iter().zip(values.iter()) {
            match value {
                RowValue::Null => writeln!(w, r#"    <field name="{}" xsi:nil="true" />"#, xml_escape(col))?,
                v => writeln!(
                    w,
                    r#"    <field name="{}">{}</field>"#,
                    xml_escape(col),
                    xml_escape(&cell_text(v, ""))
                )?,
            }
        }
        writeln!(w, "  </row>")
    }

    fn finish(&mut self, w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        writeln!(w, "</resultset>")
    }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const HTML_CSS: &str = "body{font-family:system-ui,sans-serif;margin:16px}\
table{border-collapse:collapse}th,td{border:1px solid #d4d4d4;padding:4px 10px}\
th{background:#f5f5f5;text-align:left}tr:nth-child(even) td{background:#fafafa}";

pub struct HtmlFormatter;

impl RowFormatter for HtmlFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        writeln!(w, "<!DOCTYPE html>")?;
        writeln!(w, "<html>")?;
        writeln!(
            w,
            r#"<head><meta charset="utf-8"><style>{HTML_CSS}</style></head>"#
        )?;
        writeln!(w, "<body>")?;
        writeln!(w, "<table>")?;
        writeln!(w, "<thead><tr>")?;
        for col in cols {
            writeln!(w, "  <th>{}</th>", xml_escape(col))?;
        }
        writeln!(w, "</tr></thead>")?;
        writeln!(w, "<tbody>")
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        writeln!(w, "<tr>")?;
        for value in values {
            writeln!(w, "  <td>{}</td>", xml_escape(&cell_text(value, "NULL")))?;
        }
        writeln!(w, "</tr>")
    }

    fn finish(&mut self, w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        writeln!(w, "</tbody>")?;
        writeln!(w, "</table>")?;
        writeln!(w, "</body>")?;
        writeln!(w, "</html>")
    }
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

pub struct MarkdownFormatter {
    null_text: String,
}

impl MarkdownFormatter {
    pub fn new(null_text: impl Into<String>) -> Self {
        Self { null_text: null_text.into() }
    }
}

fn md_cell(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

impl RowFormatter for MarkdownFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        writeln!(
            w,
            "| {} |",
            cols.iter().map(|c| md_cell(c)).collect::<Vec<_>>().join(" | ")
        )?;
        writeln!(
            w,
            "| {} |",
            cols.iter().map(|_| "---".to_string()).collect::<Vec<_>>().join(" | ")
        )
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        writeln!(
            w,
            "| {} |",
            values
                .iter()
                .map(|v| md_cell(&cell_text(v, &self.null_text)))
                .collect::<Vec<_>>()
                .join(" | ")
        )
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Textile (simple pipe table)
// ---------------------------------------------------------------------------

pub struct TextileFormatter {
    null_text: String,
}

impl TextileFormatter {
    pub fn new(null_text: impl Into<String>) -> Self {
        Self { null_text: null_text.into() }
    }
}

impl RowFormatter for TextileFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        let header = cols
            .iter()
            .map(|c| format!("_. {}", md_cell(c)))
            .collect::<Vec<_>>()
            .join(" | ");
        writeln!(w, "|{header} |")
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let line = values
            .iter()
            .map(|v| md_cell(&cell_text(v, &self.null_text)))
            .collect::<Vec<_>>()
            .join(" | ");
        writeln!(w, "|{line} |")
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// LaTeX
// ---------------------------------------------------------------------------

pub struct LatexFormatter {
    null_text: String,
}

impl LatexFormatter {
    pub fn new(null_text: impl Into<String>) -> Self {
        Self { null_text: null_text.into() }
    }
}

impl RowFormatter for LatexFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, cols: &[String]) -> io::Result<()> {
        let spec = vec!["l"; cols.len()].join("|");
        writeln!(w, "\\begin{{tabular}}{{|{spec}|}}")?;
        writeln!(w, r"\hline")?;
        writeln!(
            w,
            r"{} \\ \hline",
            cols.iter().map(|c| latex_escape(c)).collect::<Vec<_>>().join(" & ")
        )
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        _cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        writeln!(
            w,
            r"{} \\ \hline",
            values
                .iter()
                .map(|v| latex_escape(&cell_text(v, &self.null_text)))
                .collect::<Vec<_>>()
                .join(" & ")
        )
    }

    fn finish(&mut self, w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        writeln!(w, r"\end{{tabular}}")
    }
}

// ---------------------------------------------------------------------------
// PHP array literal
// ---------------------------------------------------------------------------

/// `$data = array(...)` script; numbers stay raw, strings use single
/// quotes, NULL maps to PHP's `null`.
pub struct PhpFormatter {
    var_name: String,
}

impl PhpFormatter {
    pub fn new(var_name: impl Into<String>) -> Self {
        Self { var_name: var_name.into() }
    }

    fn php_scalar(value: &RowValue) -> String {
        match value {
            RowValue::Null => "null".into(),
            RowValue::Int(v) => v.to_string(),
            RowValue::UInt(v) => v.to_string(),
            RowValue::Float(v) if v.is_finite() => format!("{v}"),
            RowValue::Float(_) => "null".into(),
            RowValue::Bytes(b) => format!("'{}'", bytes_hex(b)),
            other @ (RowValue::Str(_) | RowValue::Date(_) | RowValue::Time(_) | RowValue::Datetime(_)) => {
                let text = cell_text(other, "");
                format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
            }
        }
    }
}

impl RowFormatter for PhpFormatter {
    fn begin(&mut self, w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        writeln!(w, "<?php")?;
        writeln!(w, "${} = array(", self.var_name)
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let pairs = cols
            .iter()
            .zip(values.iter())
            .map(|(c, v)| {
                let key = c.replace('\\', "\\\\").replace('\'', "\\'");
                format!("'{}' => {}", key, Self::php_scalar(v))
            })
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(w, "  array({pairs}),")
    }

    fn finish(&mut self, w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        writeln!(w, ");")
    }
}

// ---------------------------------------------------------------------------
// SQL INSERT statements
// ---------------------------------------------------------------------------

/// One `INSERT INTO ... VALUES (...);` per row. Table must already be a
/// fully qualified identifier (the caller goes through `quote_qualified`).
pub struct SqlInsertsFormatter {
    table_q: String,
    insert_ignore: bool,
    complete_columns: bool,
    hex_blobs: bool,
}

impl SqlInsertsFormatter {
    pub fn new(
        table_q: impl Into<String>,
        insert_ignore: bool,
        complete_columns: bool,
        hex_blobs: bool,
    ) -> Self {
        Self {
            table_q: table_q.into(),
            insert_ignore,
            complete_columns,
            hex_blobs,
        }
    }

    fn verb(&self) -> &'static str {
        if self.insert_ignore {
            "INSERT IGNORE INTO"
        } else {
            "INSERT INTO"
        }
    }
}

impl RowFormatter for SqlInsertsFormatter {
    fn begin(&mut self, _w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        Ok(())
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let literals = values
            .iter()
            .map(|v| sql_literal(v, self.hex_blobs))
            .collect::<Vec<_>>()
            .join(", ");
        let column_list = if self.complete_columns {
            format!(
                " ({})",
                cols.iter()
                    .map(|c| crate::connections::quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            String::new()
        };
        writeln!(w, "{} {}{} VALUES ({});", self.verb(), self.table_q, column_list, literals)
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// SQL REPLACE / UPDATE statements (Phase 9-A copy-as)
// ---------------------------------------------------------------------------

/// One `REPLACE INTO ... VALUES (...);` per row — the SqlInserts shape with
/// the verb swapped, so a pasted selection upserts instead of erroring on
/// duplicate keys.
pub struct SqlReplacesFormatter {
    table_q: String,
    hex_blobs: bool,
}

impl SqlReplacesFormatter {
    pub fn new(table_q: impl Into<String>, hex_blobs: bool) -> Self {
        Self { table_q: table_q.into(), hex_blobs }
    }
}

impl RowFormatter for SqlReplacesFormatter {
    fn begin(&mut self, _w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        Ok(())
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let literals = values
            .iter()
            .map(|v| sql_literal(v, self.hex_blobs))
            .collect::<Vec<_>>()
            .join(", ");
        let column_list = cols
            .iter()
            .map(|c| crate::connections::quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        writeln!(w, "REPLACE INTO {} ({}) VALUES ({});", self.table_q, column_list, literals)
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

/// One `UPDATE tbl SET <non-pk cols> WHERE <pk cols>;` per row. Requires the
/// primary-key columns to be present among the result columns (the UI
/// disables the menu item otherwise); rows whose non-PK part is empty are
/// skipped silently.
pub struct SqlUpdatesFormatter {
    table_q: String,
    pk_columns: Vec<String>,
    hex_blobs: bool,
}

impl SqlUpdatesFormatter {
    pub fn new(table_q: impl Into<String>, pk_columns: Vec<String>, hex_blobs: bool) -> Self {
        Self { table_q: table_q.into(), pk_columns, hex_blobs }
    }
}

impl RowFormatter for SqlUpdatesFormatter {
    fn begin(&mut self, _w: &mut dyn io::Write, _cols: &[String]) -> io::Result<()> {
        Ok(())
    }

    fn row(
        &mut self,
        w: &mut dyn io::Write,
        cols: &[String],
        _row_idx: usize,
        values: &[RowValue],
    ) -> io::Result<()> {
        let mut set_parts: Vec<String> = Vec::new();
        let mut where_parts: Vec<String> = Vec::new();
        for (col, value) in cols.iter().zip(values.iter()) {
            let ident = crate::connections::quote_ident(col);
            let literal = sql_literal(value, self.hex_blobs);
            if self.pk_columns.iter().any(|pk| pk == col) {
                where_parts.push(format!("{ident} = {literal}"));
            } else {
                set_parts.push(format!("{ident} = {literal}"));
            }
        }
        if set_parts.is_empty() || where_parts.is_empty() {
            // Nothing to update (all-PK selection) or no key to match on.
            return Ok(());
        }
        writeln!(
            w,
            "UPDATE {} SET {} WHERE {};",
            self.table_q,
            set_parts.join(", "),
            where_parts.join(" AND ")
        )
    }

    fn finish(&mut self, _w: &mut dyn io::Write, _total: usize) -> io::Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

use crate::export::ExportFormat;

/// Build the formatter for one export run. `statement` feeds the XML
/// attribute; `table_q` feeds SQL INSERTs; `pk_columns` drives SqlUpdates.
pub fn make_formatter(
    format: ExportFormat,
    csv: CsvConfig,
    statement: &str,
    table_q: &str,
    insert_ignore: bool,
    hex_blobs: bool,
    pk_columns: &[String],
) -> Box<dyn RowFormatter> {
    match format {
        ExportFormat::Csv => Box::new(CsvFormatter::new(csv)),
        ExportFormat::Tsv => Box::new(TsvFormatter::new(csv.null_text.clone())),
        ExportFormat::Json => Box::new(JsonFormatter),
        ExportFormat::Xml => Box::new(XmlFormatter::new(statement)),
        ExportFormat::Html => Box::new(HtmlFormatter),
        ExportFormat::Markdown => Box::new(MarkdownFormatter::new(String::from("NULL"))),
        ExportFormat::Latex => Box::new(LatexFormatter::new(String::new())),
        ExportFormat::Php => Box::new(PhpFormatter::new("data")),
        ExportFormat::Textile => Box::new(TextileFormatter::new(String::new())),
        ExportFormat::SqlInserts => {
            Box::new(SqlInsertsFormatter::new(table_q, insert_ignore, true, hex_blobs))
        }
        ExportFormat::SqlReplaces => Box::new(SqlReplacesFormatter::new(table_q, hex_blobs)),
        ExportFormat::SqlUpdates => Box::new(SqlUpdatesFormatter::new(
            table_q,
            pk_columns.to_vec(),
            hex_blobs,
        )),
        // Unreachable: export_grid routes XLSX to the dedicated streaming
        // writer before any text formatter is constructed.
        ExportFormat::Xlsx => unreachable!("xlsx has no text formatter"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cols() -> Vec<String> {
        vec!["id".to_string(), "name".to_string(), "score".to_string()]
    }

    fn sample_rows() -> Vec<Vec<RowValue>> {
        vec![
            vec![
                RowValue::Int(1),
                RowValue::Str("plain".into()),
                RowValue::Null,
            ],
            vec![
                RowValue::UInt(2),
                RowValue::Str("quo'te,\"and,comma\"\nline\\break".into()),
                RowValue::Float(1.5),
            ],
            vec![
                RowValue::Null,
                RowValue::Bytes(vec![0xde, 0xad, 0x00]),
                RowValue::Datetime("2026-08-24T10:00:00".into()),
            ],
        ]
    }

    /// Render all sample rows through a fresh formatter.
    fn render(format: ExportFormat) -> String {
        let mut out: Vec<u8> = Vec::new();
        let rows = sample_rows();
        let cols = cols();
        let mut fmt = make_formatter(
            format,
            CsvConfig::default(),
            "SELECT 1",
            "`d`.`t`",
            false,
            false,
            &[],
        );
        fmt.begin(&mut out, &cols).unwrap();
        for (i, row) in rows.iter().enumerate() {
            fmt.row(&mut out, &cols, i, row).unwrap();
        }
        fmt.finish(&mut out, rows.len()).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn csv_quotes_only_when_needed() {
        let out = render(ExportFormat::Csv);
        assert_eq!(
            out,
            concat!(
                "id,name,score\n",
                "1,plain,\n",
                "2,\"quo'te,\"\"and,comma\"\"\nline\\break\",1.5\n",
                ",0xdead00,2026-08-24T10:00:00\n"
            )
        );
    }

    #[test]
    fn tsv_flattens_control_characters() {
        let out = render(ExportFormat::Tsv);
        assert!(out.starts_with("id\tname\tscore\n"));
        assert!(out.contains("2\tquo'te,\"and,comma\" line\\break\t1.5"));
        // No raw tabs/newlines may appear inside a field: three fields per line.
        for line in out.lines() {
            assert_eq!(line.split('\t').count(), 3);
        }
    }

    #[test]
    fn json_array_of_objects() {
        let out = render(ExportFormat::Json);
        assert!(out.starts_with("[\n"));
        assert!(out.trim_end().ends_with("]"));
        assert!(out.contains("\"id\": 1, \"name\": \"plain\", \"score\": null"));
        assert!(out.contains("\"score\": 1.5"));
        assert!(out.contains("\"name\": \"quo'te,\\\"and,comma\\\"\\nline\\\\break\""));
        // Sanity: the whole thing must parse as a JSON array of 3 objects.
        let value: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(value.as_array().unwrap().len(), 3);
    }

    #[test]
    fn xml_uses_heidi_style_resultset() {
        let out = render(ExportFormat::Xml);
        assert!(out.starts_with("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<resultset statement=\"SELECT 1\""));
        assert!(out.contains(r#"<field name="id">1</field>"#));
        assert!(out.contains(r#"<field name="score" xsi:nil="true" />"#));
        assert!(out.trim_end().ends_with("</resultset>"));
        // Entities escaped.
        assert!(out.contains("&quot;and,comma&quot;"));
    }

    #[test]
    fn html_renders_styled_table() {
        let out = render(ExportFormat::Html);
        assert!(out.contains("<style>body{font-family"));
        assert!(out.contains("<th>id</th>"));
        assert!(out.contains("<td>plain</td>"));
        assert!(out.contains("<td>NULL</td>")); // html null text
        assert!(out.trim_end().ends_with("</html>"));
    }

    #[test]
    fn markdown_pipe_table_escapes_pipes() {
        let out = render(ExportFormat::Markdown);
        assert_eq!(
            out.lines().next().unwrap(),
            "| id | name | score |"
        );
        assert_eq!(out.lines().nth(1).unwrap(), "| --- | --- | --- |");
        assert!(out.contains("| NULL |"));
    }

    #[test]
    fn textile_header_row_uses_dot_underscore() {
        let out = render(ExportFormat::Textile);
        assert_eq!(out.lines().next().unwrap(), "|_. id | _. name | _. score |");
        assert!(out.lines().nth(1).unwrap().starts_with("|1 | plain |"));
    }

    #[test]
    fn latex_tabular_structure() {
        let out = render(ExportFormat::Latex);
        assert!(out.contains(r"\begin{tabular}{|l|l|l|}"));
        assert!(out.contains(r"id & name & score \\ \hline"));
        assert!(out.contains(r"\end{tabular}"));
    }

    #[test]
    fn php_array_literal() {
        let out = render(ExportFormat::Php);
        assert!(out.starts_with("<?php\n$data = array(\n"));
        assert!(out.contains("'id' => 1, 'name' => 'plain', 'score' => null"));
        assert!(out.trim_end().ends_with(");"));
    }

    #[test]
    fn sql_inserts_quote_literals() {
        let out = render(ExportFormat::SqlInserts);
        assert!(out.contains(
            "INSERT INTO `d`.`t` (`id`, `name`, `score`) VALUES (1, 'plain', NULL);"
        ));
        assert!(out.contains("(2, 'quo''te,"));
        // Blobs render as _binary literals by default.
        assert!(out.contains("_binary'"));
    }

    #[test]
    fn sql_replaces_swap_the_verb() {
        let mut out: Vec<u8> = Vec::new();
        let cols = cols();
        let rows = sample_rows();
        let mut fmt = SqlReplacesFormatter::new("`d`.`t`", false);
        fmt.begin(&mut out, &cols).unwrap();
        for (i, row) in rows.iter().enumerate() {
            fmt.row(&mut out, &cols, i, row).unwrap();
        }
        fmt.finish(&mut out, rows.len()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(
            "REPLACE INTO `d`.`t` (`id`, `name`, `score`) VALUES (1, 'plain', NULL);"
        ));
        assert!(!text.contains("INSERT"));
    }

    #[test]
    fn sql_updates_split_set_and_where() {
        let cols = vec!["id".to_string(), "name".to_string(), "score".to_string()];
        let rows = [
            vec![RowValue::Int(1), RowValue::Str("plain".into()), RowValue::Null],
            vec![RowValue::UInt(2), RowValue::Str("quo'te".into()), RowValue::Float(1.5)],
        ];
        let mut out: Vec<u8> = Vec::new();
        let mut fmt = SqlUpdatesFormatter::new("`d`.`t`", vec!["id".into()], false);
        fmt.begin(&mut out, &cols).unwrap();
        for (i, row) in rows.iter().enumerate() {
            fmt.row(&mut out, &cols, i, row).unwrap();
        }
        fmt.finish(&mut out, rows.len()).unwrap();
        let text = String::from_utf8(out).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(
            lines[0],
            "UPDATE `d`.`t` SET `name` = 'plain', `score` = NULL WHERE `id` = 1;"
        );
        assert_eq!(
            lines[1],
            "UPDATE `d`.`t` SET `name` = 'quo''te', `score` = 1.5 WHERE `id` = 2;"
        );
    }

    #[test]
    fn sql_updates_skip_rows_without_set_part() {
        let mut out: Vec<u8> = Vec::new();
        let cols = vec!["id".to_string()];
        let mut fmt = SqlUpdatesFormatter::new("`d`.`t`", vec!["id".into()], false);
        fmt.begin(&mut out, &cols).unwrap();
        fmt.row(&mut out, &cols, 0, &[RowValue::UInt(7)]).unwrap();
        fmt.finish(&mut out, 1).unwrap();
        assert!(String::from_utf8(out).unwrap().trim().is_empty());
    }

    #[test]
    fn make_formatter_builds_copy_as_sql_variants() {
        let mut out: Vec<u8> = Vec::new();
        let cols = cols();
        let row = vec![RowValue::Int(1), RowValue::Str("a".into()), RowValue::Null];
        let mut fmt = make_formatter(
            ExportFormat::SqlUpdates,
            CsvConfig::default(),
            "SELECT 1",
            "`d`.`t`",
            false,
            false,
            &["id".to_string()],
        );
        fmt.begin(&mut out, &cols).unwrap();
        fmt.row(&mut out, &cols, 0, &row).unwrap();
        fmt.finish(&mut out, 1).unwrap();
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "UPDATE `d`.`t` SET `name` = 'a', `score` = NULL WHERE `id` = 1;\n"
        );

        let mut out2: Vec<u8> = Vec::new();
        let mut fmt = make_formatter(
            ExportFormat::SqlReplaces,
            CsvConfig::default(),
            "SELECT 1",
            "`d`.`t`",
            false,
            false,
            &[],
        );
        fmt.begin(&mut out2, &cols).unwrap();
        fmt.row(&mut out2, &cols, 0, &row).unwrap();
        fmt.finish(&mut out2, 1).unwrap();
        assert_eq!(
            String::from_utf8(out2).unwrap(),
            "REPLACE INTO `d`.`t` (`id`, `name`, `score`) VALUES (1, 'a', NULL);\n"
        );
    }

    // -- sql_literal escaping matrix ----------------------------------------

    #[test]
    fn sql_literal_null_and_numbers() {
        assert_eq!(sql_literal(&RowValue::Null, false), "NULL");
        assert_eq!(sql_literal(&RowValue::Int(-42), false), "-42");
        assert_eq!(sql_literal(&RowValue::UInt(7), false), "7");
        assert_eq!(sql_literal(&RowValue::Float(2.25), false), "2.25");
        assert_eq!(sql_literal(&RowValue::Float(f64::NAN), false), "NULL");
    }

    #[test]
    fn sql_literal_string_escaping() {
        assert_eq!(sql_literal(&RowValue::Str("it's".into()), false), "'it''s'");
        // Backslashes double so dumps survive default SQL_MODE.
        assert_eq!(sql_literal(&RowValue::Str("a\\b".into()), false), "'a\\\\b'");
        // Newlines stay literal inside the quoted string.
        assert_eq!(sql_literal(&RowValue::Str("l1\nl2".into()), false), "'l1\nl2'");
    }

    #[test]
    fn sql_literal_empty_and_unicode_strings() {
        assert_eq!(sql_literal(&RowValue::Str("".into()), false), "''");
        assert_eq!(
            sql_literal(&RowValue::Str("héllo → wörld".into()), false),
            "'héllo → wörld'"
        );
    }

    #[test]
    fn sql_literal_blob_modes() {
        let printable = RowValue::Bytes(b"a'b\\c".to_vec());
        assert_eq!(sql_literal(&printable, true), "0x6127625C63");
        assert_eq!(sql_literal(&printable, false), "_binary'a''b\\\\c'");
        // Empty blobs always render as empty hex.
        assert_eq!(sql_literal(&RowValue::Bytes(Vec::new()), false), "0x");
    }

    #[test]
    fn sql_literal_temporal_values_are_quoted() {
        assert_eq!(
            sql_literal(&RowValue::Date("2026-08-24".into()), false),
            "'2026-08-24'"
        );
        assert_eq!(
            sql_literal(&RowValue::Time("-1d 02:03:04".into()), false),
            "'-1d 02:03:04'"
        );
        assert_eq!(
            sql_literal(&RowValue::Datetime("2026-08-24T10:11:12.5".into()), false),
            "'2026-08-24T10:11:12.5'"
        );
    }

    #[test]
    fn sql_literal_extreme_numbers_round_trip() {
        assert_eq!(
            sql_literal(&RowValue::UInt(u64::MAX), false),
            "18446744073709551615"
        );
        assert_eq!(sql_literal(&RowValue::Int(i64::MIN), false), "-9223372036854775808");
        assert_eq!(
            sql_literal(&RowValue::Float(f64::INFINITY), true),
            "NULL"
        );
        assert_eq!(sql_literal(&RowValue::Float(-0.5), false), "-0.5");
    }

    #[test]
    fn sql_literal_blob_control_bytes_get_c_escapes() {
        // NUL is escaped as \0 inside _binary literals; hex mode is exact.
        let with_nul = RowValue::Bytes(vec![b'a', 0, b'b']);
        assert_eq!(sql_literal(&with_nul, false), "_binary'a\\0b'");
        assert_eq!(sql_literal(&with_nul, true), "0x610062");
    }

    #[test]
    fn sql_literal_quotes_only_never_confuse_the_parser() {
        // A string made entirely of quotes must survive a dump/import cycle.
        let quotes = RowValue::Str("''\"".into());
        assert_eq!(sql_literal(&quotes, false), "'''''\"'");
        // Backslash immediately before a quote stays unambiguous.
        let tricky = RowValue::Str("\\'".into());
        assert_eq!(sql_literal(&tricky, false), "'\\\\'''");
    }

    #[test]
    fn csv_config_honors_custom_delimiter() {
        let cfg = CsvConfig { delimiter: ';', quote: '\'', null_text: "\\N".into() };
        let mut out: Vec<u8> = Vec::new();
        let cols = vec!["a".to_string(), "b".to_string()];
        let mut fmt = CsvFormatter::new(cfg);
        fmt.begin(&mut out, &cols).unwrap();
        fmt.row(
            &mut out,
            &cols,
            0,
            &[RowValue::Str("x;y".into()), RowValue::Null],
        )
        .unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "a;b\n'x;y';\\N\n");
    }
}

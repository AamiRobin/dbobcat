//! Streaming XLSX export (dbx-inspired): builds a minimal OOXML workbook
//! incrementally inside a ZIP archive, one entry per sheet, so arbitrarily
//! large grids export in bounded memory — no spreadsheet library involved.
//!
//! Sheet overflow: Excel caps a sheet at 1,048,576 rows (header + 1,048,575
//! data rows). When the cap is hit the current sheet entry is closed and a
//! new sheet opens with repeated headers, so nothing is dropped.
//!
//! Entry order: the sheet XML parts stream first because their content is
//! known only row-by-row; `workbook.xml`, `[Content_Types].xml` and friends
//! reference the sheet count and are written last (ZIP entries carry no
//! required order).

use std::io::{Seek, Write};

use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use crate::connections::RowValue;
use crate::error::{AppError, Result};

/// Excel's hard row cap per sheet.
const EXCEL_MAX_TOTAL_ROWS: u32 = 1_048_576;

const XML_MAIN_NS: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XML_REL_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Escape XML text content (`&`, `<`, `>`) and drop characters that are
/// illegal in XML 1.0 (control bytes below 0x20 other than tab/newline/CR).
/// A single stray control char from a text column would otherwise make
/// Excel reject the entire workbook.
fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{7}'..='\u{8}' | '\u{b}'..='\u{c}' | '\u{e}'..='\u{1f}' => {}
            _ => out.push(ch),
        }
    }
    out
}

/// 1-based column index → spreadsheet letter (`1→A`, `27→AA`).
fn column_letter(mut index: u32) -> String {
    let mut letters = Vec::new();
    while index > 0 {
        let rem = ((index - 1) % 26) as u8;
        letters.push((b'A' + rem) as char);
        index = (index - 1) / 26;
    }
    letters.reverse();
    letters.into_iter().collect()
}

/// Sanitize a table name into a legal, unique sheet name (≤31 chars).
pub fn sanitize_sheet_name(base: &str, taken: &[String]) -> String {
    let cleaned: String = base
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | '?' | '*' | '[' | ']' | ':' | '\'') { ' ' } else { c })
        .collect();
    let trimmed = cleaned.trim();
    let mut name: String = if trimmed.is_empty() {
        "Sheet".into()
    } else {
        trimmed.chars().take(31).collect()
    };
    // Excel compares sheet names case-insensitively — `Users` vs `users`
    // would flag the workbook as damaged.
    let taken_lower: Vec<String> = taken.iter().map(|t| t.to_lowercase()).collect();
    let mut name_lower = name.to_lowercase();
    if taken_lower.contains(&name_lower) {
        let stem: String = name.chars().take(26).collect();
        let mut n = 2;
        loop {
            name = format!("{stem} ({n})");
            name_lower = name.to_lowercase();
            if !taken_lower.contains(&name_lower) {
                break;
            }
            n += 1;
        }
    }
    name
}

/// One open sheet's XML state.
struct SheetState {
    name: String,
    /// Excel row number of the NEXT data row (1-based; header is row 1).
    next_row: u32,
    column_count: usize,
}

/// Streaming workbook writer over any `Write + Seek` target.
pub struct StreamingXlsxWriter<W: Write + Seek> {
    zip: ZipWriter<W>,
    headers: Vec<String>,
    sheets: Vec<SheetState>,
    current: Option<SheetState>,
    max_data_rows: u32,
    auto_filter: bool,
}

impl<W: Write + Seek> StreamingXlsxWriter<W> {
    /// Column widths come from headers only (clamped 10–50 chars); the
    /// header row is bold via style `s="1"`.
    pub fn new(inner: W) -> Result<Self> {
        Ok(Self {
            zip: ZipWriter::new(inner),
            headers: Vec::new(),
            sheets: Vec::new(),
            current: None,
            max_data_rows: EXCEL_MAX_TOTAL_ROWS - 1,
            auto_filter: true,
        })
    }

    /// Begin the first sheet. `headers` double as the bold header row.
    pub fn begin(&mut self, base_sheet_name: &str, headers: &[String]) -> Result<()> {
        self.headers = headers.to_vec();
        let name = sanitize_sheet_name(base_sheet_name, &[]);
        self.open_sheet(name)
    }

    fn open_sheet(&mut self, name: String) -> Result<()> {
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        self.zip
            .start_file(format!("xl/worksheets/sheet{}.xml", self.sheets.len() + 1), options)
            .map_err(|e| AppError::Io(e.into()))?;

        let column_count = self.headers.len();
        let mut xml = String::with_capacity(4096);
        xml.push_str(&format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <worksheet xmlns=\"{XML_MAIN_NS}\">"
        ));
        // Column widths from header lengths (clamped); cols must precede sheetData.
        if column_count > 0 {
            xml.push_str("<cols>");
            for (i, header) in self.headers.iter().enumerate() {
                let width = (header.chars().count() as f64 * 1.2 + 2.0).clamp(10.0, 50.0);
                xml.push_str(&format!(
                    "<col min=\"{}\" max=\"{}\" width=\"{width:.1}\" customWidth=\"1\"/>",
                    i + 1,
                    i + 1
                ));
            }
            xml.push_str("</cols>");
        }
        xml.push_str("<sheetData>");
        // Header row (bold).
        xml.push_str("<row r=\"1\">");
        for (i, header) in self.headers.iter().enumerate() {
            xml.push_str(&format!(
                "<c r=\"{}1\" t=\"inlineStr\" s=\"1\"><is><t xml:space=\"preserve\">{}</t></is></c>",
                column_letter(i as u32 + 1),
                xml_escape(header)
            ));
        }
        xml.push_str("</row>");

        self.zip
            .write_all(xml.as_bytes())
            .map_err(AppError::Io)?;
        self.current = Some(SheetState { name, next_row: 2, column_count });
        Ok(())
    }

    /// Append one data row; rolls over to a fresh sheet at Excel's cap.
    pub fn push_row(&mut self, values: &[RowValue]) -> Result<()> {
        if self.current.is_none() {
            return Err(AppError::Db("xlsx sheet not started".into()));
        }
        if self.current.as_ref().unwrap().next_row > self.max_data_rows + 1 {
            // Overflow: close the current sheet entry, open the next one.
            self.close_current_sheet()?;
            let taken: Vec<String> = self.sheets.iter().map(|s| s.name.clone()).collect();
            let base = self.sheets.first().map(|s| s.name.clone()).unwrap_or_default();
            self.open_sheet(sanitize_sheet_name(&base, &taken))?;
        }
        let sheet = self.current.as_mut().unwrap();
        let row_number = sheet.next_row;
        let mut xml = format!("<row r=\"{row_number}\">");
        for (i, value) in values.iter().enumerate() {
            let reference = format!("{}{}", column_letter(i as u32 + 1), row_number);
            xml.push_str(&cell_xml(&reference, value));
        }
        xml.push_str("</row>");
        self.zip
            .write_all(xml.as_bytes())
            .map_err(AppError::Io)?;
        sheet.next_row += 1;
        Ok(())
    }

    /// Close the open sheet's XML entry; returns its name.
    fn close_current_sheet(&mut self) -> Result<String> {
        let sheet = self.current.take().ok_or_else(|| AppError::Db("xlsx sheet not started".into()))?;
        let last_data_row = sheet.next_row - 1;
        let mut xml = String::from("</sheetData>");
        if self.auto_filter && sheet.column_count > 0 && last_data_row >= 1 {
            let last_col = column_letter(sheet.column_count as u32);
            xml.push_str(&format!(
                "<autoFilter ref=\"A1:{last_col}{last_data_row}\"/>"
            ));
        }
        xml.push_str("</worksheet>");
        self.zip
            .write_all(xml.as_bytes())
            .map_err(AppError::Io)?;
        self.sheets.push(SheetState { name: sheet.name, next_row: sheet.next_row, column_count: sheet.column_count });
        Ok(self.sheets.last().unwrap().name.clone())
    }

    /// Finalize all remaining parts and flush the ZIP. Returns the inner
    /// writer so the caller can report the file size.
    pub fn finish(mut self) -> Result<(W, Vec<String>)> {
        if self.current.is_some() {
            self.close_current_sheet()?;
        }
        let sheet_names: Vec<String> = self.sheets.iter().map(|s| s.name.clone()).collect();
        let count = sheet_names.len();
        let options =
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        // styles.xml — minimal: font 0 normal, font 1 bold (style s="1").
        self.zip.start_file("xl/styles.xml", options).map_err(|e| AppError::Io(e.into()))?;
        self.zip.write_all(
            b"<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
              <styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">\
              <fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font>\
              <font><b/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts>\
              <fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill>\
              <fill><patternFill patternType=\"gray125\"/></fill></fills>\
              <borders count=\"1\"><border/></borders>\
              <cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs>\
              <cellXfs count=\"2\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/>\
              <xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/></cellXfs>\
              </styleSheet>",
        ).map_err(AppError::Io)?;

        // workbook.xml
        self.zip.start_file("xl/workbook.xml", options).map_err(|e| AppError::Io(e.into()))?;
        let mut xml = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <workbook xmlns=\"{XML_MAIN_NS}\" xmlns:r=\"{XML_REL_NS}\"><sheets>"
        );
        for (i, name) in sheet_names.iter().enumerate() {
            xml.push_str(&format!(
                "<sheet name=\"{}\" sheetId=\"{}\" r:id=\"rId{}\"/>",
                xml_escape(name),
                i + 1,
                i + 1
            ));
        }
        xml.push_str("</sheets></workbook>");
        self.zip.write_all(xml.as_bytes()).map_err(AppError::Io)?;

        // xl/_rels/workbook.xml.rels — sheets then styles.
        self.zip
            .start_file("xl/_rels/workbook.xml.rels", options)
            .map_err(|e| AppError::Io(e.into()))?;
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        );
        for i in 0..count {
            xml.push_str(&format!(
                "<Relationship Id=\"rId{}\" Type=\"{XML_REL_NS}/worksheet\" Target=\"worksheets/sheet{}.xml\"/>",
                i + 1,
                i + 1
            ));
        }
        xml.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"{XML_REL_NS}/styles\" Target=\"styles.xml\"/>",
            count + 1
        ));
        xml.push_str("</Relationships>");
        self.zip.write_all(xml.as_bytes()).map_err(AppError::Io)?;

        // [Content_Types].xml
        self.zip.start_file("[Content_Types].xml", options).map_err(|e| AppError::Io(e.into()))?;
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
             <Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
             <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
             <Default Extension=\"xml\" ContentType=\"application/xml\"/>\
             <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>\
             <Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>",
        );
        for i in 0..count {
            xml.push_str(&format!(
                "<Override PartName=\"/xl/worksheets/sheet{}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
                i + 1
            ));
        }
        xml.push_str("</Types>");
        self.zip.write_all(xml.as_bytes()).map_err(AppError::Io)?;

        // _rels/.rels — package root relationship.
        self.zip.start_file("_rels/.rels", options).map_err(|e| AppError::Io(e.into()))?;
        self.zip.write_all(
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
                 <Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
                 <Relationship Id=\"rId1\" Type=\"{XML_REL_NS}/officeDocument\" Target=\"xl/workbook.xml\"/>\
                 </Relationships>"
            )
            .as_bytes(),
        ).map_err(AppError::Io)?;

        let inner = self.zip.finish().map_err(|e| AppError::Io(e.into()))?;
        Ok((inner, sheet_names))
    }
}

/// One `<c>` cell for a value. Numbers are native; everything else is an
/// inline string (NULL → empty cell). NaN/Infinity degrade to text.
fn cell_xml(reference: &str, value: &RowValue) -> String {
    match value {
        RowValue::Null => format!("<c r=\"{reference}\"/>"),
        RowValue::Int(v) => format!("<c r=\"{reference}\"><v>{v}</v></c>"),
        RowValue::UInt(v) => format!("<c r=\"{reference}\"><v>{v}</v></c>"),
        RowValue::Float(v) => {
            if v.is_finite() {
                format!("<c r=\"{reference}\"><v>{v}</v></c>")
            } else {
                format!(
                    "<c r=\"{reference}\" t=\"inlineStr\"><is><t>{}</t></is></c>",
                    v
                )
            }
        }
        RowValue::Str(v) => format!(
            "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            xml_escape(v)
        ),
        RowValue::Bytes(bytes) => {
            let mut hex = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                hex.push_str(&format!("{b:02X}"));
            }
            format!(
                "<c r=\"{reference}\" t=\"inlineStr\"><is><t>0x{hex}</t></is></c>"
            )
        }
        RowValue::Date(v) | RowValue::Time(v) | RowValue::Datetime(v) => format!(
            "<c r=\"{reference}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">{}</t></is></c>",
            xml_escape(v)
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    /// Build a workbook into an in-memory buffer.
    fn build(rows: Vec<Vec<RowValue>>, max_data_rows: u32) -> Vec<u8> {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = StreamingXlsxWriter::new(cursor).unwrap();
        writer.max_data_rows = max_data_rows;
        writer
            .begin("items", &["id".to_string(), "name".to_string()])
            .unwrap();
        for row in &rows {
            writer.push_row(row).unwrap();
        }
        let (mut file, _names) = writer.finish().unwrap();
        file.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();
        buffer
    }

    fn read_entry(buffer: &[u8], name: &str) -> String {
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(buffer)).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut text = String::new();
        entry.read_to_string(&mut text).unwrap();
        text
    }

    #[test]
    fn writes_headers_rows_and_escapes_xml() {
        let buffer = build(
            vec![
                vec![RowValue::Int(1), RowValue::Str("plain".into())],
                vec![RowValue::Int(2), RowValue::Str("<b>&\"quote\"</b>".into())],
                vec![RowValue::Null, RowValue::Float(2.5)],
            ],
            EXCEL_MAX_TOTAL_ROWS - 1,
        );

        let sheet = read_entry(&buffer, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<is><t xml:space=\"preserve\">plain</t></is>"));
        assert!(sheet.contains("&lt;b&gt;&amp;&quot;quote&quot;&lt;/b&gt;"));
        assert!(sheet.contains("<c r=\"A2\"><v>1</v></c>"));
        assert!(sheet.contains("<c r=\"A4\"/>")); // NULL → empty cell
        assert!(sheet.contains("<v>2.5</v>"));
        // Bold header + auto filter present.
        assert!(sheet.contains("s=\"1\""));
        assert!(sheet.contains("<autoFilter ref=\"A1:B4\"/>"));

        let workbook = read_entry(&buffer, "xl/workbook.xml");
        assert!(workbook.contains("<sheet name=\"items\" sheetId=\"1\""));
        assert!(read_entry(&buffer, "[Content_Types].xml").contains("sheet1.xml"));
    }

    #[test]
    fn overflow_creates_new_sheet_with_repeated_header() {
        let rows: Vec<Vec<RowValue>> = (0..4)
            .map(|i| vec![RowValue::Int(i)])
            .collect();
        // Cap at 2 data rows → rows 3 and 4 land on sheet 2.
        let buffer = build(rows, 2);

        let sheet1 = read_entry(&buffer, "xl/worksheets/sheet1.xml");
        let sheet2 = read_entry(&buffer, "xl/worksheets/sheet2.xml");
        assert!(sheet1.contains("<v>1</v>"));
        assert!(!sheet1.contains("<v>2</v>"));
        assert!(sheet2.contains("<v>2</v>"));
        assert!(sheet2.contains("<v>3</v>"));
        // Header repeated on the overflow sheet.
        assert_eq!(sheet2.matches(">id<").count(), 1);
        // Workbook lists both sheets; content types cover both.
        assert!(read_entry(&buffer, "xl/workbook.xml").contains("sheetId=\"2\""));
        assert!(read_entry(&buffer, "[Content_Types].xml").contains("sheet2.xml"));
    }

    #[test]
    fn sheet_names_sanitize_and_dedupe() {
        assert_eq!(sanitize_sheet_name("order_items", &[]), "order_items");
        assert_eq!(sanitize_sheet_name("a/b:c*", &[]), "a b c");
        let taken = vec!["items".to_string(), "items (2)".to_string()];
        assert_eq!(sanitize_sheet_name("items", &taken), "items (3)");
        let long = "x".repeat(40);
        assert_eq!(sanitize_sheet_name(&long, &[]).chars().count(), 31);
    }

    #[test]
    fn binary_and_datetime_cells_render_as_text() {
        let cursor = std::io::Cursor::new(Vec::new());
        let mut writer = StreamingXlsxWriter::new(cursor).unwrap();
        writer.begin("t", &["payload".to_string()]).unwrap();
        writer
            .push_row(&[
                RowValue::Bytes(vec![0xDE, 0xAD]),
                RowValue::Datetime("2026-01-02 03:04:05".into()),
            ])
            .unwrap();
        let (mut file, names) = writer.finish().unwrap();
        assert_eq!(names, vec!["t".to_string()]);
        file.seek(std::io::SeekFrom::Start(0)).unwrap();
        let mut buffer = Vec::new();
        file.read_to_end(&mut buffer).unwrap();
        let sheet = read_entry(&buffer, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<t>0xDEAD</t>"));
        assert!(sheet.contains("2026-01-02 03:04:05"));
    }
}

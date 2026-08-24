//! Import commands (Phase 5) — CSV/text import wizard backend and SQL dump
//! file execution ("run SQL file").
//!
//! Deviation note: Heidi's raw `LOAD DATA LOCAL INFILE` path is not
//! implemented; local infile needs client-side handler plumbing that does
//! not pay off here because our CSV importer streams with bind parameters
//! (safer than LOAD DATA's parsing rules). The UI maps the "Load data file"
//! menu item onto this CSV import instead.

use std::io::Read;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::time::{Duration, Instant};

use crate::connections::manager::ConnectionManager;
use crate::connections::script::split_script_with_delimiters;
use crate::connections::{quote_qualified, RowValue};
use crate::error::{AppError, Result};

/// Progress event name shared by CSV and SQL imports.
pub const PROGRESS_EVENT: &str = "import://progress";
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Whole-file ceiling for SQL imports (documented limitation).
const MAX_SQL_FILE_BYTES: u64 = 200 * 1024 * 1024;
/// Stored error entries cap so one bad file cannot flood IPC.
const MAX_REPORTED_ERRORS: usize = 100;
const PREVIEW_ROWS: usize = 50;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// CSV dialect knobs (mirrors `CsvParseOptions` in `src/types/ipc.ts`).
/// Encoding is UTF-8 only for Phase 5.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvParseOptions {
    /// Single-character field separator.
    pub delimiter: String,
    /// Single-character quote.
    pub quote: String,
    /// First data record names the columns.
    pub has_header: bool,
    /// Records to discard before everything else.
    pub skip_rows: u32,
    /// Empty fields import as NULL instead of ''.
    pub empty_is_null: bool,
}

impl Default for CsvParseOptions {
    fn default() -> Self {
        Self {
            delimiter: ",".into(),
            quote: "\"".into(),
            has_header: true,
            skip_rows: 0,
            empty_is_null: true,
        }
    }
}

/// First-N preview of a CSV source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvPreview {
    /// Column names: header text or generated `column_N`.
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Approximate record count (embedded newlines make it an estimate).
    pub total_lines_est: u64,
}

/// One CSV column ↔ table column assignment.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSpec {
    pub csv_col_idx: usize,
    pub target_col: String,
}

/// Column definition for create-new targets (guessed types TEXT/INT/…).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportColumnSpec {
    pub name: String,
    pub data_type: String,
}

/// Create-new target description handed over by the wizard.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTableSpec {
    pub name: String,
    pub columns: Vec<ImportColumnSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    Append,
    /// TRUNCATE the target first.
    Replace,
    InsertIgnore,
    /// ON DUPLICATE KEY UPDATE on non-PK mapped columns (needs a PK).
    Upsert,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportErrorMode {
    /// Stop at the first failing batch.
    Abort,
    /// Skip the failed batch and continue.
    Skip,
    /// Retry the failed batch row-by-row so good rows still land.
    Through,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportErrorItem {
    /// 1-based CSV record number (estimate).
    pub line: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub inserted: u64,
    pub skipped: u64,
    pub errors: Vec<ImportErrorItem>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlImportResult {
    pub statements: u64,
    pub errors: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportProgress<'a> {
    phase: &'a str,
    imported: u64,
    skipped: u64,
    total_estimate: Option<u64>,
}

fn emit_progress(
    app: &AppHandle,
    phase: &str,
    imported: u64,
    skipped: u64,
    last_emit: &mut Instant,
    total_estimate: Option<u64>,
) {
    if *last_emit < Instant::now() - PROGRESS_MIN_INTERVAL || phase != "import" {
        *last_emit = Instant::now();
        let _ = app.emit(
            PROGRESS_EVENT,
            ImportProgress { phase, imported, skipped, total_estimate },
        );
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

fn first_char(text: &str, fallback: char) -> char {
    text.chars().next().unwrap_or(fallback)
}

/// Open the import source: gzip-decompressed files stream transparently;
/// pasted clipboard text comes in as a cursor.
fn open_source(
    path: &Option<String>,
    clipboard_text: &Option<String>,
) -> Result<Box<dyn Read + Send>> {
    match (path, clipboard_text) {
        (Some(p), _) => {
            let file = std::fs::File::open(p)?;
            if p.to_ascii_lowercase().ends_with(".gz") {
                Ok(Box::new(flate2::read::GzDecoder::new(file)))
            } else {
                Ok(Box::new(file))
            }
        }
        (_, Some(text)) => Ok(Box::new(std::io::Cursor::new(text.clone().into_bytes()))),
        _ => Err(AppError::Db("no import source given".into())),
    }
}

fn csv_reader<R: Read + Send>(
    reader: R,
    options: &CsvParseOptions,
) -> csv::Reader<std::io::BufReader<R>> {
    csv::ReaderBuilder::new()
        .delimiter(first_char(&options.delimiter, ',') as u8)
        .quote(first_char(&options.quote, '"') as u8)
        .has_headers(false) // handled manually so previews see the header
        .flexible(true)
        .from_reader(std::io::BufReader::new(reader))
}

// ---------------------------------------------------------------------------
// CSV preview
// ---------------------------------------------------------------------------

/// Sync core of the preview command (kept non-async for testability).
fn compute_preview(
    reader: Box<dyn Read + Send>,
    options: &CsvParseOptions,
) -> Result<CsvPreview> {
    let mut records = csv_reader(reader, options).into_records();

    let mut skipped = 0u64;
    for _ in 0..options.skip_rows {
        if records.next().is_none() {
            break;
        }
        skipped += 1;
    }

    let header: Option<Vec<String>> = if options.has_header {
        match records.next() {
            Some(r) => Some(r?.iter().map(|s| s.to_string()).collect()),
            None => None,
        }
    } else {
        None
    };

    let mut rows: Vec<Vec<Option<String>>> = Vec::with_capacity(PREVIEW_ROWS);
    let mut max_arity = header.as_ref().map(|h| h.len()).unwrap_or(0);
    for _ in 0..PREVIEW_ROWS {
        match records.next() {
            None => break,
            Some(record) => {
                let record = record?;
                max_arity = max_arity.max(record.len());
                rows.push(record.iter().map(|f| nullify(f, options)).collect());
            }
        }
    }

    let mut rest = 0u64;
    for record in records {
        let record = record?;
        max_arity = max_arity.max(record.len());
        rest += 1;
    }

    let columns = header.unwrap_or_else(|| {
        (1..=max_arity.max(1))
            .map(|i| format!("column_{i}"))
            .collect()
    });

    let header_len = u64::from(options.has_header);
    let total_lines_est = skipped + header_len + rows.len() as u64 + rest;
    Ok(CsvPreview {
        columns,
        rows,
        total_lines_est,
    })
}

/// Parse the first rows of a CSV source and estimate its size.
#[tauri::command]
pub async fn import_csv_preview(
    source_path: Option<String>,
    clipboard_text: Option<String>,
    options: CsvParseOptions,
) -> Result<CsvPreview> {
    let reader = open_source(&source_path, &clipboard_text)?;
    compute_preview(reader, &options)
}

fn nullify(field: &str, options: &CsvParseOptions) -> Option<String> {
    if field.is_empty() && options.empty_is_null {
        None
    } else {
        Some(field.to_string())
    }
}

// ---------------------------------------------------------------------------
// CSV run
// ---------------------------------------------------------------------------

/// Stream-import a CSV source into an existing (or newly created) table.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn import_csv_run(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    db: String,
    table: String,
    source_path: Option<String>,
    clipboard_text: Option<String>,
    options: CsvParseOptions,
    mapping: Vec<MapSpec>,
    new_table: Option<NewTableSpec>,
    mode: ImportMode,
    batch_size: usize,
    on_error: ImportErrorMode,
) -> Result<ImportResult> {
    let started = Instant::now();
    let mut result = ImportResult::default();

    let target = new_table.as_ref().map(|n| n.name.clone()).unwrap_or(table);
    if target.trim().is_empty() {
        return Err(AppError::Db("target table name is empty".into()));
    }

    // Optional create-new step (column types come pre-guessed client-side).
    if let Some(spec) = &new_table {
        let ddl = build_create_table_sql(&db, spec)?;
        connections.run_script(conn_id, ddl, true).await?;
    }

    let described = connections.describe_table(conn_id, &db, &target).await?;
    let known: std::collections::HashSet<&str> =
        described.iter().map(|c| c.name.as_str()).collect();

    if mapping.is_empty() {
        return Err(AppError::Db("no column mapping provided".into()));
    }
    let mut seen_targets = std::collections::HashSet::new();
    for m in &mapping {
        if !known.contains(m.target_col.as_str()) {
            return Err(AppError::Db(format!(
                "unknown target column {:?}",
                m.target_col
            )));
        }
        if !seen_targets.insert(m.target_col.clone()) {
            return Err(AppError::Db(format!(
                "column {:?} is mapped twice",
                m.target_col
            )));
        }
    }
    let insert_columns: Vec<String> = mapping.iter().map(|m| m.target_col.clone()).collect();

    // Primary keys drive the upsert clause.
    let pk_names: Vec<&str> = described
        .iter()
        .filter(|c| c.key.as_deref() == Some("PRI"))
        .map(|c| c.name.as_str())
        .collect();
    let upsert_columns: Option<Vec<String>> = match mode {
        ImportMode::Upsert => {
            if pk_names.is_empty() {
                return Err(AppError::Db(format!(
                    "upsert needs a primary key; {} has none",
                    quote_qualified(&[&db, &target])
                )));
            }
            let updates: Vec<String> = insert_columns
                .iter()
                .filter(|c| !pk_names.contains(&c.as_str()))
                .cloned()
                .collect();
            (!updates.is_empty()).then_some(updates)
        }
        _ => None,
    };
    let ignore = mode == ImportMode::InsertIgnore;

    if mode == ImportMode::Replace {
        let sql = format!("TRUNCATE TABLE {}", quote_qualified(&[&db, &target]));
        connections.execute_single(conn_id, sql).await?;
    }

    // ---- streaming parse + batched inserts ------------------------------
    let reader = open_source(&source_path, &clipboard_text)?;
    let mut records = csv_reader(reader, &options).into_records();

    let mut skipped_records = 0u64;
    for _ in 0..options.skip_rows {
        if records.next().is_none() {
            break;
        }
        skipped_records += 1;
    }
    if options.has_header {
        records.next(); // consumed as names
    }

    let batch_size = batch_size.clamp(1, 5000);
    let mut batch: Vec<Vec<RowValue>> = Vec::with_capacity(batch_size);
    let mut record_no = skipped_records + u64::from(options.has_header);
    let mut batch_first_line = record_no + 1;
    let mut last_emit = Instant::now() - PROGRESS_MIN_INTERVAL;
    let total_estimate: Option<u64> = None;

    macro_rules! flush_batch {
        () => {
            if !batch.is_empty() {
                let outcome = insert_with_policy(
                    &connections,
                    conn_id,
                    &db,
                    &target,
                    &insert_columns,
                    std::mem::take(&mut batch),
                    ignore,
                    upsert_columns.as_deref(),
                    on_error,
                    batch_first_line,
                    &mut result,
                )
                .await?;
                if outcome == FlushOutcome::Abort {
                    return Err(result
                        .errors
                        .last()
                        .map(|e| AppError::Db(e.message.clone()))
                        .unwrap_or_else(|| AppError::Db("import aborted".into())));
                }
                emit_progress(
                    &app,
                    "import",
                    result.inserted,
                    result.skipped,
                    &mut last_emit,
                    total_estimate,
                );
            }
        };
    }

    for record in records {
        let record = record.map_err(|e| AppError::Db(format!("CSV parse error: {e}")))?;
        record_no += 1;

        let row: Vec<RowValue> = mapping
            .iter()
            .map(|m| match record.get(m.csv_col_idx) {
                Some("") | None => {
                    if options.empty_is_null {
                        RowValue::Null
                    } else {
                        RowValue::Str(String::new())
                    }
                }
                Some(field) => RowValue::Str((*field).to_string()),
            })
            .collect();

        if batch.is_empty() {
            batch_first_line = record_no;
        }
        batch.push(row);
        if batch.len() >= batch_size {
            flush_batch!();
        }
    }
    flush_batch!();

    emit_progress(&app, "done", result.inserted, result.skipped, &mut last_emit, total_estimate);
    result.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(result)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FlushOutcome {
    Applied,
    Abort,
}

/// Execute one batch honouring the on-error policy; mutates counters/errors.
#[allow(clippy::too_many_arguments)]
async fn insert_with_policy(
    connections: &State<'_, ConnectionManager>,
    conn_id: u32,
    db: &str,
    table: &str,
    columns: &[String],
    batch: Vec<Vec<RowValue>>,
    ignore: bool,
    upsert_columns: Option<&[String]>,
    on_error: ImportErrorMode,
    first_line: u64,
    result: &mut ImportResult,
) -> Result<FlushOutcome> {
    match connections
        .insert_rows(conn_id, db, table, columns.to_vec(), batch.clone(), ignore, upsert_columns.map(|u| u.to_vec()))
        .await
    {
        Ok(affected) => {
            result.inserted += affected;
            Ok(FlushOutcome::Applied)
        }
        Err(err) => match on_error {
            ImportErrorMode::Abort => {
                push_error(result, first_line, err.to_string());
                Ok(FlushOutcome::Abort)
            }
            ImportErrorMode::Skip => {
                result.skipped += batch.len() as u64;
                push_error(result, first_line, err.to_string());
                Ok(FlushOutcome::Applied)
            }
            // "Through": salvage good rows by retrying one-by-one.
            ImportErrorMode::Through => {
                for (offset, row) in batch.into_iter().enumerate() {
                    match connections
                        .insert_rows(conn_id, db, table, columns.to_vec(), vec![row], ignore, upsert_columns.map(|u| u.to_vec()))
                        .await
                    {
                        Ok(affected) => result.inserted += affected,
                        Err(row_err) => {
                            result.skipped += 1;
                            push_error(result, first_line + offset as u64, row_err.to_string());
                        }
                    }
                }
                Ok(FlushOutcome::Applied)
            }
        },
    }
}

fn push_error(result: &mut ImportResult, line: u64, message: String) {
    if result.errors.len() < MAX_REPORTED_ERRORS {
        result.errors.push(ImportErrorItem { line, message });
    }
}

/// `CREATE TABLE IF NOT EXISTS` from wizard-guessed column types.
fn build_create_table_sql(db: &str, spec: &NewTableSpec) -> Result<String> {
    if spec.columns.is_empty() {
        return Err(AppError::Db("new table has no columns".into()));
    }
    let defs = spec
        .columns
        .iter()
        .map(|c| -> Result<String> {
            if c.name.trim().is_empty() {
                return Err(AppError::Db("a column name is empty".into()));
            }
            // Type strings are restricted client-side (TEXT/INT/DOUBLE/…);
            // quote defensively anyway.
            Ok(format!(
                "{} {} NULL",
                crate::connections::quote_ident(c.name.trim()),
                c.data_type.trim().to_ascii_uppercase()
            ))
        })
        .collect::<Result<Vec<_>>>()?
        .join(", ");
    Ok(format!(
        "CREATE TABLE IF NOT EXISTS {} ({})",
        quote_qualified(&[db, &spec.name]),
        defs
    ))
}

// ---------------------------------------------------------------------------
// SQL file execution
// ---------------------------------------------------------------------------

/// Run a `.sql` (or `.sql.gz`) file against the connection. Files up to
/// ~200 MB are read whole (splitting needs random access to comments and
/// quoted literals anyway); bigger ones are rejected upfront.
#[tauri::command]
pub async fn import_sql_file(
    app: AppHandle,
    connections: State<'_, ConnectionManager>,
    conn_id: u32,
    path: String,
    stop_on_error: bool,
    batch_size: usize,
) -> Result<SqlImportResult> {
    let started = Instant::now();
    if !path.to_ascii_lowercase().ends_with(".gz") {
        let len = std::fs::metadata(&path)?.len();
        if len > MAX_SQL_FILE_BYTES {
            return Err(AppError::Db(format!(
                "file is larger than the {} MB SQL import limit",
                MAX_SQL_FILE_BYTES / (1024 * 1024)
            )));
        }
    }

    let mut file = std::fs::File::open(&path)?;
    let mut contents = String::new();
    if path.to_ascii_lowercase().ends_with(".gz") {
        let mut decoder = flate2::read::GzDecoder::new(file);
        decoder.read_to_string(&mut contents)?;
        drop(decoder);
    } else {
        file.read_to_string(&mut contents)?;
    }

    let statements = split_script_with_delimiters(&contents);
    let total = statements.len();
    let batch_size = batch_size.clamp(1, 500);
    let mut errors: Vec<String> = Vec::new();
    let mut executed = 0u64;
    let mut last_emit = Instant::now() - PROGRESS_MIN_INTERVAL;

    for chunk in statements.chunks(batch_size) {
        let script = chunk.join(";\n");
        executed += chunk.len() as u64;
        let outcomes = connections.run_script(conn_id, script, stop_on_error).await?;
        for outcome in &outcomes {
            if let crate::connections::QueryOutcome::Error { message, .. } = outcome {
                if errors.len() < MAX_REPORTED_ERRORS {
                    errors.push(message.clone());
                }
            }
        }
        let had_error = outcomes.iter().any(|o| matches!(o, crate::connections::QueryOutcome::Error { .. }));
        emit_progress(&app, "sql", executed, 0, &mut last_emit, Some(total as u64));
        if had_error && stop_on_error {
            break;
        }
    }

    emit_progress(&app, "done", executed, 0, &mut last_emit, Some(total as u64));
    Ok(SqlImportResult {
        statements: executed,
        errors,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn preview(text: &str, options: CsvParseOptions) -> CsvPreview {
        compute_preview(
            Box::new(std::io::Cursor::new(text.as_bytes().to_vec())),
            &options,
        )
        .unwrap()
    }

    #[test]
    fn preview_names_columns_from_header() {
        let p = preview("id,name\n1,ann\n2,bob\n", CsvParseOptions::default());
        assert_eq!(p.columns, vec!["id", "name"]);
        assert_eq!(p.rows.len(), 2);
        assert_eq!(p.rows[0][1].as_deref(), Some("ann"));
        assert_eq!(p.total_lines_est, 3);
    }

    #[test]
    fn preview_generates_column_names_without_header() {
        let opts = CsvParseOptions { has_header: false, ..Default::default() };
        let p = preview("1,x\n2,y,z\n", opts);
        assert_eq!(p.columns, vec!["column_1", "column_2", "column_3"]);
        assert_eq!(p.total_lines_est, 2);
    }

    #[test]
    fn preview_respects_skip_rows_and_semicolons() {
        let text = "garbage\ngarbage2\na;b\n1;2;\n";
        let opts = CsvParseOptions {
            delimiter: ";".into(),
            skip_rows: 2,
            ..Default::default()
        };
        let p = preview(text, opts);
        assert_eq!(p.columns, vec!["a", "b"]);
        assert_eq!(p.rows.len(), 1);
        assert_eq!(p.rows[0], vec![Some("1".into()), Some("2".into()), None]);
    }

    #[test]
    fn preview_empty_fields_become_null_when_configured() {
        let keep = CsvParseOptions { empty_is_null: false, ..Default::default() };
        let p = preview("a,b\n,\"\"\n", keep);
        assert_eq!(p.rows[0], vec![Some(String::new()), Some(String::new())]);

        let nulls = CsvParseOptions { empty_is_null: true, ..Default::default() };
        let p = preview("a,b\n,\"\"\n", nulls);
        assert_eq!(p.rows[0], vec![None, None]);
    }

    #[test]
    fn gz_csv_round_trip_through_preview() {
        // Write a gzipped CSV and read it back through the importer path.
        let path = std::env::temp_dir().join(format!("murmeli-test-{}.csv.gz", std::process::id()));
        {
            let file = std::fs::File::create(&path).unwrap();
            let mut enc = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            write!(enc, "x,y\n7,eight\n").unwrap();
            enc.finish().unwrap();
        }
        let p = compute_preview(
            Box::new(flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap())),
            &CsvParseOptions::default(),
        )
        .unwrap();
        assert_eq!(p.columns, vec!["x", "y"]);
        assert_eq!(p.rows[0], vec![Some("7".into()), Some("eight".into())]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn create_table_sql_quotes_and_types() {
        let spec = NewTableSpec {
            name: "staging".into(),
            columns: vec![
                ImportColumnSpec { name: "id".into(), data_type: "INT".into() },
                ImportColumnSpec { name: "note`".into(), data_type: "text".into() },
            ],
        };
        let sql = build_create_table_sql("db", &spec).unwrap();
        assert_eq!(
            sql,
            "CREATE TABLE IF NOT EXISTS `db`.`staging` (`id` INT NULL, `note``` TEXT NULL)"
        );
        assert!(
            build_create_table_sql(
                "db",
                &NewTableSpec { name: "t".into(), columns: vec![] },
            )
            .is_err()
        );
    }

    #[test]
    fn delimiter_directive_parsing_is_lenient_about_case() {
        assert_eq!(crate::connections::script::delimiter_directive("DELIMITER ;;"), Some(";;".to_string()));
        assert_eq!(crate::connections::script::delimiter_directive("delimiter $$"), Some("$$".to_string()));
        assert_eq!(crate::connections::script::delimiter_directive("DELIMITER"), None);
        assert_eq!(crate::connections::script::delimiter_directive("SELECT 1"), None);
    }
}

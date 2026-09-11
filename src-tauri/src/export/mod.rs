//! Export engine (Phase 5).
//!
//! Streams grid rows, query results and full SQL dumps into files (optionally
//! gzipped), the system clipboard or another server connection. Design rules:
//!
//! - **No giant IPC payloads**: file writes happen here in Rust; only an
//!   [`ExportResult`] summary crosses back to the UI.
//! - **Bounded memory**: rows are pulled through `stream_table_rows` /
//!   `stream_query_rows` in chunks and pushed straight into the formatter;
//!   at most one chunk and one INSERT batch live in RAM at any time.
//! - **Cooperative cancellation**: every run registers an id + AtomicBool;
//!   `export_cancel(id)` flips it, loops check it between chunks and hang up
//!   the row stream (the driver stops fetching once its channel receiver is
//!   gone).
//! - **Progress**: `export://progress` events (throttled to ~100 ms) carry
//!   `{id, phase, table, rowsDone, totalTables, bytes}`.

pub mod formatters;
pub mod sql_dump;
pub mod xlsx;

use std::collections::HashMap;
use std::io::Write as IoWrite;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use flate2::write::GzEncoder;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::connections::dialect::SqlDialect;
use crate::connections::manager::ConnectionManager;
use crate::connections::{
    quote_qualified, ObjectKind, ResultColumnMeta, RoutineKind, RowValue, RowsChunk,
};
use crate::error::{AppError, Result};

use formatters::{make_formatter, CsvConfig, RowFormatter};
use sql_dump::{DataStatement, SqlDumpOptions};

/// Progress event name (frontend listens via `@tauri-apps/api/event`).
pub const PROGRESS_EVENT: &str = "export://progress";
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);

/// Clipboard payloads above this size are rejected (Heidi parity).
const CLIPBOARD_MAX_BYTES: u64 = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// Output syntax of a grid/query export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Xml,
    Html,
    Markdown,
    Latex,
    Php,
    Textile,
    SqlInserts,
    /// Copy-as variant of SqlInserts (`REPLACE INTO`, upsert semantics).
    SqlReplaces,
    /// Copy-as UPDATE statements (needs PK columns among the exported ones).
    SqlUpdates,
    /// Native Excel workbook (streaming ZIP+OOXML writer; file output only).
    Xlsx,
}

impl ExportFormat {
    /// `(label, extensions)` pair used by native save dialogs.
    pub fn file_filter(self) -> (&'static str, &'static [&'static str]) {
        match self {
            ExportFormat::Csv => ("CSV", &["csv"]),
            ExportFormat::Tsv => ("TSV", &["tsv", "txt"]),
            ExportFormat::Json => ("JSON", &["json"]),
            ExportFormat::Xml => ("XML", &["xml"]),
            ExportFormat::Html => ("HTML", &["html"]),
            ExportFormat::Markdown => ("Markdown", &["md"]),
            ExportFormat::Latex => ("LaTeX", &["tex"]),
            ExportFormat::Php => ("PHP", &["php"]),
            ExportFormat::Textile => ("Textile", &["txt"]),
            ExportFormat::SqlInserts => ("SQL", &["sql"]),
            ExportFormat::SqlReplaces => ("SQL REPLACE", &["sql"]),
            ExportFormat::SqlUpdates => ("SQL UPDATE", &["sql"]),
            ExportFormat::Xlsx => ("Excel", &["xlsx"]),
        }
    }

    pub fn default_extension(self) -> &'static str {
        self.file_filter().1[0]
    }
}

/// Where the generated output lands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ExportDestination {
    File { path: String, gzip: bool },
    Clipboard,
    /// Run the generated INSERTs against another open connection.
    Server { conn_id: u32, db: String },
}

/// Summary returned to the frontend after a finished (or cancelled) export.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub bytes_written: u64,
    pub rows: u64,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub cancelled: bool,
}

/// Payload of `export://progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub id: u32,
    /// "structure" | "data" | "objects" | "done" | "cancelled".
    pub phase: String,
    pub table: Option<String>,
    pub rows_done: u64,
    pub total_tables: usize,
    pub bytes: u64,
}

/// Per-object request for DDL export (designer parity).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlObjectRequest {
    pub db: String,
    pub kind: ObjectKind,
    pub name: String,
    /// Required when `kind` is routine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routine_kind: Option<RoutineKind>,
}

// ---------------------------------------------------------------------------
// Cancellation registry
// ---------------------------------------------------------------------------

static NEXT_EXPORT_ID: AtomicU32 = AtomicU32::new(1);

fn cancel_map() -> &'static Mutex<HashMap<u32, Arc<AtomicBool>>> {
    static MAP: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Shared cancel flag for one running export.
#[derive(Clone)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

/// Lock helper: recover the inner guard instead of panicking when another
/// thread panicked while holding the registry. The map itself stays valid
/// (plain insert/remove), so poisoning costs nothing here.
fn lock_cancel_map() -> std::sync::MutexGuard<'static, HashMap<u32, Arc<AtomicBool>>> {
    cancel_map().lock().unwrap_or_else(|e| e.into_inner())
}

/// Register a fresh export run; returns its event id and cancel token.
pub fn begin_export() -> (u32, CancelToken) {
    let id = NEXT_EXPORT_ID.fetch_add(1, Ordering::Relaxed);
    let token = Arc::new(AtomicBool::new(false));
    lock_cancel_map().insert(id, token.clone());
    (id, CancelToken(token))
}

/// Flip the flag for `id`; true when a run was actually registered.
pub fn request_cancel(id: u32) -> bool {
    match lock_cancel_map().get(&id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// Forget a finished run's token. Shared by the Phase 7 find-text scanner,
/// which reuses this registry (and its id space) for cancellation.
pub fn end_export(id: u32) {
    lock_cancel_map().remove(&id);
}

// ---------------------------------------------------------------------------
// Output sinks
// ---------------------------------------------------------------------------

enum SinkInner {
    File(std::io::BufWriter<std::fs::File>),
    Gzip(Box<GzEncoder<std::io::BufWriter<std::fs::File>>>),
    Memory(Vec<u8>),
}

impl IoWrite for SinkInner {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            SinkInner::File(w) => w.write(buf),
            SinkInner::Gzip(w) => w.write(buf),
            // Memory never short-writes.
            SinkInner::Memory(v) => {
                v.extend_from_slice(buf);
                Ok(buf.len())
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            SinkInner::File(w) => w.flush(),
            SinkInner::Gzip(w) => w.flush(),
            SinkInner::Memory(_) => Ok(()),
        }
    }
}

/// Byte-counting wrapper over a sink (progress + result reporting).
pub(crate) struct CountingWriter {
    inner: SinkInner,
    bytes: u64,
}

impl IoWrite for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// Accumulates INSERT statement text and splits it into bounded script
/// chunks at newline boundaries (every INSERT ends with `;\n`, so chunk
/// edges never cut a statement apart). Used by server-to-server exports.
#[derive(Default)]
pub struct StatementBuffer {
    current: String,
    chunks: Vec<String>,
}

const STATEMENT_CHUNK_TARGET: usize = 256 * 1024;

impl StatementBuffer {
    fn total_bytes(&self) -> u64 {
        self.chunks.iter().map(|c| c.len() as u64).sum::<u64>() + self.current.len() as u64
    }

    fn drain_chunks(&mut self) -> Vec<String> {
        if !self.current.trim().is_empty() {
            let tail = std::mem::take(&mut self.current);
            self.chunks.push(tail);
        } else {
            self.current.clear();
        }
        std::mem::take(&mut self.chunks)
    }
}

impl IoWrite for StatementBuffer {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.current.push_str(&String::from_utf8_lossy(buf));
        if self.current.len() >= STATEMENT_CHUNK_TARGET && self.current.ends_with('\n') {
            let full = std::mem::take(&mut self.current);
            self.chunks.push(full);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Output target for one export run: a byte writer backed by file, gzip or
/// memory, or a statement buffer executed on another connection afterwards.
pub enum ExportOutput {
    Writer(Box<CountingWriter>, ExportDestination),
    ServerStatements(StatementBuffer, u32),
}

impl ExportOutput {
    /// Open the output for `dest`. Unless `overwrite` is set, an existing
    /// file yields [`AppError::Exists`] so the UI can confirm first.
    pub fn open(dest: &ExportDestination, overwrite: bool) -> Result<Self> {
        match dest {
            ExportDestination::File { path, gzip } => {
                let p = PathBuf::from(path);
                let mut opts = std::fs::OpenOptions::new();
                opts.write(true);
                if overwrite {
                    opts.create(true).truncate(true);
                } else {
                    opts.create_new(true);
                }
                let file = opts.open(&p).map_err(|e| {
                    if e.kind() == std::io::ErrorKind::AlreadyExists {
                        AppError::Exists(p.display().to_string())
                    } else {
                        e.into()
                    }
                })?;
                let buffered = std::io::BufWriter::with_capacity(64 * 1024, file);
                let inner = if *gzip {
                    SinkInner::Gzip(Box::new(GzEncoder::new(buffered, flate2::Compression::default())))
                } else {
                    SinkInner::File(buffered)
                };
                Ok(ExportOutput::Writer(
                    Box::new(CountingWriter { inner, bytes: 0 }),
                    dest.clone(),
                ))
            }
            ExportDestination::Clipboard => Ok(ExportOutput::Writer(
                Box::new(CountingWriter { inner: SinkInner::Memory(Vec::new()), bytes: 0 }),
                dest.clone(),
            )),
            ExportDestination::Server { conn_id, .. } => {
                Ok(ExportOutput::ServerStatements(StatementBuffer::default(), *conn_id))
            }
        }
    }

    pub fn write_str(&mut self, text: &str) -> Result<()> {
        IoWrite::write_all(writer_of(self), text.as_bytes())?;
        Ok(())
    }

    pub fn bytes_so_far(&self) -> u64 {
        match self {
            ExportOutput::Writer(w, _) => w.bytes,
            ExportOutput::ServerStatements(buf, _) => buf.total_bytes(),
        }
    }

    /// Flush/close the underlying medium. Clipboard content is validated
    /// against the size cap and written atomically here. For server targets,
    /// buffered INSERT batches execute through `manager` unless `run_server`
    /// is false (cancelled runs discard them instead of importing halfway).
    pub async fn finish(
        self,
        app: &AppHandle,
        manager: Option<&ConnectionManager>,
        run_server: bool,
    ) -> Result<u64> {
        match self {
            ExportOutput::Writer(mut w, dest) => {
                w.flush()?;
                let bytes = w.bytes;
                if let ExportDestination::Clipboard = dest {
                    // Swap the buffer out so it can be moved into the
                    // clipboard writer while the counting wrapper stays
                    // intact for dropping.
                    let taken =
                        std::mem::replace(&mut w.inner, SinkInner::Memory(Vec::new()));
                    let SinkInner::Memory(buf) = taken else {
                        unreachable!("clipboard sink is memory-backed")
                    };
                    if buf.len() as u64 > CLIPBOARD_MAX_BYTES {
                        return Err(AppError::Db(format!(
                            "clipboard export exceeds the {} MB limit",
                            CLIPBOARD_MAX_BYTES / (1024 * 1024)
                        )));
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    use tauri_plugin_clipboard_manager::ClipboardExt;
                    app.clipboard()
                        .write_text(text)
                        .map_err(|e| AppError::Db(format!("clipboard write failed: {e}")))?;
                }
                // Dropping closes files and finalizes the gzip footer.
                drop(w);
                Ok(bytes)
            }
            ExportOutput::ServerStatements(mut buffer, conn_id) => {
                let chunks = buffer.drain_chunks();
                let bytes: u64 = chunks.iter().map(|c| c.len() as u64).sum();
                if let (Some(manager), true) = (manager, run_server) {
                    for chunk in chunks {
                        execute_script_on_target(manager, conn_id, chunk).await?;
                    }
                }
                Ok(bytes)
            }
        }
    }
}

async fn execute_script_on_target(
    manager: &ConnectionManager,
    conn_id: u32,
    script: String,
) -> Result<()> {
    let outcomes = manager.run_script(conn_id, script, false).await?;
    if let Some(err) = outcomes.iter().find_map(|o| match o {
        crate::connections::QueryOutcome::Error { message, .. } => Some(message.clone()),
        _ => None,
    }) {
        return Err(AppError::Db(format!("target import failed: {err}")));
    }
    Ok(())
}

/// Mutable write access to the output's byte sink.
fn writer_of(output: &mut ExportOutput) -> &mut dyn IoWrite {
    match output {
        ExportOutput::Writer(w, _) => &mut **w,
        ExportOutput::ServerStatements(buf, _) => buf,
    }
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

/// Emits throttled `export://progress` events for one run.
pub struct ProgressReporter<'a> {
    app: &'a AppHandle,
    pub id: u32,
    pub total_tables: usize,
    last_emit: Instant,
}

impl<'a> ProgressReporter<'a> {
    pub fn new(app: &'a AppHandle, id: u32, total_tables: usize) -> Self {
        Self { app, id, total_tables, last_emit: Instant::now() - PROGRESS_MIN_INTERVAL }
    }

    pub fn emit_now(&self, phase: &str, table: Option<&str>, rows_done: u64, bytes: u64) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            ExportProgress {
                id: self.id,
                phase: phase.into(),
                table: table.map(|t| t.to_string()),
                rows_done,
                total_tables: self.total_tables,
                bytes,
            },
        );
    }

    pub fn emit_throttled(&mut self, phase: &str, table: Option<&str>, rows_done: u64, bytes: u64) {
        if self.last_emit.elapsed() >= PROGRESS_MIN_INTERVAL {
            self.last_emit = Instant::now();
            self.emit_now(phase, table, rows_done, bytes);
        }
    }
}

// ---------------------------------------------------------------------------
// Chunked row streaming
// ---------------------------------------------------------------------------

/// What rows to export: a whole table or the result of one SELECT.
#[derive(Debug, Clone)]
pub enum RowSource {
    Table { db: String, table: String },
    Sql(String),
}

/// Outcome of a streamed read.
pub struct StreamStats {
    pub rows: u64,
    pub cancelled: bool,
}

/// Pull rows chunk-by-chunk from the connection actor and feed them to
/// `on_chunk(columns, rows, first_row_index)`. Cancels cooperatively; the
/// pending DB fetch aborts when this future stops draining its channel.
pub async fn stream_rows(
    manager: &ConnectionManager,
    conn_id: u32,
    source: &RowSource,
    chunk_size: usize,
    cancel: &CancelToken,
    mut on_chunk: impl FnMut(&[ResultColumnMeta], &[Vec<RowValue>], u64) -> Result<()>,
) -> Result<StreamStats> {
    const CHANNEL_CAPACITY: usize = 4;

    let (tx, mut rx) =
        tokio::sync::mpsc::channel::<crate::error::Result<RowsChunk>>(CHANNEL_CAPACITY);
    match source {
        RowSource::Table { db, table } => {
            manager.stream_table_rows(conn_id, db, table, chunk_size, tx).await?
        }
        RowSource::Sql(sql) => {
            manager.stream_query_rows(conn_id, sql.clone(), chunk_size, tx).await?
        }
    }

    let mut rows_total = 0u64;
    let mut cancelled = false;
    let mut tick = tokio::time::interval(Duration::from_millis(120));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = tick.tick() => {
                if cancel.is_cancelled() {
                    cancelled = true;
                    break;
                }
            }
            msg = rx.recv() => match msg {
                None => break,
                Some(Ok(chunk)) => {
                    let count = chunk.rows.len() as u64;
                    on_chunk(&chunk.columns, &chunk.rows, rows_total)?;
                    rows_total += count;
                    if cancel.is_cancelled() {
                        cancelled = true;
                        break;
                    }
                }
                Some(Err(err)) => return Err(err),
            }
        }
    }

    Ok(StreamStats { rows: rows_total, cancelled })
}

// ---------------------------------------------------------------------------
// Grid / query-result exports
// ---------------------------------------------------------------------------

/// Per-run knobs for grid exports coming from the dialog.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GridExportOptions {
    pub delimiter: Option<String>,
    pub quote: Option<String>,
    pub null_text: Option<String>,
    /// Primary-key column names for the SqlUpdates format (copy-as UPDATE).
    pub pk_columns: Option<Vec<String>>,
}

impl GridExportOptions {
    fn csv_config(&self) -> CsvConfig {
        CsvConfig {
            delimiter: self.delimiter.as_deref().and_then(|d| d.chars().next()).unwrap_or(','),
            quote: self.quote.as_deref().and_then(|q| q.chars().next()).unwrap_or('"'),
            null_text: self.null_text.clone().unwrap_or_default(),
        }
    }
}

/// Export grid rows (table scan, one SELECT, or an explicit client-side
/// selection) in the requested format/destination.
#[allow(clippy::too_many_arguments)]
pub async fn export_grid(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    db: Option<String>,
    table: Option<String>,
    sql: Option<String>,
    selection: Option<(Vec<String>, Vec<Vec<RowValue>>)>,
    format: ExportFormat,
    destination: ExportDestination,
    options: GridExportOptions,
    overwrite: bool,
) -> Result<ExportResult> {
    let started = Instant::now();
    let (id, cancel) = begin_export();

    if matches!(destination, ExportDestination::Server { .. }) && format != ExportFormat::SqlInserts {
        end_export(id);
        return Err(AppError::Db(
            "server-to-server export only supports the SQL INSERTS format".into(),
        ));
    }
    // XLSX is a binary ZIP: clipboard text and server statements don't apply.
    if format == ExportFormat::Xlsx && !matches!(destination, ExportDestination::File { .. }) {
        end_export(id);
        return Err(AppError::Db("XLSX export supports file destinations only".into()));
    }
    if format == ExportFormat::Xlsx {
        let result = run_grid_xlsx_inner(
            app, manager, conn_id, db, table, sql, selection, &destination, overwrite, id, &cancel,
            started,
        )
        .await;
        end_export(id);
        return result;
    }

    let result = run_grid_inner(
        app, manager, conn_id, db, table, sql, selection, format, &destination, &options,
        overwrite, id, &cancel, started,
    )
    .await;

    end_export(id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_grid_inner(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    db: Option<String>,
    table: Option<String>,
    sql: Option<String>,
    selection: Option<(Vec<String>, Vec<Vec<RowValue>>)>,
    format: ExportFormat,
    destination: &ExportDestination,
    options: &GridExportOptions,
    overwrite: bool,
    id: u32,
    cancel: &CancelToken,
    started: Instant,
) -> Result<ExportResult> {
    // UPDATE exports are meaningless without a key to match rows on.
    let pk_columns = options.pk_columns.clone().unwrap_or_default();
    if format == ExportFormat::SqlUpdates
        && (pk_columns.is_empty()
            || selection
                .as_ref()
                .map(|(cols, _)| cols.len() <= pk_columns.len())
                .unwrap_or(false))
    {
        return Err(AppError::Db(
            "UPDATE export needs primary-key columns plus at least one other column".into(),
        ));
    }
    // Server exports requalify INSERTs with the TARGET database.
    let target_db = match destination {
        ExportDestination::Server { db, .. } => db.clone(),
        _ => db.clone().unwrap_or_default(),
    };
    let table_name = table.clone().unwrap_or_else(|| "result".to_string());
    let table_q = quote_qualified(&[&target_db, &table_name]);
    let statement = sql.clone().unwrap_or_else(|| {
        format!("SELECT * FROM {}", quote_qualified(&[&target_db, &table_name]))
    });

    let mut output = ExportOutput::open(destination, overwrite)?;

    // Selection export: rows already live client-side; no DB round-trip.
    if let Some((cols, sel_rows)) = selection {
        let mut fmt = make_formatter(
            format,
            options.csv_config(),
            &statement,
            &table_q,
            false,
            false,
            &pk_columns,
        );
        fmt.begin(writer_of(&mut output), &cols)?;
        for (idx, row) in sel_rows.iter().enumerate() {
            if cancel.is_cancelled() {
                break;
            }
            fmt.row(writer_of(&mut output), &cols, idx, row)?;
        }
        fmt.finish(writer_of(&mut output), sel_rows.len())?;
        return close_out(output, sel_rows.len() as u64, started, destination, app, manager, cancel.is_cancelled(), id).await;
    }

    // Streaming export: exactly one of table / sql.
    let source = match (&table, &sql) {
        (Some(t), _) if !t.is_empty() => RowSource::Table {
            db: db.clone().ok_or_else(|| AppError::Db("missing database for table export".into()))?,
            table: t.clone(),
        },
        (_, Some(s)) if !s.is_empty() => RowSource::Sql(s.clone()),
        _ => {
            return Err(AppError::Db(
                "grid export needs a table, a SELECT statement, or selected rows".into(),
            ))
        }
    };

    let reporter = ProgressReporter::new(app, id, 1);
    reporter.emit_now("data", table.as_deref(), 0, output.bytes_so_far());

    let mut state =
        GridFormatState::new(format, options.csv_config(), statement, table_q, pk_columns);

    let stats = stream_rows(manager, conn_id, &source, 1000, cancel, |cols, rows, base| {
        state.format_chunk(&mut output, cols, rows, base)
    })
    .await?;

    state.finish(&mut output)?;

    close_out(output, stats.rows, started, destination, app, manager, stats.cancelled, id).await
}

/// XLSX grid export: streams rows into the OOXML writer with the same
/// selection / table / query sources as the text formats. File destinations
/// only (checked upstream); `gzip` is ignored — the workbook is already a
/// ZIP archive.
#[allow(clippy::too_many_arguments)]
async fn run_grid_xlsx_inner(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    db: Option<String>,
    table: Option<String>,
    sql: Option<String>,
    selection: Option<(Vec<String>, Vec<Vec<RowValue>>)>,
    destination: &ExportDestination,
    overwrite: bool,
    id: u32,
    cancel: &CancelToken,
    started: Instant,
) -> Result<ExportResult> {
    let ExportDestination::File { path, .. } = destination else {
        return Err(AppError::Db("XLSX export supports file destinations only".into()));
    };

    // Same open semantics as ExportOutput::open: existing file without the
    // overwrite flag yields AppError::Exists so the UI can confirm.
    let path_buf = PathBuf::from(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true);
    if overwrite {
        opts.create(true).truncate(true);
    } else {
        opts.create_new(true);
    }
    let file = opts.open(&path_buf).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Exists(path_buf.display().to_string())
        } else {
            e.into()
        }
    })?;
    // Rows stream one write_all() at a time; buffer so that isn't one
    // syscall per row. BufWriter<File> implements Seek, which the ZIP
    // central-directory needs at finish().
    let buffered = std::io::BufWriter::with_capacity(64 * 1024, file);

    let sheet_base = table.clone().unwrap_or_else(|| "result".to_string());
    let mut writer = xlsx::StreamingXlsxWriter::new(buffered)?;
    let mut reporter = ProgressReporter::new(app, id, 1);
    reporter.emit_now("data", table.as_deref(), 0, 0);

    let mut rows_done: u64 = 0;
    let mut cancelled = false;

    match selection {
        Some((cols, sel_rows)) => {
            writer.begin(&sheet_base, &cols)?;
            for row in &sel_rows {
                if cancel.is_cancelled() {
                    cancelled = true;
                    break;
                }
                writer.push_row(row)?;
                rows_done += 1;
            }
        }
        None => {
            let source = match (&table, &sql) {
                (Some(t), _) if !t.is_empty() => RowSource::Table {
                    db: db.clone()
                        .ok_or_else(|| AppError::Db("missing database for table export".into()))?,
                    table: t.clone(),
                },
                (_, Some(s)) if !s.is_empty() => RowSource::Sql(s.clone()),
                _ => {
                    return Err(AppError::Db(
                        "grid export needs a table, a SELECT statement, or selected rows".into(),
                    ))
                }
            };
            let mut begun = false;
            let stats = stream_rows(
                manager,
                conn_id,
                &source,
                1000,
                cancel,
                |cols, rows, _base| {
                    if !begun {
                        let names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
                        writer.begin(&sheet_base, &names)?;
                        begun = true;
                    }
                    for row in rows {
                        writer.push_row(row)?;
                    }
                    rows_done += rows.len() as u64;
                    reporter.emit_throttled("data", table.as_deref(), rows_done, 0);
                    Ok(())
                },
            )
            .await?;
            rows_done = stats.rows;
            cancelled = stats.cancelled;
        }
    }

    // Flush the ZIP central directory through the BufWriter before sizing
    // the file; a dropped BufWriter would flush silently, swallowing errors.
    let (mut sink, _) = writer.finish()?;
    sink.flush()?;
    drop(sink);

    // Bytes written: the ZIP central directory makes the final size unknown
    // until finish; read it back from the file.
    let bytes = std::fs::metadata(&path_buf).map(|m| m.len()).unwrap_or(0);

    let phase = if cancelled { "cancelled" } else { "done" };
    app.emit(
        PROGRESS_EVENT,
        ExportProgress {
            id,
            phase: phase.into(),
            table: None,
            rows_done,
            total_tables: 1,
            bytes,
        },
    )
    .ok();

    Ok(ExportResult {
        bytes_written: bytes,
        rows: rows_done,
        elapsed_ms: started.elapsed().as_millis() as u64,
        path: destination_path(destination),
        cancelled,
    })
}

/// Deferred formatter: `begin` waits for the first chunk because column
/// metadata arrives together with it.
struct GridFormatState {
    format: ExportFormat,
    csv: CsvConfig,
    statement: String,
    table_q: String,
    pk_columns: Vec<String>,
    inner: Option<Box<dyn RowFormatter>>,
}

impl GridFormatState {
    fn new(
        format: ExportFormat,
        csv: CsvConfig,
        statement: String,
        table_q: String,
        pk_columns: Vec<String>,
    ) -> Self {
        Self { format, csv, statement, table_q, pk_columns, inner: None }
    }

    fn ensure_begun(&mut self, w: &mut dyn IoWrite, cols: &[ResultColumnMeta]) -> std::io::Result<()> {
        if self.inner.is_none() {
            let names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
            let mut fmt = make_formatter(
                self.format,
                self.csv.clone(),
                &self.statement,
                &self.table_q,
                false,
                false,
                &self.pk_columns,
            );
            fmt.begin(w, &names)?;
            self.inner = Some(fmt);
        }
        Ok(())
    }

    fn format_chunk(
        &mut self,
        output: &mut ExportOutput,
        cols: &[ResultColumnMeta],
        rows: &[Vec<RowValue>],
        base_index: u64,
    ) -> Result<()> {
        self.ensure_begun(writer_of(output), cols)?;
        let names: Vec<String> = cols.iter().map(|c| c.name.clone()).collect();
        let fmt = self.inner.as_mut().expect("formatter initialized");
        for (i, row) in rows.iter().enumerate() {
            fmt.row(writer_of(output), &names, base_index as usize + i, row)?;
        }
        Ok(())
    }

    fn finish(&mut self, output: &mut ExportOutput) -> Result<()> {
        if let Some(mut fmt) = self.inner.take() {
            fmt.finish(writer_of(output), 0)?;
        }
        Ok(())
    }
}

/// Emit the final progress event, close the medium and build the summary.
#[allow(clippy::too_many_arguments)]
async fn close_out(
    output: ExportOutput,
    rows: u64,
    started: Instant,
    destination: &ExportDestination,
    app: &AppHandle,
    manager: &ConnectionManager,
    cancelled: bool,
    id: u32,
) -> Result<ExportResult> {
    let bytes = output
        .finish(app, Some(manager), !cancelled)
        .await?;

    let phase = if cancelled { "cancelled" } else { "done" };
    app.emit(
        PROGRESS_EVENT,
        ExportProgress {
            id,
            phase: phase.into(),
            table: None,
            rows_done: rows,
            total_tables: 1,
            bytes,
        },
    )
    .ok();

    Ok(ExportResult {
        bytes_written: bytes,
        rows,
        elapsed_ms: started.elapsed().as_millis() as u64,
        path: destination_path(destination),
        cancelled,
    })
}

fn destination_path(dest: &ExportDestination) -> Option<String> {
    match dest {
        ExportDestination::File { path, .. } => Some(path.clone()),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// SQL dump
// ---------------------------------------------------------------------------

/// Generate the full SQL dump described by `options` into `destination`.
pub async fn export_sql_dump(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    options: SqlDumpOptions,
    destination: ExportDestination,
    overwrite: bool,
) -> Result<ExportResult> {
    let started = Instant::now();
    let (id, cancel) = begin_export();

    let result =
        run_dump_inner(app, manager, conn_id, &options, &destination, overwrite, id, &cancel, started).await;

    end_export(id);
    result
}

#[allow(clippy::too_many_arguments)]
async fn run_dump_inner(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    options: &SqlDumpOptions,
    destination: &ExportDestination,
    overwrite: bool,
    id: u32,
    cancel: &CancelToken,
    started: Instant,
) -> Result<ExportResult> {
    if options.dbs.is_empty() {
        return Err(AppError::Db("no databases selected for the dump".into()));
    }
    let data_only_to_server = matches!(destination, ExportDestination::Server { .. });
    if data_only_to_server && options.what == sql_dump::DumpWhat::Structure {
        return Err(AppError::Db(
            "structure-only dumps cannot be exported to another server".into(),
        ));
    }

    // Resolve the table plan up front so progress has a denominator.
    let mut plan: Vec<(String, Vec<String>)> = Vec::new();
    for db in &options.dbs {
        let names = match &options.tables {
            Some(list) => list.clone(),
            None => manager
                .list_tables(conn_id, db)
                .await?
                .into_iter()
                .filter(|t| t.kind == crate::connections::TableKind::Table)
                .map(|t| t.name)
                .collect(),
        };
        plan.push((db.clone(), names));
    }
    let total_tables: usize = plan.iter().map(|(_, t)| t.len()).sum();

    let dialect = manager.server_info(conn_id).await?.dialect;

    let mut output = ExportOutput::open(destination, overwrite)?;
    let mut reporter = ProgressReporter::new(app, id, total_tables);
    let mut tables_seen = 0usize;

    output.write_str(&sql_dump::dump_header("DBobcat", env!("CARGO_PKG_VERSION")))?;
    output.write_str(sql_dump::session_setup_sql(dialect))?;

    'outer: for (db, tables) in &plan {
        if cancel.is_cancelled() {
            break;
        }

        if options.create_db_header && !data_only_to_server && dialect == SqlDialect::Mysql {
            if options.drop_database {
                if let Some(drop_db) = sql_dump::drop_database_sql(db, dialect) {
                    output.write_str(&drop_db)?;
                }
            }
            output.write_str(&sql_dump::create_db_sql(db))?;
        }

        // ---- base tables -------------------------------------------------
        for table in tables {
            if cancel.is_cancelled() {
                break 'outer;
            }
            tables_seen += 1;
            let ddl = manager.get_table_ddl(conn_id, db, table).await?;

            if options.what != sql_dump::DumpWhat::Data && !data_only_to_server {
                reporter.emit_now("structure", Some(table), tables_seen as u64, output.bytes_so_far());
                output.write_str(&sql_dump::structure_comment(
                    "Table structure",
                    &quote_qualified(&[db, table]),
                ))?;
                if options.drop_add {
                    output.write_str(&sql_dump::drop_table_sql(db, table))?;
                }
                let create_sql = if options.strip_auto_increment {
                    sql_dump::strip_auto_increment(&ddl.create_sql)
                } else {
                    ddl.create_sql.clone()
                };
                // SHOW CREATE text arrives without a trailing newline.
                output.write_str(&create_sql)?;
                output.write_str("\n\n")?;
            }

            if options.what != sql_dump::DumpWhat::Structure {
                reporter.emit_now("data", Some(table), 0, output.bytes_so_far());
                if !data_only_to_server {
                    output.write_str(&sql_dump::structure_comment(
                        "Dumping data",
                        &quote_qualified(&[db, table]),
                    ))?;
                }
                // TRUNCATE is DDL on MySQL (implicit commit) — it must run
                // before any transaction/lock wrapper, not inside one.
                if options.truncate_before && !data_only_to_server {
                    output.write_str(&sql_dump::truncate_table_sql(db, table, dialect))?;
                }
                if options.add_locks && !data_only_to_server && dialect == SqlDialect::Mysql {
                    output.write_str(&sql_dump::lock_table_sql(db, table))?;
                }
                if options.use_transactions {
                    // BEGIN works on every engine; MySQL's classic spelling
                    // is kept for parity with mysqldump.
                    if dialect == SqlDialect::Mysql {
                        output.write_str("START TRANSACTION;\n")?;
                    } else {
                        output.write_str("BEGIN;\n")?;
                    }
                }

                let columns: Vec<String> = ddl.columns.iter().map(|c| c.name.clone()).collect();
                let pk_columns: Vec<String> = ddl
                    .indexes
                    .iter()
                    .filter(|ix| ix.kind == crate::connections::IndexKind::Primary)
                    .flat_map(|ix| ix.columns.clone())
                    .collect();
                // Server targets requalify INSERTs with their own schema.
                let table_q = match destination {
                    ExportDestination::Server { db: target_db, .. } => {
                        quote_qualified(&[target_db, table])
                    }
                    _ => quote_qualified(&[db, table]),
                };
                let mode = options.data_statement;
                // DELETE+INSERT pairs cannot live inside a VALUES batch.
                let extended = options.extended_inserts && mode != DataStatement::DeleteInsert;
                let mut batcher =
                    sql_dump::InsertBatcher::new(
                        &table_q,
                        &columns,
                        extended,
                        options.complete_inserts || data_only_to_server,
                        false,
                        options.hex_blobs,
                    )
                    .with_dialect(dialect)
                    .with_mode(mode)
                    .with_batch_limits(options.batch_rows, options.max_insert_size_kb);
                if mode == DataStatement::Replace && dialect == SqlDialect::Postgres {
                    batcher = batcher.with_pg_upsert(&pk_columns);
                }
                // Once per table, not per row: DELETE+INSERT without a PK
                // silently degrades to plain INSERT (whole-row matching
                // would be far too slow to be useful here).
                let has_pk = !pk_columns.is_empty();

                let mut rows_done = 0u64;
                let stats = stream_rows(
                    manager,
                    conn_id,
                    &RowSource::Table { db: db.clone(), table: table.clone() },
                    1000,
                    cancel,
                    |_cols, rows, _base| {
                        for row in rows {
                            if mode == DataStatement::DeleteInsert && has_pk {
                                if let Some(delete_sql) = sql_dump::delete_row_sql(
                                    &table_q,
                                    &columns,
                                    &pk_columns,
                                    row,
                                    dialect,
                                    options.hex_blobs,
                                ) {
                                    output.write_str(&delete_sql)?;
                                }
                            }
                            batcher.push_row(row);
                            // In DELETE+INSERT mode each INSERT must drain
                            // immediately so it stays after its own DELETE.
                            if mode == DataStatement::DeleteInsert {
                                if let Some(ready) = batcher.take_ready() {
                                    output.write_str(&ready)?;
                                    if options.delay_ms > 0 {
                                        std::thread::sleep(Duration::from_millis(
                                            options.delay_ms as u64,
                                        ));
                                    }
                                }
                            }
                        }
                        if mode != DataStatement::DeleteInsert {
                            if let Some(ready) = batcher.take_ready() {
                                output.write_str(&ready)?;
                                if options.delay_ms > 0 {
                                    std::thread::sleep(Duration::from_millis(
                                        options.delay_ms as u64,
                                    ));
                                }
                            }
                        }
                        rows_done += rows.len() as u64;
                        reporter.emit_throttled("data", Some(table), rows_done, output.bytes_so_far());
                        Ok(())
                    },
                )
                .await?;

                if let Some(tail) = batcher.finish() {
                    output.write_str(&tail)?;
                }
                if options.use_transactions {
                    output.write_str("COMMIT;\n")?;
                }
                if options.add_locks && !data_only_to_server && dialect == SqlDialect::Mysql {
                    output.write_str(sql_dump::UNLOCK_TABLES_SQL)?;
                }
                output.write_str("\n")?;

                if stats.cancelled {
                    break 'outer;
                }
            }
        }

        // ---- views -------------------------------------------------------
        if options.include_views && options.what != sql_dump::DumpWhat::Data && !data_only_to_server
        {
            let view_names: Vec<String> = manager
                .list_tables(conn_id, db)
                .await?
                .into_iter()
                .filter(|t| t.kind == crate::connections::TableKind::View)
                .map(|t| t.name)
                .collect();
            for view in view_names {
                if cancel.is_cancelled() {
                    break 'outer;
                }
                reporter.emit_now("structure", Some(&view), tables_seen as u64, output.bytes_so_far());
                output.write_str(&sql_dump::structure_comment(
                    "View structure",
                    &quote_qualified(&[db, &view]),
                ))?;
                if options.drop_add {
                    let view_drop = match dialect {
                        SqlDialect::Mysql => format!(
                            "DROP VIEW IF EXISTS {};\n",
                            quote_qualified(&[db, &view])
                        ),
                        SqlDialect::Postgres => format!("DROP VIEW IF EXISTS \"{db}\".\"{view}\";\n"),
                        SqlDialect::Sqlite => format!("DROP VIEW IF EXISTS \"{view}\";\n"),
                    };
                    output.write_str(&view_drop)?;
                }
                let ddl = manager.get_view_ddl(conn_id, db, &view).await?.create_sql;
                output.write_str(&maybe_strip_definer(&ddl, options.definer_strip))?;
                output.write_str("\n\n")?;
            }
        }

        // ---- routines / triggers / events -------------------------------
        if options.include_routines && !data_only_to_server {
            for routine in manager.list_routines(conn_id, db).await? {
                if cancel.is_cancelled() {
                    break 'outer;
                }
                let ddl = manager
                    .get_routine_ddl(conn_id, db, &routine.name, routine.kind)
                    .await?
                    .create_sql;
                write_object_block(&mut output, "Routine", db, &routine.name, &ddl, options.definer_strip, dialect)?;
            }
        }
        if options.include_triggers && !data_only_to_server {
            for trigger in manager.list_triggers(conn_id, db).await? {
                if cancel.is_cancelled() {
                    break 'outer;
                }
                let ddl = manager.get_trigger_ddl(conn_id, db, &trigger.name).await?.create_sql;
                write_object_block(&mut output, "Trigger", db, &trigger.name, &ddl, options.definer_strip, dialect)?;
            }
        }
        if options.include_events && !data_only_to_server {
            for event in manager.list_events(conn_id, db).await? {
                if cancel.is_cancelled() {
                    break 'outer;
                }
                let ddl = manager.get_event_ddl(conn_id, db, &event.name).await?.create_sql;
                write_object_block(&mut output, "Event", db, &event.name, &ddl, options.definer_strip, dialect)?;
            }
        }
    }

    let cancelled = cancel.is_cancelled();
    let bytes = output.finish(app, Some(manager), !cancelled).await?;

    reporter.emit_now(
        if cancelled { "cancelled" } else { "done" },
        None,
        0,
        bytes,
    );

    Ok(ExportResult {
        bytes_written: bytes,
        rows: tables_seen as u64,
        elapsed_ms: started.elapsed().as_millis() as u64,
        path: destination_path(destination),
        cancelled,
    })
}

fn maybe_strip_definer(ddl: &str, strip: bool) -> String {
    if strip {
        sql_dump::strip_definers(ddl)
    } else {
        ddl.to_string()
    }
}

fn write_object_block(
    output: &mut ExportOutput,
    label: &str,
    db: &str,
    name: &str,
    ddl: &str,
    definer_strip: bool,
    dialect: SqlDialect,
) -> Result<()> {
    output.write_str(&sql_dump::structure_comment(label, &quote_qualified(&[db, name])))?;
    let text = maybe_strip_definer(ddl, definer_strip);
    if dialect == SqlDialect::Mysql {
        // Compound bodies contain semicolons: wrap them in DELIMITER blocks
        // so any delimiter-aware importer executes them intact.
        output.write_str("DELIMITER ;;\n")?;
        output.write_str(&sql_dump::with_custom_delimiter(&text))?;
        output.write_str("DELIMITER ;\n\n")?;
    } else {
        // PostgreSQL ($$ bodies) and SQLite need no delimiter switching.
        output.write_str(text.trim_end())?;
        output.write_str("\n\n")?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// DDL export (designer parity)
// ---------------------------------------------------------------------------

/// Copy the CREATE definitions of the requested objects into a destination
/// (file or clipboard; server targets are rejected).
pub async fn export_objects_ddl(
    app: &AppHandle,
    manager: &ConnectionManager,
    conn_id: u32,
    requests: Vec<DdlObjectRequest>,
    destination: ExportDestination,
    title: Option<String>,
    overwrite: bool,
) -> Result<ExportResult> {
    let started = Instant::now();
    let (id, cancel) = begin_export();

    let result = async {
        if matches!(destination, ExportDestination::Server { .. }) {
            return Err(AppError::Db("DDL export supports files and clipboard only".into()));
        }
        let mut output = ExportOutput::open(&destination, overwrite)?;
        let reporter = ProgressReporter::new(app, id, requests.len());

        if let Some(title) = &title {
            output.write_str(&format!("-- {title}\n\n"))?;
        }

        for req in &requests {
            if cancel.is_cancelled() {
                break;
            }
            reporter.emit_now("objects", Some(&req.name), 0, output.bytes_so_far());
            let ddl = fetch_object_ddl(manager, conn_id, req).await?;
            output.write_str(&format!(
                "--\n-- {} {}.{}\n--\n",
                kind_label(req.kind),
                req.db,
                req.name
            ))?;
            output.write_str(&ddl)?;
            output.write_str("\n\n")?;
        }

        let cancelled = cancel.is_cancelled();
        let bytes = output.finish(app, None, false).await?;
        reporter.emit_now(if cancelled { "cancelled" } else { "done" }, None, 0, bytes);
        Ok(ExportResult {
            bytes_written: bytes,
            rows: requests.len() as u64,
            elapsed_ms: started.elapsed().as_millis() as u64,
            path: destination_path(&destination),
            cancelled,
        })
    }
    .await;

    end_export(id);
    result
}

async fn fetch_object_ddl(
    manager: &ConnectionManager,
    conn_id: u32,
    req: &DdlObjectRequest,
) -> Result<String> {
    match req.kind {
        ObjectKind::Table => Ok(manager.get_table_ddl(conn_id, &req.db, &req.name).await?.create_sql),
        ObjectKind::View => Ok(manager.get_view_ddl(conn_id, &req.db, &req.name).await?.create_sql),
        ObjectKind::Trigger => Ok(manager.get_trigger_ddl(conn_id, &req.db, &req.name).await?.create_sql),
        ObjectKind::Event => Ok(manager.get_event_ddl(conn_id, &req.db, &req.name).await?.create_sql),
        ObjectKind::Routine => {
            let kind = req.routine_kind.unwrap_or(RoutineKind::Procedure);
            Ok(manager
                .get_routine_ddl(conn_id, &req.db, &req.name, kind)
                .await?
                .create_sql)
        }
    }
}

fn kind_label(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::Table => "TABLE",
        ObjectKind::View => "VIEW",
        ObjectKind::Routine => "ROUTINE",
        ObjectKind::Trigger => "TRIGGER",
        ObjectKind::Event => "EVENT",
    }
}

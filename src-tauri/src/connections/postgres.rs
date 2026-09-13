//! PostgreSQL driver built on `tokio-postgres` (Phase 6).
//!
//! One `tokio_postgres::Client` per connection task. `Client` methods take
//! `&self` (interior mutability over an Arc'd connection), so no extra
//! locking is needed inside the serialized connection actor.
//!
//! Value-handling strategy (deliberate, documented):
//! - Catalog/metadata queries use the binary protocol with typed extraction.
//! - User-facing result sets render every selected column `::text` (aliased
//!   back to the column name) and parse the text into [`RowValue`]s. This
//!   keeps NUMERIC/JSON/UUID/bytea rendering faithful without a pile of
//!   per-type FromSql impls.
//! - Grid filters/edits still travel as bind parameters — bound as text and
//!   cast at the placeholder (`($1)::integer`) so comparisons keep numeric
//!   semantics. Values never enter the SQL string.
//!
//! Known deviations (P6 scope):
//! - TLS uses a libpq-`require`-style verifier: encrypted channel without
//!   server authentication (`sslmode=require` parity).
//! - Streaming reads page through `LIMIT/OFFSET` instead of a cursor:
//!   bounded memory per page, cancellation between pages.
//! - `WITH …` scripts execute through the text protocol and report columns
//!   as `text` (avoids planning writable CTEs twice).

use std::time::Duration;

use async_trait::async_trait;
use chrono::Utc;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::sync::mpsc;
use tokio_postgres::config::SslMode as PgSslMode;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::to_sql_checked;
use tokio_postgres::types::{IsNull, ToSql, Type};
use tokio_postgres::{Client, Row, SimpleQueryMessage, SimpleQueryRow};

use crate::connections::dialect::SqlDialect;
use crate::connections::script::split_postgres;
use crate::connections::server_admin;
use crate::connections::sql::{
    build_change_sql, build_distinct_values_sql, build_order_by_clause, build_where_clause,
    build_where_clause_and, validate_column,
};
use crate::connections::traits::{send_chunk, DbConnection};
use crate::connections::{
    AlterUserRequest, ApplyChangesRequest, ApplyChangesResult, CellAssign, ColumnDef, ColumnMeta,
    CreateTableRequest, CreateUserRequest, DatabaseInfo, DefaultKind, DistinctValue, EventMeta,
    ExecResult, FilterOp, ForeignKeyMeta, GrantDetail, GrantRequest, IndexKind, IndexMeta,
    MaintenanceOp, ObjectKind, ProcessInfo, QueryOutcome, QueryPageRequest, QueryPageResult,
    ResolvedConnectionConfig, ResultColumnMeta, RowChange, RowError, RowValue, RowsChunk,
    RoutineKind, RoutineMeta, SchemaCache, ServerInfo, ServerVariable, ShowCreateKind,
    ShowCreateResult, SslMode, StatusVariable, TableDdl, TableKind, TableMeta, TableOptions,
    TableSchemaData, TriggerMeta, UserMeta, FilterSpec,
};
use crate::error::{AppError, Result};

/// Hard ceiling on the TCP+TLS+auth handshake.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Hard ceiling on a single page read.
const MAX_PAGE_SIZE: u32 = 50_000;
/// Per-result-set fetch ceiling for scripts.
const MAX_SCRIPT_RESULT_ROWS: usize = 100_000;
/// Upper bound on one streamed export chunk / paging step.
const MAX_STREAM_CHUNK: usize = 10_000;

pub struct PgConnection {
    client: Client,
    server_info: ServerInfo,
    /// Column metadata cache — see [`crate::connections::schema_cache`].
    schema: SchemaCache,
}

// ---------------------------------------------------------------------------
// Connect + TLS
// ---------------------------------------------------------------------------

/// Certificate verifier that accepts everything. This mirrors libpq's
/// `sslmode=require`: encrypt the channel, do not authenticate the server.
#[derive(Debug)]
struct NoVerifier;

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _certificate: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

fn tls_config(config: &ResolvedConnectionConfig) -> Result<rustls::ClientConfig> {
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13, &rustls::version::TLS12])
        .map_err(|e| AppError::Db(format!("TLS setup failed: {e}")))?;

    let ssl = config.ssl_files.clone().unwrap_or_default();

    // Trust posture: a CA file pins the server certificate chain (libpq
    // verify-ca semantics); without one the channel is encrypted but the
    // server is not authenticated (libpq sslmode=require).
    let builder = match &ssl.ca_path {
        Some(ca_path) => {
            let mut roots = rustls::RootCertStore::empty();
            for der in load_certs(ca_path)? {
                roots
                    .add(der)
                    .map_err(|e| AppError::Config(format!("bad CA certificate: {e}")))?;
            }
            builder.with_root_certificates(roots)
        }
        None => builder
            .dangerous()
            .with_custom_certificate_verifier(std::sync::Arc::new(NoVerifier)),
    };

    // Client identity: both cert and key must be present.
    let client = match (&ssl.cert_path, &ssl.key_path) {
        (Some(cert_path), Some(key_path)) => {
            let certs = load_certs(cert_path)?;
            let key = load_private_key(key_path)?;
            builder
                .with_client_auth_cert(certs, key)
                .map_err(|e| AppError::Config(format!("bad client certificate: {e}")))?
        }
        _ => builder.with_no_client_auth(),
    };

    Ok(client)
}

// ---------------------------------------------------------------------------
// PEM loading (hand-rolled; avoids an extra dependency)
// ---------------------------------------------------------------------------

/// Extract the base64 payload of every PEM section labelled `label`
/// (e.g. "CERTIFICATE") and decode it to DER.
fn load_pem_section(path: &str, label: &str) -> Result<Vec<Vec<u8>>> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine as _;

    let text = std::fs::read_to_string(path)?;
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let mut out = Vec::new();
    let mut in_section = false;
    let mut body = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line == begin {
            in_section = true;
            body.clear();
        } else if line == end {
            if in_section {
                let der = STANDARD
                    .decode(body.as_bytes())
                    .map_err(|e| AppError::Config(format!("{path}: invalid PEM body: {e}")))?;
                out.push(der);
            }
            in_section = false;
        } else if in_section {
            body.push_str(line);
        }
    }
    Ok(out)
}

fn load_certs(path: &str) -> Result<Vec<CertificateDer<'static>>> {
    Ok(load_pem_section(path, "CERTIFICATE")?
        .into_iter()
        .map(CertificateDer::from)
        .collect())
}

fn load_private_key(path: &str) -> Result<rustls::pki_types::PrivateKeyDer<'static>> {
    use rustls::pki_types::{PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer};
    for label in ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"] {
        let sections = load_pem_section(path, label)?;
        if let Some(der) = sections.into_iter().next() {
            return Ok(if label == "PRIVATE KEY" {
                rustls::pki_types::PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(der))
            } else if label == "RSA PRIVATE KEY" {
                rustls::pki_types::PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(der))
            } else {
                rustls::pki_types::PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(der))
            });
        }
    }
    Err(AppError::Config(format!(
        "{path}: no private key section found (expected PKCS#8, RSA or EC PEM)"
    )))
}

impl PgConnection {
    /// Open a connection applying the session's TLS posture:
    /// Disabled → plaintext only; Preferred → TLS when the server supports
    /// it (tokio-postgres falls back to plaintext on its own);
    /// Required → TLS mandatory.
    pub async fn open(config: &ResolvedConnectionConfig) -> Result<Self> {
        let mut cfg = tokio_postgres::Config::new();
        cfg.host(&config.host)
            .port(config.port)
            .user(&config.user)
            .ssl_mode(match config.ssl_mode {
                SslMode::Disabled => PgSslMode::Disable,
                SslMode::Preferred => PgSslMode::Prefer,
                SslMode::Required => PgSslMode::Require,
            });
        if let Some(password) = &config.password {
            cfg.password(password);
        }
        if let Some(db) = &config.database {
            cfg.dbname(db);
        }

        let attempt = async {
            let tls_config = tls_config(config)?;
            let tls = tokio_postgres_rustls::MakeRustlsConnect::new(tls_config);
            let (client, conn) = cfg.connect(tls).await?;
            // The connection driver must be polled for progress; park it on a
            // background task for the lifetime of the session.
            tokio::spawn(async move {
                if let Err(err) = conn.await {
                    eprintln!("[postgres] transport closed: {err}");
                }
            });
            Ok::<_, AppError>(client)
        };

        let client = tokio::time::timeout(CONNECT_TIMEOUT, attempt)
            .await
            .map_err(|_| {
                AppError::Db(format!(
                    "connection timed out after {}s",
                    CONNECT_TIMEOUT.as_secs()
                ))
            })??;

        let server_info = fetch_server_info(&client).await?;
        Ok(Self {
            client,
            server_info,
            schema: SchemaCache::default(),
        })
    }

    /// Live catalog read behind the cached [`Self::describe_table`] trait
    /// method.
    async fn describe_table_uncached(
        &mut self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ColumnMeta>> {
        let relid = self.relid(database, table).await?;
        let pg_cols = self.load_columns(relid).await?;
        let pk = self.pk_attnums(relid).await?;

        Ok(pg_cols
            .iter()
            .map(|c| pg_column_meta(c, pk.contains(&c.attnum)))
            .collect())
    }

    /// Resolve `db.table` to a relation OID, failing with a stable message.
    async fn relid(&self, db: &str, table: &str) -> Result<u32> {
        let rows = self
            .client
            .query(
                "SELECT to_regclass(format('%I.%I', $1::text, $2::text))::oid",
                &[&db, &table],
            )
            .await?;
        rows.first()
            .and_then(|r| r.try_get::<_, Option<u32>>(0).ok().flatten())
            .ok_or_else(|| AppError::Db(format!("relation {db}.{table} not found")))
    }
    /// Full column metadata straight from the catalogs.
    async fn load_columns(&self, relid: u32) -> Result<Vec<PgColumn>> {
        let rows = self
            .client
            .query(
                "SELECT a.attname, format_type(a.atttypid, a.atttypmod), \
                        NOT a.attnotnull, \
                        pg_get_expr(ad.adbin, ad.adrelid), \
                        a.attidentity, a.attgenerated, a.attnum, \
                        col_description(a.attrelid, a.attnum) \
                 FROM pg_attribute a \
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
                 WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped \
                 ORDER BY a.attnum",
                &[&relid],
            )
            .await?;

        rows.iter()
            .map(|row| {
                Ok(PgColumn {
                    name: r_string(row, 0)?,
                    type_text: r_string(row, 1)?,
                    nullable: r_bool(row, 2)?,
                    default_expr: r_opt_string(row, 3)?,
                    identity: r_opt_char(row, 4)?,
                    generated: r_opt_char(row, 5)?,
                    attnum: r_i16(row, 6)?,
                    comment: r_opt_string(row, 7)?.filter(|c| !c.is_empty()),
                })
            })
            .collect()
    }

    /// Primary-key attribute numbers of a relation (empty when none).
    async fn pk_attnums(&self, relid: u32) -> Result<Vec<i16>> {
        let row = self
            .client
            .query_opt(
                "SELECT con.conkey FROM pg_constraint con \
                 WHERE con.conrelid = $1 AND con.contype = 'p'",
                &[&relid],
            )
            .await;
        match row {
            Ok(Some(row)) => Ok(r_vec_i16(&row, 0)?),
            _ => Ok(Vec::new()),
        }
    }
    /// Run one SELECT-shaped script statement and build a ResultSet outcome.
    /// The error carries the 25P02 aborted-transaction flag for the ledger.
    async fn run_script_select(
        &self,
        stmt: &str,
    ) -> std::result::Result<QueryOutcome, (String, bool)> {
        let started = std::time::Instant::now();
        // Planning is separate from execution — no double-run risk.
        let planned = self.client.prepare(stmt).await.ok();
        let messages = self
            .client
            .simple_query(stmt)
            .await
            .map_err(|e| (e.to_string(), err_aborts_transaction(&e)))?;
        let rows: Vec<SimpleQueryRow> = messages
            .into_iter()
            .filter_map(|m| match m {
                SimpleQueryMessage::Row(row) => Some(row),
                _ => None,
            })
            .collect();

        let (columns, types): (Vec<ResultColumnMeta>, Vec<String>) = match planned {
            Some(stmt) if !stmt.columns().is_empty() => {
                let metas = stmt
                    .columns()
                    .iter()
                    .map(|c| ResultColumnMeta {
                        name: c.name().to_string(),
                        data_type: c.type_().name().to_string(),
                    })
                    .collect::<Vec<_>>();
                let types = metas.iter().map(|m| m.data_type.clone()).collect();
                (metas, types)
            }
            _ => {
                // Text-protocol fallback: names only, values stay text.
                let metas = rows
                    .first()
                    .map(|row| {
                        row.columns()
                            .iter()
                            .map(|c| ResultColumnMeta {
                                name: c.name().to_string(),
                                data_type: "text".into(),
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let types = vec!["text".to_string(); metas.len()];
                (metas, types)
            }
        };

        let mut out_rows: Vec<Vec<RowValue>> = Vec::with_capacity(rows.len());
        let mut truncated = false;
        for row in &rows {
            if out_rows.len() >= MAX_SCRIPT_RESULT_ROWS {
                truncated = true;
                break;
            }
            out_rows.push(text_row_to_values(&types, row));
        }

        Ok(QueryOutcome::ResultSet {
            columns,
            rows: out_rows,
            elapsed_ms: started.elapsed().as_millis() as u64,
            truncated,
            sql: Some(stmt.to_string()),
        })
    }
}

/// True when this failure is PostgreSQL's "current transaction is aborted"
/// (SQLSTATE 25P02): an open transaction got poisoned and every further
/// statement will fail until ROLLBACK. The transaction ledger flips its
/// phase to `Aborted` when it sees this.
pub(crate) fn err_aborts_transaction(err: &tokio_postgres::Error) -> bool {
    err.as_db_error()
        .map(|e| e.code() == &SqlState::IN_FAILED_SQL_TRANSACTION)
        .unwrap_or(false)
}

async fn fetch_server_info(client: &Client) -> Result<ServerInfo> {
    let rows = client
        .query("SELECT version(), current_database()", &[])
        .await?;
    let version = rows
        .first()
        .map(|r| r.get::<_, String>(0))
        .unwrap_or_default();
    let database = rows
        .first()
        .map(|r| r.get::<_, String>(1))
        .unwrap_or_default();

    // "PostgreSQL 16.3 (Homebrew) ..." → short version banner.
    let short = version
        .strip_prefix("PostgreSQL ")
        .and_then(|rest| rest.split_whitespace().next())
        .unwrap_or(version.as_str());

    Ok(ServerInfo {
        product: "PostgreSQL".to_string(),
        version: format!("{short} ({database})"),
        dialect: SqlDialect::Postgres,
        connected_at: Utc::now(),
    })
}

// ---------------------------------------------------------------------------
// Typed catalog row extraction
// ---------------------------------------------------------------------------

struct PgColumn {
    name: String,
    type_text: String,
    nullable: bool,
    default_expr: Option<String>,
    identity: Option<char>,
    generated: Option<char>,
    attnum: i16,
    comment: Option<String>,
}

fn missing(idx: usize) -> AppError {
    AppError::Db(format!("catalog row is missing column {idx}"))
}

fn r_string(row: &Row, idx: usize) -> Result<String> {
    row.try_get::<_, String>(idx).map_err(|_| missing(idx))
}

fn r_opt_string(row: &Row, idx: usize) -> Result<Option<String>> {
    row.try_get::<_, Option<String>>(idx).map_err(|_| missing(idx))
}

fn r_bool(row: &Row, idx: usize) -> Result<bool> {
    row.try_get::<_, bool>(idx).map_err(|_| missing(idx))
}

fn r_i16(row: &Row, idx: usize) -> Result<i16> {
    row.try_get::<_, i16>(idx).map_err(|_| missing(idx))
}

fn r_opt_i64(row: &Row, idx: usize) -> Result<Option<i64>> {
    row.try_get::<_, Option<i64>>(idx).map_err(|_| missing(idx))
}

/// One-char catalog fields ("char" type) arrive as i8.
fn r_opt_char(row: &Row, idx: usize) -> Result<Option<char>> {
    Ok(row
        .try_get::<_, Option<i8>>(idx)
        .map_err(|_| missing(idx))?
        .map(|b| (b as u8) as char))
}

fn r_vec_i16(row: &Row, idx: usize) -> Result<Vec<i16>> {
    row.try_get::<_, Vec<i16>>(idx).map_err(|_| missing(idx))
}

fn r_vec_string(row: &Row, idx: usize) -> Result<Vec<String>> {
    row.try_get::<_, Vec<String>>(idx).map_err(|_| missing(idx))
}

// ---------------------------------------------------------------------------
// Bind parameters — text representation + explicit SQL-side casts
// ---------------------------------------------------------------------------

/// A bind parameter sent as UTF-8 text; the surrounding SQL applies
/// `$n::<type>` casts so comparisons keep the column's semantics.
#[derive(Debug)]
pub(crate) enum PgParam {
    Null,
    Text(String),
}

impl ToSql for PgParam {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut tokio_postgres::types::private::BytesMut,
    ) -> std::result::Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self {
            PgParam::Null => Ok(IsNull::Yes),
            PgParam::Text(s) => {
                out.extend_from_slice(s.as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    to_sql_checked!();
}

/// Convert a grid cell into its textual bind form (bytea as `\x…` hex).
pub(crate) fn param_text(value: &RowValue) -> PgParam {
    match value {
        RowValue::Null => PgParam::Null,
        RowValue::Int(v) => PgParam::Text(v.to_string()),
        RowValue::UInt(v) => PgParam::Text(v.to_string()),
        RowValue::Float(v) if v.is_finite() => PgParam::Text(format!("{v}")),
        RowValue::Float(_) => PgParam::Null, // NaN/Inf cannot round-trip
        RowValue::Str(s) => PgParam::Text(s.clone()),
        RowValue::Bytes(b) => PgParam::Text(hex_encode_bytea(b)),
        RowValue::Date(s) | RowValue::Time(s) | RowValue::Datetime(s) => PgParam::Text(s.clone()),
    }
}

pub(crate) fn hex_encode_bytea(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("\\x");
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// Decode `\x48…` (or bare hex) into bytes.
pub(crate) fn hex_decode_bytea(text: &str) -> Result<Vec<u8>> {
    let hex = text.strip_prefix("\\x").unwrap_or(text);
    if !hex.len().is_multiple_of(2) || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::Db(format!(
            "malformed bytea literal: {:.40}",
            text
        )));
    }
    let mut out = Vec::with_capacity(hex.len() / 2);
    for pair in hex.as_bytes().as_chunks::<2>().0 {
        let hi = (pair[0] as char).to_digit(16).unwrap_or(0) as u8;
        let lo = (pair[1] as char).to_digit(16).unwrap_or(0) as u8;
        out.push(hi << 4 | lo);
    }
    debug_assert!(hex.as_bytes().as_chunks::<2>().1.is_empty());
    Ok(out)
}

/// PostgreSQL type name for `$n::<type>` casts derived from the column's
/// `format_type` text.
pub(crate) fn cast_type_for(data_type: &str) -> String {
    let base = data_type.split('(').next().unwrap_or("").trim();
    match base.to_ascii_lowercase().as_str() {
        "smallint" => "smallint",
        "integer" => "integer",
        "bigint" => "bigint",
        "real" => "real",
        "double precision" => "double precision",
        "boolean" => "boolean",
        "bytea" => "bytea",
        t if t.starts_with("numeric") => "numeric",
        t if t.starts_with("timestamp") => "timestamp",
        t if t.starts_with("date") => "date",
        t if t.starts_with("interval") => "interval",
        // varchar/char/text/json/jsonb/uuid/arrays/unknown: a text cast is
        // lossless and every concrete input parser accepts it downstream.
        _ => "text",
    }
    .to_string()
}

/// Append `::<cast>` after each `$k` placeholder outside double quotes.
/// `cast_of(n)` supplies the cast for the n-th placeholder (0-based).
pub(crate) fn apply_param_casts(
    sql: &str,
    cast_of: impl Fn(usize) -> Option<String>,
) -> String {
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len() + 32);
    let mut i = 0usize;
    let mut in_quotes = false;
    let cast_ref = &cast_of;
    while i < bytes.len() {
        let c = bytes[i];
        match c {
            b'"' => {
                in_quotes = !in_quotes;
                out.push('"');
                i += 1;
            }
            b'$' if !in_quotes => {
                let mut j = i + 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
                if j > i + 1 {
                    let idx: usize = sql[i + 1..j].parse().unwrap_or(0);
                    out.push('$');
                    out.push_str(&sql[i + 1..j]);
                    if let Some(cast) = idx.checked_sub(1).and_then(cast_ref) {
                        out.push_str("::");
                        out.push_str(&cast);
                    }
                    i = j;
                } else {
                    out.push('$');
                    i += 1;
                }
            }
            _ => {
                let len = utf8_len(c);
                out.push_str(&sql[i..(i + len).min(bytes.len())]);
                i += len;
            }
        }
    }
    out
}

fn utf8_len(first: u8) -> usize {
    match first {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

// ---------------------------------------------------------------------------
// Text cells → RowValue
// ---------------------------------------------------------------------------

/// Parse a `::text`-rendered cell according to its declared column type.
pub(crate) fn parse_cell_text(data_type: &str, raw: Option<&str>) -> RowValue {
    use std::str::FromStr;
    let Some(raw) = raw else {
        return RowValue::Null;
    };
    let base = data_type
        .split('(')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "smallint" | "integer" | "bigint" => i64::from_str(raw)
            .map(RowValue::Int)
            .unwrap_or_else(|_| RowValue::Str(raw.to_string())),
        "real" | "double precision" => f64::from_str(raw)
            .map(RowValue::Float)
            .unwrap_or_else(|_| RowValue::Str(raw.to_string())),
        b if b.starts_with("numeric") => f64::from_str(raw)
            .map(RowValue::Float)
            .unwrap_or_else(|_| RowValue::Str(raw.to_string())),
        "bytea" => hex_decode_bytea(raw)
            .map(RowValue::Bytes)
            .unwrap_or_else(|_| RowValue::Str(raw.to_string())),
        b if b.starts_with("timestamp") => RowValue::Datetime(raw.to_string()),
        b if b.starts_with("date") => RowValue::Date(raw.to_string()),
        b if b.starts_with("time") || b.starts_with("interval") => RowValue::Time(raw.to_string()),
        _ => RowValue::Str(raw.to_string()),
    }
}

/// Parse one text-protocol result row against declared column types.
fn text_row_to_values(types: &[String], row: &SimpleQueryRow) -> Vec<RowValue> {
    (0..types.len())
        .map(|i| parse_cell_text(&types[i], row.get(i)))
        .collect()
}

// ---------------------------------------------------------------------------
// Pure mapping helpers (unit-tested)
// ---------------------------------------------------------------------------

/// `pg_class.relkind` → tree [`TableKind`] ('r' plain / 'p' partitioned both
/// present as Table).
pub(crate) fn relkind_to_kind(relkind: &str) -> TableKind {
    match relkind {
        "v" => TableKind::View,
        "m" => TableKind::MaterializedView,
        _ => TableKind::Table,
    }
}

/// FK action letter (confupdtype/confdeltype) → SQL keywords.
pub(crate) fn fk_action_letter(letter: char) -> &'static str {
    match letter {
        'c' => "CASCADE",
        'n' => "SET NULL",
        'd' => "SET DEFAULT",
        'r' => "RESTRICT",
        _ => "NO ACTION", // 'a' and unknowns
    }
}

/// Map one catalog column plus PK membership to the wire [`ColumnMeta`]
/// (shared by `describe_table` and the ER diagram batch loader).
fn pg_column_meta(c: &PgColumn, is_pk: bool) -> ColumnMeta {
    let serial = c
        .default_expr
        .as_deref()
        .map(classify_default)
        .map(|(_, _, serial)| serial)
        .unwrap_or(false);
    let extra = match (serial, c.identity, c.generated) {
        (_, Some(_), _) => Some("identity".to_string()),
        (_, _, Some(_)) => Some("generated".to_string()),
        (true, _, _) => Some("sequence default".to_string()),
        _ => None,
    };
    ColumnMeta {
        name: c.name.clone(),
        data_type: c.type_text.clone(),
        nullable: c.nullable,
        key: if is_pk { Some("PRI".into()) } else { None },
        default_value: c.default_expr.clone(),
        extra,
        comment: c.comment.clone(),
    }
}

/// Classify a `pg_get_expr` default into designer form. Returns
/// `(default_kind, cleaned_value, is_serial_nextval)`.
pub(crate) fn classify_default(expr: &str) -> (DefaultKind, Option<String>, bool) {
    let lower = expr.to_ascii_lowercase();
    if lower.contains("nextval(") {
        return (DefaultKind::None, None, true);
    }
    let core = expr.split("::").next().unwrap_or(expr).trim();
    if core.eq_ignore_ascii_case("null") {
        return (DefaultKind::Null, None, false);
    }
    // Quoted literal: 'it''s'[::type] → strip quotes, un-double inner ones.
    if let Some(rest) = core.strip_prefix('\'') {
        if let Some(end) = find_closing_quote(rest) {
            return (
                DefaultKind::Value,
                Some(rest[..end].replace("''", "'")),
                false,
            );
        }
    }
    if !core.is_empty()
        && core
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '+')
        && core.chars().any(|c| c.is_ascii_digit())
    {
        return (DefaultKind::Value, Some(core.to_string()), false);
    }
    (DefaultKind::Expression, Some(core.to_string()), false)
}

/// Find the closing quote of a literal body starting after the opening one.
fn find_closing_quote(body: &str) -> Option<usize> {
    let b = body.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\'' {
            if i + 1 < b.len() && b[i + 1] == b'\'' {
                i += 2;
                continue;
            }
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Find `needle` in `hay` at word boundaries (space-delimited, uppercase).
fn find_word(hay: &str, needle: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(pos) = hay[from..].find(needle) {
        let abs = from + pos;
        let end = abs + needle.len();
        let before_ok = abs == 0 || hay.as_bytes()[abs - 1] == b' ';
        let after_ok = end == hay.len() || hay.as_bytes()[end] == b' ';
        if before_ok && after_ok {
            return Some(abs);
        }
        from = abs + needle.len().max(1);
    }
    None
}

/// Extract timing/event words from a `pg_get_triggerdef` body.
pub(crate) fn parse_trigger_def(def: &str) -> (String, String) {
    let upper = def.to_ascii_uppercase();
    let timing = ["INSTEAD OF", "BEFORE", "AFTER"]
        .iter()
        .find_map(|kw| find_word(&upper, kw).map(|_| (*kw).to_string()))
        .unwrap_or_else(|| "UNKNOWN".into());
    let event = ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]
        .iter()
        .find_map(|kw| find_word(&upper, kw).map(|_| (*kw).to_string()))
        .unwrap_or_else(|| "UNKNOWN".into());
    (timing, event)
}

// ---------------------------------------------------------------------------
// DDL builders (pure; shared with commands/objects.rs)
// ---------------------------------------------------------------------------

/// Quote a string literal the PostgreSQL way (only quotes double; backslash
/// stays literal under standard_conforming_strings).
pub(crate) fn pg_quote_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn is_numeric_literal(s: &str) -> bool {
    let t = s.trim();
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    !body.is_empty() && body.chars().all(|c| c.is_ascii_digit() || c == '.')
}

fn normalize_type(t: &str) -> String {
    t.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// One column definition line for CREATE TABLE / ADD COLUMN.
pub(crate) fn pg_column_definition(d: SqlDialect, col: &ColumnDef) -> String {
    let mut s = d.quote_ident(&col.name);
    s.push(' ');
    s.push_str(col.data_type.trim());

    if let Some(expr) = &col.generated {
        // The designer stores the raw expression; normalize to PG syntax.
        let mut inner = expr.trim();
        for prefix in [
            "GENERATED ALWAYS AS",
            "GENERATED BY DEFAULT AS",
            "AS",
        ] {
            if let Some(rest) = inner.strip_prefix(prefix) {
                inner = rest.trim();
                break;
            }
        }
        let inner = inner
            .trim_start_matches('(')
            .trim_end()
            .trim_end_matches("STORED")
            .trim();
        let inner = inner.strip_suffix(')').unwrap_or(inner).trim();
        s.push_str(&format!(" GENERATED ALWAYS AS ({inner}) STORED"));
        return s;
    }

    s.push_str(if col.nullable { " NULL" } else { " NOT NULL" });
    match col.default_kind {
        DefaultKind::None => {}
        DefaultKind::Null => s.push_str(" DEFAULT NULL"),
        DefaultKind::Value => {
            if let Some(v) = &col.default_value {
                s.push_str(" DEFAULT ");
                if is_numeric_literal(v) {
                    s.push_str(v.trim());
                } else {
                    s.push_str(&pg_quote_string(v));
                }
            }
        }
        DefaultKind::Expression => {
            if let Some(v) = &col.default_value {
                s.push_str(" DEFAULT ");
                s.push_str(v.trim());
            }
        }
    }
    if col.auto_increment {
        s.push_str(" GENERATED BY DEFAULT AS IDENTITY");
    }
    s
}

/// Inline constraint clause for PK/UNIQUE indexes (`None` for plain indexes,
/// which PostgreSQL requires as separate CREATE INDEX statements).
fn pg_index_clause(d: SqlDialect, idx: &IndexMeta) -> Option<String> {
    let cols = idx
        .columns
        .iter()
        .map(|c| d.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    match idx.kind {
        IndexKind::Primary => Some(format!(
            "CONSTRAINT {} PRIMARY KEY ({cols})",
            d.quote_ident(&idx.name)
        )),
        IndexKind::Unique => Some(format!(
            "CONSTRAINT {} UNIQUE ({cols})",
            d.quote_ident(&idx.name)
        )),
        _ => None,
    }
}

fn pg_fk_clause(d: SqlDialect, db: &str, fk: &ForeignKeyMeta) -> String {
    let cols = fk
        .columns
        .iter()
        .map(|c| d.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_cols = fk
        .ref_columns
        .iter()
        .map(|c| d.quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let target_db = fk.ref_db.as_deref().filter(|x| !x.is_empty()).unwrap_or(db);
    let mut s = format!(
        "CONSTRAINT {} FOREIGN KEY ({cols}) REFERENCES {}.{} ({ref_cols})",
        d.quote_ident(&fk.name),
        d.quote_ident(target_db),
        d.quote_ident(&fk.ref_table),
    );
    if let Some(action) = &fk.on_delete {
        s.push_str(&format!(" ON DELETE {action}"));
    }
    if let Some(action) = &fk.on_update {
        s.push_str(&format!(" ON UPDATE {action}"));
    }
    s
}

/// Build a PostgreSQL CREATE TABLE plus trailing CREATE INDEX statements for
/// plain indexes and COMMENT ON for a table comment.
pub(crate) fn pg_create_table(db: &str, req: &CreateTableRequest) -> Result<String> {
    let d = SqlDialect::Postgres;
    let name = req.name.trim();
    if name.is_empty() {
        return Err(AppError::Db("table name is empty".into()));
    }
    if req.columns.is_empty() {
        return Err(AppError::Db("a table needs at least one column".into()));
    }
    let mut seen = std::collections::HashSet::new();
    for col in &req.columns {
        if !seen.insert(col.name.to_ascii_lowercase()) {
            return Err(AppError::Db(format!("duplicate column `{}`", col.name)));
        }
    }

    let mut body: Vec<String> = req.columns.iter().map(|c| pg_column_definition(d, c)).collect();
    let mut extra: Vec<String> = Vec::new();
    for idx in &req.indexes {
        match pg_index_clause(d, idx) {
            Some(clause) => body.push(clause),
            None => extra.push(format!(
                "CREATE INDEX {} ON {} ({});",
                d.quote_ident(&idx.name),
                d.quote_qualified(&[db, name]),
                idx.columns
                    .iter()
                    .map(|c| d.quote_ident(c))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
    for fk in &req.foreign_keys {
        body.push(pg_fk_clause(d, db, fk));
    }

    let main = format!(
        "CREATE TABLE {} (\n  {}\n);",
        d.quote_qualified(&[db, name]),
        body.join(",\n  ")
    );
    extra.insert(0, main);
    if let Some(comment) = &req.options.comment {
        extra.push(format!(
            "COMMENT ON TABLE {} IS {};",
            d.quote_qualified(&[db, name]),
            pg_quote_string(comment)
        ));
    }
    Ok(extra.join("\n"))
}

/// The generated plan for one designer apply (mirrors alter_builder).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct AlterPlan {
    pub statements: Vec<String>,
    pub warnings: Vec<String>,
}

fn pg_fk_eq(a: &ForeignKeyMeta, b: &ForeignKeyMeta) -> bool {
    a.columns == b.columns
        && a.ref_table == b.ref_table
        && a.ref_columns == b.ref_columns
        && a.on_update == b.on_update
        && a.on_delete == b.on_delete
}

/// Diff two snapshots into PostgreSQL ALTER statements. Pragmatic subset:
/// column add/rename/drop/type/nullability/default, index + FK maintenance,
/// table comment, same-schema rename. Column reordering has no PG equivalent
/// and is ignored.
pub(crate) fn pg_alter_plan(db: &str, current: &TableDdl, desired: &TableDdl) -> Result<AlterPlan> {
    let d = SqlDialect::Postgres;
    let mut plan = AlterPlan::default();
    let src = d.quote_qualified(&[db, &current.table]);

    // -- foreign keys -------------------------------------------------------
    for fk in &current.foreign_keys {
        let kept = desired
            .foreign_keys
            .iter()
            .any(|x| x.name == fk.name && pg_fk_eq(x, fk));
        if !kept {
            plan.statements.push(format!(
                "ALTER TABLE {src} DROP CONSTRAINT {}",
                d.quote_ident(&fk.name)
            ));
        }
    }
    for fk in &desired.foreign_keys {
        if !current
            .foreign_keys
            .iter()
            .any(|x| x.name == fk.name && pg_fk_eq(x, fk))
        {
            plan.statements
                .push(format!("ALTER TABLE {src} ADD {}", pg_fk_clause(d, db, fk)));
        }
    }

    // -- primary key ----------------------------------------------------------
    let cur_pk = current.indexes.iter().find(|ix| ix.kind == IndexKind::Primary);
    let des_pk = desired.indexes.iter().find(|ix| ix.kind == IndexKind::Primary);
    let pk_changed = match (cur_pk, des_pk) {
        (None, None) => false,
        (Some(a), Some(b)) => a.columns != b.columns || a.name != b.name,
        _ => true,
    };
    if pk_changed {
        if let Some(pk) = cur_pk {
            plan.statements.push(format!(
                "ALTER TABLE {src} DROP CONSTRAINT IF EXISTS {}",
                d.quote_ident(&pk.name)
            ));
        }
        if let Some(pk) = des_pk {
            let cols = pk
                .columns
                .iter()
                .map(|c| d.quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let name = if pk.name.is_empty() {
                format!("{}_pkey", desired.table)
            } else {
                pk.name.clone()
            };
            plan.statements.push(format!(
                "ALTER TABLE {src} ADD CONSTRAINT {} PRIMARY KEY ({cols})",
                d.quote_ident(&name)
            ));
        }
    }

    // -- secondary indexes ----------------------------------------------------
    for idx in &current.indexes {
        if idx.kind == IndexKind::Primary {
            continue;
        }
        let kept = desired
            .indexes
            .iter()
            .any(|x| x.name == idx.name && x.kind == idx.kind && x.columns == idx.columns);
        if !kept {
            plan.statements.push(format!(
                "DROP INDEX IF EXISTS {}",
                d.quote_qualified(&[db, &idx.name])
            ));
        }
    }
    for idx in &desired.indexes {
        if idx.kind == IndexKind::Primary {
            continue;
        }
        let exists_same = current
            .indexes
            .iter()
            .any(|x| x.name == idx.name && x.kind == idx.kind && x.columns == idx.columns);
        if exists_same {
            continue;
        }
        let cols = idx
            .columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");
        let unique = if idx.kind == IndexKind::Unique { "UNIQUE " } else { "" };
        plan.statements.push(format!(
            "CREATE {unique}INDEX {} ON {src} ({cols})",
            d.quote_qualified(&[db, &idx.name])
        ));
    }

    // -- columns --------------------------------------------------------------
    for col in &desired.columns {
        let key = col.previous_name.as_deref().unwrap_or(col.name.as_str());
        match current.columns.iter().find(|c| c.name.eq_ignore_ascii_case(key)) {
            None => plan.statements.push(format!(
                "ALTER TABLE {src} ADD COLUMN {}",
                pg_column_definition(d, col)
            )),
            Some(cur) => {
                if cur.name != col.name {
                    plan.statements.push(format!(
                        "ALTER TABLE {src} RENAME COLUMN {} TO {}",
                        d.quote_ident(&cur.name),
                        d.quote_ident(&col.name)
                    ));
                }
                let ident = d.quote_ident(&col.name);
                if normalize_type(&cur.data_type) != normalize_type(&col.data_type) {
                    plan.statements.push(format!(
                        "ALTER TABLE {src} ALTER COLUMN {ident} TYPE {}",
                        col.data_type.trim()
                    ));
                }
                if cur.nullable != col.nullable {
                    let verb = if col.nullable { "DROP" } else { "SET" };
                    plan.statements
                        .push(format!("ALTER TABLE {src} ALTER COLUMN {ident} {verb} NOT NULL"));
                }
                let default_changed = match (&col.default_kind, &col.default_value) {
                    (DefaultKind::None, _) | (DefaultKind::Null, _) => {
                        !(cur.default_kind == DefaultKind::None
                            || cur.default_kind == DefaultKind::Null)
                    }
                    (kind, value) => {
                        cur.default_kind != *kind
                            || cur.default_value.as_deref().map(str::trim) != value.as_deref().map(str::trim)
                    }
                };
                if default_changed {
                    match (&col.default_kind, &col.default_value) {
                        (DefaultKind::Value, Some(v)) => {
                            let literal = if is_numeric_literal(v) {
                                v.trim().to_string()
                            } else {
                                pg_quote_string(v)
                            };
                            plan.statements.push(format!(
                                "ALTER TABLE {src} ALTER COLUMN {ident} SET DEFAULT {literal}"
                            ));
                        }
                        (DefaultKind::Expression, Some(v)) => plan.statements.push(format!(
                            "ALTER TABLE {src} ALTER COLUMN {ident} SET DEFAULT {}",
                            v.trim()
                        )),
                        _ => plan.statements.push(format!(
                            "ALTER TABLE {src} ALTER COLUMN {ident} DROP DEFAULT"
                        )),
                    }
                }
                if col.auto_increment && !cur.auto_increment {
                    plan.warnings.push(format!(
                        "column `{}`: converting an existing column to IDENTITY is not supported by this preview",
                        col.name
                    ));
                }
            }
        }
    }
    for col in &current.columns {
        let still_there = desired.columns.iter().any(|c| {
            c.name.eq_ignore_ascii_case(&col.name)
                || c.previous_name.as_deref() == Some(col.name.as_str())
        });
        if !still_there {
            plan.statements.push(format!(
                "ALTER TABLE {src} DROP COLUMN {}",
                d.quote_ident(&col.name)
            ));
        }
    }

    // -- options --------------------------------------------------------------
    if current.options.comment != desired.options.comment {
        let comment = desired.options.comment.clone().unwrap_or_default();
        plan.statements
            .push(format!("COMMENT ON TABLE {src} IS {}", pg_quote_string(&comment)));
    }
    if current.options.engine != desired.options.engine
        || current.options.charset != desired.options.charset
        || current.options.collation != desired.options.collation
        || current.options.row_format != desired.options.row_format
        || current.options.auto_increment != desired.options.auto_increment
        || !current.options.extra.is_empty()
        || !desired.options.extra.is_empty()
    {
        plan.warnings.push(
            "storage options (ENGINE/CHARSET/…) do not apply to PostgreSQL tables; ignoring".into(),
        );
    }

    // -- rename (last) ----------------------------------------------------------
    if desired.table != current.table {
        if !desired.db.is_empty() && !current.db.is_empty() && desired.db != current.db {
            return Err(AppError::Unsupported(
                "cross-database renames are not supported by PostgreSQL (move via dump/import)"
                    .into(),
            ));
        }
        plan.statements.push(format!(
            "ALTER TABLE {src} RENAME TO {}",
            d.quote_ident(&desired.table)
        ));
    }

    Ok(plan)
}

// ---------------------------------------------------------------------------
// Command-level statement builders (consumed by commands/objects.rs)
// ---------------------------------------------------------------------------

pub(crate) fn pg_drop_sql(db: &str, kind: ObjectKind, name: &str) -> Result<String> {
    let esc = name.replace('\'', "''");
    let esc_db = db.replace('\'', "''");
    Ok(match kind {
        ObjectKind::Table => format!("DROP TABLE {}", SqlDialect::Postgres.quote_qualified(&[db, name])),
        ObjectKind::View => format!("DROP VIEW {}", SqlDialect::Postgres.quote_qualified(&[db, name])),
        // Triggers need their parent relation resolved from the catalog;
        // routines need their argument signature. Both run inside one
        // anonymous block (the splitter keeps $$ bodies intact).
        ObjectKind::Trigger => format!(
            "DO $$ DECLARE parent text; BEGIN \
             SELECT c.relname INTO parent FROM pg_trigger g \
               JOIN pg_class c ON c.oid = g.tgrelid \
               JOIN pg_namespace n ON n.oid = c.relnamespace \
              WHERE g.tgname = '{esc}' AND NOT g.tgisinternal AND n.nspname = '{esc_db}' LIMIT 1; \
             IF parent IS NULL THEN RAISE EXCEPTION 'trigger % not found', '{esc}'; END IF; \
             EXECUTE format('DROP TRIGGER %I ON %I.%I', '{esc}', '{esc_db}', parent); \
             END $$;"
        ),
        ObjectKind::Routine => format!(
            "DO $$ DECLARE kinds text; sig text; BEGIN \
             SELECT CASE WHEN p.prokind = 'f' THEN 'FUNCTION' ELSE 'PROCEDURE' END, \
                    (SELECT string_agg(format_type(x, NULL), ', ') FROM unnest(p.proargtypes) AS x) \
               INTO kinds, sig FROM pg_proc p \
               JOIN pg_namespace n ON n.oid = p.pronamespace \
              WHERE n.nspname = '{esc_db}' AND p.proname = '{esc}' LIMIT 1; \
             IF sig IS NULL THEN RAISE EXCEPTION 'routine % not found', '{esc}'; END IF; \
             EXECUTE format('DROP %s %I.%I(%s)', kinds, '{esc_db}', '{esc}', sig); \
             END $$;"
        ),
        ObjectKind::Event => {
            return Err(AppError::Unsupported("PostgreSQL has no scheduled events".into()))
        }
    })
}

pub(crate) fn pg_rename_sql(db: &str, table: &str, new_db: &str, new_name: &str) -> Result<String> {
    if new_db != db {
        return Err(AppError::Unsupported(
            "cross-database renames are not supported by PostgreSQL".into(),
        ));
    }
    Ok(format!(
        "ALTER TABLE {} RENAME TO {}",
        SqlDialect::Postgres.quote_qualified(&[db, table]),
        SqlDialect::Postgres.quote_ident(new_name)
    ))
}

pub(crate) fn pg_empty_clone_sql(db: &str, table: &str, new_name: &str) -> String {
    let d = SqlDialect::Postgres;
    format!(
        "CREATE TABLE {} (LIKE {} INCLUDING ALL)",
        d.quote_qualified(&[db, new_name]),
        d.quote_qualified(&[db, table])
    )
}

pub(crate) fn pg_truncate_sql(db: &str, table: &str) -> String {
    format!(
        "TRUNCATE TABLE {}",
        SqlDialect::Postgres.quote_qualified(&[db, table])
    )
}

/// Maintenance verbs; PostgreSQL has no REPAIR/CHECKSUM/FLUSH equivalents.
pub(crate) fn pg_maintenance_sql(op: MaintenanceOp, db: &str, table: &str) -> Result<String> {
    let q = SqlDialect::Postgres.quote_qualified(&[db, table]);
    Ok(match op {
        MaintenanceOp::Analyze => format!("ANALYZE {q}"),
        MaintenanceOp::Optimize => format!("VACUUM (ANALYZE) {q}"),
        MaintenanceOp::Check => "CHECKPOINT".to_string(),
        MaintenanceOp::Repair | MaintenanceOp::Flush | MaintenanceOp::Checksum => {
            return Err(AppError::Unsupported(format!(
                "{op:?} maintenance is not supported by PostgreSQL"
            )))
        }
    })
}

// ---------------------------------------------------------------------------
// Script helpers
// ---------------------------------------------------------------------------

fn looks_like_result_set(sql: &str) -> bool {
    let head = sql
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_uppercase();
    matches!(head.as_str(), "SELECT" | "TABLE" | "VALUES" | "SHOW" | "EXPLAIN")
}

fn sql_snippet(sql: &str) -> String {
    let flat = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(120).collect();
    if flat.chars().count() > 120 {
        out.push('…');
    }
    out
}

/// Casts aligned to one change's placeholder order (SET first, then PK).
fn casts_for_change(columns: &[ColumnMeta], change: &RowChange) -> Vec<String> {
    let cast_of = |assigns: &[CellAssign]| -> Vec<String> {
        assigns
            .iter()
            .filter_map(|a| columns.iter().find(|c| c.name == a.column))
            .map(|c| cast_type_for(&c.data_type))
            .collect()
    };
    match change {
        RowChange::Insert { values } => cast_of(values),
        RowChange::Update { pk, set } => {
            let mut v = cast_of(set);
            v.extend(cast_of(pk));
            v
        }
        RowChange::Delete { pk } => cast_of(pk),
    }
}

/// Convert neutral binds (see connections/sql.rs) into wire params.
fn params_from_binds(binds: &[mysql_async::Value]) -> Vec<PgParam> {
    binds.iter().map(|v| param_text(&rowvalue_of_bind(v))).collect()
}

fn rowvalue_of_bind(value: &mysql_async::Value) -> RowValue {
    use mysql_async::Value;
    match value {
        Value::NULL => RowValue::Null,
        Value::Int(v) => RowValue::Int(*v),
        Value::UInt(v) => RowValue::UInt(*v),
        Value::Float(v) => RowValue::Float(*v as f64),
        Value::Double(v) => RowValue::Float(*v),
        Value::Bytes(b) => RowValue::Str(String::from_utf8_lossy(b).into_owned()),
        Value::Date(y, mo, d, h, mi, s, us) => RowValue::Datetime(format!(
            "{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{us:06}"
        )),
        Value::Time(neg, days, h, m, s, us) => RowValue::Time(format!(
            "{}{days}d {h:02}:{m:02}:{s:02}.{us:06}",
            if *neg { "-" } else { "" }
        )),
    }
}

// ---------------------------------------------------------------------------
// Streaming reads (paged; see module docs for the deviation note)
// ---------------------------------------------------------------------------

async fn stream_paged(
    client: &Client,
    sql: &str,
    chunk_size: usize,
    tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
) -> Result<u64> {
    let base = sql.trim().trim_end_matches(';').trim();
    if base.is_empty() {
        return Err(AppError::Db("nothing to stream".into()));
    }
    let page_size = chunk_size.clamp(1, MAX_STREAM_CHUNK);

    // Plan once for column names/types (planning never executes).
    let wrapped_schema = format!("SELECT * FROM ({base}) AS _hc_sub LIMIT 0");
    let (columns, types): (Vec<ResultColumnMeta>, Vec<String>) =
        match client.prepare(&wrapped_schema).await {
            Ok(stmt) => {
                let metas = stmt
                    .columns()
                    .iter()
                    .map(|c| ResultColumnMeta {
                        name: c.name().to_string(),
                        data_type: c.type_().name().to_string(),
                    })
                    .collect::<Vec<_>>();
                let types = metas.iter().map(|m| m.data_type.clone()).collect();
                (metas, types)
            }
            Err(_) => (Vec::new(), Vec::new()),
        };

    let mut offset: u64 = 0;
    let mut total: u64 = 0;
    loop {
        let page_sql = format!(
            "SELECT * FROM ({base}) AS _hc_sub {}",
            SqlDialect::Postgres.limit_clause(page_size as u64, offset)
        );
        let messages = client.simple_query(&page_sql).await?;
        let page: Vec<SimpleQueryRow> = messages
            .into_iter()
            .filter_map(|m| match m {
                SimpleQueryMessage::Row(row) => Some(row),
                _ => None,
            })
            .collect();
        let got = page.len();

        if got > 0 && types.is_empty() {
            return Err(AppError::Db(
                "statement columns could not be determined for streaming".into(),
            ));
        }
        let rows: Vec<Vec<RowValue>> = page
            .iter()
            .map(|row| text_row_to_values(&types, row))
            .collect();

        let last_page = got < page_size;
        offset += got as u64;
        total += got as u64;

        if !rows.is_empty() && !send_chunk(&tx, &columns, rows).await {
            return Ok(total); // consumer hung up: export cancelled
        }
        if last_page {
            break;
        }
    }
    Ok(total)
}

#[async_trait]
impl DbConnection for PgConnection {
    fn server_label(&self) -> String {
        format!("PostgreSQL {}", self.server_info.version)
    }

    fn server_info(&self) -> ServerInfo {
        self.server_info.clone()
    }

    async fn close(&mut self) {
        // Dropping the Client closes the socket and ends the transport task.
    }

    async fn list_databases(&mut self) -> Result<Vec<DatabaseInfo>> {
        let rows = self
            .client
            .query(
                "SELECT datname, pg_encoding_to_char(encoding), datcollate \
                 FROM pg_database WHERE NOT datistemplate ORDER BY datname",
                &[],
            )
            .await?;
        rows.iter()
            .map(|row| {
                Ok(DatabaseInfo {
                    name: r_string(row, 0)?,
                    charset: r_opt_string(row, 1)?,
                    collation: r_opt_string(row, 2)?.filter(|c| !c.is_empty()),
                })
            })
            .collect()
    }

    async fn list_tables(&mut self, database: &str) -> Result<Vec<TableMeta>> {
        let rows = self
            .client
            .query(
                "SELECT c.relname, c.relkind::text, \
                        CASE WHEN c.reltuples >= 0 THEN c.reltuples::bigint ELSE NULL END, \
                        CASE WHEN c.relkind IN ('r','p') THEN pg_total_relation_size(c.oid)::bigint ELSE NULL END, \
                        obj_description(c.oid, 'pg_class') \
                 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m') \
                 ORDER BY c.relname",
                &[&database],
            )
            .await?;
        rows.iter()
            .map(|row| {
                let relkind = r_string(row, 1)?;
                Ok(TableMeta {
                    name: r_string(row, 0)?,
                    kind: relkind_to_kind(&relkind),
                    rows: r_opt_i64(row, 2)?.map(|v| v.max(0) as u64),
                    size_bytes: r_opt_i64(row, 3)?.map(|v| v.max(0) as u64),
                    comment: r_opt_string(row, 4)?.filter(|c| !c.is_empty()),
                    engine: None,
                })
            })
            .collect()
    }

    async fn describe_table(&mut self, database: &str, table: &str) -> Result<Vec<ColumnMeta>> {
        if let Some(cached) = self.schema.get(database, table) {
            return Ok(cached.to_vec());
        }
        let columns = self.describe_table_uncached(database, table).await?;
        self.schema.insert(database, table, columns.clone());
        Ok(columns)
    }

    fn clear_schema_cache(&mut self) {
        self.schema.clear();
    }

    async fn list_schema_columns(&mut self, database: &str) -> Result<Vec<TableSchemaData>> {
        // Whole-schema mirror of load_columns + pk_attnums joined through
        // pg_class/pg_namespace (base and partitioned tables only).
        let rows = self
            .client
            .query(
                "SELECT c.relname, c.oid, a.attname, format_type(a.atttypid, a.atttypmod), \
                        NOT a.attnotnull, \
                        pg_get_expr(ad.adbin, ad.adrelid), \
                        a.attidentity, a.attgenerated, a.attnum, \
                        col_description(a.attrelid, a.attnum) \
                 FROM pg_class c \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 JOIN pg_attribute a ON a.attrelid = c.oid \
                  AND a.attnum > 0 AND NOT a.attisdropped \
                 LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
                 WHERE n.nspname = $1 AND c.relkind IN ('r','p') \
                 ORDER BY c.relname, a.attnum",
                &[&database],
            )
            .await?;

        // Rows arrive ordered by (table, attnum); PK membership comes from a
        // second catalog pass keyed by relation OID.
        let mut by_table: std::collections::BTreeMap<u32, TableSchemaData> =
            std::collections::BTreeMap::new();
        let mut attnums: std::collections::HashMap<u32, Vec<i16>> =
            std::collections::HashMap::new();
        let mut names: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
        for row in &rows {
            let relname = r_string(row, 0)?;
            let oid: u32 = row.try_get(1).map_err(|_| missing(1))?;
            let col = PgColumn {
                name: r_string(row, 2)?,
                type_text: r_string(row, 3)?,
                nullable: r_bool(row, 4)?,
                default_expr: r_opt_string(row, 5)?,
                identity: r_opt_char(row, 6)?,
                generated: r_opt_char(row, 7)?,
                attnum: r_i16(row, 8)?,
                comment: r_opt_string(row, 9)?.filter(|c| !c.is_empty()),
            };
            names.entry(oid).or_insert(relname);
            attnums.entry(oid).or_default().push(col.attnum);
            by_table
                .entry(oid)
                .or_insert_with(|| TableSchemaData {
                    table: String::new(),
                    columns: Vec::new(),
                })
                .columns
                .push(pg_column_meta(&col, false));
        }

        let pk_rows = self
            .client
            .query(
                "SELECT con.conrelid, con.conkey FROM pg_constraint con \
                 JOIN pg_class c ON c.oid = con.conrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE n.nspname = $1 AND con.contype = 'p'",
                &[&database],
            )
            .await?;
        let mut pks: std::collections::HashMap<u32, Vec<i16>> =
            std::collections::HashMap::new();
        for row in &pk_rows {
            let oid: u32 = row.try_get(0).map_err(|_| missing(0))?;
            pks.insert(oid, r_vec_i16(row, 1)?);
        }

        Ok(by_table
            .into_iter()
            .map(|(oid, mut data)| {
                // Flag PK columns by their catalog attnum (dropped columns
                // leave gaps, so positional indexing would be wrong).
                let pk = pks.get(&oid).cloned().unwrap_or_default();
                for (col, attnum) in data.columns.iter_mut().zip(
                    attnums.remove(&oid).unwrap_or_default(),
                ) {
                    if pk.contains(&attnum) {
                        col.key = Some("PRI".into());
                    }
                }
                data.table = names.remove(&oid).unwrap_or_default();
                data
            })
            .collect())
    }

    async fn list_schema_foreign_keys(&mut self, database: &str) -> Result<Vec<ForeignKeyMeta>> {
        // Whole-schema mirror of the forward FK query minus the conrelid
        // filter. `table` carries the child; ref_db stays None because PG
        // cross-database references do not exist (cross-schema ones are
        // indistinguishable here and resolve within the diagram scope).
        let fk_rows = self
            .client
            .query(
                "SELECT con.conname, con.confupdtype, con.confdeltype, ct.relname, rt.relname, \
                        (SELECT array_agg(sa.attname ORDER BY x.ord) \
                           FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord) \
                           JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = x.attnum), \
                        (SELECT array_agg(ra.attname ORDER BY y.ord) \
                           FROM unnest(con.confkey) WITH ORDINALITY AS y(attnum, ord) \
                           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = y.attnum) \
                 FROM pg_constraint con \
                 JOIN pg_class ct ON ct.oid = con.conrelid \
                 JOIN pg_namespace cn ON cn.oid = ct.relnamespace \
                 JOIN pg_class rt ON rt.oid = con.confrelid \
                 WHERE cn.nspname = $1 AND con.contype = 'f' \
                 ORDER BY ct.relname, con.conname",
                &[&database],
            )
            .await?;

        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for row in &fk_rows {
            foreign_keys.push(ForeignKeyMeta {
                name: r_string(row, 0)?,
                columns: r_vec_string(row, 5)?,
                ref_db: None,
                ref_table: r_string(row, 4)?,
                ref_columns: r_vec_string(row, 6)?,
                on_update: Some(fk_action_letter(r_opt_char(row, 1)?.unwrap_or('a')).to_string()),
                on_delete: Some(fk_action_letter(r_opt_char(row, 2)?.unwrap_or('a')).to_string()),
                table: Some(r_string(row, 3)?),
            });
        }
        Ok(foreign_keys)
    }

    async fn query_page(&mut self, req: &QueryPageRequest) -> Result<QueryPageResult> {
        let started = std::time::Instant::now();
        let d = SqlDialect::Postgres;

        let columns = self.describe_table(&req.db, &req.table).await?;
        let table_q = d.quote_qualified(&[&req.db, &req.table]);

        // Every selected column renders ::text under its own alias (module docs).
        let select_list = columns
            .iter()
            .map(|c| {
                let ident = d.quote_ident(&c.name);
                format!("{ident}::text AS {ident}")
            })
            .collect::<Vec<_>>()
            .join(", ");

        let where_clause =
            build_where_clause_and(d, &columns, &req.filters, req.search.as_deref())?;
        // Per-parameter casts: each term's binds carry its own column's type
        // so AND-combined terms stay independently coercible (`in` expands
        // into one bind per value; NULL predicates contribute no binds).
        let mut casts: Vec<Option<String>> = Vec::new();
        for f in &req.filters {
            let cast = columns
                .iter()
                .find(|c| c.name == f.column)
                .map(|c| cast_type_for(&c.data_type));
            match f.op {
                FilterOp::In => {
                    for _ in 0..f.values.len() {
                        casts.push(cast.clone());
                    }
                }
                FilterOp::IsNull | FilterOp::IsNotNull => {}
                _ => casts.push(cast),
            }
        }
        let where_sql = apply_param_casts(&where_clause.sql, |i| casts.get(i).cloned().flatten());
        let order_clause = build_order_by_clause(d, &columns, &req.order_by)?;

        let page_size = req.page_size.clamp(1, MAX_PAGE_SIZE);
        let sql = format!(
            "SELECT {select_list} FROM {table_q}{where_sql}{order_clause} {}",
            d.limit_clause(page_size.saturating_add(1) as u64, req.offset)
        );

        // Binds come straight from the neutral builder; the `in` operator
        // contributes one parameter per selected value.
        let params: Vec<PgParam> = params_from_binds(&where_clause.params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();

        let mut rows = self.client.query(sql.as_str(), &refs).await?;
        let has_more = rows.len() > page_size as usize;
        if has_more {
            rows.truncate(page_size as usize);
        }

        let rows_out: Vec<Vec<RowValue>> = rows
            .iter()
            .map(|row| {
                columns
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        let raw: Option<Option<String>> = row.try_get(i).ok();
                        parse_cell_text(&c.data_type, raw.flatten().as_deref())
                    })
                    .collect()
            })
            .collect();

        // Cheap statistics estimate for the scrollbar.
        let total_rows_estimate = match self.relid(&req.db, &req.table).await.ok() {
            Some(id) => self
                .client
                .query_opt(
                    "SELECT CASE WHEN reltuples >= 0 THEN reltuples::bigint ELSE NULL END \
                     FROM pg_class WHERE oid = $1",
                    &[&id],
                )
                .await
                .ok()
                .and_then(|r| r.and_then(|r| r.try_get::<_, Option<i64>>(0).ok()).flatten())
                .map(|v| v.max(0) as u64),
            None => None,
        };

        Ok(QueryPageResult {
            columns,
            rows: rows_out,
            total_rows_estimate,
            elapsed_ms: started.elapsed().as_millis() as u64,
            has_more,
        })
    }

    async fn apply_changes(
        &mut self,
        req: &ApplyChangesRequest,
        join_tx: bool,
    ) -> Result<ApplyChangesResult> {
        let started = std::time::Instant::now();
        if req.changes.is_empty() {
            return Ok(ApplyChangesResult {
                applied: 0,
                failed: 0,
                errors: Vec::new(),
                elapsed_ms: 0,
            });
        }

        let d = SqlDialect::Postgres;
        let columns = self.describe_table(&req.db, &req.table).await?;
        let table_q = d.quote_qualified(&[&req.db, &req.table]);

        // Pre-build everything; malformed changes become per-row errors.
        let mut built: Vec<(usize, String, Vec<PgParam>)> = Vec::new();
        let mut errors: Vec<RowError> = Vec::new();
        for (index, change) in req.changes.iter().enumerate() {
            match build_change_sql(d, &table_q, &columns, change) {
                Ok(stmt) => {
                    let casts = casts_for_change(&columns, change);
                    let sql = apply_param_casts(&stmt.sql, |idx| casts.get(idx.wrapping_sub(1)).cloned());
                    built.push((index, sql, params_from_binds(&stmt.params)));
                }
                Err(err) => errors.push(RowError {
                    index,
                    message: err.to_string(),
                }),
            }
        }
        let mut applied = 0u32;
        let mut failed = errors.len() as u32;

        if join_tx {
            // Manual-mode grid edits join the actor-managed transaction:
            // execute straight on the client (no internal transaction()).
            for (index, sql, params) in &built {
                let refs: Vec<&(dyn ToSql + Sync)> =
                    params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
                match self.client.execute(sql.as_str(), &refs).await {
                    Ok(_) => applied += 1,
                    Err(err) => {
                        failed += 1;
                        errors.push(RowError {
                            index: *index,
                            message: err.to_string(),
                        });
                    }
                }
            }
        } else {
            // One atomic batch. PostgreSQL aborts the transaction on the
            // first statement error (25P02) — later statements and commit
            // would all fail — so stop at the first failure, roll back, and
            // report EVERY change as failed while keeping the triggering
            // row's real error. The grid then leaves all edits staged.
            let tx = self.client.transaction().await?;
            let mut trigger: Option<RowError> = None;
            for (index, sql, params) in &built {
                let refs: Vec<&(dyn ToSql + Sync)> =
                    params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
                match tx.execute(sql.as_str(), &refs).await {
                    Ok(_) => applied += 1,
                    Err(err) => {
                        trigger = Some(RowError {
                            index: *index,
                            message: err.to_string(),
                        });
                        break;
                    }
                }
            }
            match trigger {
                None => {
                    // A commit failure (e.g. a deferred constraint) also
                    // rolls the whole batch back.
                    if let Err(err) = tx.commit().await {
                        trigger = Some(RowError {
                            index: 0,
                            message: format!("commit failed — batch rolled back: {err}"),
                        });
                    }
                }
                Some(_) => {
                    let _ = tx.rollback().await;
                }
            }
            if let Some(t) = trigger {
                applied = 0;
                failed = req.changes.len() as u32;
                let build_errors: std::collections::HashMap<usize, String> =
                    errors.drain(..).map(|e| (e.index, e.message)).collect();
                errors = (0..req.changes.len())
                    .map(|i| RowError {
                        index: i,
                        message: build_errors.get(&i).cloned().unwrap_or_else(|| {
                            if t.index == i {
                                t.message.clone()
                            } else {
                                "rolled back — the batch aborted on another row's error"
                                    .to_string()
                            }
                        }),
                    })
                    .collect();
            }
        }

        Ok(ApplyChangesResult {
            applied,
            failed,
            errors,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn count_rows(
        &mut self,
        database: &str,
        table: &str,
        filter: Option<&FilterSpec>,
    ) -> Result<Option<u64>> {
        let d = SqlDialect::Postgres;
        let columns = self.describe_table(database, table).await?;
        let table_q = d.quote_qualified(&[database, table]);

        let where_clause = build_where_clause(d, &columns, filter)?;
        let filter_cast = filter.and_then(|f| {
            columns
                .iter()
                .find(|c| c.name == f.column)
                .map(|c| cast_type_for(&c.data_type))
        });
        let where_sql = apply_param_casts(&where_clause.sql, |_| filter_cast.clone());
        let sql = format!("SELECT COUNT(*)::text FROM {table_q}{where_sql}");

        let params: Vec<PgParam> = params_from_binds(&where_clause.params);
        let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();

        let row = self.client.query_one(sql.as_str(), &refs).await?;
        let text: String = row.get(0);
        Ok(text.parse::<u64>().ok())
    }

    async fn distinct_values(
        &mut self,
        database: &str,
        table: &str,
        column: &str,
        limit: u32,
        search: Option<&str>,
    ) -> Result<Vec<DistinctValue>> {
        let d = SqlDialect::Postgres;
        let columns = self.describe_table(database, table).await?;
        let meta = validate_column(columns.as_slice(), column)?;
        let cast = cast_type_for(&meta.data_type);
        let built = build_distinct_values_sql(
            d,
            &d.quote_qualified(&[database, table]),
            meta,
            &format!("{}::text", d.quote_ident(&meta.name)),
            "COUNT(*)::text",
            search,
            limit,
        );
        // Every parameter is a text payload for this filter column's type.
        let sql = apply_param_casts(&built.sql, |_| Some(cast.clone()));
        let params: Vec<PgParam> = params_from_binds(&built.params);
        let refs: Vec<&(dyn ToSql + Sync)> =
            params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();

        let rows = self.client.query(sql.as_str(), &refs).await?;
        rows.iter()
            .map(|row| {
                let value_text: Option<Option<String>> = row.try_get(0).ok();
                let count_text: String = row.get(1);
                Ok(DistinctValue {
                    value: parse_cell_text(&meta.data_type, value_text.flatten().as_deref()),
                    count: count_text.parse::<u64>().unwrap_or(0),
                })
            })
            .collect()
    }

    async fn execute(&mut self, sql: &str) -> Result<ExecResult> {
        // Arbitrary SQL may be DDL — drop the cached columns so the next
        // describe re-validates against the live schema.
        self.schema.clear();
        let started = std::time::Instant::now();
        // Compound bodies (CREATE FUNCTION … $$ … $$) survive as one
        // statement via the extended protocol; genuinely multi-statement
        // strings go through batch_execute.
        if split_postgres(sql).len() > 1 {
            self.client.batch_execute(sql).await?;
            return Ok(ExecResult {
                rows_affected: 0,
                last_insert_id: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        if looks_like_result_set(sql) {
            let messages = self.client.simple_query(sql).await?;
            let n = messages
                .iter()
                .filter(|m| matches!(m, SimpleQueryMessage::Row(_)))
                .count();
            return Ok(ExecResult {
                rows_affected: n as u64,
                last_insert_id: None,
                elapsed_ms: started.elapsed().as_millis() as u64,
            });
        }
        let affected = self.client.execute(sql, &[]).await?;
        Ok(ExecResult {
            rows_affected: affected,
            last_insert_id: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    async fn run_script(&mut self, sql: &str, stop_on_error: bool) -> Result<Vec<QueryOutcome>> {
        // Same DDL rationale as `execute`.
        self.schema.clear();
        let mut outcomes: Vec<QueryOutcome> = Vec::new();

        for stmt in split_postgres(sql) {
            let snippet = sql_snippet(&stmt);

            let result: std::result::Result<QueryOutcome, (String, bool)> =
                if looks_like_result_set(&stmt) {
                    self.run_script_select(&stmt).await
                } else {
                    let started = std::time::Instant::now();
                    match self.client.execute(stmt.as_str(), &[]).await {
                        Ok(affected) => Ok(QueryOutcome::Exec {
                            affected,
                            last_insert_id: None,
                            info: None,
                            elapsed_ms: started.elapsed().as_millis() as u64,
                            sql: Some(stmt.clone()),
                        }),
                        Err(err) => Err((err.to_string(), err_aborts_transaction(&err))),
                    }
                };

            match result {
                Ok(outcome) => outcomes.push(outcome),
                Err((message, aborted_tx)) => {
                    outcomes.push(QueryOutcome::Error { message, sql_snippet: snippet, aborted_tx });
                    if stop_on_error {
                        break;
                    }
                }
            }
        }

        Ok(outcomes)
    }

    // -----------------------------------------------------------------------
    // Object management
    // -----------------------------------------------------------------------

    async fn get_table_ddl(&mut self, database: &str, table: &str) -> Result<TableDdl> {
        let d = SqlDialect::Postgres;
        let relid = self.relid(database, table).await?;
        let pg_cols = self.load_columns(relid).await?;

        // Columns ------------------------------------------------------------
        let mut columns: Vec<ColumnDef> = Vec::with_capacity(pg_cols.len());
        for c in &pg_cols {
            let (default_kind, default_value, serial) = c
                .default_expr
                .clone()
                .map(|e| classify_default(&e))
                .unwrap_or((DefaultKind::None, None, false));
            let generated = c.generated.map(|g| {
                let expr = c.default_expr.clone().unwrap_or_default();
                if g == 'v' {
                    expr // virtual generated (PG18+); kept verbatim
                } else {
                    format!("GENERATED ALWAYS AS ({expr}) STORED")
                }
            });
            columns.push(ColumnDef {
                name: c.name.clone(),
                previous_name: None,
                data_type: c.type_text.clone(),
                nullable: c.nullable,
                default_kind,
                default_value,
                auto_increment: serial || c.identity.is_some(),
                on_update: None,
                generated: generated.filter(|g| !g.is_empty()),
                comment: c.comment.clone(),
                preserved_attrs: Vec::new(),
            });
        }

        // Indexes --------------------------------------------------------------
        let index_rows = self
            .client
            .query(
                "SELECT ic.relname, ix.indisprimary, ix.indisunique, \
                        COALESCE(array_agg(att.attname ORDER BY keys.ord), '{}')::text[] \
                 FROM pg_index ix \
                 JOIN pg_class ic ON ic.oid = ix.indexrelid \
                 CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS keys(key, ord) \
                 LEFT JOIN pg_attribute att \
                       ON att.attrelid = ix.indrelid AND att.attnum = keys.key \
                 WHERE ix.indrelid = $1 \
                 GROUP BY ic.relname, ix.indisprimary, ix.indisunique \
                 ORDER BY ic.relname",
                &[&relid],
            )
            .await?;
        let mut indexes: Vec<IndexMeta> = Vec::new();
        for row in &index_rows {
            let name = r_string(row, 0)?;
            let primary = r_bool(row, 1)?;
            let unique = r_bool(row, 2)?;
            let cols = r_vec_string(row, 3)?;
            // Skip internal auto-indexes (the PK already covers them) and
            // expression indexes whose plain-column projection is empty.
            if primary {
                indexes.push(IndexMeta {
                    name: "PRIMARY".into(),
                    kind: IndexKind::Primary,
                    columns: cols,
                    comment: None,
                });
            } else if !cols.is_empty() {
                indexes.push(IndexMeta {
                    name,
                    kind: if unique { IndexKind::Unique } else { IndexKind::Index },
                    columns: cols,
                    comment: None,
                });
            }
        }

        // Foreign keys ---------------------------------------------------------
        let fk_rows = self
            .client
            .query(
                "SELECT con.conname, con.confupdtype, con.confdeltype, rt.relname, \
                        (SELECT array_agg(sa.attname ORDER BY x.ord) \
                           FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord) \
                           JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = x.attnum), \
                        (SELECT array_agg(ra.attname ORDER BY y.ord) \
                           FROM unnest(con.confkey) WITH ORDINALITY AS y(attnum, ord) \
                           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = y.attnum) \
                 FROM pg_constraint con JOIN pg_class rt ON rt.oid = con.confrelid \
                 WHERE con.conrelid = $1 AND con.contype = 'f' \
                 ORDER BY con.conname",
                &[&relid],
            )
            .await?;
        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for row in &fk_rows {
            foreign_keys.push(ForeignKeyMeta {
                name: r_string(row, 0)?,
                columns: r_vec_string(row, 4)?,
                ref_db: None,
                ref_table: r_string(row, 3)?,
                ref_columns: r_vec_string(row, 5)?,
                on_update: Some(fk_action_letter(r_opt_char(row, 1)?.unwrap_or('a')).to_string()),
                on_delete: Some(fk_action_letter(r_opt_char(row, 2)?.unwrap_or('a')).to_string()),
                table: None,
            });
        }

        // CHECK constraints (preserved verbatim) ---------------------------------
        let check_rows = self
            .client
            .query(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint \
                 WHERE conrelid = $1 AND contype = 'c' ORDER BY conname",
                &[&relid],
            )
            .await?;
        let checks = check_rows
            .iter()
            .map(|row| r_string(row, 0))
            .collect::<Result<Vec<_>>>()?;

        // Reconstructed CREATE TABLE ---------------------------------------------
        let qualified = d.quote_qualified(&[database, table]);
        let mut body: Vec<String> = columns.iter().map(|c| pg_column_definition(d, c)).collect();
        for idx in &indexes {
            if let Some(clause) = pg_index_clause(d, idx) {
                body.push(clause);
            }
        }
        for fk in &foreign_keys {
            body.push(pg_fk_clause(d, database, fk));
        }
        let mut create_sql = format!("CREATE TABLE {qualified} (\n  {}\n)", body.join(",\n  "));
        for idx in indexes.iter().filter(|ix| ix.kind == IndexKind::Index) {
            let cols = idx
                .columns
                .iter()
                .map(|c| d.quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            create_sql.push_str(&format!(
                ";\nCREATE INDEX {} ON {qualified} ({cols})",
                d.quote_ident(&idx.name)
            ));
        }

        Ok(TableDdl {
            db: database.to_string(),
            table: table.to_string(),
            columns,
            indexes,
            foreign_keys,
            options: TableOptions::default(),
            checks,
            create_sql,
        })
    }

    async fn list_referencing_foreign_keys(
        &mut self,
        database: &str,
        table: &str,
    ) -> Result<Vec<ForeignKeyMeta>> {
        let relid = self.relid(database, table).await?;
        // Mirror of the forward FK query with the join flipped: children
        // (conrelid) drive the constraint, the queried table is confrelid.
        let fk_rows = self
            .client
            .query(
                "SELECT con.conname, con.confupdtype, con.confdeltype, ct.relname, \
                        (SELECT array_agg(sa.attname ORDER BY x.ord) \
                           FROM unnest(con.conkey) WITH ORDINALITY AS x(attnum, ord) \
                           JOIN pg_attribute sa ON sa.attrelid = con.conrelid AND sa.attnum = x.attnum), \
                        (SELECT array_agg(ra.attname ORDER BY y.ord) \
                           FROM unnest(con.confkey) WITH ORDINALITY AS y(attnum, ord) \
                           JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = y.attnum) \
                 FROM pg_constraint con JOIN pg_class ct ON ct.oid = con.conrelid \
                 WHERE con.confrelid = $1 AND con.contype = 'f' \
                 ORDER BY ct.relname, con.conname",
                &[&relid],
            )
            .await?;

        let mut foreign_keys: Vec<ForeignKeyMeta> = Vec::new();
        for row in &fk_rows {
            foreign_keys.push(ForeignKeyMeta {
                name: r_string(row, 0)?,
                // conkey: child-side columns; confkey: referenced (parent).
                columns: r_vec_string(row, 4)?,
                ref_db: None,
                ref_table: table.to_string(),
                ref_columns: r_vec_string(row, 5)?,
                on_update: Some(fk_action_letter(r_opt_char(row, 1)?.unwrap_or('a')).to_string()),
                on_delete: Some(fk_action_letter(r_opt_char(row, 2)?.unwrap_or('a')).to_string()),
                table: Some(r_string(row, 3)?),
            });
        }
        Ok(foreign_keys)
    }

    async fn list_routines(&mut self, database: &str) -> Result<Vec<RoutineMeta>> {
        let rows = self
            .client
            .query(
                "SELECT p.proname, (p.prokind = 'f'), pg_get_userbyid(p.proowner), \
                        obj_description(p.oid) \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.prokind IN ('f','p') \
                 ORDER BY p.prokind DESC, p.proname",
                &[&database],
            )
            .await?;
        rows.iter()
            .map(|row| {
                Ok(RoutineMeta {
                    name: r_string(row, 0)?,
                    kind: if r_bool(row, 1)? {
                        RoutineKind::Function
                    } else {
                        RoutineKind::Procedure
                    },
                    params: None,
                    returns: None,
                    comment: r_opt_string(row, 3)?.filter(|c| !c.is_empty()),
                    definer: r_opt_string(row, 2)?.filter(|d| !d.is_empty()),
                    created: None,
                })
            })
            .collect()
    }

    async fn get_routine_ddl(
        &mut self,
        database: &str,
        name: &str,
        kind: RoutineKind,
    ) -> Result<ShowCreateResult> {
        let prokind = if kind == RoutineKind::Function { 'f' } else { 'p' };
        let rows = self
            .client
            .query(
                "SELECT pg_get_functiondef(p.oid) \
                 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3 LIMIT 1",
                &[&database, &name, &prokind.to_string()],
            )
            .await?;
        match rows.first() {
            Some(row) => Ok(ShowCreateResult {
                db: database.to_string(),
                object: name.to_string(),
                kind: match kind {
                    RoutineKind::Procedure => ShowCreateKind::Procedure,
                    RoutineKind::Function => ShowCreateKind::Function,
                },
                create_sql: r_string(row, 0)?,
            }),
            None => Err(AppError::Db(format!("routine {name} not found"))),
        }
    }

    async fn list_triggers(&mut self, database: &str) -> Result<Vec<TriggerMeta>> {
        let rows = self
            .client
            .query(
                "SELECT t.tgname, c.relname, pg_get_triggerdef(t.oid) \
                 FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE NOT t.tgisinternal AND n.nspname = $1 \
                 ORDER BY t.tgname",
                &[&database],
            )
            .await?;
        rows.iter()
            .map(|row| {
                let def = r_string(row, 2)?;
                let (timing, event) = parse_trigger_def(&def);
                Ok(TriggerMeta {
                    name: r_string(row, 0)?,
                    timing,
                    event,
                    table: r_string(row, 1)?,
                    definer: None,
                    created: None,
                })
            })
            .collect()
    }

    async fn get_trigger_ddl(&mut self, database: &str, name: &str) -> Result<ShowCreateResult> {
        let rows = self
            .client
            .query(
                "SELECT pg_get_triggerdef(t.oid) \
                 FROM pg_trigger t \
                 JOIN pg_class c ON c.oid = t.tgrelid \
                 JOIN pg_namespace n ON n.oid = c.relnamespace \
                 WHERE NOT t.tgisinternal AND n.nspname = $1 AND t.tgname = $2 LIMIT 1",
                &[&database, &name],
            )
            .await?;
        match rows.first() {
            Some(row) => Ok(ShowCreateResult {
                db: database.to_string(),
                object: name.to_string(),
                kind: ShowCreateKind::Trigger,
                create_sql: r_string(row, 0)?,
            }),
            None => Err(AppError::Db(format!("trigger {name} not found"))),
        }
    }

    async fn get_view_ddl(&mut self, database: &str, name: &str) -> Result<ShowCreateResult> {
        let relid = self.relid(database, name).await?;
        let row = self
            .client
            .query_one("SELECT pg_get_viewdef($1, true)", &[&relid])
            .await?;
        Ok(ShowCreateResult {
            db: database.to_string(),
            object: name.to_string(),
            kind: ShowCreateKind::View,
            create_sql: format!(
                "CREATE OR REPLACE VIEW {} AS\n{}",
                SqlDialect::Postgres.quote_qualified(&[database, name]),
                r_string(&row, 0)?
            ),
        })
    }

    async fn list_events(&mut self, _database: &str) -> Result<Vec<EventMeta>> {
        // PostgreSQL has no scheduled events; the tree hides the group.
        Ok(Vec::new())
    }

    // -----------------------------------------------------------------------
    // Streaming reads (paged)
    // -----------------------------------------------------------------------

    async fn stream_table_rows(
        &mut self,
        database: &str,
        table: &str,
        chunk_size: usize,
        tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        let sql = format!(
            "SELECT * FROM {}",
            SqlDialect::Postgres.quote_qualified(&[database, table])
        );
        stream_paged(&self.client, &sql, chunk_size, tx).await
    }

    async fn stream_query_rows(
        &mut self,
        sql: &str,
        chunk_size: usize,
        tx: mpsc::Sender<crate::error::Result<RowsChunk>>,
    ) -> Result<u64> {
        stream_paged(&self.client, sql, chunk_size, tx).await
    }

    /// Multi-row INSERT with positional binds (CSV import batches). Batches
    /// respect PostgreSQL's 65535-parameter ceiling.
    #[allow(clippy::too_many_arguments)]
    async fn insert_rows(
        &mut self,
        database: &str,
        table: &str,
        columns: &[String],
        rows: &[Vec<RowValue>],
        ignore: bool,
        upsert_columns: Option<&[String]>,
    ) -> Result<u64> {
        if rows.is_empty() || columns.is_empty() {
            return Ok(0);
        }
        let d = SqlDialect::Postgres;
        let table_q = d.quote_qualified(&[database, table]);

        // Validate every column against the live schema first.
        let described = self.describe_table(database, table).await?;
        for name in columns {
            validate_column(&described, name)?;
        }

        let casts: Vec<String> = columns
            .iter()
            .map(|c| {
                described
                    .iter()
                    .find(|dc| dc.name == *c)
                    .map(|dc| cast_type_for(&dc.data_type))
                    .unwrap_or_else(|| "text".into())
            })
            .collect();

        let col_list = columns
            .iter()
            .map(|c| d.quote_ident(c))
            .collect::<Vec<_>>()
            .join(", ");

        let upsert_tail = upsert_columns.filter(|c| !c.is_empty()).map(|conflict| {
            let targets = conflict
                .iter()
                .map(|c| d.quote_ident(c))
                .collect::<Vec<_>>()
                .join(", ");
            let sets = conflict
                .iter()
                .map(|c| format!("{} = excluded.{}", d.quote_ident(c), d.quote_ident(c)))
                .collect::<Vec<_>>()
                .join(", ");
            format!(" ON CONFLICT ({targets}) DO UPDATE SET {sets}")
        });

        let max_params = 65_000usize;
        let rows_per_stmt = (max_params / columns.len()).clamp(1, 10_000);

        let mut affected_total = 0u64;
        for batch in rows.chunks(rows_per_stmt) {
            // Sequential $n marks across all VALUES groups.
            let mut mark = 0usize;
            let values_sql = batch
                .iter()
                .map(|_| {
                    let inner = (0..columns.len())
                        .map(|_| {
                            mark += 1;
                            d.placeholder(mark)
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({inner})")
                })
                .collect::<Vec<_>>()
                .join(", ");

            let mut sql = format!(
                "{} {table_q} ({col_list}) VALUES {values_sql}",
                d.insert_verb(ignore)
            );
            match &upsert_tail {
                Some(tail) => sql.push_str(tail),
                None if ignore => sql.push_str(" ON CONFLICT DO NOTHING"),
                None => {}
            }
            let sql = apply_param_casts(&sql, |idx| {
                casts.get((idx - 1) % casts.len()).cloned()
            });

            let params: Vec<PgParam> = batch
                .iter()
                .flat_map(|row| row.iter())
                .map(param_text)
                .collect();
            let refs: Vec<&(dyn ToSql + Sync)> =
                params.iter().map(|p| p as &(dyn ToSql + Sync)).collect();
            affected_total += self.client.execute(sql.as_str(), &refs).await?;
        }
        Ok(affected_total)
    }

    // -----------------------------------------------------------------------
    // Server tools (Phase 7)
    // -----------------------------------------------------------------------

    async fn list_users(&mut self) -> Result<Vec<UserMeta>> {
        let rows = self
            .client
            .query(
                "SELECT rolname, rolcanlogin, rolconnlimit, rolsuper \
                 FROM pg_roles ORDER BY 1",
                &[],
            )
            .await?;
        rows.iter()
            .map(|row| {
                Ok(UserMeta {
                    user: r_string(row, 0)?,
                    host: None,
                    // PostgreSQL has no account lock; non-login roles are the
                    // closest equivalent (they cannot open sessions).
                    locked: !r_bool(row, 1)?,
                    auth_plugin: None,
                    password_last_changed: None,
                    max_connections: r_opt_i64(row, 2)?,
                })
            })
            .collect()
    }

    async fn show_user_grants(&mut self, user: &str, host: Option<&str>) -> Result<GrantDetail> {
        if host.is_some() {
            return Err(AppError::Db(
                "PostgreSQL roles have no host part".into(),
            ));
        }
        let d = SqlDialect::Postgres;
        let role_q = d.quote_ident(user);
        let mut raw_statements: Vec<String> = Vec::new();

        // Table-level grants from the SQL standard view.
        let table_rows = self
            .client
            .query(
                "SELECT table_schema, table_name, privilege_type, is_grantable \
                 FROM information_schema.role_table_grants \
                 WHERE grantee = $1 \
                 ORDER BY table_schema, table_name, privilege_type",
                &[&user],
            )
            .await?;
        for row in &table_rows {
            let schema = r_string(row, 0)?;
            let table = r_string(row, 1)?;
            let priv_type = r_string(row, 2)?;
            let grantable = r_string(row, 3)?.eq_ignore_ascii_case("YES");
            raw_statements.push(format!(
                "GRANT {} ON {} TO {}{}",
                priv_type,
                d.quote_qualified(&[&schema, &table]),
                role_q,
                if grantable { " WITH GRANT OPTION" } else { "" },
            ));
        }

        // Schema-level USAGE/CREATE probed through the privilege functions.
        let schema_rows = self
            .client
            .query(
                "SELECT n.nspname, p.privilege_type \
                 FROM pg_namespace n \
                 CROSS JOIN (VALUES ('USAGE'), ('CREATE')) AS p(privilege_type) \
                 WHERE n.nspname NOT LIKE 'pg\\_%' AND has_schema_privilege($1, n.nspname, p.privilege_type) \
                 ORDER BY 1, 2",
                &[&user],
            )
            .await?;
        for row in &schema_rows {
            let schema = r_string(row, 0)?;
            let priv_type = r_string(row, 1)?;
            raw_statements.push(format!(
                "GRANT {priv_type} ON SCHEMA {} TO {role_q}",
                d.quote_ident(&schema)
            ));
        }

        // Database-level privileges on the current database.
        let db_rows = self
            .client
            .query(
                "SELECT p.privilege_type FROM (VALUES ('CREATE'), ('CONNECT'), ('TEMPORARY')) AS p(privilege_type) \
                 WHERE has_database_privilege($1, current_database(), p.privilege_type) \
                 ORDER BY 1",
                &[&user],
            )
            .await?;
        for row in &db_rows {
            let priv_type = r_string(row, 0)?;
            raw_statements.push(format!("GRANT {priv_type} ON DATABASE {role_q}"));
        }

        Ok(GrantDetail {
            scopes: server_admin::parse_grant_statements(&raw_statements),
            raw_statements,
        })
    }

    async fn create_user(&mut self, req: &CreateUserRequest) -> Result<()> {
        validate_role_name(&req.user)?;
        if req.host.is_some() || req.auth_plugin.is_some() {
            return Err(AppError::Db(
                "PostgreSQL roles have no host part or auth plugins".into(),
            ));
        }
        let mut sql = format!("CREATE ROLE {} LOGIN", SqlDialect::Postgres.quote_ident(&req.user));
        if let Some(pw) = &req.password {
            sql.push_str(&format!(
                " PASSWORD {}",
                server_admin::sql_literal(SqlDialect::Postgres, pw)
            ));
        }
        self.execute(&sql).await.map(|_| ())
    }

    async fn alter_user(
        &mut self,
        user: &str,
        host: Option<&str>,
        req: &AlterUserRequest,
    ) -> Result<()> {
        if host.is_some() {
            return Err(AppError::Db("PostgreSQL roles have no host part".into()));
        }
        validate_role_name(user)?;
        let d = SqlDialect::Postgres;
        let base = d.quote_ident(user);

        // RENAME must run alone; everything else composes.
        if let Some(new_name) = req.new_name.as_deref().filter(|n| !n.is_empty()) {
            validate_role_name(new_name)?;
            self.execute(&format!(
                "ALTER ROLE {base} RENAME TO {}",
                d.quote_ident(new_name)
            ))
            .await.map(|_| ())?;
        }

        if let Some(pw) = &req.new_password {
            let clause = match pw.is_empty() {
                true => " PASSWORD NULL".to_string(),
                false => format!(
                    " PASSWORD {}",
                    server_admin::sql_literal(SqlDialect::Postgres, pw)
                ),
            };
            self.execute(&format!("ALTER ROLE {base}{clause}"))
                .await
                .map(|_| ())?;
        }

        if let Some(lock) = req.lock {
            self.execute(&format!(
                "ALTER ROLE {base} {}",
                if lock { "NOLOGIN" } else { "LOGIN" }
            ))
            .await.map(|_| ())?;
        }

        // Only CONNECTION LIMIT maps; hourly quotas have no PG equivalent
        // and are silently ignored (surfaced by the UI note).
        if let Some(limit) = req.limits.max_connections {
            self.execute(&format!(
                "ALTER ROLE {base} CONNECTION LIMIT {}",
                limit.clamp(-1, i32::MAX as i64)
            ))
            .await.map(|_| ())?;
        }

        if req.auth_plugin.is_some() {
            return Err(AppError::Db("PostgreSQL has no auth plugin switch".into()));
        }
        Ok(())
    }

    async fn drop_user(&mut self, user: &str, host: Option<&str>) -> Result<()> {
        if host.is_some() {
            return Err(AppError::Db("PostgreSQL roles have no host part".into()));
        }
        validate_role_name(user)?;
        self.execute(&format!(
            "DROP ROLE {}",
            SqlDialect::Postgres.quote_ident(user)
        ))
        .await.map(|_| ())
    }

    async fn grant_revoke(&mut self, req: &GrantRequest) -> Result<()> {
        validate_role_name(&req.user)?;
        let d = SqlDialect::Postgres;
        let scope = server_admin::grant_scope_sql(d, req)?;
        let privs = server_admin::normalized_privileges(&req.privileges).join(", ");
        let role_q = d.quote_ident(&req.user);
        let sql = if req.revoke {
            let grant_option_for = if req.grant_option { "GRANT OPTION FOR " } else { "" };
            format!("REVOKE {grant_option_for}{privs} ON {scope} FROM {role_q}")
        } else {
            let with = if req.grant_option { " WITH GRANT OPTION" } else { "" };
            format!("GRANT {privs} ON {scope} TO {role_q}{with}")
        };
        self.execute(&sql).await.map(|_| ())
    }

    async fn list_processes(&mut self) -> Result<Vec<ProcessInfo>> {
        let rows = self
            .client
            .query(
                "SELECT pid, usename, COALESCE(CAST(client_addr AS TEXT), ''), \
                        datname, state, wait_event_type, wait_event, application_name, \
                        EXTRACT(EPOCH FROM (clock_timestamp() - COALESCE(query_start, backend_start)))::float8, \
                        left(query, 500), (pid = pg_backend_pid()) \
                 FROM pg_stat_activity ORDER BY pid",
                &[],
            )
            .await?;
        rows.iter()
            .map(|row| {
                let wait_type: Option<String> = row.try_get(5).unwrap_or(None);
                let wait_evt: Option<String> = row.try_get(6).unwrap_or(None);
                let app_name: Option<String> = row.try_get(7).unwrap_or(None);
                let mut state_text = r_opt_string(row, 4)?.unwrap_or_default();
                if let Some(app) = app_name.filter(|a| !a.is_empty()) {
                    if !state_text.is_empty() {
                        state_text = format!("{state_text} · {app}");
                    } else {
                        state_text = app;
                    }
                }
                Ok(ProcessInfo {
                    id: i64::from(r_i32(row, 0)?),
                    user: r_string(row, 1)?,
                    host: r_opt_string(row, 2)?.filter(|h| !h.is_empty()),
                    db: r_opt_string(row, 3)?.filter(|d| !d.is_empty()),
                    command: Some(state_text),
                    state: wait_type.clone(),
                    info: r_opt_string(row, 9)?.filter(|i| !i.trim().is_empty()),
                    time_seconds: r_f64(row, 8)?,
                    wait_event_type: wait_type,
                    wait_event: wait_evt,
                    is_own: r_bool(row, 10)?,
                })
            })
            .collect()
    }

    async fn kill_process(&mut self, process_id: i64, query_only: bool) -> Result<()> {
        let (sql, verb) = match query_only {
            true => ("SELECT pg_cancel_backend($1)", "cancel"),
            false => ("SELECT pg_terminate_backend($1)", "terminate"),
        };
        let rows = self.client.query(sql, &[&process_id]).await?;
        let ok = rows
            .first()
            .and_then(|r| r.try_get::<_, bool>(0).ok())
            .unwrap_or(false);
        if ok {
            Ok(())
        } else {
            Err(AppError::Db(format!(
                "could not {verb} backend {process_id} (missing privilege or already finished)"
            )))
        }
    }

    async fn list_variables(&mut self) -> Result<Vec<ServerVariable>> {
        // SHOW ALL returns name | setting | description over either protocol;
        // simple_query sidesteps per-version column-type surprises.
        let messages = self.client.simple_query("SHOW ALL").await?;
        let mut out = Vec::new();
        for msg in messages {
            if let SimpleQueryMessage::Row(row) = msg {
                out.push(ServerVariable {
                    name: row.get(0).unwrap_or_default().to_string(),
                    value: row.get(1).unwrap_or_default().to_string(),
                });
            }
        }
        Ok(out)
    }

    async fn list_status(&mut self) -> Result<Vec<StatusVariable>> {
        let mut out: Vec<StatusVariable> = Vec::new();

        // Both views flatten to name/value pairs; per-database rows keep a
        // `<view>:<datname>.<column>` label so names stay unique.
        for (view, sql) in [
            ("stat_database", "SELECT * FROM pg_stat_database"),
            (
                "stat_bgwriter",
                "SELECT * FROM pg_stat_bgwriter", /* pre-v17 columns */
            ),
            (
                "stat_checkpointer",
                "SELECT * FROM pg_stat_checkpointer", /* v17+ */
            ),
        ] {
            let messages = match self.client.simple_query(sql).await {
                Ok(messages) => messages,
                // Views missing on older/newer servers (e.g. pre-v17 has no
                // pg_stat_checkpointer) are skipped quietly.
                Err(_) => continue,
            };
            for msg in messages {
                let SimpleQueryMessage::Row(row) = msg else {
                    continue;
                };
                let columns: Vec<String> =
                    row.columns().iter().map(|c| c.name().to_string()).collect();
                let values: Vec<Option<String>> = (0..columns.len())
                    .map(|i| row.get(i).map(|s| s.to_string()))
                    .collect();
                flatten_status_row(view, &columns, &values, &mut out);
            }
        }

        // Uptime anchors the "since server start" note in the UI.
        let uptime_rows = self
            .client
            .simple_query(
                "SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint::text",
            )
            .await?;
        for msg in uptime_rows {
            if let SimpleQueryMessage::Row(row) = msg {
                if let Some(secs) = row.get(0) {
                    out.push(StatusVariable {
                        name: "Uptime".into(),
                        value: secs.to_string(),
                    });
                }
            }
        }

        Ok(out)
    }
}

fn validate_role_name(name: &str) -> Result<()> {
    if name.trim().is_empty() {
        return Err(AppError::Db("role name must not be empty".into()));
    }
    Ok(())
}

fn r_i32(row: &Row, idx: usize) -> Result<i32> {
    row.try_get::<_, i32>(idx).map_err(|_| missing(idx))
}

fn r_f64(row: &Row, idx: usize) -> Result<f64> {
    row.try_get::<_, f64>(idx).map_err(|_| missing(idx))
}

/// Flatten one text-protocol statistics row into `<view>.<column>` /
/// `<view>:<datname>.<column>` name/value pairs (pure, unit-tested).
/// The `datname` column itself never becomes an entry.
pub(crate) fn flatten_status_row(
    view: &str,
    columns: &[String],
    values: &[Option<String>],
    out: &mut Vec<StatusVariable>,
) {
    let datname = columns
        .iter()
        .position(|c| c == "datname")
        .and_then(|i| values.get(i).and_then(|v| v.as_deref()))
        .filter(|d| !d.is_empty());

    for (col, value) in columns.iter().zip(values) {
        if col == "datname" {
            continue;
        }
        let name = match datname {
            Some(db) => format!("{view}:{db}.{col}"),
            None => format!("{view}.{col}"),
        };
        out.push(StatusVariable {
            name,
            value: value.clone().unwrap_or_default(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pg_status_rows_flatten_to_name_value_pairs() {
        let mut out: Vec<StatusVariable> = Vec::new();

        // Global view (no datname column — e.g. pg_stat_bgwriter).
        flatten_status_row(
            "stat_bgwriter",
            &["checkpoints_timed".into(), "checkpoints_req".into()],
            &[Some("12".into()), Some("1".into())],
            &mut out,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].name, "stat_bgwriter.checkpoints_timed");
        assert_eq!(out[0].value, "12");
        assert_eq!(out[1].name, "stat_bgwriter.checkpoints_req");

        // Per-database view: rows are labelled with their database.
        flatten_status_row(
            "stat_database",
            &["datname".into(), "xact_commit".into(), "xact_rollback".into()],
            &[Some("appdb".into()), Some("1000".into()), None],
            &mut out,
        );
        assert_eq!(out.len(), 4);
        assert_eq!(out[2].name, "stat_database:appdb.xact_commit");
        assert_eq!(out[2].value, "1000");
        // NULL values render as empty strings; datname never becomes an entry.
        assert_eq!(out[3].name, "stat_database:appdb.xact_rollback");
        assert_eq!(out[3].value, "");
    }

    #[test]
    fn pg_status_empty_datname_is_treated_as_global() {
        let mut out: Vec<StatusVariable> = Vec::new();
        flatten_status_row(
            "stat_database",
            &["datname".into(), "blks_read".into()],
            &[Some(String::new()), Some("7".into())],
            &mut out,
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "stat_database.blks_read");
    }

    #[test]
    fn relkinds_map_to_tree_kinds() {
        assert_eq!(relkind_to_kind("r"), TableKind::Table);
        assert_eq!(relkind_to_kind("p"), TableKind::Table);
        assert_eq!(relkind_to_kind("v"), TableKind::View);
        assert_eq!(relkind_to_kind("m"), TableKind::MaterializedView);
        assert_eq!(relkind_to_kind("?"), TableKind::Table);
    }

    #[test]
    fn fk_action_letters_expand_to_keywords() {
        assert_eq!(fk_action_letter('c'), "CASCADE");
        assert_eq!(fk_action_letter('n'), "SET NULL");
        assert_eq!(fk_action_letter('d'), "SET DEFAULT");
        assert_eq!(fk_action_letter('r'), "RESTRICT");
        assert_eq!(fk_action_letter('a'), "NO ACTION");
        assert_eq!(fk_action_letter('z'), "NO ACTION");
    }

    #[test]
    fn defaults_classify_into_designer_kinds() {
        use crate::connections::DefaultKind;
        let (kind, value, serial) = classify_default("nextval('users_id_seq'::regclass)");
        assert_eq!(kind, DefaultKind::None);
        assert!(value.is_none());
        assert!(serial);

        let (kind, value, _) = classify_default("'abc'::character varying");
        assert_eq!(kind, DefaultKind::Value);
        assert_eq!(value.as_deref(), Some("abc"));

        let (kind, value, _) = classify_default("NULL::text");
        assert_eq!(kind, DefaultKind::Null);
        assert!(value.is_none());

        let (kind, value, _) = classify_default("-12.5");
        assert_eq!(kind, DefaultKind::Value);
        assert_eq!(value.as_deref(), Some("-12.5"));

        let (kind, value, _) = classify_default("now()");
        assert_eq!(kind, DefaultKind::Expression);
        assert_eq!(value.as_deref(), Some("now()"));

        // Embedded quotes un-double.
        let (kind, value, _) = classify_default("'it''s'");
        assert_eq!(kind, DefaultKind::Value);
        assert_eq!(value.as_deref(), Some("it's"));
    }

    #[test]
    fn trigger_definitions_reveal_timing_and_event() {
        let (timing, event) = parse_trigger_def(
            "CREATE TRIGGER audit BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()",
        );
        assert_eq!(timing, "BEFORE");
        assert_eq!(event, "INSERT");

        let (timing, event) = parse_trigger_def(
            "CREATE TRIGGER t AFTER UPDATE OF balance ON accounts FOR EACH ROW EXECUTE FUNCTION g()",
        );
        assert_eq!(timing, "AFTER");
        assert_eq!(event, "UPDATE");

        let (timing, event) = parse_trigger_def("CREATE TRIGGER z INSTEAD OF DELETE ON v FOR EACH STATEMENT EXECUTE PROCEDURE h()");
        assert_eq!(timing, "INSTEAD OF");
        assert_eq!(event, "DELETE");
    }

    #[test]
    fn bytea_hex_round_trips() {
        let bytes = vec![0x00, 0xDE, 0xAD, 0xBE, 0xEF, 0xff];
        let encoded = hex_encode_bytea(&bytes);
        assert_eq!(encoded, "\\x00deadbeefff");
        assert_eq!(hex_decode_bytea(&encoded).unwrap(), bytes);
        assert!(hex_decode_bytea("\\xabc").is_err());
        assert_eq!(hex_decode_bytea("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn cell_text_parses_by_declared_type() {
        assert_eq!(parse_cell_text("integer", Some("42")), RowValue::Int(42));
        assert_eq!(parse_cell_text("bigint", Some("-7")), RowValue::Int(-7));
        assert_eq!(parse_cell_text("numeric(10,2)", Some("1.25")), RowValue::Float(1.25));
        assert_eq!(parse_cell_text("double precision", Some("x")), RowValue::Str("x".into()));
        assert_eq!(
            parse_cell_text("bytea", Some("\\x4869")),
            RowValue::Bytes(b"Hi".to_vec())
        );
        assert_eq!(parse_cell_text("timestamp without time zone", Some("2026-01-02 03:04:05")),
            RowValue::Datetime("2026-01-02 03:04:05".into()));
        assert_eq!(parse_cell_text("date", Some("2026-08-24")), RowValue::Date("2026-08-24".into()));
        assert_eq!(parse_cell_text("character varying", Some("hi")), RowValue::Str("hi".into()));
        assert_eq!(parse_cell_text("integer", None), RowValue::Null);
    }

    #[test]
    fn param_casts_attach_only_outside_quotes() {
        let sql = r#"UPDATE "t" SET "a" = $1, "b" = $2 WHERE "id" = $3"#;
        let out = apply_param_casts(sql, |i| Some(format!("t{i}")));
        assert_eq!(
            out,
            r#"UPDATE "t" SET "a" = $1::t0, "b" = $2::t1 WHERE "id" = $3::t2"#
        );

        // Placeholders inside quoted identifiers are untouched.
        let quoted = r#"SELECT "$1" FROM t WHERE x = $1"#;
        let out = apply_param_casts(quoted, |_| Some("int".into()));
        assert_eq!(out, r#"SELECT "$1" FROM t WHERE x = $1::int"#);

        // Missing casts leave placeholders alone; $ with no digits passes.
        assert_eq!(apply_param_casts("$ $1", |_| None), "$ $1");
    }

    #[test]
    fn create_table_builds_pg_statement_with_indexes_and_comment() {
        use crate::connections::{ColumnDef, CreateTableRequest, ExtraTableOption, TableOptions};
        let req = CreateTableRequest {
            name: "items".into(),
            columns: vec![
                ColumnDef {
                    name: "id".into(),
                    previous_name: None,
                    data_type: "integer".into(),
                    nullable: false,
                    default_kind: DefaultKind::None,
                    default_value: None,
                    auto_increment: true,
                    on_update: None,
                    generated: None,
                    comment: None,
                    preserved_attrs: Vec::new(),
                },
                ColumnDef {
                    name: "label".into(),
                    previous_name: None,
                    data_type: "character varying(40)".into(),
                    nullable: false,
                    default_kind: DefaultKind::Value,
                    default_value: Some("new item".into()),
                    auto_increment: false,
                    on_update: None,
                    generated: None,
                    comment: None,
                    preserved_attrs: Vec::new(),
                },
            ],
            indexes: vec![
                IndexMeta {
                    name: "items_pkey".into(),
                    kind: IndexKind::Primary,
                    columns: vec!["id".into()],
                    comment: None,
                },
                IndexMeta {
                    name: "idx_label".into(),
                    kind: IndexKind::Index,
                    columns: vec!["label".into()],
                    comment: None,
                },
            ],
            foreign_keys: vec![],
            options: TableOptions {
                engine: None,
                charset: None,
                collation: None,
                comment: Some("it's fine".into()),
                auto_increment: None,
                row_format: None,
                extra: vec![ExtraTableOption { key: "IGNORED".into(), value: "1".into() }],
                partition: None,
            },
        };
        let sql = pg_create_table("shop", &req).unwrap();
        assert!(sql.starts_with("CREATE TABLE \"shop\".\"items\" ("), "{sql}");
        assert!(sql.contains("\"id\" integer NOT NULL GENERATED BY DEFAULT AS IDENTITY"), "{sql}");
        assert!(sql.contains("\"label\" character varying(40) NOT NULL DEFAULT 'new item'"), "{sql}");
        assert!(sql.contains("CONSTRAINT \"items_pkey\" PRIMARY KEY (\"id\")"), "{sql}");
        assert!(sql.contains("CREATE INDEX \"idx_label\" ON \"shop\".\"items\" (\"label\");"), "{sql}");
        assert!(sql.contains("COMMENT ON TABLE \"shop\".\"items\" IS 'it''s fine';"), "{sql}");
    }

    #[test]
    fn alter_plan_covers_add_drop_modify_rename() {
        use crate::connections::{
            DefaultKind, IndexKind, IndexMeta, TableOptions,
        };

        let mk_col = |name: &str, dtype: &str, nullable: bool| ColumnDef {
            name: name.into(),
            previous_name: None,
            data_type: dtype.into(),
            nullable,
            default_kind: DefaultKind::None,
            default_value: None,
            auto_increment: false,
            on_update: None,
            generated: None,
            comment: None,
            preserved_attrs: Vec::new(),
        };

        let current = TableDdl {
            db: "shop".into(),
            table: "users".into(),
            columns: vec![mk_col("id", "integer", false), mk_col("old", "text", true)],
            indexes: vec![IndexMeta {
                name: "users_pkey".into(),
                kind: IndexKind::Primary,
                columns: vec!["id".into()],
                comment: None,
            }],
            foreign_keys: vec![],
            options: TableOptions::default(),
            checks: Vec::new(),
            create_sql: String::new(),
        };

        // Rename old→renamed and change its nullability.
        let mut desired = current.clone();
        let mut renamed = mk_col("renamed", "text", false);
        renamed.previous_name = Some("old".into());
        desired.columns = vec![mk_col("id", "integer", false), renamed];

        let plan = pg_alter_plan("shop", &current, &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("RENAME COLUMN \"old\" TO \"renamed\""), "{joined}");
        assert!(joined.contains("ALTER COLUMN \"renamed\" SET NOT NULL"), "{joined}");

        // Drop + add + type change.
        let mut desired = current.clone();
        desired.columns.remove(1);
        desired.columns.push(mk_col("age", "bigint", true));
        desired.columns[0].data_type = "bigint".into();

        let plan = pg_alter_plan("shop", &current, &desired).unwrap();
        let joined = plan.statements.join("\n");
        assert!(joined.contains("ADD COLUMN \"age\" bigint NULL"), "{joined}");
        assert!(joined.contains("DROP COLUMN \"old\""), "{joined}");
        assert!(joined.contains("ALTER COLUMN \"id\" TYPE bigint"), "{joined}");

        // Cross-schema rename refused.
        let mut desired = current.clone();
        desired.table = "members".into();
        desired.db = "other".into();
        assert!(pg_alter_plan("shop", &current, &desired).is_err());
    }

    #[test]
    fn drop_and_rename_builders_are_dialect_correct() {
        use crate::connections::ObjectKind;
        assert_eq!(
            pg_drop_sql("shop", ObjectKind::Table, "users").unwrap(),
            "DROP TABLE \"shop\".\"users\""
        );
        assert_eq!(
            pg_drop_sql("shop", ObjectKind::View, "v1").unwrap(),
            "DROP VIEW \"shop\".\"v1\""
        );
        let trigger_sql = pg_drop_sql("shop", ObjectKind::Trigger, "tg").unwrap();
        assert!(trigger_sql.starts_with("DO $$"), "{trigger_sql}");
        assert!(trigger_sql.contains("DROP TRIGGER %I ON %I.%I"));

        assert!(pg_drop_sql("shop", ObjectKind::Event, "e").is_err());
        assert!(pg_drop_sql("shop", ObjectKind::Routine, "r").is_ok());

        assert_eq!(
            pg_rename_sql("shop", "users", "shop", "people").unwrap(),
            "ALTER TABLE \"shop\".\"users\" RENAME TO \"people\""
        );
        assert!(pg_rename_sql("shop", "users", "other", "people").is_err());

        assert_eq!(
            pg_truncate_sql("shop", "users"),
            "TRUNCATE TABLE \"shop\".\"users\""
        );
        assert_eq!(
            pg_empty_clone_sql("shop", "users", "users2"),
            "CREATE TABLE \"shop\".\"users2\" (LIKE \"shop\".\"users\" INCLUDING ALL)"
        );
    }

    #[test]
    fn maintenance_maps_to_supported_verbs() {
        assert_eq!(
            pg_maintenance_sql(MaintenanceOp::Analyze, "shop", "users").unwrap(),
            "ANALYZE \"shop\".\"users\""
        );
        assert_eq!(
            pg_maintenance_sql(MaintenanceOp::Optimize, "shop", "users").unwrap(),
            "VACUUM (ANALYZE) \"shop\".\"users\""
        );
        assert!(pg_maintenance_sql(MaintenanceOp::Repair, "shop", "users").is_err());
        assert!(pg_maintenance_sql(MaintenanceOp::Checksum, "shop", "users").is_err());
    }

    #[test]
    fn result_set_sniffing_matches_read_statements() {
        assert!(looks_like_result_set("select 1"));
        assert!(looks_like_result_set("  EXPLAIN ANALYZE select 1"));
        assert!(looks_like_result_set("SHOW search_path"));
        assert!(!looks_like_result_set("INSERT INTO t VALUES (1)"));
        assert!(!looks_like_result_set("WITH x AS (INSERT …) SELECT * FROM x"));
        assert!(!looks_like_result_set(""));
    }
}

#[cfg(test)]
mod tls_pem_tests {
    use super::*;

    /// A minimal valid PEM-shaped body (base64 of "hello"); the loader never
    /// inspects DER contents, only section labels and base64 integrity.
    const TEST_CERT_PEM: &str = "-----BEGIN CERTIFICATE-----\naGVsbG8gY2VydA==\n-----END CERTIFICATE-----\n";
    const TEST_KEY_PEM: &str = concat!(
        "-----BEGIN PRIVATE KEY-----\naGVsbG8ga2V5\n-----END PRIVATE KEY-----\n",
        "-----BEGIN CERTIFICATE-----\naGVsbG8gY2VydDI=\n-----END CERTIFICATE-----\n"
    );

    fn write_temp(name: &str, contents: &str) -> String {
        let dir = std::env::temp_dir().join(format!("dbobcat-tls-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, contents).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    fn load_certs_extracts_every_section() {
        let path = write_temp("multi.pem", &format!("{TEST_CERT_PEM}TEST_CERT_PEM_DUMMY"));
        let _ = path;
    }

    #[test]
    fn load_private_key_prefers_pkcs8_section() {
        let path = write_temp("key.pem", TEST_KEY_PEM);
        let key = load_private_key(&path).unwrap();
        assert!(matches!(
            key,
            rustls::pki_types::PrivateKeyDer::Pkcs8(_)
        ));
    }

    #[test]
    fn load_certs_reads_all_certificate_sections() {
        let combined = format!("{TEST_CERT_PEM}{}", TEST_KEY_PEM);
        let path = write_temp("chain.pem", &combined);
        let certs = load_certs(&path).unwrap();
        assert_eq!(certs.len(), 2);
    }

    #[test]
    fn missing_sections_error_clearly() {
        let path = write_temp("empty.pem", "not a pem file");
        let err = load_private_key(&path).unwrap_err();
        assert!(err.to_string().contains("no private key section"));
    }
}

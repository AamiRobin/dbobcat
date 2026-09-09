//! AI assistant engine (Phase 12).
//!
//! A deliberately thin, BYOK ("bring your own key") client for the
//! **OpenAI-compatible chat-completions schema** — one wire format covers
//! OpenAI, OpenRouter, Groq, Together, Ollama, LM Studio, llama.cpp, ...
//! DBobcat never proxies anything: requests go straight from the app to the
//! endpoint the user configured, and the API key lives in the encrypted
//! credential store like every other secret.
//!
//! Trust contract (mirrored in the UI): the backend only ever *relays*
//! context the frontend assembled — table/column metadata and query text.
//! No row data is collected here, and nothing is sent anywhere without an
//! explicit user action.
//!
//! Streaming: the provider's SSE response is parsed incrementally and text
//! deltas are forwarded through a Tauri [`tauri::ipc::Channel`]. Jobs can be
//! cancelled via [`AiJobs`] while in flight.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// Credential-store entry holding the AI provider API key.
pub const KEY_ENTRY_ID: &str = "ai";

/// Per-request connect timeout. No overall timeout: completions stream for
/// a long time by design, and hangs are handled by cancellation instead.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// Low temperature: SQL drafting wants determinism, not creativity.
const TEMPERATURE: f32 = 0.2;

// ---------------------------------------------------------------------------
// Wire types (mirrored in src/types/ipc.ts)
// ---------------------------------------------------------------------------

/// Endpoint + model the user configured in AI settings. The base URL must
/// already include the version segment (e.g. `https://api.openai.com/v1`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProviderConfig {
    pub base_url: String,
    pub model: String,
}

/// What the assistant is asked to do; decides the system prompt and which
/// request fields are meaningful.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AiMode {
    /// Natural language → SQL draft, using the supplied schema.
    Generate,
    /// SQL + engine error → corrected SQL.
    Fix,
    /// SQL → plain-English explanation (prose, not insertable).
    Explain,
    /// Settings "test connection" ping.
    Test,
}

/// One assistant job. Fields are optional rather than per-mode structs so
/// the IPC shape stays flat; each mode documents what it reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiJob {
    pub mode: AiMode,
    /// SQL family ("mysql" | "postgresql" | "sqlite") — steers the prompt.
    pub dialect: String,
    /// Database the user is querying (context line only).
    pub database: Option<String>,
    /// Serialized schema context, built by the frontend from cached
    /// metadata (table/column/FK text — never row data). Generate/Fix.
    pub schema: Option<String>,
    /// The user's natural-language request. Generate.
    pub prompt: Option<String>,
    /// The SQL being fixed or explained. Fix/Explain.
    pub sql: Option<String>,
    /// Raw engine error message. Fix.
    pub error: Option<String>,
}

/// One chat message on the OpenAI wire format.
#[derive(Debug, Clone, Serialize)]
pub struct ChatMessage {
    pub role: &'static str,
    pub content: String,
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

fn require<'a>(field: Option<&'a String>, what: &str) -> Result<&'a str> {
    field
        .map(String::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| AppError::Config(format!("AI request is missing {what}")))
}

/// Human name for a dialect id, used inside prompts.
fn dialect_label(dialect: &str) -> &str {
    match dialect {
        "postgresql" => "PostgreSQL",
        "sqlite" => "SQLite",
        _ => "MySQL/MariaDB",
    }
}

/// Build the chat messages for a job. The system prompt enforces the
/// "SQL only, no markdown fences" output contract the draft-preview UI
/// relies on; the user message carries all context (schema, SQL, error).
pub fn build_messages(job: &AiJob) -> Result<Vec<ChatMessage>> {
    match job.mode {
        AiMode::Test => Ok(vec![ChatMessage {
            role: "user",
            content: "Reply with the single word: OK".into(),
        }]),
        AiMode::Generate => {
            let prompt = require(job.prompt.as_ref(), "a description")?;
            let schema = job.schema.as_deref().unwrap_or("");
            let mut user = String::new();
            if !schema.is_empty() {
                user.push_str("Schema of the database `");
                user.push_str(job.database.as_deref().unwrap_or("main"));
                user.push_str("`:\n");
                user.push_str(schema);
                user.push_str("\n\n");
            }
            user.push_str("Write a ");
            user.push_str(dialect_label(&job.dialect));
            user.push_str(" query: ");
            user.push_str(prompt);
            Ok(vec![
                ChatMessage {
                    role: "system",
                    content: format!(
                        "You are a SQL assistant inside the DBobcat database client. \
                         The user describes a query; you return ONE runnable \
                         {dialect} statement. Rules: use only the tables, columns \
                         and foreign keys from the provided schema (when one is \
                         supplied); qualify nothing unless the schema requires it; \
                         prefer explicit JOINs over commas; reply with ONLY the SQL \
                         — no explanations, no markdown code fences, no comments \
                         beyond short inline clarifications.",
                        dialect = dialect_label(&job.dialect)
                    ),
                },
                ChatMessage { role: "user", content: user },
            ])
        }
        AiMode::Fix => {
            let sql = require(job.sql.as_ref(), "the SQL to fix")?;
            let error = require(job.error.as_ref(), "the engine error message")?;
            let schema = job.schema.as_deref().unwrap_or("");
            let mut user = String::from("This ");
            user.push_str(dialect_label(&job.dialect));
            user.push_str(" statement failed:\n\n");
            user.push_str(sql);
            user.push_str("\n\nThe engine reported:\n");
            user.push_str(error);
            if !schema.is_empty() {
                user.push_str("\n\nRelevant schema:\n");
                user.push_str(schema);
            }
            user.push_str("\n\nReturn the corrected statement.");
            Ok(vec![
                ChatMessage {
                    role: "system",
                    content: format!(
                        "You are a SQL repair assistant inside the DBobcat database \
                         client. Given a failing {dialect} statement and the engine's \
                         error, return the minimal corrected statement. Reply with \
                         ONLY the SQL — no explanations, no markdown code fences.",
                        dialect = dialect_label(&job.dialect)
                    ),
                },
                ChatMessage { role: "user", content: user },
            ])
        }
        AiMode::Explain => {
            let sql = require(job.sql.as_ref(), "the SQL to explain")?;
            Ok(vec![
                ChatMessage {
                    role: "system",
                    content: format!(
                        "You explain SQL inside the DBobcat database client. Explain \
                         the given {dialect} statement concisely in plain English: \
                         what it returns or does, table by table, noting filters, \
                         joins and aggregates. A short paragraph or compact bullet \
                         list; no markdown code fences.",
                        dialect = dialect_label(&job.dialect)
                    ),
                },
                ChatMessage {
                    role: "user",
                    content: sql.to_string(),
                },
            ])
        }
    }
}

// ---------------------------------------------------------------------------
// Provider client (OpenAI-compatible chat completions, SSE streaming)
// ---------------------------------------------------------------------------

/// Completion token ceilings per mode. Drafts stay small on purpose; a
/// run-away generation is a cost problem, not a feature.
fn max_tokens_for(mode: AiMode) -> u32 {
    match mode {
        AiMode::Test => 8,
        AiMode::Explain => 1024,
        AiMode::Generate | AiMode::Fix => 2048,
    }
}

/// Run a job end-to-end: build messages, stream the completion, forward
/// text deltas, return the full text.
pub async fn run_job(
    config: &AiProviderConfig,
    api_key: Option<&str>,
    job: &AiJob,
    cancel: &AtomicBool,
    on_delta: impl FnMut(&str),
) -> Result<String> {
    let messages = build_messages(job)?;
    stream_chat(
        config,
        api_key,
        &messages,
        max_tokens_for(job.mode),
        cancel,
        on_delta,
    )
    .await
}

/// POST one chat-completion request and stream text deltas out of the SSE
/// response. Returns the concatenated assistant text.
pub async fn stream_chat(
    config: &AiProviderConfig,
    api_key: Option<&str>,
    messages: &[ChatMessage],
    max_tokens: u32,
    cancel: &AtomicBool,
    mut on_delta: impl FnMut(&str),
) -> Result<String> {
    let url = format!("{}/chat/completions", config.base_url.trim_end_matches('/'));
    let body = serde_json::json!({
        "model": config.model,
        "messages": messages,
        "stream": true,
        "temperature": TEMPERATURE,
        "max_tokens": max_tokens,
    });

    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|e| AppError::Config(format!("cannot create HTTP client: {e}")))?;

    let mut request = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(serde_json::to_vec(&body)?);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }

    let response = request.send().await.map_err(reqwest_error)?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(AppError::Config(format!(
            "AI provider returned {status}: {}",
            truncate(&text, 400)
        )));
    }

    let mut response = response;
    let mut buffer: Vec<u8> = Vec::new();
    let mut full = String::new();

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Cancelled("AI request cancelled".into()));
        }
        // Pull the next chunk; a `None` ends the body.
        let chunk = match response.chunk().await {
            Ok(Some(bytes)) => bytes,
            Ok(None) => break,
            Err(e) => return Err(reqwest_error(e)),
        };
        buffer.extend_from_slice(&chunk);

        // SSE events are newline-delimited; keep the partial tail in the
        // buffer and process only complete lines.
        while let Some(pos) = buffer.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=pos).collect();
            let line = String::from_utf8_lossy(&line[..line.len() - 1]);
            let line = line.trim_end_matches('\r');
            let Some(payload) = line.strip_prefix("data:") else {
                continue; // comments, event:/id: lines, keep-alives
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                return Ok(full);
            }
            match extract_delta(payload) {
                Ok(Some(delta)) if !delta.is_empty() => {
                    full.push_str(&delta);
                    on_delta(&delta);
                }
                // Null-content frames (role-only) and non-JSON keep-alives.
                Ok(_) => continue,
                Err(message) => return Err(AppError::Config(message)),
            }
        }
    }

    if full.is_empty() {
        return Err(AppError::Config(
            "AI provider returned an empty response".into(),
        ));
    }
    Ok(full)
}

/// Pull the text delta out of one SSE `data:` payload. Handles the
/// `chat.completion.chunk` shape (`choices[0].delta.content`), tolerates
/// null content (role-only frames), and reports mid-stream error frames as
/// `Err` with a readable message.
fn extract_delta(payload: &str) -> std::result::Result<Option<String>, String> {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(_) => return Ok(None), // non-JSON keep-alive / partial frame
    };
    if let Some(err) = value.get("error") {
        let message = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("unknown provider error");
        return Err(format!("AI provider error: {message}"));
    }
    let Some(choice) = value.get("choices").and_then(|c| c.get(0)) else {
        return Ok(None);
    };
    if let Some(content) = choice
        .get("delta")
        .and_then(|d| d.get("content"))
        .and_then(|c| c.as_str())
    {
        return Ok(Some(content.to_string()));
    }
    // Legacy/plain completion frames (`choices[0].text`) — some proxies.
    Ok(choice
        .get("text")
        .and_then(|t| t.as_str())
        .map(str::to_string))
}

fn reqwest_error(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::Config("AI provider connection timed out".into())
    } else if e.is_connect() {
        AppError::Config(format!("cannot reach AI provider: {e}"))
    } else {
        AppError::Config(format!("AI request failed: {e}"))
    }
}

/// Cap a string for error display.
fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    format!("{cut}…")
}

// ---------------------------------------------------------------------------
// Job registry (cancellation)
// ---------------------------------------------------------------------------

/// Registry of in-flight AI jobs. The frontend mints the job id so it can
/// cancel a request it started without a round-trip.
#[derive(Default)]
pub struct AiJobs {
    active: Mutex<HashMap<u64, Arc<AtomicBool>>>,
}

impl AiJobs {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record a job; returns its cancellation flag.
    pub fn register(&self, id: u64) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, flag.clone());
        flag
    }

    /// Mark a job cancelled; `true` when it was still active.
    pub fn cancel(&self, id: u64) -> bool {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .map(|flag| {
                flag.store(true, Ordering::Relaxed);
                true
            })
            .unwrap_or(false)
    }

    /// Drop a finished job's registration.
    pub fn finish(&self, id: u64) {
        self.active
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn job(mode: AiMode) -> AiJob {
        AiJob {
            mode,
            dialect: "mysql".into(),
            database: Some("shop".into()),
            schema: Some("TABLE users (id int PRIMARY KEY)".into()),
            prompt: Some("users created today".into()),
            sql: Some("SELECT * FORM users".into()),
            error: Some("syntax error near FORM".into()),
        }
    }

    #[test]
    fn generate_prompt_carries_schema_and_request() {
        let messages = build_messages(&job(AiMode::Generate)).unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, "system");
        assert!(messages[0].content.contains("MySQL"));
        assert!(messages[1].content.contains("TABLE users (id int PRIMARY KEY)"));
        assert!(messages[1].content.contains("users created today"));
    }

    #[test]
    fn fix_prompt_carries_sql_and_error() {
        let messages = build_messages(&job(AiMode::Fix)).unwrap();
        assert!(messages[0].content.contains("MySQL"));
        assert!(messages[1].content.contains("SELECT * FORM users"));
        assert!(messages[1].content.contains("syntax error near FORM"));
    }

    #[test]
    fn explain_prompt_carries_sql() {
        let messages = build_messages(&job(AiMode::Explain)).unwrap();
        assert!(messages[1].content.contains("SELECT * FORM users"));
    }

    #[test]
    fn missing_fields_are_config_errors() {
        let mut j = job(AiMode::Generate);
        j.prompt = None;
        assert!(build_messages(&j).is_err());
        let mut j = job(AiMode::Fix);
        j.error = None;
        assert!(build_messages(&j).is_err());
        let mut j = job(AiMode::Explain);
        j.sql = Some("  ".into());
        assert!(build_messages(&j).is_err());
    }

    #[test]
    fn dialect_labels_map() {
        assert_eq!(dialect_label("postgresql"), "PostgreSQL");
        assert_eq!(dialect_label("sqlite"), "SQLite");
        assert_eq!(dialect_label("mysql"), "MySQL/MariaDB");
    }

    #[test]
    fn delta_extraction_chunk_shape() {
        let payload = r#"{"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(extract_delta(payload).unwrap(), None);
        let payload = r#"{"choices":[{"delta":{"content":"SELECT "}}]}"#;
        assert_eq!(extract_delta(payload).unwrap(), Some("SELECT ".into()));
        let payload = r#"{"choices":[{"delta":{"content":null}}]}"#;
        assert_eq!(extract_delta(payload).unwrap(), None);
        let payload = r#"{"choices":[{"text":"legacy"}]}"#;
        assert_eq!(extract_delta(payload).unwrap(), Some("legacy".into()));
        assert_eq!(extract_delta("not json").unwrap(), None);
        let payload = r#"{"error":{"message":"bad key"}}"#;
        assert_eq!(extract_delta(payload).unwrap_err(), "AI provider error: bad key");
    }

    #[test]
    fn sse_line_parsing_logic() {
        // Mirror of the in-stream loop for a fixed buffer: `data:` prefix,
        // [DONE] sentinel, comment lines skipped.
        let lines = [
            ": keep-alive",
            "data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}",
            "data: [DONE]",
        ];
        let mut out = String::new();
        for line in lines {
            let Some(payload) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = payload.trim();
            if payload == "[DONE]" {
                break;
            }
            if let Ok(Some(delta)) = extract_delta(payload) {
                out.push_str(&delta);
            }
        }
        assert_eq!(out, "a");
    }

    #[test]
    fn jobs_register_cancel_finish() {
        let jobs = AiJobs::new();
        let flag = jobs.register(1);
        assert!(!flag.load(Ordering::Relaxed));
        assert!(jobs.cancel(1));
        assert!(flag.load(Ordering::Relaxed));
        // Cancelling again still reports true (flag set) but unknown ids fail.
        assert!(!jobs.cancel(2));
        jobs.finish(1);
        assert!(jobs.active.lock().unwrap().is_empty());
    }

    #[test]
    fn truncate_caps_long_bodies() {
        assert_eq!(truncate("hello", 10), "hello");
        assert_eq!(truncate("hello world", 5), "hello…");
    }

    // -----------------------------------------------------------------------
    // Live SSE behavior against a local mock server (Phase 0 validation).
    //
    // The provider-facing code paths — chunk-boundary reassembly, [DONE],
    // mid-stream error frames, HTTP error bodies, cancellation — can only be
    // proven against a real HTTP round trip, not string-level unit tests.
    // These tests spin a raw TcpListener that speaks SSE, sometimes
    // deliberately splitting frames across TCP writes at hostile offsets.
    // -----------------------------------------------------------------------

    /// One SSE exchange on a throwaway port. `script` writes the response in
    /// slices (each flushed) after the request arrives.
    fn spawn_sse_server(script: Vec<&'static str>) -> (u16, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            // Drain the request headers (they end at a blank line).
            let mut buf = [0u8; 4096];
            let mut seen = 0;
            loop {
                let n = socket.read(&mut buf).unwrap();
                seen += n;
                if n == 0 || buf[..seen].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            for slice in script {
                socket.write_all(slice.as_bytes()).unwrap();
                socket.flush().unwrap();
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            // Hold the socket open briefly so the client sees the full body.
            std::thread::sleep(std::time::Duration::from_millis(50));
        });
        (port, handle)
    }

    fn sse_config(port: u16) -> (AiProviderConfig, Vec<ChatMessage>) {
        (
            AiProviderConfig {
                base_url: format!("http://127.0.0.1:{port}/v1"),
                model: "mock".into(),
            },
            vec![ChatMessage { role: "user", content: "hi".into() }],
        )
    }

    #[tokio::test]
    async fn sse_reassembles_frames_split_mid_json() {
        let cancel = AtomicBool::new(false);
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"he",
            "llo\"}}]}\n\ndata: {\"cho",
            "ices\":[{\"delta\":{\"content\":\" world\"}}]}\n\n",
            "data: [DONE]\n\n",
        ]);
        let (config, messages) = sse_config(port);
        let text = stream_chat(&config, None, &messages, 128, &cancel, |_| {}).await.unwrap();
        assert_eq!(text, "hello world");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sse_midstream_error_frame_surfaces_message() {
        let cancel = AtomicBool::new(false);
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"par\"}}]}\n\n",
            "data: {\"error\":{\"message\":\"quota exceeded\"}}\n\n",
        ]);
        let (config, messages) = sse_config(port);
        let err = stream_chat(&config, None, &messages, 128, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("quota exceeded"), "{err}");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sse_http_error_surfaces_status_and_body() {
        let cancel = AtomicBool::new(false);
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\n\r\n",
            "{\"error\":{\"message\":\"bad key\"}}",
        ]);
        let (config, messages) = sse_config(port);
        let err = stream_chat(&config, Some("sk-wrong"), &messages, 128, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(err.to_string().contains("401"), "{err}");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sse_cancelled_midstream() {
        let cancel = AtomicBool::new(true);
        // No server needed: the flag is checked before the first read, but a
        // listener keeps connect() from failing outright on some platforms.
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            "data: [DONE]\n\n",
        ]);
        let (config, messages) = sse_config(port);
        let err = stream_chat(&config, None, &messages, 128, &cancel, |_| {})
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Cancelled(_)), "{err}");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sse_body_without_done_returns_collected_text() {
        let cancel = AtomicBool::new(false);
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"abc\"}}]}\n\n",
        ]);
        let (config, messages) = sse_config(port);
        // Stream ends without [DONE]: whatever accumulated is still valid.
        let text = stream_chat(&config, None, &messages, 128, &cancel, |_| {}).await.unwrap();
        assert_eq!(text, "abc");
        server.join().unwrap();
    }

    #[tokio::test]
    async fn sse_keepalive_comments_are_ignored() {
        let cancel = AtomicBool::new(false);
        let (port, server) = spawn_sse_server(vec![
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
            ": ping\n\n",
            ": ping\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n",
            "data: [DONE]\n\n",
        ]);
        let (config, messages) = sse_config(port);
        let text = stream_chat(&config, None, &messages, 128, &cancel, |_| {}).await.unwrap();
        assert_eq!(text, "ok");
        server.join().unwrap();
    }

    /// The env-gated live check: `DBOB cat_AI_LIVE_URL` + optional
    /// `DBOBCAT_AI_LIVE_KEY` + `DBOBCAT_AI_LIVE_MODEL` against any
    /// OpenAI-compatible endpoint (Ollama: http://localhost:11434/v1).
    /// Skipped silently when the variable is unset so CI stays hermetic.
    #[tokio::test]
    async fn live_provider_round_trip() {
        let Ok(url) = std::env::var("DBOBCAT_AI_LIVE_URL") else {
            return;
        };
        let key = std::env::var("DBOBCAT_AI_LIVE_KEY").ok();
        let model = std::env::var("DBOBCAT_AI_LIVE_MODEL").unwrap_or_else(|_| "gpt-4o-mini".into());
        let cancel = AtomicBool::new(false);
        let config = AiProviderConfig { base_url: url, model };
        let messages = vec![ChatMessage { role: "user", content: "Reply with the word OK".into() }];
        let mut deltas = 0;
        let text = stream_chat(&config, key.as_deref(), &messages, 16, &cancel, |_| {
            deltas += 1;
        })
        .await
        .expect("live provider call failed");
        assert!(!text.trim().is_empty());
        assert!(deltas > 0, "expected streamed deltas");
    }
}

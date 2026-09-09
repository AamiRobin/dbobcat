//! `dbobcat mcp` — Model Context Protocol server (Phase 13).
//!
//! Lets MCP-capable agents (Claude Code, Cursor, ...) inspect databases the
//! user explicitly allowlisted, read-only. Runs headless on stdio
//! (newline-delimited JSON-RPC), reusing the app's driver layer, settings
//! and credential vault — no second binary, no node.
//!
//! Design rules (see `policy.rs` for the policy itself):
//! - Fail closed: no policy, no tools.
//! - The policy is re-read on every request; GUI edits apply immediately.
//! - Tool failures are MCP *results* with `isError: true`; only protocol
//!   violations are JSON-RPC errors.
//! - Diagnostics go to stderr; stdout carries protocol frames only.

use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::mcp::tools::{call_tool, tool_defs, McpCtx};

pub mod policy;
pub mod schema_context;
pub mod tools;

/// MCP protocol version supported. Echoed back from the client's
/// `initialize`; the spec lets a server answer with any version it
/// supports, and we only speak this one.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Entry point behind the `dbobcat mcp` CLI argument: serve stdio until
/// EOF. `data_dir` overrides the app data directory (tests, `DBX_DATA_DIR`-
/// style sandboxing).
pub async fn run_stdio_with_dir(data_dir: PathBuf) -> Result<()> {
    if !crate::mcp::tools::looks_like_data_dir(&data_dir) {
        eprintln!(
            "dbobcat mcp: no settings found in {} — start the DBobcat app once, first",
            data_dir.display()
        );
        return Ok(()); // a client connecting to nothing should not error-loop
    }
    let ctx = McpCtx::new(data_dir);
    run_loop(&ctx, &mut std::io::stdin().lock(), &mut std::io::stdout().lock()).await
}

/// Default entry: use the standard app data directory, or the `DBOBCAT_DATA_DIR`
/// override (portable setups). The override relocates storage; it can never
/// widen the policy — a different directory simply has its own, still-closed
/// by default.
pub async fn run_stdio() -> Result<()> {
    let data_dir = match std::env::var_os("DBOBCAT_DATA_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => crate::credentials::default_store_dir()?,
    };
    run_stdio_with_dir(data_dir).await
}

/// The protocol loop, generic over reader/writer so tests drive it
/// in-memory. Returns when the input ends. Public for tests.
pub async fn run_loop<R: std::io::BufRead, W: Write>(
    ctx: &McpCtx,
    input: &mut R,
    output: &mut W,
) -> Result<()> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = input.read_line(&mut line).map_err(AppError::Io)?;
        if n == 0 {
            return Ok(()); // EOF: graceful shutdown, exit code 0
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(response) = handle_message(ctx, trimmed).await {
            writeln!(output, "{response}").map_err(AppError::Io)?;
            output.flush().map_err(AppError::Io)?;
        } // no `else`: notifications get no response
    }
}


/// Handle one incoming line. Returns the response JSON (without newline),
/// or `None` for notifications / malformed-but-id-less frames.
pub async fn handle_message(ctx: &McpCtx, line: &str) -> Option<String> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            // Unparseable frame: if we can't even find an id, drop it.
            eprintln!("dbobcat mcp: dropping unparseable frame: {e}");
            return None;
        }
    };

    let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(json!({}));

    // Notifications (no id) never get responses — including errors.
    let method = method?;
    let result = dispatch(ctx, &method, &params).await;
    let id = id?; // a request carries an id; anything else was a notification

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
    .map(|v| v.to_string())
}

type RpcError = (i64, String);

const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;
const INTERNAL_ERROR: i64 = -32603;

async fn dispatch(ctx: &McpCtx, method: &str, params: &Value) -> std::result::Result<Value, RpcError> {
    match method {
        "initialize" => {
            // Echo the client's version only when we actually support it;
            // otherwise answer with ours (spec: server picks the version).
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let version = match requested {
                Some(v) if v == PROTOCOL_VERSION => v,
                _ => PROTOCOL_VERSION,
            };
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "dbobcat",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                "instructions": "Read-only database access via DBobcat connections. \
                    Only connections allowlisted in DBobcat Settings → Agent access are usable. \
                    Write statements are rejected by policy.",
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tool_defs().iter().map(|t| json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let policy = ctx.policy();
            if !policy.enabled {
                return Ok(tool_error(
                    "Agent access is disabled in DBobcat settings \
                     (Settings → Agent access).",
                ));
            }
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Err((INVALID_PARAMS, "tools/call requires a tool name".into()));
            };
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            match call_tool(ctx, name, &args).await {
                Ok(text) => Ok(json!({
                    "content": [{ "type": "text", "text": text }],
                    "isError": false,
                })),
                Err(message) => Ok(tool_error(&message)),
            }
        }
        "notifications/initialized" | "notifications/cancelled" => Ok(json!({})),
        other => Err((
            METHOD_NOT_FOUND,
            format!("method {other:?} not found (supported: initialize, ping, tools/list, tools/call)"),
        )),
    }
}

fn tool_error(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Guard: INTERNAL_ERROR would otherwise be unused in stdio mode.
    #[test]
    fn error_codes_are_stable() {
        assert_eq!(METHOD_NOT_FOUND, -32601);
        assert_eq!(INVALID_PARAMS, -32602);
        assert_eq!(INTERNAL_ERROR, -32603);
    }

    #[tokio::test]
    async fn notifications_produce_no_response() {
        let ctx = McpCtx::new(std::env::temp_dir());
        assert!(handle_message(&ctx, r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn initialize_echoes_and_advertises_tools() {
        let ctx = McpCtx::new(std::env::temp_dir());
        let response = handle_message(
            &ctx,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#,
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(v["result"]["serverInfo"]["name"], "dbobcat");
    }

    #[tokio::test]
    async fn tools_list_lists_readonly_suite() {
        let ctx = McpCtx::new(std::env::temp_dir());
        let response = handle_message(
            &ctx,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        let names: Vec<&str> = v["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, [
            "dbobcat_list_connections",
            "dbobcat_list_databases",
            "dbobcat_list_tables",
            "dbobcat_describe_table",
            "dbobcat_get_schema_context",
            "dbobcat_query",
        ]);
    }

    #[tokio::test]
    async fn tools_call_without_policy_reports_is_error_result() {
        // temp_dir has no (valid) settings — policy fails closed.
        let ctx = McpCtx::new(std::env::temp_dir().join(format!("empty-{}", std::process::id())));
        std::fs::create_dir_all(&ctx.data_dir).unwrap();
        let response = handle_message(
            &ctx,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dbobcat_list_connections","arguments":{}}}"#,
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["result"]["isError"], true);
        let text = v["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("disabled") || text.contains("not allowed") || text.contains("cannot read"), "{text}");
    }

    #[tokio::test]
    async fn unknown_method_is_protocol_error() {
        let ctx = McpCtx::new(std::env::temp_dir());
        let response = handle_message(
            &ctx,
            r#"{"jsonrpc":"2.0","id":9,"method":"resources/list"}"#,
        )
        .await
        .unwrap();
        let v: Value = serde_json::from_str(&response).unwrap();
        assert_eq!(v["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn stdio_loop_round_trips_frames() {
        let ctx = McpCtx::new(std::env::temp_dir());
        let mut input = std::io::Cursor::new(
            concat!(
                "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
                "\n",
                "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n",
                "not json at all\n",
            ),
        );
        let mut output: Vec<u8> = Vec::new();
        run_loop(&ctx, &mut input, &mut output).await.unwrap();
        let out = String::from_utf8(output).unwrap();
        // Exactly one response: the ping (notification and garbage are silent).
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines.len(), 1, "{out}");
        let v: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"], json!({}));
    }
}

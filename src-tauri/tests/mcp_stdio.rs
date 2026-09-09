//! End-to-end MCP server test (Phase 13 acceptance gate).
//!
//! Drives the full stdio protocol loop in-memory against a real SQLite
//! database: initialize → tools/list → list_connections → query, plus the
//! three refusal paths that matter (writes rejected by the classifier,
//! non-allowlisted sessions rejected by policy, disabled policy).

use serde_json::{json, Value};

use dbobcat_lib::mcp::tools::McpCtx;

fn unique_dir(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "dbobcat-mcp-e2e-{}-{tag}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Create `users` with two rows; returns the db file path.
fn seed_sqlite(dir: &std::path::Path, tag: &str) -> String {
    let path = dir.join(format!("{tag}.db"));
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch(
        "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
         INSERT INTO users (name) VALUES ('ada'), ('grace');",
    )
    .unwrap();
    path.to_string_lossy().to_string()
}

fn write_settings(
    dir: &std::path::Path,
    db_path: &str,
    extra_session: bool,
    mcp: Value,
) -> (String, String) {
    let mut sessions = vec![json!({
        "id": "sess-allowed",
        "name": "Local Test",
        "user": "",
        "dbType": "sqlite",
        "host": db_path,
        "port": 0,
    })];
    if extra_session {
        sessions.push(json!({
            "id": "sess-hidden",
            "name": "Hidden Test",
            "user": "",
            "dbType": "sqlite",
            "host": db_path,
            "port": 0,
        }));
    }
    let doc = json!({ "sessions": sessions, "mcp": mcp });
    std::fs::write(dir.join("settings.json"), serde_json::to_vec(&doc).unwrap()).unwrap();
    ("sess-allowed".into(), "sess-hidden".into())
}

async fn drive(ctx: &McpCtx, frames: &[Value]) -> Vec<Value> {
    let mut input = String::new();
    for (i, frame) in frames.iter().enumerate() {
        let _ = i;
        input.push_str(&frame.to_string());
        input.push('\n');
    }
    let mut reader = std::io::Cursor::new(input);
    let mut output: Vec<u8> = Vec::new();
    dbobcat_lib::mcp::run_loop(ctx, &mut reader, &mut output).await.unwrap();
    String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn result_text(response: &Value) -> (bool, String) {
    let is_error = response["result"]["isError"].as_bool().unwrap_or(false);
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    (is_error, text)
}

#[tokio::test]
async fn full_agent_session_happy_and_refusals() {
    let dir = unique_dir("full");
    let db_path = seed_sqlite(&dir, "main");
    write_settings(
        &dir,
        &db_path,
        true,
        json!({ "enabled": true, "allowed": ["sess-allowed"] }),
    );
    let ctx = McpCtx::new(dir.clone());

    let responses = drive(
        &ctx,
        &[
            json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"dbobcat_list_connections","arguments":{}}}),
            json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"dbobcat_list_tables","arguments":{"connection":"Local Test","database":"main"}}}),
            json!({"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"dbobcat_describe_table","arguments":{"connection":"sess-allowed","database":"main","table":"users"}}}),
            json!({"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"dbobcat_get_schema_context","arguments":{"connection":"sess-allowed","database":"main"}}}),
            json!({"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"dbobcat_query","arguments":{"connection":"sess-allowed","sql":"SELECT id, name FROM users ORDER BY id"}}}),
            json!({"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"dbobcat_query","arguments":{"connection":"sess-allowed","sql":"DELETE FROM users"}}}),
            json!({"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"dbobcat_query","arguments":{"connection":"sess-hidden","sql":"SELECT 1"}}}),
            json!({"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"dbobcat_query","arguments":{"connection":"sess-allowed","sql":"SELECT 1; DROP TABLE users"}}}),
        ],
    )
    .await;

    // Notifications are silent: 10 requests in, 10 responses out.
    assert_eq!(responses.len(), 10, "{:?}", responses.len());

    // initialize
    assert_eq!(responses[0]["result"]["serverInfo"]["name"], "dbobcat");

    // tools/list — the read-only suite
    let names: Vec<&str> = responses[1]["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"dbobcat_query"));
    assert!(!names.iter().any(|n| n.contains("execute_batch")));

    // list_connections — only the allowlisted session is visible
    let (is_err, text) = result_text(&responses[2]);
    assert!(!is_err, "{text}");
    assert!(text.contains("sess-allowed"), "{text}");
    assert!(!text.contains("sess-hidden"), "hidden session leaked: {text}");
    assert!(!text.to_lowercase().contains("password"), "{text}");

    // list_tables
    let (is_err, text) = result_text(&responses[3]);
    assert!(!is_err, "{text}");
    assert!(text.contains("users"), "{text}");

    // describe_table
    let (is_err, text) = result_text(&responses[4]);
    assert!(!is_err, "{text}");
    assert!(text.contains("name"), "{text}");

    // schema context
    let (is_err, text) = result_text(&responses[5]);
    assert!(!is_err, "{text}");
    assert!(text.contains("TABLE users ("), "{text}");

    // query — real rows back
    let (is_err, text) = result_text(&responses[6]);
    assert!(!is_err, "{text}");
    let parsed: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["statements"][0]["rowCount"], 2);
    assert_eq!(parsed["statements"][0]["rows"][1][1], "grace");

    // write → classifier refusal (an isError RESULT, not a protocol error)
    let (is_err, text) = result_text(&responses[7]);
    assert!(is_err, "DELETE must be refused: {text}");
    assert!(text.contains("rejected") || text.contains("forbids"), "{text}");

    // non-allowlisted session → policy refusal
    let (is_err, text) = result_text(&responses[8]);
    assert!(is_err, "hidden session must be refused: {text}");
    assert!(text.contains("not allowed") || text.contains("unknown"), "{text}");

    // stacked statements → refusal
    let (is_err, text) = result_text(&responses[9]);
    assert!(is_err, "stacked statements must be refused: {text}");
    assert!(text.contains("single statement"), "{text}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn disabled_policy_refuses_everything() {
    let dir = unique_dir("disabled");
    let db_path = seed_sqlite(&dir, "main");
    write_settings(
        &dir,
        &db_path,
        false,
        json!({ "enabled": false, "allowed": ["sess-allowed"] }),
    );
    let ctx = McpCtx::new(dir.clone());

    let responses = drive(
        &ctx,
        &[json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dbobcat_list_connections","arguments":{}}})],
    )
    .await;
    let (is_err, text) = result_text(&responses[0]);
    assert!(is_err);
    assert!(text.contains("disabled"), "{text}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn policy_edit_applies_without_restart() {
    // Policy is re-read per request: starting closed, a GUI-style settings
    // rewrite must open access on the very next call.
    let dir = unique_dir("hotreload");
    let db_path = seed_sqlite(&dir, "main");
    write_settings(
        &dir,
        &db_path,
        false,
        json!({ "enabled": false, "allowed": [] }),
    );
    let ctx = McpCtx::new(dir.clone());

    let refused = drive(
        &ctx,
        &[json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"dbobcat_list_connections","arguments":{}}})],
    )
    .await;
    assert!(result_text(&refused[0]).0, "must start closed");

    // The GUI flips the switches.
    write_settings(
        &dir,
        &db_path,
        false,
        json!({ "enabled": true, "allowed": ["sess-allowed"] }),
    );

    let allowed = drive(
        &ctx,
        &[json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"dbobcat_list_connections","arguments":{}}})],
    )
    .await;
    let (is_err, text) = result_text(&allowed[0]);
    assert!(!is_err, "policy edit must apply without restart: {text}");
    assert!(text.contains("sess-allowed"), "{text}");

    let _ = std::fs::remove_dir_all(&dir);
}

# DBobcat MCP server (`dbobcat mcp`)

DBobcat ships a **read-only [Model Context Protocol](https://modelcontextprotocol.io) server** that lets
MCP-capable agents — Claude Code, Cursor, Windsurf, any MCP client — inspect and query the
database connections you explicitly allow. It runs headless on stdio from the same binary as
the desktop app: no second install, no Node.js.

## Enabling agent access

1. Open DBobcat → **Settings (AI) → Agent access (MCP)**.
2. Toggle **Expose DBobcat to AI agents** on.
3. Check the connections you want to allow. Nothing is exposed until a connection is
   explicitly checked; the policy lives in `settings.json` under the `"mcp"` key:

   ```json
   { "mcp": { "enabled": true, "allowed": ["<session-id>"] } }
   ```

   The server re-reads the policy on **every request** — changes apply immediately, no
   client restart needed.

4. Register the server with your client:

   **Claude Code**
   ```sh
   claude mcp add dbobcat -- dbobcat mcp
   ```

   **Generic `.mcp.json`**
   ```json
   {
     "mcpServers": {
       "dbobcat": { "command": "dbobcat", "args": ["mcp"] }
     }
   }
   ```

Use the full path to the `dbobcat` binary if it is not on your `PATH`.

## Tools

| Tool | Reads | Notes |
|---|---|---|
| `dbobcat_list_connections` | Allowed sessions only | id, name, engine, default database — never secrets |
| `dbobcat_list_databases` | Database names | |
| `dbobcat_list_tables` | Table/view names + row estimates | |
| `dbobcat_describe_table` | Columns, types, keys, comments | |
| `dbobcat_get_schema_context` | Compact schema dump | AI-optimized text: tables, columns, FKs |
| `dbobcat_query` | Query results | **Read-only, single statement, hard-capped** |

## Safety model (fail-closed)

- **No policy = nothing exposed.** A missing, malformed, or disabled `"mcp"` key means the
  server answers `initialize` but refuses every tool call.
- **Allowlist only.** Sessions must be explicitly allowlisted; hidden sessions are invisible
  to `list_connections` and refused by every other tool.
- **Read-only by construction.** `dbobcat_query` accepts exactly one statement starting with
  `SELECT` / `WITH` / `SHOW` / `EXPLAIN` / `DESCRIBE`. Anything containing data-modifying
  keywords is rejected — including data-modifying CTEs (`WITH x AS (DELETE …)`), locking
  reads (`FOR UPDATE`), `EXPLAIN ANALYZE` (which executes), and `SELECT … INTO OUTFILE`.
  Multiple statements in one call are rejected.
- **Hard caps.** 100 rows per query, truncated cells, 64 KB per result — so an agent cannot
  pull your whole table into its context window.
- **No env-var override.** `DBOBCAT_DATA_DIR` relocates storage (portable setups); it can
  never widen a policy, because every directory starts closed.

## Data directory

By default the server reads the same data directory as the desktop app. Set
`DBOBCAT_DATA_DIR=/path/to/dir` to point it at a different one (it must contain a
`settings.json` created by the app).

## What agents cannot do

- Write, update, delete, DDL, truncate, grant, kill, load data.
- See connection passwords, users, or hosts of SSH sessions.
- See sessions that are not allowlisted.
- Bypass row/cell/result caps.
- Keep working after you switch the policy off — enforcement re-reads on every request.

Write assistance is deliberately out of scope for v1: agents draft, humans execute. If you
want a write-capable agent surface, it will arrive as a separately-gated mode, not by
loosening this one.

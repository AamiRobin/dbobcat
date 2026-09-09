# Changelog

Notable changes to DBobcat. Formats follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **MCP server (`dbobcat mcp`)** — exposes allowlisted DBobcat connections to
  MCP-capable agents (Claude Code, Cursor, …) over stdio, from the same
  binary as the app. Six read-only tools (connections, databases, tables,
  table details, compact schema context, single-statement query) with a
  fail-closed policy: explicit per-session allowlist, a read-only SQL
  classifier (rejects writes, data-modifying CTEs, `FOR UPDATE`,
  `EXPLAIN ANALYZE`, `SELECT … INTO OUTFILE`, stacked statements), and hard
  row/cell/result caps. Policy is edited in Settings → AI → Agent access and
  re-read on every request.
- **AI assistant (BYOK)** — a prompt bar above the query editor (`Mod+I`).
  Natural language → SQL drafts built from the real schema, one-click
  "fix with AI" for failed statements, and plain-English query
  explanations. Works with any OpenAI-compatible endpoint (OpenAI,
  OpenRouter, Groq, …) including fully local Ollama and LM Studio.
  Privacy contract: only schema metadata and your SQL ever leave the app
  — never row data — the API key is stored in the same AES-GCM vault as
  connection passwords, and the assistant stays off until you explicitly
  configure and enable it.

## [0.1.0-alpha.3] — 2026-09-08

First public alpha — a cross-platform database GUI client for
MySQL/MariaDB, PostgreSQL, and SQLite, inspired by HeidiSQL.

### Added

- **Session manager** — MySQL/MariaDB, PostgreSQL, and SQLite connections;
  SSH tunnels, TLS, AES-GCM-encrypted password storage with an optional
  master password, session groups, and per-connection transaction defaults.
- **Data grid** — virtualized browsing with inline editing, filtering and
  sorting, BLOB handling, and a local changeset that posts edits to the
  server.
- **Query editor** — schema-driven completion, multi-query execution,
  query history, and formatting (CodeMirror 6).
- **Table designer** — columns, indexes, and foreign keys with an ALTER
  preview before you commit.
- **Export & import** — SQL dump, CSV, HTML, XML, JSON, LaTeX, Markdown,
  PHP, and Textile targets with optional gzip, plus clipboard export and
  CSV import.
- **Server tools** — user manager, process list, find text across tables,
  and copy table.
- **Schema diagram** — auto-laid-out ER view with SVG/PNG export.
- **Command palette** (`Mod+K`), SQL snippets, and a launch-milestone
  GitHub star prompt (entirely local state — no telemetry).

### Known limitations

- **macOS builds are Apple Silicon only** and unsigned — right-click the
  app and choose *Open* (or run `xattr -cr /Applications/DBobcat.app`) on
  first launch.
- **Windows installers are unsigned** — SmartScreen may warn on first run.
- **In-app updates:** the updater endpoint ignores prereleases, so while
  only alpha builds exist, *Check for Updates…* reports "auto-update
  unavailable". This is expected until the first stable release.
- Alpha quality — expect rough edges. Nothing is sent anywhere: all data
  stays on your machine.

[0.1.0-alpha.3]: https://github.com/AamiRobin/dbobcat/releases/tag/v0.1.0-alpha.3

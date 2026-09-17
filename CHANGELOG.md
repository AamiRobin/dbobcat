# Changelog

Notable changes to DBobcat. Formats follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.1.7] — 2026-09-18

macOS icon release — the Dock icon now renders natively on macOS 26+.

### Fixed

- **macOS icon drawn inside a system-generated frame** — the bundled
  `icon.icns` carried the rounded-tile artwork with transparent margins,
  which macOS 26+ treats as a legacy icon: it scales the artwork down and
  composites it onto an auto-generated squircle with a border. The macOS
  icon is now compiled from a full-bleed, edge-to-edge variant that the
  system masks into its own squircle like native apps. Windows and Linux
  keep the rounded tile. `scripts/make-macos-icon.ts` rebuilds the macOS
  icon from the canonical tile (or from a hand-made full-bleed export);
  the workflow is documented in `assets/brand/README.md`.

## [0.1.2] — 2026-09-12

Update experience release — the app now checks for updates on its own
and shows a visible install button.

### Added

- **Automatic update check** — five seconds after launch the app quietly
  queries the release feed; when a newer version exists, an install
  button appears in the status bar and a toast announces it. Checking
  stays silent when you are already current. Downloads report progress
  in the same spot and end with a restart prompt. (Previously the check
  only ran from Help → Check for Updates….)

### Fixed

- **Windows/Linux had no reachable update check** — the app removes the
  native title bar on those platforms, which also removes the menu bar
  housing "Check for Updates…". The new status bar button makes the
  update path platform-independent; the menu item remains for macOS.

## [0.1.1] — 2026-09-12

UI polish release — fixes for dialog sizing, chip shapes, and wizard
markup.

### Fixed

- **Dialogs ignored their width overrides** — `AlertDialogContent`
  expressed its default width as `data-[size]` variants, whose class +
  attribute selector outranks a plain `sm:max-w-*` override in the CSS
  cascade, so every alert dialog that asked to be wider stayed stuck at
  384px with its right side clipped (stepper steps and footer buttons
  cut off). Affected the CSV/text import wizard and export dialog most
  visibly, plus copy-table and the tree rename/definition dialogs.
  Default widths are now plain utilities that `tailwind-merge` can
  dedupe against caller classes; the small size keeps its narrower cap.
- **Badges rendered as pills** — the Badge used `rounded-4xl` (26px via
  the theme token) on chips only 16–20px tall, i.e. fully rounded ends,
  in the message log, status bar transaction chip, data toolbar, query
  result grid, object editor, designer, user manager, export dialog and
  blob viewer. Now `rounded-sm`, matching the small-control corners
  used elsewhere.
- **Import wizard markup** — the step indicator (an `<ol>`) sat inside
  `AlertDialogDescription`, which renders a `<p>` (invalid HTML nesting
  that trips React warnings); it is now a sibling of a screen-reader
  description. The paste-area placeholder showed a literal `\n` because
  JSX string attributes don't process escapes; it now renders a real
  line break.

## [0.1.0] — 2026-09-12

First stable release — and the first one the in-app updater tracks
(*Check for Updates…* now finds stable releases).

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
- **AI agent mode** — the assistant can now act, not just draft: it inspects
  your schema, runs read-only queries, and proposes writes that stay one
  confirmation away. Every statement passes an AST-based SQL risk
  classifier (sqlparser — not regex), and a proposed write executes only
  after you approve the exact SQL. Each approval is bound to the
  connection, database, and statement it was granted for, and re-verified
  — including a live "am I still on the intended database?" check —
  immediately before execution.
- **Advanced export options (HeidiSQL-style)** — SQL dumps gain INSERT
  batching by row count and byte size, selectable data statements
  (`INSERT` / `REPLACE` / `INSERT IGNORE` / `INSERT … ON DUPLICATE KEY
  UPDATE` / `DELETE` + `INSERT`), `TRUNCATE`-before-insert, `DROP
  DATABASE`, and AUTO_INCREMENT stripping, with an optional delay between
  batches and full cancellation support. CSV/TSV export picks delimiter,
  quoting, and NULL representation.
- **Streaming XLSX export** — data grids and dumps can target Excel
  workbooks written incrementally (constant memory), spilling into extra
  sheets at Excel's 1,048,576-row limit.
- **ER diagram upgrades** — crow's-foot cardinality ticks (filled =
  mandatory child column, outline = nullable, plain line = composite
  constraint), in-diagram table search with zoom-to-fit, and a focus mode
  that isolates one table's relationships; selecting an edge pins a label
  with the constraint's `ON UPDATE` / `ON DELETE` actions.

### Fixed

- Switching between tables no longer shows a stale or empty data grid
  until manual refresh; left-clicking a table opens its data without
  expanding the tree — expansion stays on the chevron.
- Renaming, moving, or dropping a table now retargets or closes its open
  data tabs instead of leaving stale ones behind; unsaved designer and
  object-editor edits survive tab remounts.
- PostgreSQL edits apply atomically: on failure everything rolls back and
  the real server error is reported for the offending row. MySQL upserts
  handle MySQL-only `INSERT IGNORE` semantics correctly.
- Session manager: the Import tooltip no longer pops open when the dialog
  opens.

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

[0.1.0]: https://github.com/AamiRobin/dbobcat/releases/tag/v0.1.0
[0.1.0-alpha.3]: https://github.com/AamiRobin/dbobcat/releases/tag/v0.1.0-alpha.3

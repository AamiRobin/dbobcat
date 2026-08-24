# Murmeli — Open-Source Database Client (formerly heidisql-clone)

Swiss-German for *marmot* — an alpine nod to HeidiSQL's heritage.

## 1. Vision

Open-source, cross-platform (Windows / Linux / macOS) database GUI client inspired by HeidiSQL, with a modern shadcn/ui design.

**Goal:** cover most of HeidiSQL's feature set.

**Deliberately out of scope for early versions** (can be added later via driver trait):

- Firebird / Interbase
- ProxySQL
- Redshift

## 2. Decisions Already Made

| Area | Decision |
|---|---|
| First database engine | MySQL/MariaDB (later PostgreSQL, SQLite, then MS SQL via shared driver abstraction) |
| Data grid | Custom virtualized grid built with TanStack Virtual + shadcn components (no heavy grid dependency) |
| Password storage | Encrypted local file (AES-GCM, key derived via argon2 from optional master password) — **NOT** OS keychain |
| SSH tunnels | Pure Rust using the `russh` crate (implemented as localhost port-forwarder so any driver works through it unchanged) |
| Tech stack | Tauri 2, React 19, TypeScript, Vite, bun, Tailwind CSS v4, shadcn/ui (new-york style), lucide-react |

## 3. Feature Parity Matrix (HeidiSQL feature → our plan)

| HeidiSQL feature | Our plan |
|---|---|
| Multiple connections in one window | Multi-session tree + per-session tabs |
| MySQL/MariaDB, PostgreSQL, SQLite, MSSQL | Driver trait; MySQL/MariaDB → v1, PG+SQLite → v2, MSSQL → v3 |
| SSH tunnel + SSL | Pure Rust `russh` local port-forward; TLS via `native-tls` |
| Session manager | Saved sessions in settings, passwords in AES-GCM encrypted file (argon2, optional master password) |
| DB tree (tables, views, routines, triggers, events, columns-as-children) | Lazy-loaded tree, context menus, drag & drop later |
| Data grid (browse/edit/filter/sort, BLOBs) | Custom virtualized shadcn grid, change tracking + "Post changes" like Heidi |
| Query editor (highlighting, completion, multi-query, formatter) | CodeMirror 6 + `sqlformat` crate |
| Table designer (columns/indexes/FK/options) with ALTER preview | Yes — generates diff DDL |
| Views / procedures / triggers / events editors | Code editor tabs with `SHOW CREATE` round-trip |
| Export: SQL, CSV, HTML, XML, JSON, LaTeX, Markdown, PHP, Textile; gzip; clipboard; server→server | Rust exporters, streamed |
| Import text files / SQL dumps | Wizard with preview |
| User manager (privileges, roles, auth plugins) | Phase 7 |
| Process list monitor + kill | Phase 7 |
| Find text in all tables of all DBs | Phase 7 |
| Maintenance (optimize/repair/analyze/flush), bulk table ops | Phase 4 |
| Command-line connect | Tauri CLI args → auto-open session |
| "Launch parallel mysql.exe" | Cross-platform equivalent: copy ready-made CLI command / integrated terminal (stretch) |

## 4. Tech Stack

### Frontend (existing React 19, TypeScript, Vite, bun)

- Tailwind CSS v4 + shadcn/ui (new-york) + lucide-react
- TanStack Query (IPC/server state) + Zustand (UI/tab state)
- CodeMirror 6 (`@uiw/react-codemirror`, `@codemirror/lang-sql`, autocompletion from live schema)
- `@tanstack/react-virtual` — the data grid
- `react-resizable-panels` — Heidi-style 3-pane layout

### Backend (Rust, Tauri 2)

- `mysql_async` (v1) → `tokio-postgres` + `rusqlite` (v2) → `tiberius` (v3)
- `russh` + `russh-keys` — SSH tunnels as localhost port-forwarder
- `aes-gcm` + `argon2` — credential file encryption
- `csv`, `flate2`, `sqlformat`, `chrono`
- Tauri plugins: store (settings), window-state, later updater

## 5. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│ React UI layer                                                │
│   Session manager · DB tree · Tabs (Data/Query/Designer)      │
│   Zustand tabs/UI state · TanStack Query ──► invoke() IPC     │
├───────────────────────────────────────────────────────────────┤
│ Rust backend                                                  │
│   ConnectionManager                                           │
│     HashMap<ConnId, mpsc::Sender<Cmd>>                        │
│   one tokio task per connection                               │
│     (serialized queries · cancellation · keeps session vars)  │
│   trait DbConnection { list_dbs, list_tables, describe,       │
│     query_page, execute, apply_row_changes, users, ... }      │
│   SshTunnel (russh) · Credentials (AES-GCM) · Exporters       │
└───────────────────────────────────────────────────────────────┘
```

### Key Architectural Decisions

- **One tokio task per connection with an mpsc channel** — mirrors Heidi's session model, enables query cancellation (`KILL QUERY`), avoids parallel-query races, keeps `SET` session state.
- **Row editing model:** grid accumulates a local changeset (inserts/updates/deletes with original PK values) → sent as structured data to Rust → backend builds prepared statements (**never string-concatenated values; identifiers strictly quoted**). "Post changes" button like Heidi.
- **Large results:** page size ~1,000 rows with "load more"; grid virtualized on both axes; BLOB columns truncated in-cell, full view in side viewer (hex/image/text).
- **IPC payloads typed via serde enums;** `QueryResult { columns: ColumnMeta[], rows, affected, elapsedMs }`.

## 6. UI Layout (shadcn, Heidi-inspired)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Toolbar: [Connect] [New query] [Refresh]          session color ●    │
├──────────────┬───────────────────────────────────────────────────────┤
│              │  Tabs:  [Data: users] [Query 1] [users*]              │
│  DB tree     │ ┌───────────────────────────────────────────────────┐ │
│  (lazy)      │ │                                                   │ │
│  ▾ conn      │ │   data grid  /  SQL editor  /  designer           │ │
│    ▾ db      │ │                                                   │ │
│      ▸ tbl   │ │                                                   │ │
│      ▸ view  │ └───────────────────────────────────────────────────┘ │
│      ▸ proc  ├───────────────────────────────────────────────────────┤
│              │  Message log panel                                    │
├──────────────┴───────────────────────────────────────────────────────┤
│ Status bar: session ● · rows: 1000 · elapsed: 42ms · ver 8.0.36      │
└──────────────────────────────────────────────────────────────────────┘
```

- Toolbar: connect, new query, refresh, session color.
- Left panel: database tree; center: tabs area (data grid / SQL editor / designer), laid out with `react-resizable-panels`.
- Bottom: message log panel; status bar shows session indicator (●), row count, elapsed time, server version.
- Dark mode default; theme accents follow per-session color.

## 7. Project Structure

```
src/
  components/
    ui/
    layout/
    session-manager/
    db-tree/
    grid/
    query/
    designer/
    export/
    common/
  hooks/
  stores/
  lib/
  types/

src-tauri/src/
  lib.rs
  error.rs
  settings.rs
  credentials.rs
  ssh.rs
  connections/
    mod.rs
    traits.rs
    mysql.rs
    postgres.rs        # later
    sqlite.rs          # later
  commands/
    sessions.rs
    schema.rs
    query.rs
    data.rs
    export.rs
    import.rs
    users.rs
    server.rs
```

## 8. Roadmap (each phase ends demoable)

| Phase | Name | Scope |
|---|---|---|
| P0 | Foundation | Tailwind v4 + shadcn init, app shell (panels, tab system, menus, dark mode), state/IPC conventions, Rust module skeleton + error types, settings store |
| P1 | Connect & browse | Session manager dialog (CRUD, encrypted passwords, SSH tunnel, SSL), MySQL connect, lazy DB tree + context menus, basic server info |
| P2 | Data grid | Virtualized grid, pagination/sort/filter, inline edit + changeset posting, NULL handling, BLOB viewer, row copy/paste, grid export (CSV quick version) |
| P3 | Query editor | CodeMirror, schema-driven autocompletion, multi-statement + multiple result tabs, message panel, formatter, query history |
| P4 | Table designer + object editors | Columns/indexes/FK/options with ALTER preview, create/copy/rename/drop, views/routines/triggers/events code tabs, bulk table ops, maintenance dialogs |
| P5 | Export/Import | Full SQL dump tool (struct/data, gzip, clipboard/file/server→server), all export formats, CSV import wizard, batch file insert |
| P6 | More engines | PostgreSQL + SQLite behind the `DbConnection` trait, per-dialect SQL generation |
| P7 | Server tools | User manager, process list + kill, find-text-on-server, variables/status dashboards, MSSQL |
| P8 | Polish | Shortcuts, CLI args/deep-link sessions, auto-updater, installers (MSI/DMG/deb/AppImage), i18n groundwork, docs site |

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| SSH ↔ driver integration complexity | Local port-forward approach keeps drivers untouched |
| DDL diffing complexity | MySQL-only first, table-driven per-dialect generators |
| Tauri IPC overhead on huge exports | Stream to file in Rust; only paths return over IPC |
| Scope creep | Heidi parity is a marathon; each phase ships standalone value |

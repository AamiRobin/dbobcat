<p align="center">
  <img src="assets/brand/dbobcat-mark.svg" alt="DBobcat logo — a tufted bobcat perched atop its den, drawn as a database cylinder" height="120">
</p>

<h1 align="center">DBobcat</h1>

DBobcat (**d**atabase + bobcat) is an open-source, cross-platform database GUI client for MySQL/MariaDB, PostgreSQL, and SQLite — inspired by [HeidiSQL](https://www.heidisql.com/), built with a modern stack.

Repository: <https://github.com/AamiRobin/dbobcat>

## Features

- **Session manager** with SSH tunnels, TLS, and AES-GCM-encrypted password storage (optional master password)
- **Virtualized data grid** with inline editing, filtering/sorting, BLOB handling, and a local changeset you post to the server ("Post changes", HeidiSQL-style)
- **Query editor** with schema-driven completion, multi-query execution, history, and formatting
- **Table designer** with columns/indexes/foreign keys and an ALTER preview before applying
- **Full export matrix** — SQL dump, CSV, HTML, XML, JSON, LaTeX, Markdown, PHP, Textile; gzip; clipboard; plus CSV import
- **Server tools** — user manager, process list, find text across tables, copy table
- **Schema diagram** — auto-laid-out ER view of a database with export to SVG/PNG
- **Command palette** (Mod+K), SQL snippets, per-connection transaction defaults
- Multi-engine via a driver abstraction (one tokio task per connection)

## Tech stack

[Tauri 2](https://tauri.app/) + Rust backend, React 19 + TypeScript (strict) + Vite frontend, shadcn/ui + Tailwind CSS v4, CodeMirror 6.

## Development

Prerequisites: [bun](https://bun.sh) ≥ 1.1 and a stable Rust toolchain.

```sh
bun install          # install frontend dependencies
bun run tauri dev    # run the desktop app in dev mode
```

### Tests & checks

```sh
bun test                                   # frontend unit tests
cd src-tauri && cargo test                 # Rust unit tests
cargo clippy --all-targets -- -D warnings  # lint
```

## CLI flags

`dbobcat --connect <session>` / `dbobcat --new-query [session]` — see [`docs/CLI.md`](docs/CLI.md).

## License

MIT. See the About dialog in-app.

## Credits

Inspired by [HeidiSQL](https://www.heidisql.com/) — thanks for decades of ideas.

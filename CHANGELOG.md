# Changelog

Notable changes to DBobcat. Formats follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/).

## [0.1.0-alpha.1] — 2026-09-08

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

[0.1.0-alpha.1]: https://github.com/AamiRobin/dbobcat/releases/tag/v0.1.0-alpha.1

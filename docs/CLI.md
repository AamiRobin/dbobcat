# CLI flags & single-instance behavior

DBobcat can be launched straight into a session from the command line,
HeidiSQL-style. Flags work on the initial launch **and** when a second
invocation hands its arguments to the already-running instance
(single-instance handoff).

## Flags

| Flag | Short | Argument | Effect |
|---|---|---|---|
| `--connect <session>` | `-c` | session **name or id** | Connect to a saved session at startup |
| `--new-query [session]` | `-n` | optional session name/id | Open a new Query tab; if a session is given, connect first |

Both forms are accepted: `--connect name` and `--connect=name`.
Flags may be combined (`--connect local --new-query`).

### Examples

```sh
# Connect to the saved session named "local"
dbobcat --connect local

# Connect by session id and open an empty query tab
dbobcat --connect 7f3c... --new-query

# Just open a fresh query tab on whatever is connected (or nothing)
dbobcat --new-query

# Handoff: the running app receives these args instead of starting twice
dbobcat -c production
```

## Resolution rules

- The value is matched against saved sessions **by exact id first**, then by
  unique name.
- An **ambiguous** name (two saved sessions with the same name) or an unknown
  name logs an error to the message log and opens the Session Manager so you
  can pick manually.
- No auto-reconnect retry happens on failure; the error is shown in the log.

## Auto-updater groundwork

The updater plugin is registered in every desktop build, but stays inert
unless the build was produced with signing/update configuration:

- Local/dev builds: `Check for Updates…` (Help menu) reports that auto-update
  is unavailable — this is expected and logged, not an error dialog.
- Release builds are produced by the `Release` workflow
  (`.github/workflows/release.yml`), triggered by pushing a `v*` tag. It:

  1. installs the Tauri system dependencies (Linux) plus Bun and Rust,
  2. substitutes `__TAURI_UPDATER_PUBLIC_KEY__` in
     `src-tauri/tauri.updater.conf.json` with the `TAURI_UPDATER_PUBLIC_KEY`
     repository secret, failing fast if the secret is unset,
  3. runs `bun run tauri build --config src-tauri/tauri.updater.conf.json`
     with the signing key material exported as environment variables
     (scoped to that build step only),
  4. generates a per-platform updater metadata fragment (`latest.json`
     slice: version from the tag, signature contents, and the release
     download URL of the platform's updater archive) for every matrix
     target, uploading it alongside the bundles as workflow artifacts,
     and — via a separate `publish` job with only that job granted
     `contents: write` —
  5. merges the fragments into one `latest.json` and publishes a GitHub
     Release on the tag containing all installers, updater archives,
     `.sig` files, and `latest.json`. The updater then resolves updates at
     `releases/latest/download/latest.json`.

   Updater platform keys follow Tauri's naming, derived from what the
   matrix actually builds: `darwin-aarch64` (macOS `.app.tar.gz`),
   `linux-x86_64` (`.AppImage`), and `windows-x86_64` (NSIS `-setup.exe`).

  Required secrets: `TAURI_UPDATER_PUBLIC_KEY` (minisign public key) and
  `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (exported
  with `bunx tauri signer generate`). This keeps local builds key-free while
  making release builds updatable end-to-end.

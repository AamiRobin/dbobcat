# CLI flags & single-instance behavior

Murmeli can be launched straight into a session from the command line,
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
murmeli --connect local

# Connect by session id and open an empty query tab
murmeli --connect 7f3c... --new-query

# Just open a fresh query tab on whatever is connected (or nothing)
murmeli --new-query

# Handoff: the running app receives these args instead of starting twice
murmeli -c production
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
- Release builds are bundled with:

  ```sh
  TAURI_SIGNING_PRIVATE_KEY=... TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... \
    bun run tauri build --config src-tauri/tauri.updater.conf.json
  ```

  The overlay (`src-tauri/tauri.updater.conf.json`) enables
  `bundle.createUpdaterArtifacts` and points the updater at the release
  endpoint; CI substitutes `__TAURI_UPDATER_PUBLIC_KEY__` with the real
  public key. This keeps local builds key-free while making release builds
  updatable end-to-end.

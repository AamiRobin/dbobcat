# Security Policy

## Supported versions

DBobcat is pre-1.0; only the latest tagged release and the current `main`
branch (nightly builds) receive security fixes.

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report privately via [GitHub's private vulnerability reporting](https://github.com/AamiRobin/dbobcat/security/advisories/new)
(Settings → Code security → Report a vulnerability). Include a description,
steps to reproduce, and the affected version.

## Scope notes

DBobcat is a local desktop application that stores connection credentials
(AES-GCM-encrypted, optionally behind a master password) on the user's machine.
Of particular interest:

- Anything that leaks stored credentials or master password material
- SQL/connection setting injection through imported session files or exports
- Escapes from the Tauri webview sandbox (CSP violations, IPC misuse)
- The update path (Tauri updater signature verification)

## Updates

Release artifacts are signed with the Tauri updater's minisign key; see
[`docs/RELEASE.md`](docs/RELEASE.md) for how the signing pipeline works.

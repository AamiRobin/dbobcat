# Contributing to DBobcat

Thanks for your interest! DBobcat is an open-source (MIT) database GUI client
for MySQL/MariaDB, PostgreSQL, and SQLite, inspired by HeidiSQL.

## Getting started

Prerequisites: [bun](https://bun.sh) ≥ 1.1 and a stable Rust toolchain.

```sh
bun install          # install frontend dependencies
bun run tauri dev    # run the desktop app in dev mode
```

## Checks before you open a PR

CI runs all of these on every push — please run them locally first:

```sh
bunx tsc --noEmit                           # frontend typecheck
bun test                                    # frontend unit tests
bun run build                               # frontend build
cd src-tauri
cargo check                                 # Rust compile check
cargo clippy --all-targets -- -D warnings   # Rust lint
cargo test                                  # Rust unit tests
```

On Linux, building the Tauri shell needs the system packages listed in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) (webkit2gtk, gtk3, …).

## How to contribute

1. Open an issue first for anything larger than a small fix, so we can agree
   on the approach.
2. Fork the repo (or push a branch) and keep the change focused.
3. Follow the existing code style — TypeScript strict mode on the frontend,
   idiomatic tokio-based Rust on the backend.
4. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
   (e.g. `feat(grid): …`, `fix(mysql): …`).
5. Open a pull request against `main` and fill in the PR template.

## Reporting bugs and security issues

- Bugs and feature requests: [GitHub Issues](https://github.com/AamiRobin/dbobcat/issues)
  with the provided templates.
- Security vulnerabilities: please use
  [GitHub's private vulnerability reporting](https://github.com/AamiRobin/dbobcat/security/advisories/new)
  instead of a public issue — see [SECURITY.md](SECURITY.md).

## Releasing

Maintainers: see the release runbook in [`docs/RELEASE.md`](docs/RELEASE.md).

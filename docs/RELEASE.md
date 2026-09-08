# Release Runbook

Step-by-step for shipping a DBobcat release. The GitHub Actions workflow
(`.github/workflows/release.yml`) handles cross-platform builds and publishes
to a GitHub Release, but it needs three secrets and one tag push.

## 1. One-time: generate signing keys

The Tauri v2 updater uses [`minisign`](https://jedisct1.github.io/minisign/)
keys for signing release artifacts.

```sh
# Install minisign if missing (macOS)
brew install minisign

# Generate the keypair. minisign prompts for a passphrase — store it in a
# password manager; you'll set it as an Actions secret below.
minisign -G -p dbobcat-updater.pub -s dbobcat-updater.key -c "DBobcat updater signing key"

# minisign prints a base64-encoded secret key on the line beginning with
# "Uncomment the..." — capture the whole block as-is for TAURI_SIGNING_PRIVATE_KEY.
# The .pub file content (a single base64 line) is TAURI_UPDATER_PUBLIC_KEY.
```

## 2. Add the GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**.

| Secret name | Value |
|---|---|
| `TAURI_UPDATER_PUBLIC_KEY` | contents of `dbobcat-updater.pub` (one base64 line) |
| `TAURI_SIGNING_PRIVATE_KEY` | the base64 secret-key block from `minisign -G` output |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | passphrase you set when generating the key |

The release workflow substitutes `__TAURI_UPDATER_PUBLIC_KEY__` in
`src-tauri/tauri.updater.conf.json` with `TAURI_UPDATER_PUBLIC_KEY` at build
time. If the secret is missing, the workflow fails fast.

## 3. Bump the version in three places

Keep these in sync — there's no automation yet.

- `package.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `"version"`

The git tag (`v0.1.0`) drives the published version string.

## 4. Tag and push

```sh
git tag v0.1.0
git push origin v0.1.0
```

A `-rc.*` tag is treated as a **prerelease** by the workflow (safe dry run):

```sh
git tag v0.1.0-rc.1
git push origin v0.1.0-rc.1
```

## 5. Verify the release

1. The Actions run `Release bundles (ubuntu-22.04)`, `Release bundles
   (macos-latest)`, `Release bundles (windows-latest)` should all succeed.
2. The `publish` job creates the GitHub Release and uploads:
   - Linux: `.AppImage` + `.deb` + updater manifest fragment
   - macOS: `.app.tar.gz` (signed) + `.dmg`
   - Windows: `-setup.exe` (NSIS, signed) — no MSI, whose numeric-only
     version field cannot carry semver prerelease identifiers
   - `latest.json` (merged from per-platform fragments)
3. Sanity-check `latest.json` in the release:
   `https://github.com/AamiRobin/dbobcat/releases/latest/download/latest.json`
   should list all three platforms with non-empty `signature` and `url`.

## 6. Verify the updater from a real binary

Install a previous build, then trigger the in-app "Check for Updates…"
action. It should:

- Pull `latest.json` over HTTPS.
- Validate the signature against the embedded pubkey.
- Download and stage the next-version bundle.

If it surfaces "auto-update unavailable" the build was made without the
release overlay (`tauri build --config src-tauri/tauri.updater.conf.json`),
or `TAURI_UPDATER_PUBLIC_KEY` did not match the key the binary was signed
with.

## Local development builds

`bun run tauri dev` and an unflagged `bun run tauri build` deliberately do
**not** embed an updater pubkey — the in-app updater surfaces
"auto-update unavailable" and that's fine for local work. Only release
builds use the overlay config.
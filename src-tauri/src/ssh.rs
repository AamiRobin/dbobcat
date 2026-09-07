//! SSH tunnels via `russh`, implemented as a localhost port-forwarder.
//!
//! Every tunnel owns one SSH session and a TCP listener on an ephemeral
//! 127.0.0.1 port. Each accepted connection is bridged to the target
//! host:port through its own `direct-tcpip` channel, so many connections
//! can share a single authenticated session. Database drivers connect to
//! `127.0.0.1:local_port` and need no SSH awareness at all.
//!
//! Host keys are verified trust-on-first-use (TOFU): the first handshake
//! records the server's OpenSSH-style SHA-256 fingerprint in a
//! `known_hosts` file under the app data directory; later handshakes must
//! present a matching key or the connection fails closed (a changed key
//! may indicate a man-in-the-middle). Authentication supports password or
//! private key.
//!
//! Two format notes: hosts presenting OpenSSH certificates
//! (`*-cert-v01@openssh.com`) pin the certificate authority's public key,
//! because russh hands us the cert's key via
//! `PublicKeyOrCertificate::public_key()` — not a leaf host key. And
//! entries are always written as plain `host:port`, even for port 22;
//! OpenSSH's `[host]:port` bracket form is never emitted, so lines copied
//! from an OpenSSH `known_hosts` for non-default ports will not match and
//! such hosts re-pin as duplicates.

use std::collections::HashMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

use crate::error::{AppError, Result};

/// How long a tunnel may take to establish (TCP + banner + KEX + auth).
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);

/// Upper bound on one `direct-tcpip` open so a stalled session cannot pin
/// the shared handle (and thereby every other local connection) forever.
const CHANNEL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

/// File name of the TOFU host-key store inside the app data directory.
const KNOWN_HOSTS_FILE: &str = "known_hosts";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "method")]
pub enum SshAuth {
    Password { password: String },
    Key { key_path: String, passphrase: Option<String> },
}

/// Everything needed to establish one tunnel. Mirrors `SshConfig` in
/// `src/types/ipc.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
}

/// Result of opening a tunnel; `local_port` is where drivers dial in.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub tunnel_id: u32,
    pub local_port: u16,
}

struct TunnelHandle {
    local_port: u16,
    session: Arc<SessionSlot>,
    listener_task: JoinHandle<()>,
}

#[derive(Default)]
pub struct SshTunnelManager {
    inner: Arc<TunnelInner>,
}

/// Shared state behind [`SshTunnelManager`]; the manager is cheaply
/// cloneable so the connection actor can keep a handle for silent
/// reconnects (Phase 9-B) without lifetime ties to the command caller.
#[derive(Default)]
struct TunnelInner {
    tunnels: Mutex<HashMap<u32, TunnelHandle>>,
    next_tunnel_id: AtomicU32,
}

impl Clone for SshTunnelManager {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl SshTunnelManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Establish an SSH session and start listening for local connections.
    pub async fn open(&self, config: SshTunnelConfig, target_host: &str, target_port: u16) -> Result<TunnelInfo> {
        tokio::time::timeout(OPEN_TIMEOUT, self.open_inner(config, target_host, target_port))
            .await
            .map_err(|_| AppError::Ssh("SSH connection timed out".into()))?
    }

    async fn open_inner(
        &self,
        config: SshTunnelConfig,
        target_host: &str,
        target_port: u16,
    ) -> Result<TunnelInfo> {
        let ssh_addr = format!("{}:{}", config.host, config.port);
        let client_config = Arc::new(client::Config {
            // Keep NAT/router state alive on idle database sessions.
            keepalive_interval: Some(Duration::from_secs(30)),
            keepalive_max: 3,
            nodelay: true,
            ..client::Config::default()
        });

        let mut session =
            client::connect(client_config, ssh_addr.as_str(), TunnelClient::new(config.host.clone(), config.port))
                .await
                .map_err(|e| AppError::Ssh(format!("cannot reach SSH server {ssh_addr}: {e}")))?;

        authenticate(&mut session, &config).await?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();

        let slot = Arc::new(SessionSlot::default());
        *slot.handle.lock().await = Some(session);
        let target = (target_host.to_string(), target_port);
        let session_for_task = Arc::clone(&slot);

        let listener_task = tokio::spawn(async move {
            accept_loop(listener, session_for_task, target).await;
        });

        let mut tunnels = self.inner.tunnels.lock().await;
        let tunnel_id = self
            .inner
            .next_tunnel_id
            .fetch_add(1, Ordering::Relaxed);
        tunnels.insert(
            tunnel_id,
            TunnelHandle {
                local_port,
                session: slot,
                listener_task,
            },
        );

        Ok(TunnelInfo {
            tunnel_id,
            local_port,
        })
    }

    /// Tear down a tunnel: stop accepting, abort in-flight channels by
    /// disconnecting the SSH session.
    pub async fn close(&self, tunnel_id: u32) {
        let handle = self.inner.tunnels.lock().await.remove(&tunnel_id);
        if let Some(handle) = handle {
            handle.listener_task.abort();
            handle.session.closed.store(true, Ordering::Relaxed);
            // Wake takers parked on the slot so they observe `closed`.
            handle.session.restored.notify_waiters();
            if let Some(session) = handle.session.handle.lock().await.take() {
                let _ = session
                    .disconnect(Disconnect::ByApplication, "", "en")
                    .await;
            }
        }
    }
}

/// Shared per-tunnel SSH-session slot.
///
/// Connection tasks briefly *take* the handle out of [`Self::handle`] so
/// the network round-trip of `channel_open_direct_tcpip` does not run
/// under the lock; [`Self::restored`] hands the slot back to waiters and
/// [`Self::closed`] coordinates teardown (see the put-back logic in
/// [`accept_loop`] for why disconnecting happens exactly once).
struct SessionSlot {
    handle: Mutex<Option<Handle<TunnelClient>>>,
    restored: Notify,
    closed: AtomicBool,
}

impl Default for SessionSlot {
    fn default() -> Self {
        Self {
            handle: Mutex::new(None),
            restored: Notify::new(),
            closed: AtomicBool::new(false),
        }
    }
}

/// Take the session handle out for a channel-open, parking on `restored`
/// while another connection is using it. Returns `None` once the tunnel
/// is closing.
async fn take_session(slot: &SessionSlot) -> Option<Handle<TunnelClient>> {
    loop {
        {
            let mut guard = slot.handle.lock().await;
            if let Some(handle) = guard.take() {
                return Some(handle);
            }
        }
        if slot.closed.load(Ordering::Relaxed) {
            return None;
        }
        let notified = slot.restored.notified();
        tokio::pin!(notified);
        // Arm the notification, then re-check: a restore that happens
        // between the check above and `notified.await` would otherwise
        // be missed (notify has no memory).
        {
            let mut guard = slot.handle.lock().await;
            if let Some(handle) = guard.take() {
                return Some(handle);
            }
        }
        notified.await;
    }
}

/// Accept loop: each incoming TCP connection gets its own direct-tcpip
/// channel piped bidirectionally into the accepted socket.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<SessionSlot>,
    (target_host, target_port): (String, u16),
) {
    loop {
        let accepted = listener.accept().await;
        let (mut tcp_stream, peer) = match accepted {
            Ok(pair) => pair,
            Err(err) => {
                // Transient conditions (signals, would-block, reset bursts)
                // must not kill the tunnel permanently: log and keep going.
                // Anything else means the listener itself is gone; stop.
                let transient = matches!(
                    err.kind(),
                    ErrorKind::ConnectionAborted
                        | ErrorKind::ConnectionReset
                        | ErrorKind::Interrupted
                        | ErrorKind::WouldBlock
                );
                if transient && !session.closed.load(Ordering::Relaxed) {
                    continue;
                }
                break;
            }
        };
        let _ = tcp_stream.set_nodelay(true);

        let session = Arc::clone(&session);
        let target_host = target_host.clone();
        tokio::spawn(async move {
            let handle = match take_session(&session).await {
                Some(handle) => handle,
                None => return, // tunnel closing; dropping `tcp_stream` ends it
            };

            // Network round-trip happens OUTSIDE the slot lock so other
            // local connections proceed concurrently.
            let opened =
                tokio::time::timeout(
                    CHANNEL_OPEN_TIMEOUT,
                    handle.channel_open_direct_tcpip(
                        target_host.as_str(),
                        u32::from(target_port),
                        peer.ip().to_string(),
                        u32::from(peer.port()),
                    ),
                )
                .await;

            // Always put the handle back, then close the gap with `close()`:
            // if teardown observed the empty slot and skipped disconnecting,
            // we are the ones who must disconnect — otherwise `close()`
            // found the handle and did it. Either way exactly once.
            {
                let mut guard = session.handle.lock().await;
                *guard = Some(handle);
            }
            session.restored.notify_one();
            if session.closed.load(Ordering::Relaxed) {
                if let Some(handle) = session.handle.lock().await.take() {
                    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
                }
            }

            if let Ok(Ok(channel)) = opened {
                let mut channel_stream = channel.into_stream();
                let _ = copy_bidirectional(&mut tcp_stream, &mut channel_stream).await;
            }
            // Otherwise the channel open failed or timed out; dropping
            // `tcp_stream` ends the client connection.
        });
    }
}

/// One parsed line of the `known_hosts` file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct KnownHostEntry {
    host_port: String,
    key_type: String,
    fingerprint: String,
}

impl KnownHostEntry {
    fn to_line(&self) -> String {
        format!("{} {} {}", self.host_port, self.key_type, self.fingerprint)
    }

    /// Lenient parse: comments, blank lines, and malformed entries are
    /// skipped so a hand-edited file cannot wedge tunnel establishment.
    fn parse(line: &str) -> Option<Self> {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let mut parts = line.split_whitespace();
        Some(Self {
            host_port: parts.next()?.to_string(),
            key_type: parts.next()?.to_string(),
            fingerprint: parts.next()?.to_string(),
        })
    }
}

fn read_entries(path: &Path) -> Result<Vec<KnownHostEntry>> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text.lines().filter_map(KnownHostEntry::parse).collect()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(AppError::Config(format!(
            "cannot read {}: {e}",
            path.display()
        ))),
    }
}

/// Replace `path` contents atomically (temp file + rename), mirroring
/// [`crate::credentials::write_atomic`].
fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::Config(format!("cannot create data directory: {e}")))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)
        .map_err(|e| AppError::Config(format!("cannot write known_hosts file: {e}")))?;
    fs::rename(&tmp, path)
        .map_err(|e| AppError::Config(format!("cannot finalize known_hosts file: {e}")))?;
    Ok(())
}

/// TOFU host-key store backed by a `known_hosts` file.
///
/// Format: one `host:port keytype base64-fingerprint` per line, where the
/// fingerprint is the OpenSSH-style `SHA256:<unpadded-base64>` digest over
/// the raw public key bytes.
struct KnownHostsStore {
    path: PathBuf,
}

/// Process-global lock held across every known_hosts read-modify-write
/// cycle. Stores are constructed fresh per handshake, so a per-instance
/// mutex could not stop two concurrent first-connects from both reading an
/// empty file and writing; this serializes all of them. Poison recovery:
/// a panic mid-write leaves the last atomic rename intact, so recovering
/// by taking the poisoned lock cannot corrupt the file.
static KNOWN_HOSTS_LOCK: std::sync::LazyLock<std::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(()));

impl KnownHostsStore {
    fn default_path() -> Result<PathBuf> {
        // Mirrors Tauri's `app_data_dir` layout via the `dirs` crate, the
        // same convention as the credentials store.
        dirs::data_dir()
            .map(|d| d.join("app.dbobcat.desktop").join(KNOWN_HOSTS_FILE))
            .ok_or_else(|| AppError::Config("could not resolve app data directory".into()))
    }

    #[cfg(test)]
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Trust-on-first-use check for `host:port` presenting a key of
    /// `key_type` with `fingerprint`.
    ///
    /// Known and matching, or first contact (recorded atomically) → `Ok`;
    /// a different key than recorded → `Err` (fail closed).
    fn verify_or_record(&self, host: &str, port: u16, key_type: &str, fingerprint: &str) -> Result<()> {
        let host_port = format!("{host}:{port}");
        // Hold the process-global lock across the whole read-modify-write:
        // stores are built per handshake, so only this lock prevents two
        // concurrent connects from interleaving a stale read over another's
        // write.
        let _guard = KNOWN_HOSTS_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let entries = read_entries(&self.path)?;
        if let Some(recorded) = entries.iter().find(|e| e.host_port == host_port) {
            return if recorded.key_type == key_type && recorded.fingerprint == fingerprint {
                Ok(())
            } else {
                Err(AppError::Ssh(format!(
                    "HOST KEY MISMATCH for {host_port}: the server now presents \
                     {key_type} {fingerprint}, but '{fp}' is recorded in {}. \
                     This may indicate a man-in-the-middle attack; if the server key \
                     legitimately changed, remove the '{host_port}' line from that file.",
                    self.path.display(),
                    fp = recorded.fingerprint,
                )))
            };
        }

        let mut lines: Vec<String> = entries.iter().map(KnownHostEntry::to_line).collect();
        lines.push(
            KnownHostEntry {
                host_port,
                key_type: key_type.to_string(),
                fingerprint: fingerprint.to_string(),
            }
            .to_line(),
        );
        let mut out = lines.join("\n");
        out.push('\n');
        write_atomic(&self.path, &out)
    }
}

/// Verify the presented server key against the default `known_hosts`
/// store (trust-on-first-use, fail closed on mismatch).
fn verify_server_host_key(key: &russh::keys::PublicKey, host: &str, port: u16) -> Result<()> {
    let key_type = key.algorithm().to_string();
    let fingerprint = key
        .fingerprint(russh::keys::ssh_key::HashAlg::Sha256)
        .to_string();
    let store = KnownHostsStore {
        path: KnownHostsStore::default_path()?,
    };
    store.verify_or_record(host, port, &key_type, &fingerprint)
}

/// Client policy: TOFU host-key verification against the app-level
/// `known_hosts` file; unknown hosts are pinned on first contact,
/// mismatches abort the handshake.
struct TunnelClient {
    host: String,
    port: u16,
}

impl TunnelClient {
    fn new(host: String, port: u16) -> Self {
        Self { host, port }
    }
}

impl client::Handler for TunnelClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        verify_server_host_key(&server_public_key.public_key(), &self.host, self.port)
            .map(|()| true)
            .map_err(|e| {
                // Carry the actionable message (including HOST KEY MISMATCH)
                // through the handler error channel so callers see it.
                russh::Error::IO(std::io::Error::other(e.to_string()))
            })
    }
}

async fn authenticate(session: &mut Handle<TunnelClient>, config: &SshTunnelConfig) -> Result<()> {
    let result = match &config.auth {
        SshAuth::Password { password } => session
            .authenticate_password(config.user.as_str(), password.as_str())
            .await
            .map_err(|e| AppError::Ssh(format!("SSH auth error: {e}")))?,
        SshAuth::Key { key_path, passphrase } => {
            let key = load_secret_key(key_path, passphrase.as_deref())
                .map_err(|e| AppError::Ssh(format!("cannot load private key '{key_path}': {e}")))?;
            session
                .authenticate_publickey(
                    config.user.as_str(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|e| AppError::Ssh(format!("SSH auth error: {e}")))?
        }
    };

    match result {
        AuthResult::Success => Ok(()),
        AuthResult::Failure { .. } => Err(AppError::Ssh(format!(
            "SSH authentication failed for user '{}'",
            config.user
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir per test invocation so parallel tests don't clash.
    fn temp_store(tag: &str) -> KnownHostsStore {
        let dir = std::env::temp_dir().join(format!(
            "dbobcat-known-hosts-{}-{tag}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        KnownHostsStore::new(dir.join("known_hosts"))
    }

    const ED25519: &str = "ssh-ed25519";
    const FP_A: &str = "SHA256:ldyiXa1JQakitNU5tErauu8DvWQ1dZ7aXu+rm7KQuog";
    const FP_B: &str = "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0";

    #[test]
    fn parses_lines_and_skips_noise() {
        let text = "\
# a comment

example.com:22 ssh-ed25519 SHA256:abc
malformed-line
db.internal:2222 rsa-sha2-512 SHA256:def
";
        let entries: Vec<KnownHostEntry> = text.lines().filter_map(KnownHostEntry::parse).collect();
        assert_eq!(
            entries,
            vec![
                KnownHostEntry {
                    host_port: "example.com:22".into(),
                    key_type: "ssh-ed25519".into(),
                    fingerprint: "SHA256:abc".into(),
                },
                KnownHostEntry {
                    host_port: "db.internal:2222".into(),
                    key_type: "rsa-sha2-512".into(),
                    fingerprint: "SHA256:def".into(),
                },
            ]
        );
    }

    #[test]
    fn first_use_records_and_persists() {
        let store = temp_store("first-use");
        store
            .verify_or_record("srv.example.com", 22, ED25519, FP_A)
            .unwrap();

        let raw = fs::read_to_string(&store.path).unwrap();
        assert_eq!(raw, format!("srv.example.com:22 {ED25519} {FP_A}\n"));

        // Same key again passes without changing the file.
        store
            .verify_or_record("srv.example.com", 22, ED25519, FP_A)
            .unwrap();
        assert_eq!(
            fs::read_to_string(&store.path).unwrap(),
            format!("srv.example.com:22 {ED25519} {FP_A}\n")
        );
    }

    #[test]
    fn mismatch_fails_closed_with_clear_message() {
        let store = temp_store("mismatch");
        store
            .verify_or_record("srv.example.com", 22, ED25519, FP_A)
            .unwrap();

        let err = store
            .verify_or_record("srv.example.com", 22, ED25519, FP_B)
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("HOST KEY MISMATCH"), "got: {msg}");
        assert!(msg.contains(FP_A) && msg.contains(FP_B), "got: {msg}");

        // The recorded entry survives a rejected connection.
        assert_eq!(
            fs::read_to_string(&store.path).unwrap(),
            format!("srv.example.com:22 {ED25519} {FP_A}\n")
        );
    }

    #[test]
    fn key_type_change_counts_as_mismatch() {
        let store = temp_store("key-type-change");
        store
            .verify_or_record("srv.example.com", 22, ED25519, FP_A)
            .unwrap();
        let err = store
            .verify_or_record("srv.example.com", 22, "rsa-sha2-512", FP_A)
            .unwrap_err();
        assert!(err.to_string().contains("HOST KEY MISMATCH"));
    }

    #[test]
    fn hosts_and_ports_are_isolated() {
        let store = temp_store("isolation");
        store.verify_or_record("a.example.com", 22, ED25519, FP_A).unwrap();
        store.verify_or_record("b.example.com", 22, ED25519, FP_B).unwrap();
        store
            .verify_or_record("a.example.com", 2222, ED25519, FP_B)
            .unwrap();

        // Each host:port still validates against its own entry.
        store.verify_or_record("a.example.com", 22, ED25519, FP_A).unwrap();
        store.verify_or_record("b.example.com", 22, ED25519, FP_B).unwrap();
        store
            .verify_or_record("a.example.com", 2222, ED25519, FP_B)
            .unwrap();

        let raw = fs::read_to_string(&store.path).unwrap();
        assert_eq!(raw.lines().count(), 3);
    }

    #[test]
    fn existing_file_entries_are_honored() {
        let store = temp_store("existing-file");
        fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        fs::write(
            &store.path,
            "# manual edit\nother.host:22 ssh-dsa SHA256:zzz\n\n",
        )
        .unwrap();

        // Unrelated entry does not block a new host...
        store.verify_or_record("new.host", 22, ED25519, FP_A).unwrap();
        // ...and the pre-existing entry is preserved and enforced.
        store
            .verify_or_record("other.host", 22, "ssh-dsa", "SHA256:zzz")
            .unwrap();
        assert!(
            store
                .verify_or_record("other.host", 22, "ssh-dsa", FP_A)
                .is_err()
        );

        let raw = fs::read_to_string(&store.path).unwrap();
        assert!(raw.contains("other.host:22 ssh-dsa SHA256:zzz"));
        assert!(raw.contains("new.host:22"));
    }

    #[test]
    fn missing_parent_dirs_are_created() {
        let store = temp_store("nested-dir");
        let nested = store.path.parent().unwrap().join("deeper");
        let store = KnownHostsStore::new(nested.join("known_hosts"));
        store.verify_or_record("h", 2200, ED25519, FP_A).unwrap();
        assert!(store.path.exists());
    }
}

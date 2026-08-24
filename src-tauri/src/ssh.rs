//! SSH tunnels via `russh`, implemented as a localhost port-forwarder.
//!
//! Every tunnel owns one SSH session and a TCP listener on an ephemeral
//! 127.0.0.1 port. Each accepted connection is bridged to the target
//! host:port through its own `direct-tcpip` channel, so many connections
//! can share a single authenticated session. Database drivers connect to
//! `127.0.0.1:local_port` and need no SSH awareness at all.
//!
//! Host key verification accepts any server key for now (TOFU/known-hosts
//! support is planned); authentication supports password or private key.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::Disconnect;
use serde::{Deserialize, Serialize};
use tokio::io::copy_bidirectional;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::{AppError, Result};

/// How long a tunnel may take to establish (TCP + banner + KEX + auth).
const OPEN_TIMEOUT: Duration = Duration::from_secs(20);

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
    session: Arc<Mutex<Option<Handle<TunnelClient>>>>,
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
            client::connect(client_config, ssh_addr.as_str(), TunnelClient)
                .await
                .map_err(|e| AppError::Ssh(format!("cannot reach SSH server {ssh_addr}: {e}")))?;

        authenticate(&mut session, &config).await?;

        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let local_port = listener.local_addr()?.port();

        let session: Arc<Mutex<Option<Handle<TunnelClient>>>> =
            Arc::new(Mutex::new(Some(session)));
        let target = (target_host.to_string(), target_port);
        let session_for_task = Arc::clone(&session);

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
                session,
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
            if let Some(session) = handle.session.lock().await.take() {
                let _ = session
                    .disconnect(Disconnect::ByApplication, "", "en")
                    .await;
            }
        }
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

/// Accept loop: each incoming TCP connection gets its own direct-tcpip
/// channel piped bidirectionally into the accepted socket.
async fn accept_loop(
    listener: TcpListener,
    session: Arc<Mutex<Option<Handle<TunnelClient>>>>,
    (target_host, target_port): (String, u16),
) {
    loop {
        let accepted = listener.accept().await;
        let (mut tcp_stream, peer) = match accepted {
            Ok(pair) => pair,
            Err(_) => break,
        };
        let _ = tcp_stream.set_nodelay(true);

        let session = Arc::clone(&session);
        let target_host = target_host.clone();
        tokio::spawn(async move {
            // Hold the session lock only while opening the channel so
            // concurrent connections can proceed independently.
            let channel = {
                let mut guard = session.lock().await;
                match guard.as_mut() {
                    Some(handle) => handle
                        .channel_open_direct_tcpip(
                            target_host.as_str(),
                            u32::from(target_port),
                            peer.ip().to_string(),
                            u32::from(peer.port()),
                        )
                        .await
                        .ok(),
                    None => None,
                }
            };

            if let Some(channel) = channel {
                let mut channel_stream = channel.into_stream();
                let _ = copy_bidirectional(&mut tcp_stream, &mut channel_stream).await;
            }
            // Otherwise the SSH session is gone; dropping `tcp_stream` ends it.
        });
    }
}

/// Client policy: trust any host key (P1 placeholder until known_hosts).
struct TunnelClient;

impl client::Handler for TunnelClient {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        // TODO(P2+): TOFU / known_hosts file instead of blanket acceptance.
        Ok(true)
    }
}

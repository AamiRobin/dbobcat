//! Encrypted local credential store.
//!
//! Passwords live in a single binary file (`credentials.bin`) inside the app
//! data directory. Layout (v1):
//!
//! ```text
//! magic       8 bytes   b"HCRDv1\0\0"
//! device_key 32 bytes   random device key (see security note below)
//! salt       16 bytes   argon2 salt
//! nonce      12 bytes   AES-256-GCM nonce
//! payload    ...        AES-256-GCM ciphertext || tag of a JSON map
//!                       { session_id -> password }
//! ```
//!
//! # Security note
//!
//! The key is derived with argon2id from either a user-supplied master
//! password or — when none is configured — the raw `device_key` stored next
//! to the ciphertext in the same file. Device-key mode is therefore only
//! **obfuscation-level** security: it defeats casual grepping of the disk,
//! not a determined attacker with file access. The file format deliberately
//! supports swapping in a real master password later without migration:
//! the KDF input is just bytes (`master` when present, else `device_key`),
//! so enabling master-password mode only changes which bytes are fed into
//! the KDF.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rng;
use rand::Rng;
use serde_json::Value;

use crate::error::{AppError, Result};

/// File name inside the app data directory.
pub const CREDENTIALS_FILE: &str = "credentials.bin";

const MAGIC: &[u8; 8] = b"HCRDv1\0\0";
const DEVICE_KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// Directory used for the credentials file when no explicit path is given.
/// Mirrors Tauri's `app_data_dir` layout via the `dirs` crate.
pub fn default_store_dir() -> Result<PathBuf> {
    dirs::data_dir()
        .map(|d| d.join("app.murmeli.desktop"))
        .ok_or_else(|| AppError::Config("could not resolve app data directory".into()))
}

fn default_store_path() -> Result<PathBuf> {
    Ok(default_store_dir()?.join(CREDENTIALS_FILE))
}

type EntryMap = HashMap<String, String>;

/// Credential store handle. All state lives on disk; an internal mutex
/// serializes the read-decrypt-mutate-write cycle so concurrent Tauri
/// commands cannot interleave and silently drop each other's updates.
pub struct CredentialStore {
    path: PathBuf,
    /// Guards one full update cycle; contents are irrelevant.
    write_lock: Mutex<()>,
}

impl CredentialStore {
    pub fn load(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        if let Some(parent) = path.parent() {
            create_private_dir(parent)
                .map_err(|e| AppError::Config(format!("cannot create data directory: {e}")))?;
        }
        Ok(Self {
            path,
            write_lock: Mutex::new(()),
        })
    }

    /// Open the store at the default platform location.
    pub fn load_default() -> Result<Self> {
        Self::load(default_store_path()?)
    }

    /// Store `password` for `session_id`, replacing any previous value.
    pub fn save_password(
        &self,
        session_id: &str,
        password: &str,
        master: Option<&str>,
    ) -> Result<()> {
        self.update(session_id, master, |entries| {
            entries.insert(session_id.to_string(), password.to_string());
        })
    }

    /// Remove the stored password for `session_id` (no-op when absent).
    pub fn delete_password(&self, session_id: &str, master: Option<&str>) -> Result<()> {
        self.update(session_id, master, |entries| {
            entries.remove(session_id);
        })
    }

    /// Look up the password for `session_id`.
    ///
    /// Returns `Ok(None)` when nothing is stored for that id and
    /// [`AppError::Config`] when decryption fails (wrong/corrupt key).
    pub fn get_password(&self, session_id: &str, master: Option<&str>) -> Result<Option<String>> {
        let entries = self.decrypt_entries(master)?;
        Ok(entries.get(session_id).cloned())
    }

    /// Read → modify → re-encrypt cycle shared by save/delete.
    ///
    /// Note: every call must use the same master the store was last written
    /// with; mixing modes fails decryption by design.
    fn update(
        &self,
        _session_id: &str,
        master: Option<&str>,
        mutate: impl FnOnce(&mut EntryMap),
    ) -> Result<()> {
        // Serialize the whole read-decrypt-mutate-write cycle: two concurrent
        // commands would otherwise both read the same base blob and the
        // second write would silently discard the first update.
        let _guard = self
            .write_lock
            .lock()
            // Poison recovery is safe: nothing inside the critical section
            // can leave shared state inconsistent (all state is re-derived).
            .unwrap_or_else(|e| e.into_inner());
        let existing = self.read_raw()?;
        let mut entries = match &existing {
            Some(blob) => decrypt_blob(blob, master)?,
            None => EntryMap::new(),
        };
        mutate(&mut entries);

        // Preserve device key + salt from the previous file when present so
        // the KDF input stays stable; rotate only the nonce.
        let (device_key, salt) = match &existing {
            Some(blob) => (blob.device_key.clone(), blob.salt.clone()),
            None => (random_bytes(DEVICE_KEY_LEN), random_bytes(SALT_LEN)),
        };
        let nonce = random_bytes(NONCE_LEN);
        let payload = encrypt_entries(&entries, kdf_input(master, &device_key).as_slice(), &salt, &nonce)?;

        write_atomic(
            &self.path,
            &StoredBlob {
                device_key,
                salt,
                nonce,
                payload,
            }
            .encode(),
        )
    }

    fn read_raw(&self) -> Result<Option<StoredBlob>> {
        match std::fs::read(&self.path) {
            Ok(raw) => Ok(Some(decode_blob(&raw)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::Config(format!(
                "cannot read credentials file: {e}"
            ))),
        }
    }

    /// Decrypt the whole map with the effective KDF input.
    fn decrypt_entries(&self, master: Option<&str>) -> Result<EntryMap> {
        match self.read_raw()? {
            Some(blob) => decrypt_blob(&blob, master),
            None => Ok(EntryMap::new()),
        }
    }
}

/// Decrypt a stored blob into the entry map.
fn decrypt_blob(blob: &StoredBlob, master: Option<&str>) -> Result<EntryMap> {
    let key = derive_key(kdf_input(master, blob.device_key.as_slice()).as_slice(), &blob.salt);
    let cipher = Aes256Gcm::new(&key_array(&key));
    let nonce: [u8; NONCE_LEN] = blob
        .nonce
        .as_slice()
        .try_into()
        .map_err(|_| AppError::Config("bad nonce length".into()))?;
    let plaintext = cipher
        .decrypt(&nonce.into(), blob.payload.as_ref())
        .map_err(|_| AppError::Config("credential store decryption failed".into()))?;
    serde_json::from_slice::<Value>(&plaintext)
        .ok()
        .and_then(|v| serde_json::from_value::<EntryMap>(v).ok())
        .ok_or_else(|| AppError::Config("credential store payload is malformed".into()))
}

/// 32-byte argon2 output as an AES-256 key.
fn key_array(key: &[u8]) -> Key<Aes256Gcm> {
    Key::<Aes256Gcm>::try_from(key).expect("argon2 always yields 32 bytes")
}

/// Entry id under which a session's SSH login password is kept.
pub fn ssh_entry_id(session_id: &str) -> String {
    format!("{session_id}#ssh")
}

struct StoredBlob {
    device_key: Vec<u8>,
    salt: Vec<u8>,
    nonce: Vec<u8>,
    payload: Vec<u8>,
}

impl StoredBlob {
    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MAGIC.len() + DEVICE_KEY_LEN + self.salt.len() + self.nonce.len() + self.payload.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&self.device_key);
        out.extend_from_slice(&self.salt);
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.payload);
        out
    }
}

fn decode_blob(raw: &[u8]) -> Result<StoredBlob> {
    let header = MAGIC.len() + DEVICE_KEY_LEN + SALT_LEN + NONCE_LEN;
    if raw.len() <= header || &raw[..MAGIC.len()] != MAGIC {
        return Err(AppError::Config(
            "credentials file has an unexpected format".into(),
        ));
    }
    let mut cursor = MAGIC.len();
    let device_key = raw[cursor..cursor + DEVICE_KEY_LEN].to_vec();
    cursor += DEVICE_KEY_LEN;
    let salt = raw[cursor..cursor + SALT_LEN].to_vec();
    cursor += SALT_LEN;
    let nonce = raw[cursor..cursor + NONCE_LEN].to_vec();
    cursor += NONCE_LEN;
    let payload = raw[cursor..].to_vec();
    Ok(StoredBlob {
        device_key,
        salt,
        nonce,
        payload,
    })
}

/// Bytes fed into the KDF: master password when supplied, else the device key.
fn kdf_input<'a>(master: Option<&'a str>, device_key: &'a [u8]) -> Vec<u8> {
    match master {
        Some(m) => m.as_bytes().to_vec(),
        None => device_key.to_vec(),
    }
}

/// Derive a 32-byte AES key with argon2id using conservative defaults.
fn derive_key(input: &[u8], salt: &[u8]) -> Vec<u8> {
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default());
    let mut key = vec![0u8; 32];
    argon2
        .hash_password_into(input, salt, &mut key)
        .expect("argon2 hashing with valid params cannot fail");
    key
}

/// Encrypt the serialized entry map with AES-256-GCM under an argon2id key.
fn encrypt_entries(
    entries: &EntryMap,
    kdf_input: &[u8],
    salt: &[u8],
    nonce: &[u8],
) -> Result<Vec<u8>> {
    let key = derive_key(kdf_input, salt);
    let cipher = Aes256Gcm::new(&key_array(&key));
    let plaintext = serde_json::to_vec(entries)
        .map_err(|e| AppError::Config(format!("cannot serialize credentials: {e}")))?;
    let nonce_arr: [u8; NONCE_LEN] =
        nonce.try_into().map_err(|_| AppError::Config("bad nonce length".into()))?;
    cipher
        .encrypt(&nonce_arr.into(), plaintext.as_ref())
        .map_err(|_| AppError::Config("credential encryption failed".into()))
}

fn random_bytes(len: usize) -> Vec<u8> {
    let mut buf = vec![0u8; len];
    rng().fill_bytes(&mut buf);
    buf
}

/// Create `dir` (recursively) with owner-only permissions on unix; a no-op
/// permission-wise on Windows where ACLs are inherited instead.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir)?;
        // 0o700 = rwx------ ; also tightened retroactively for dirs that
        // already existed with looser umask-derived modes.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        std::fs::create_dir_all(dir)
    }
}

/// Best-effort chmod of a credentials file to owner-only (0600 on unix).
fn set_private_file_perms(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ =
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        create_private_dir(parent)
            .map_err(|e| AppError::Config(format!("cannot create data directory: {e}")))?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)
        .map_err(|e| AppError::Config(format!("cannot write credentials file: {e}")))?;
    // Restrict before the rename so the final path never exposes wider
    // permissions, even briefly.
    set_private_file_perms(&tmp);
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::Config(format!("cannot finalize credentials file: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp file per test invocation so parallel tests don't clash.
    fn temp_store(tag: &str) -> CredentialStore {
        let dir = std::env::temp_dir().join(format!(
            "murmeli-cred-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // First argon2 derivation creates the file; fine to do once here.
        CredentialStore::load(dir.join(CREDENTIALS_FILE)).unwrap()
    }

    #[test]
    fn save_get_delete_roundtrip() {
        let store = temp_store("roundtrip");

        assert_eq!(store.get_password("s1", None).unwrap(), None);

        store.save_password("s1", "hunter2", None).unwrap();
        store.save_password("s2", "p@ss w0rd\"`'\\", None).unwrap();
        assert_eq!(store.get_password("s1", None).unwrap().as_deref(), Some("hunter2"));
        assert_eq!(store.get_password("s2", None).unwrap().as_deref(), Some("p@ss w0rd\"`'\\"));

        // Overwrite replaces the previous value.
        store.save_password("s1", "updated", None).unwrap();
        assert_eq!(store.get_password("s1", None).unwrap().as_deref(), Some("updated"));

        store.delete_password("s1", None).unwrap();
        assert_eq!(store.get_password("s1", None).unwrap(), None);
        assert_eq!(store.get_password("s2", None).unwrap().as_deref(), Some("p@ss w0rd\"`'\\"));

        // Deleting an absent id is a no-op.
        store.delete_password("nope", None).unwrap();
    }

    #[test]
    fn state_survives_reload() {
        let tag = "reload";
        let dir = std::env::temp_dir().join(format!(
            "murmeli-cred-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CREDENTIALS_FILE);

        {
            let store = CredentialStore::load(&path).unwrap();
            store.save_password("sess-a", "secret-a", None).unwrap();
        }
        {
            // A fresh instance reads the persisted device key + ciphertext.
            let store = CredentialStore::load(&path).unwrap();
            assert_eq!(store.get_password("sess-a", None).unwrap().as_deref(), Some("secret-a"));
        }
    }

    #[test]
    fn wrong_master_fails_decryption() {
        let store = temp_store("master");
        store.save_password("s", "pw", None).unwrap();

        // Device-key mode works...
        assert_eq!(store.get_password("s", None).unwrap().as_deref(), Some("pw"));
        // ...but a different KDF input cannot decrypt the payload.
        let err = store.get_password("s", Some("wrong-master")).unwrap_err();
        assert!(matches!(err, AppError::Config(_)));
    }

    #[test]
    fn master_password_mode_roundtrip() {
        // A store written under a master password stays readable with it and
        // unreadable without — same file format, different KDF input.
        let tag = "mastermode";
        let dir = std::env::temp_dir().join(format!(
            "murmeli-cred-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = CredentialStore::load(dir.join(CREDENTIALS_FILE)).unwrap();
        store.save_password("m", "mpw", Some("correct horse")).unwrap();
        assert_eq!(
            store.get_password("m", Some("correct horse")).unwrap().as_deref(),
            Some("mpw")
        );
        assert!(store.get_password("m", None).is_err());
    }

    #[test]
    fn ssh_entry_id_is_namespaced() {
        assert_eq!(ssh_entry_id("abc"), "abc#ssh");
    }

    #[test]
    fn rejects_garbage_files() {
        let tag = "garbage";
        let dir = std::env::temp_dir().join(format!(
            "murmeli-cred-{}-{tag}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CREDENTIALS_FILE);
        std::fs::write(&path, b"definitely not our format").unwrap();

        let store = CredentialStore::load(&path).unwrap(); // exists → opened as-is
        assert!(store.get_password("x", None).is_err());
    }
}

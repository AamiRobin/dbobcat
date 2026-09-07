//! BLOB file transfer commands — HeidiSQL-style "Save to file…" and
//! "Load from file…" for binary cell values.
//!
//! Bytes cross IPC as base64 (compact and JSON-safe); the frontend holds the
//! payload either way, so no database round-trip is needed. Decoding errors
//! surface as `AppError::Config` ("invalid base64: …").

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use tokio::task::spawn_blocking;

use crate::error::{AppError, Result};

/// Write a base64-encoded payload to `path`; returns the byte count written.
#[tauri::command]
pub async fn blob_write_file(path: String, data_b64: String) -> Result<u64> {
    let bytes = decode(&data_b64)?;
    spawn_blocking(move || write_impl(&path, &bytes))
        .await
        .map_err(|e| AppError::Db(format!("write task failed: {e}")))?
}

/// Read `path` and return the bytes base64-encoded.
#[tauri::command]
pub async fn blob_read_file(path: String) -> Result<String> {
    let bytes = spawn_blocking(move || read_impl(&path))
        .await
        .map_err(|e| AppError::Db(format!("read task failed: {e}")))??;
    Ok(B64.encode(bytes))
}

fn decode(data_b64: &str) -> Result<Vec<u8>> {
    // Tolerate line breaks/indentation (pasted or pretty-printed payloads).
    let cleaned: String = data_b64.split_whitespace().collect();
    B64.decode(cleaned.as_bytes())
        .map_err(|e| AppError::Config(format!("invalid base64: {e}")))
}

fn write_impl(path: &str, bytes: &[u8]) -> Result<u64> {
    std::fs::write(path, bytes)?;
    Ok(bytes.len() as u64)
}

fn read_impl(path: &str) -> Result<Vec<u8>> {
    Ok(std::fs::read(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_round_trips_standard_base64() {
        let bytes = decode("aGVsbG8gd29ybGQ=").unwrap(); // "hello world"
        assert_eq!(bytes, b"hello world");
    }

    #[test]
    fn decode_accepts_whitespace_and_newlines() {
        let bytes = decode("aGVs\nbG8=").unwrap();
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn decode_rejects_garbage() {
        let err = decode("!!!not-base64!!!").unwrap_err();
        assert!(err.to_string().contains("invalid base64"));
    }

    #[test]
    fn write_and_read_round_trip() {
        let dir = std::env::temp_dir().join(format!("murmeli-blob-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("blob.bin");
        let path_str = path.to_string_lossy().to_string();

        let written = write_impl(&path_str, &[0, 1, 2, 255, 128]).unwrap();
        assert_eq!(written, 5);

        let read = read_impl(&path_str).unwrap();
        assert_eq!(read, vec![0, 1, 2, 255, 128]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_missing_file_is_io_error() {
        let err = read_impl("/nonexistent/murmeli/blob.bin").unwrap_err();
        assert!(err.to_string().contains("I/O error"));
    }
}

//! Unified application error type.
//!
//! Everything that crosses the IPC boundary is reported as the
//! `Display` string of an `AppError`, so frontend messages stay readable.

use serde::Serialize;
use thiserror::Error;

/// Convenience alias used across the backend.
pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Tauri error: {0}")]
    Tauri(#[from] tauri::Error),

    /// Driver/query failures (MySQL, Postgres, ... — Phase 1+).
    #[error("Database error: {0}")]
    Db(String),

    /// Malformed or missing configuration / settings.
    #[error("Configuration error: {0}")]
    Config(String),

    /// SSH tunnel establishment or transport failures.
    #[error("SSH error: {0}")]
    Ssh(String),

    /// A user-requested cancellation (AI streams, future long jobs). The
    /// frontend matches on the "cancelled: " prefix to stay quiet instead
    /// of toasting an error.
    #[error("cancelled: {0}")]
    Cancelled(String),

    /// Feature that exists in the UI but has no implementation yet.
    #[error("Unsupported: {0}")]
    Unsupported(String),

    /// A target file already exists and `overwrite` was not requested.
    /// The frontend matches on the "file exists: " prefix to raise a
    /// confirm dialog and retry with overwrite enabled.
    #[error("file exists: {0}")]
    Exists(String),
}

impl From<tauri_plugin_store::Error> for AppError {
    fn from(err: tauri_plugin_store::Error) -> Self {
        AppError::Config(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::Config(err.to_string())
    }
}

impl From<mysql_async::Error> for AppError {
    fn from(err: mysql_async::Error) -> Self {
        AppError::Db(err.to_string())
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Db(format!("SQLite error: {err}"))
    }
}

impl From<tokio_postgres::Error> for AppError {
    fn from(err: tokio_postgres::Error) -> Self {
        AppError::Db(format!("PostgreSQL error: {err}"))
    }
}

impl From<csv::Error> for AppError {
    fn from(err: csv::Error) -> Self {
        AppError::Db(format!("CSV error: {err}"))
    }
}

// Serialized into the IPC rejection payload; Tauri requires `Serialize`.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_to_message_string() {
        let err = AppError::Unsupported("nope".into());
        let json = serde_json::to_string(&err).unwrap();
        assert_eq!(json, r#""Unsupported: nope""#);
    }
}

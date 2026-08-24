//! Connection-loss classification and silent-reconnect policy (Phase 9-B).
//!
//! Pure, unit-tested helpers only — the actual reconnect machinery lives in
//! [`crate::connections::manager`] (it needs the driver, tunnels and event
//! handle). Keeping classification here makes it testable against
//! synthesized driver error strings without opening any connection.
//!
//! Classification is deliberately conservative: a false "lost" verdict costs
//! one needless reconnect attempt on a healthy session, but a missed one
//! leaves the user stranded, so transport-flavoured phrases from all three
//! drivers are matched. Statement-level failures ("Lock wait timeout",
//! "syntax error", "duplicate entry") never classify as lost.

/// Silent reconnect schedule after the first classified failure: attempts
/// run immediately, then after each delay. Exhausting the schedule marks the
/// connection `lost` until the next user action triggers one more attempt.
pub const RECONNECT_BACKOFF_SECS: &[u64] = &[1, 5, 15];

/// Total reconnect attempts per episode: immediate + one per backoff step.
pub const RECONNECT_ATTEMPTS: u32 = 1 + RECONNECT_BACKOFF_SECS.len() as u32;

/// Substrings (lower-cased) that indicate the transport died. Ordered by
/// driver family in the comments; matching is a plain case-insensitive
/// substring scan over the error text.
const LOST_MARKERS: &[&str] = &[
    // MySQL client / server (2002/2003/2006/2013 families):
    "server has gone away",
    "lost connection",
    "can't connect",
    "connection refused",
    "connection reset",
    "connection aborted",
    "connection closed unexpectedly",
    // mysql_async transport wrappers:
    "io error",
    "driver error",
    // tokio-postgres transport:
    "error communicating with the server",
    "unexpected eof",
    "unexpected response",
    // Generic OS/socket phrases across drivers:
    "broken pipe",
    "reset by peer",
    "timed out",
    "end of file",
    "eof while",
    // Our own driver state after an explicit close:
    "connection is closed",
];

/// True when the given error text looks like a dead transport rather than a
/// statement-level failure. `message` is the human-readable `AppError`
/// display string that crossed (or would cross) IPC.
pub fn is_connection_lost(message: &str) -> bool {
    let lowered = message.to_ascii_lowercase();
    LOST_MARKERS.iter().any(|marker| lowered.contains(marker))
}

/// Effective keep-alive interval for a session (Phase 9-B).
///
/// - SQLite is a local file: no pings, ever (`None`).
/// - Unset follows Heidi's 20-second default.
/// - `0` explicitly disables keep-alive.
/// - Values above one day clamp to one day.
///
/// Returns the interval in seconds.
pub fn effective_keep_alive_sec(engine: crate::connections::DbType, keep_alive_sec: Option<u64>) -> Option<u64> {
    match engine {
        crate::connections::DbType::Sqlite => None,
        _ => match keep_alive_sec {
            Some(0) => None,
            Some(secs) => Some(secs.min(MAX_KEEP_ALIVE_SEC)),
            None => Some(DEFAULT_KEEP_ALIVE_SEC),
        },
    }
}

/// Heidi's default ping interval when the session does not specify one.
pub const DEFAULT_KEEP_ALIVE_SEC: u64 = 20;

/// Upper bound for the configured interval (one day).
pub const MAX_KEEP_ALIVE_SEC: u64 = 86_400;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_mysql_transport_failures() {
        assert!(is_connection_lost(
            "Database error: MySQL server has gone away"
        ));
        assert!(is_connection_lost(
            "Database error: Lost connection to MySQL server during query"
        ));
        assert!(is_connection_lost(
            "Database error: Can't connect to MySQL server on '127.0.0.1:3306' (61)"
        ));
        assert!(is_connection_lost(
            "IO Error: Connection reset by peer (os error 54)"
        ));
        assert!(is_connection_lost("IO Error: Broken pipe (os error 32)"));
        assert!(is_connection_lost("Driver error: initialization failed"));
    }

    #[test]
    fn classifies_postgres_transport_failures() {
        assert!(is_connection_lost(
            "PostgreSQL error: error communicating with the server: Connection refused (os error 61)"
        ));
        assert!(is_connection_lost(
            "PostgreSQL error: unexpected response from the server"
        ));
        assert!(is_connection_lost(
            "PostgreSQL error: error communicating with the server: Operation timed out"
        ));
    }

    #[test]
    fn classifies_generic_socket_phrases() {
        assert!(is_connection_lost("Connection refused (os error 111)"));
        assert!(is_connection_lost("read timed out"));
        assert!(is_connection_lost("connection is closed"));
    }

    #[test]
    fn statement_level_failures_are_not_connection_loss() {
        assert!(!is_connection_lost(
            "Lock wait timeout exceeded; try restarting transaction"
        ));
        assert!(!is_connection_lost(
            "Duplicate entry '1' for key 'PRIMARY'"
        ));
        assert!(!is_connection_lost(
            "You have an error in your SQL syntax near 'FORM'"
        ));
        assert!(!is_connection_lost("relation \"users\" does not exist"));
        assert!(!is_connection_lost("no such table: users"));
        assert!(!is_connection_lost("Query was interrupted"));
        assert!(!is_connection_lost(""));
    }

    #[test]
    fn keep_alive_defaults_and_bounds() {
        use crate::connections::DbType;
        assert_eq!(
            effective_keep_alive_sec(DbType::Mysql, None),
            Some(DEFAULT_KEEP_ALIVE_SEC)
        );
        assert_eq!(effective_keep_alive_sec(DbType::Sqlite, None), None);
        assert_eq!(effective_keep_alive_sec(DbType::Sqlite, Some(5)), None);
        assert_eq!(effective_keep_alive_sec(DbType::Mysql, Some(0)), None);
        assert_eq!(effective_keep_alive_sec(DbType::Postgres, Some(45)), Some(45));
        assert_eq!(
            effective_keep_alive_sec(DbType::Mysql, Some(u64::MAX)),
            Some(MAX_KEEP_ALIVE_SEC)
        );
    }

    #[test]
    fn backoff_schedule_shape() {
        assert_eq!(RECONNECT_BACKOFF_SECS, &[1, 5, 15]);
        assert_eq!(RECONNECT_ATTEMPTS, 4);
    }
}

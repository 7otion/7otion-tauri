use std::fmt;
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use sqlx::sqlite::SqliteConnectOptions;

use crate::error::{Error, Result};

const DEFAULT_PRAGMAS: &[(&str, &str)] = &[
    ("journal_mode", "WAL"),
    ("foreign_keys", "ON"),
    ("synchronous", "NORMAL"),
    ("temp_store", "MEMORY"),
];

/// Pragmas that change the file, which a read-only connection cannot.
const WRITER_ONLY_PRAGMAS: &[&str] = &["journal_mode"];

const DEFAULT_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const DEFAULT_WRITER_WAIT: Duration = Duration::from_secs(10);
const DEFAULT_READERS: u32 = 4;

/// How a database is opened. Loading an open database with a different config is refused.
#[derive(Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DatabaseConfig {
    /// SQLCipher key; needs the `encryption` feature.
    pub key: Option<String>,
    /// Run in order after the defaults; one naming a default replaces it.
    pub pragmas: Vec<(String, String)>,
    /// How long a write waits for the writer connection. Defaults to 10000.
    pub writer_wait_ms: Option<u64>,
    /// Read-only connections kept for reads outside a transaction. Defaults to 4.
    pub readers: Option<u32>,
}

impl DatabaseConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn key(mut self, key: impl Into<String>) -> Self {
        self.key = Some(key.into());
        self
    }

    pub fn pragma(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.pragmas.push((name.into(), value.into()));
        self
    }

    pub fn writer_wait(mut self, wait: Duration) -> Self {
        self.writer_wait_ms = Some(wait.as_millis() as u64);
        self
    }

    pub fn readers(mut self, readers: u32) -> Self {
        self.readers = Some(readers);
        self
    }

    pub(crate) fn writer_wait_duration(&self) -> Duration {
        self.writer_wait_ms
            .map_or(DEFAULT_WRITER_WAIT, Duration::from_millis)
    }

    /// Never fewer than one.
    pub(crate) fn reader_count(&self) -> usize {
        self.readers.unwrap_or(DEFAULT_READERS).max(1) as usize
    }

    /// Whether the two open a database the same way, defaults filled in.
    pub(crate) fn opens_like(&self, other: &Self) -> bool {
        self.key == other.key
            && self.writer_wait_duration() == other.writer_wait_duration()
            && self.reader_count() == other.reader_count()
            && self.effective_pragmas() == other.effective_pragmas()
    }

    /// The defaults with the given pragmas applied over them, names compared without case.
    fn effective_pragmas(&self) -> Vec<(String, String)> {
        let mut effective: Vec<(String, String)> = Vec::new();
        let defaults = DEFAULT_PRAGMAS
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()));
        for (name, value) in defaults.chain(self.pragmas.iter().cloned()) {
            let name = name.to_ascii_lowercase();
            match effective.iter_mut().find(|(held, _)| *held == name) {
                Some(slot) => slot.1 = value,
                None => effective.push((name, value)),
            }
        }
        effective
    }

    pub(crate) fn connect_options(
        &self,
        path: &Path,
        read_only: bool,
    ) -> Result<SqliteConnectOptions> {
        let mut options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(!read_only)
            .read_only(read_only)
            .busy_timeout(DEFAULT_BUSY_TIMEOUT)
            // sqlx keeps a cached statement's columns from its first preparation; after a schema
            // change SQLite re-prepares it with other columns, and sqlx panics reading its rows.
            .statement_cache_capacity(0);

        let defaults = DEFAULT_PRAGMAS
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()));

        for (name, value) in defaults.chain(self.pragmas.iter().cloned()) {
            Self::validate_pragma(&name)?;
            let writer_only = WRITER_ONLY_PRAGMAS
                .iter()
                .any(|pragma| name.eq_ignore_ascii_case(pragma));
            if !(read_only && writer_only) {
                options = options.pragma(name, value);
            }
        }

        if let Some(key) = &self.key {
            options = Self::with_key(options, key)?;
        }

        Ok(options)
    }

    fn validate_pragma(name: &str) -> Result<()> {
        let mut chars = name.chars();
        let valid = chars
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');

        if !valid {
            return Err(Error::InvalidPragma(name.to_owned()));
        }
        if name.eq_ignore_ascii_case("key") || name.eq_ignore_ascii_case("rekey") {
            return Err(Error::KeyAsPragma(name.to_owned()));
        }
        Ok(())
    }

    #[cfg(feature = "encryption")]
    fn with_key(options: SqliteConnectOptions, key: &str) -> Result<SqliteConnectOptions> {
        // sqlx runs `key` before every other PRAGMA, as SQLCipher requires.
        Ok(options.pragma("key", format!("'{}'", key.replace('\'', "''"))))
    }

    #[cfg(not(feature = "encryption"))]
    fn with_key(_options: SqliteConnectOptions, _key: &str) -> Result<SqliteConnectOptions> {
        Err(Error::EncryptionDisabled)
    }
}

impl fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DatabaseConfig")
            .field("key", &self.key.as_ref().map(|_| "<redacted>"))
            .field("pragmas", &self.pragmas)
            .field("writer_wait_ms", &self.writer_wait_ms)
            .field("readers", &self.readers)
            .finish()
    }
}

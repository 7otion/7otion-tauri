use serde::Serialize;
use sqlx::error::ErrorKind;

/// What went wrong, as the JavaScript side is given it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    Unique,
    ForeignKey,
    NotNull,
    Check,
    Busy,
    ReadOnly,
    Value,
    Misuse,
    Unknown,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Sql(#[from] sqlx::Error),

    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error(
        "database handle {0} is not open: it was closed, its page reloaded, or its database was closed"
    )]
    UnknownHandle(u64),

    #[error("transaction {0} is not open on this handle: it ended, or it never began here")]
    UnknownTransaction(u64),

    #[error("database {0} was closed")]
    Closed(String),

    #[error(
        "the statement left a transaction open, which was rolled back: begin one with the begin command"
    )]
    LeftOpen,

    #[error(
        "database {0} is already open with a different configuration: release every handle to it, \
         and close it from Rust if the app loaded it there, then load it again with the new one"
    )]
    ConfigMismatch(String),

    #[error("the writer connection of {database} was not free within {waited_ms}ms")]
    WriterBusy { database: String, waited_ms: u64 },

    #[error("a key needs the plugin's `encryption` feature, which this build does not enable")]
    EncryptionDisabled,

    #[error("invalid PRAGMA name {0:?}")]
    InvalidPragma(String),

    #[error("PRAGMA {0} is set through the config's key, not its pragmas")]
    KeyAsPragma(String),

    #[error("{0} cannot be bound: only null, booleans, numbers, strings and {{ blob }} can")]
    Unbindable(&'static str),

    #[error("the statement has {placeholders} placeholders and was given {params} params")]
    ParamCount { placeholders: usize, params: usize },

    #[error("the integer {0} is beyond 2^53 and cannot cross as a number")]
    IntegerRange(i64),

    #[error("the whole number {0} is beyond 2^53: stored, it could not be read back")]
    WholeNumberRange(String),

    #[error("the value {0} is not finite and cannot cross as a number")]
    NotFinite(f64),

    #[error(
        "a script of several statements takes no params, and this one holds a placeholder: \
         send the statement that needs params on its own"
    )]
    ScriptPlaceholder,

    #[error("relative path {0} needs the app data directory, which is unavailable")]
    NoDataDirectory(String),

    #[error("{0} names no file")]
    NoFileName(String),

    #[error("migration {migration} failed on {database}: {source}")]
    Migration {
        database: String,
        migration: String,
        source: sqlx::Error,
    },

    #[error(
        "{database} has run migration {migration}, which this app does not declare: \
         another build of the app wrote the file"
    )]
    UnknownMigration { database: String, migration: String },

    #[error(
        "{database} has not run migration {pending}, but has run {applied}, which is declared after it"
    )]
    MigrationOrder {
        database: String,
        pending: String,
        applied: String,
    },

    #[error("after migrating {database}, rows of {table} point at no row of {parent}")]
    ForeignKeyCheck {
        database: String,
        table: String,
        parent: String,
    },

    #[error("{database} does not match its migrations: {difference}")]
    SchemaDrift {
        database: String,
        difference: String,
    },

    #[error("no migrations are registered under {0:?}")]
    UnknownMigrations(String),

    #[error(
        "{database} is open under the migrations {open:?}, and was asked for under {given:?}: \
         a file runs one set"
    )]
    MigrationsMismatch {
        database: String,
        open: Option<String>,
        given: String,
    },
}

impl Error {
    pub fn code(&self) -> Code {
        match self {
            Self::Sql(error) | Self::Migration { source: error, .. } => Self::sql_code(error),
            Self::ForeignKeyCheck { .. } => Code::ForeignKey,
            Self::WriterBusy { .. } => Code::Busy,
            Self::Unbindable(_)
            | Self::ParamCount { .. }
            | Self::IntegerRange(_)
            | Self::WholeNumberRange(_)
            | Self::NotFinite(_)
            | Self::ScriptPlaceholder => Code::Value,
            Self::UnknownHandle(_)
            | Self::UnknownTransaction(_)
            | Self::Closed(_)
            | Self::LeftOpen
            | Self::EncryptionDisabled
            | Self::ConfigMismatch(_)
            | Self::UnknownMigration { .. }
            | Self::MigrationOrder { .. }
            | Self::SchemaDrift { .. }
            | Self::UnknownMigrations(_)
            | Self::MigrationsMismatch { .. } => Code::Misuse,
            _ => Code::Unknown,
        }
    }

    fn sql_code(error: &sqlx::Error) -> Code {
        let sqlx::Error::Database(error) = error else {
            return Code::Unknown;
        };
        match error.kind() {
            ErrorKind::UniqueViolation => Code::Unique,
            ErrorKind::ForeignKeyViolation => Code::ForeignKey,
            ErrorKind::NotNullViolation => Code::NotNull,
            ErrorKind::CheckViolation => Code::Check,
            // SQLITE_CONSTRAINT_ROWID: a rowid taken, on a table without INTEGER PRIMARY KEY.
            _ if error.code().as_deref() == Some("2579") => Code::Unique,
            _ => Self::primary_code(error.code().as_deref()),
        }
    }

    /// SQLite's extended result code carries the primary one in its low byte.
    fn primary_code(extended: Option<&str>) -> Code {
        match extended
            .and_then(|code| code.parse::<i32>().ok())
            .map(|code| code & 0xff)
        {
            // SQLITE_BUSY, SQLITE_LOCKED
            Some(5 | 6) => Code::Busy,
            // SQLITE_READONLY
            Some(8) => Code::ReadOnly,
            _ => Code::Unknown,
        }
    }
}

/// What a failed command rejects with.
#[derive(Debug)]
pub struct Failure {
    pub error: Error,
    /// The statement carried a transaction, and SQLite ended it.
    pub transaction_ended: bool,
}

impl<E: Into<Error>> From<E> for Failure {
    fn from(error: E) -> Self {
        Self {
            error: error.into(),
            transaction_ended: false,
        }
    }
}

impl Serialize for Failure {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire<'a> {
            code: Code,
            message: &'a str,
            transaction_ended: bool,
        }

        Wire {
            code: self.error.code(),
            message: &self.error.to_string(),
            transaction_ended: self.transaction_ended,
        }
        .serialize(serializer)
    }
}

pub type Result<T> = std::result::Result<T, Error>;

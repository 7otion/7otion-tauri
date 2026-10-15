use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::ops::{Deref, DerefMut};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value as JsonValue;
use sqlx::sqlite::SqliteConnection;
use sqlx::{Column, ConnectOptions, Connection, Either, Executor, Row, Statement};
use tokio::sync::{Mutex, OwnedMutexGuard, Semaphore, SemaphorePermit};
use tokio::time::timeout;

use crate::config::DatabaseConfig;
use crate::databases::HandleId;
use crate::error::{Error, Failure, Result};
use crate::migrate::Migrations;
use crate::value;

/// Identifies one open transaction. Never reused within a process.
pub(crate) type TxId = u64;

static NEXT_TRANSACTION: AtomicU64 = AtomicU64::new(1);

/// One open database file: a writer connection, and read-only connections for everything else.
pub struct Database {
    id: String,
    config: DatabaseConfig,
    writer: Arc<Mutex<Writer>>,
    readers: Readers,
    transactions: Mutex<HashMap<TxId, Arc<Pinned>>>,
    /// Handles that may still begin a transaction. Changed only while `transactions` is locked,
    /// so a begin that waited for the writer sees a release or a close that came meanwhile.
    live: std::sync::Mutex<HashSet<HandleId>>,
}

/// None once the database is closed.
struct Writer {
    connection: Option<SqliteConnection>,
}

/// A transaction: the writer, held from BEGIN until COMMIT or ROLLBACK.
struct Pinned {
    handle: HandleId,
    /// Locked for each statement, so the statements of one transaction run one at a time.
    writer: Mutex<OwnedMutexGuard<Writer>>,
}

/// What `run` answers: rows as column names plus positional values,
/// so names are not repeated per row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Answer {
    pub(crate) columns: Vec<String>,
    pub(crate) rows: Vec<Vec<JsonValue>>,
    /// Always 0 for `select`.
    pub(crate) rows_affected: u64,
    /// The statement carried a `tx` and left the connection outside any transaction.
    pub(crate) transaction_ended: bool,
    /// Spent waiting for a connection: a reader from the pool, or the writer.
    pub(crate) waited_ms: f64,
    /// Spent in SQLite running the statement and reading its rows.
    pub(crate) ran_ms: f64,
    /// From the command's entry to its answer, the two above included; 0 off the command path.
    pub(crate) plugin_ms: f64,
}

impl Database {
    pub(crate) async fn open(
        id: String,
        path: &Path,
        config: DatabaseConfig,
        migrations: Option<&Migrations>,
    ) -> Result<Self> {
        // The writer first: it creates the file and puts it in WAL mode, which a reader cannot.
        let mut writer = config.connect_options(path, false)?.connect().await?;
        if let Some(migrations) = migrations {
            migrations.apply(&mut writer, &id).await?;
        }

        let mut readers = Vec::with_capacity(config.reader_count());
        for _ in 0..config.reader_count() {
            readers.push(config.connect_options(path, true)?.connect().await?);
        }

        Ok(Self {
            id,
            config,
            writer: Arc::new(Mutex::new(Writer {
                connection: Some(writer),
            })),
            readers: Readers::new(readers),
            transactions: Mutex::new(HashMap::new()),
            live: std::sync::Mutex::new(HashSet::new()),
        })
    }

    /// `handle` may begin transactions until it is released or the database closes.
    pub(crate) fn attach(&self, handle: HandleId) {
        self.live
            .lock()
            .expect("no handle is attached while panicking")
            .insert(handle);
    }

    /// The resolved path, which identifies the database to the plugin.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The writer connection, held until the guard drops; every write and transaction waits.
    pub async fn lock(&self) -> Result<WriterGuard> {
        Ok(WriterGuard(self.acquire_writer().await?))
    }

    pub(crate) fn config(&self) -> &DatabaseConfig {
        &self.config
    }

    /// Runs one statement. Inside a transaction it takes the writer that transaction holds;
    /// outside one it runs on a reader when SQLite says the statement only reads.
    pub(crate) async fn run(
        &self,
        handle: HandleId,
        sql: &str,
        params: Vec<JsonValue>,
        tx: Option<TxId>,
    ) -> std::result::Result<Answer, Failure> {
        tracing::debug!(database = %self.id, handle, tx, sql, params = params.len(), "run");

        let Some(tx) = tx else {
            if !Self::needs_writer(sql) {
                let waiting = Instant::now();
                let mut reader = self.readers.acquire(&self.id).await?;
                let waited = waiting.elapsed();
                // A reader prepares against the schema it last read; after the writer changed it,
                // sqlx would keep the old columns while SQLite answers with the new ones.
                let _ = sqlx::query("SELECT 1 FROM sqlite_master LIMIT 1")
                    .fetch_optional(&mut *reader)
                    .await;
                if Self::reads_only(&mut reader, sql).await {
                    let running = Instant::now();
                    let result = Self::run_prepared(&mut reader, sql, params).await;
                    let ran = running.elapsed();

                    // A reader is never handed back inside a transaction, which would hold its snapshot.
                    if Self::ended(&mut reader).await == Some(false) {
                        let _ = sqlx::query("ROLLBACK").execute(&mut *reader).await;
                        result?;
                        return Err(Error::LeftOpen.into());
                    }
                    return Ok(Self::timed(result?, waited, ran));
                }
            }

            let waiting = Instant::now();
            let mut writer = self.acquire_writer().await?;
            let waited = waiting.elapsed();
            let connection = writer.open(&self.id)?;
            let running = Instant::now();
            let result = Self::run_counted(connection, sql, params).await;
            let ran = running.elapsed();

            // A script may open a transaction and stop short of ending it; the writer is
            // never handed on inside one.
            if Self::ended(connection).await == Some(false) {
                let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
                result?;
                return Err(Error::LeftOpen.into());
            }
            return Ok(Self::timed(result?, waited, ran));
        };

        let pinned = self.pinned(handle, tx).await?;
        let waiting = Instant::now();
        let mut writer = pinned.writer.lock().await;
        let waited = waiting.elapsed();
        let connection = writer.open(&self.id)?;

        // Queued behind a statement that ended the transaction: run now, it would run outside it.
        if Self::ended(connection).await == Some(true) {
            drop(writer);
            self.forget(tx).await;
            return Err(Error::UnknownTransaction(tx).into());
        }

        let running = Instant::now();
        let result = Self::run_counted(connection, sql, params).await;
        let ran = running.elapsed();
        let ended = Self::ended(connection).await.unwrap_or(false);
        drop(writer);
        if ended {
            self.forget(tx).await;
        }

        match result {
            Ok(answer) => Ok(Answer {
                transaction_ended: ended,
                ..Self::timed(answer, waited, ran)
            }),
            Err(error) => Err(Failure {
                error,
                transaction_ended: ended,
            }),
        }
    }

    /// Takes the writer and keeps it until the transaction ends.
    pub(crate) async fn begin(&self, handle: HandleId) -> Result<TxId> {
        let mut writer = self.acquire_writer().await?;
        sqlx::query("BEGIN IMMEDIATE")
            .execute(&mut *writer.open(&self.id)?)
            .await?;

        let tx = NEXT_TRANSACTION.fetch_add(1, Ordering::Relaxed);

        let mut transactions = self.transactions.lock().await;
        // Released, or the database closed, while this waited: nothing could end the transaction.
        let live = self
            .live
            .lock()
            .expect("no handle is attached while panicking")
            .contains(&handle);
        if !live {
            drop(transactions);
            let _ = sqlx::query("ROLLBACK")
                .execute(&mut *writer.open(&self.id)?)
                .await;
            return Err(Error::UnknownHandle(handle));
        }

        tracing::debug!(database = %self.id, handle, tx, "begin");
        transactions.insert(
            tx,
            Arc::new(Pinned {
                handle,
                writer: Mutex::new(writer),
            }),
        );
        Ok(tx)
    }

    pub(crate) async fn commit(&self, handle: HandleId, tx: TxId) -> Result<()> {
        tracing::debug!(database = %self.id, handle, tx, "commit");
        let pinned = self.take(handle, tx).await?;
        Self::finish(&pinned, "COMMIT", &self.id).await
    }

    pub(crate) async fn rollback(&self, handle: HandleId, tx: TxId) -> Result<()> {
        tracing::debug!(database = %self.id, handle, tx, "rollback");
        let pinned = self.take(handle, tx).await?;
        Self::finish(&pinned, "ROLLBACK", &self.id).await
    }

    /// Rolls back every transaction `handle` left open; reports how many.
    pub(crate) async fn release_handle(&self, handle: HandleId) -> usize {
        let left: Vec<Arc<Pinned>> = {
            let mut transactions = self.transactions.lock().await;
            self.live
                .lock()
                .expect("no handle is attached while panicking")
                .remove(&handle);
            let ids: Vec<TxId> = transactions
                .iter()
                .filter(|(_, pinned)| pinned.handle == handle)
                .map(|(tx, _)| *tx)
                .collect();
            ids.iter()
                .filter_map(|tx| transactions.remove(tx))
                .collect()
        };

        for pinned in &left {
            if let Err(error) = Self::finish(pinned, "ROLLBACK", &self.id).await {
                tracing::error!(database = %self.id, handle, %error, "rolling back a transaction its handle left open failed");
            }
        }
        left.len()
    }

    pub(crate) async fn close(&self) -> Result<()> {
        let open: Vec<Arc<Pinned>> = {
            let mut transactions = self.transactions.lock().await;
            self.live
                .lock()
                .expect("no handle is attached while panicking")
                .clear();
            transactions.drain().map(|(_, pinned)| pinned).collect()
        };
        for pinned in open {
            if let Err(error) = Self::finish(&pinned, "ROLLBACK", &self.id).await {
                tracing::error!(database = %self.id, %error, "rolling back before closing failed");
            }
        }

        if let Some(connection) = self.writer.lock().await.connection.take() {
            connection.close().await?;
        }
        self.readers.close().await;
        Ok(())
    }

    /// Runs the statement that ends a transaction. A COMMIT that fails is followed
    /// by a ROLLBACK, so the writer is never handed on inside a transaction.
    async fn finish(pinned: &Pinned, sql: &str, id: &str) -> Result<()> {
        let mut writer = pinned.writer.lock().await;
        let connection = writer.open(id)?;

        let result = sqlx::query(sql).execute(&mut *connection).await;
        if result.is_err() && Self::ended(connection).await != Some(true) {
            let _ = sqlx::query("ROLLBACK").execute(&mut *connection).await;
        }
        result?;
        Ok(())
    }

    async fn acquire_writer(&self) -> Result<OwnedMutexGuard<Writer>> {
        let wait = self.config.writer_wait_duration();
        let writer = timeout(wait, self.writer.clone().lock_owned())
            .await
            .map_err(|_| Error::WriterBusy {
                database: self.id.clone(),
                waited_ms: wait.as_millis() as u64,
            })?;

        if writer.connection.is_none() {
            return Err(Error::Closed(self.id.clone()));
        }
        Ok(writer)
    }

    async fn pinned(&self, handle: HandleId, tx: TxId) -> Result<Arc<Pinned>> {
        match self.transactions.lock().await.get(&tx) {
            Some(pinned) if pinned.handle == handle => Ok(pinned.clone()),
            _ => Err(Error::UnknownTransaction(tx)),
        }
    }

    async fn take(&self, handle: HandleId, tx: TxId) -> Result<Arc<Pinned>> {
        let mut transactions = self.transactions.lock().await;
        match transactions.get(&tx) {
            Some(pinned) if pinned.handle == handle => Ok(transactions
                .remove(&tx)
                .expect("the transaction was found just above")),
            _ => Err(Error::UnknownTransaction(tx)),
        }
    }

    /// The writer is released once the last statement holding the transaction lets go.
    async fn forget(&self, tx: TxId) {
        self.transactions.lock().await.remove(&tx);
    }

    fn timed(answer: Answer, waited: Duration, ran: Duration) -> Answer {
        Answer {
            waited_ms: waited.as_secs_f64() * 1000.0,
            ran_ms: ran.as_secs_f64() * 1000.0,
            ..answer
        }
    }

    async fn run_prepared(
        connection: &mut SqliteConnection,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Answer> {
        let statement = (&mut *connection).prepare(sql).await?;

        let placeholders = match statement.parameters() {
            Some(Either::Left(types)) => types.len(),
            Some(Either::Right(count)) => count,
            None => 0,
        };
        if placeholders != params.len() {
            return Err(Error::ParamCount {
                placeholders,
                params: params.len(),
            });
        }

        let columns = statement
            .columns()
            .iter()
            .map(|column| column.name().to_owned())
            .collect();

        let mut query = statement.query();
        for param in params {
            query = value::bind(query, param)?;
        }

        let rows = query
            .fetch_all(&mut *connection)
            .await?
            .iter()
            .map(|row| {
                (0..row.len())
                    .map(|index| value::to_json(row.try_get_raw(index)?))
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<Vec<_>>>()?;

        Ok(Answer {
            columns,
            rows,
            rows_affected: 0,
            transaction_ended: false,
            waited_ms: 0.0,
            ran_ms: 0.0,
            plugin_ms: 0.0,
        })
    }

    /// On the writer, a statement that changes rows and returns them runs inside a savepoint: its
    /// rows become JSON only once it has run, and a row that cannot leaves nothing behind.
    async fn run_on_writer(
        connection: &mut SqliteConnection,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Answer> {
        let returns_rows = !(&mut *connection).prepare(sql).await?.columns().is_empty();
        let writes = Self::inspect(connection, sql)
            .await
            .is_some_and(|statement| !statement.readonly);
        // A PRAGMA may refuse to run inside a transaction, as `journal_mode` does.
        let pragma = Self::first_word(sql)
            .get(..6)
            .is_some_and(|word| word.eq_ignore_ascii_case("PRAGMA"));
        if !(returns_rows && writes) || pragma {
            return Self::run_prepared(connection, sql, params).await;
        }

        sqlx::query("SAVEPOINT orm_answer")
            .execute(&mut *connection)
            .await?;
        let answer = Self::run_prepared(connection, sql, params).await;
        // After a failed statement either may fail harmlessly: a statement that ended the
        // transaction took the savepoint with it.
        if answer.is_err() {
            let _ = sqlx::query("ROLLBACK TO orm_answer")
                .execute(&mut *connection)
                .await;
        }
        let released = sqlx::query("RELEASE orm_answer")
            .execute(&mut *connection)
            .await;
        // Outside a transaction the RELEASE is the commit, where a deferred constraint fails.
        match (answer, released) {
            (Ok(_), Err(error)) => Err(error.into()),
            (answer, _) => answer,
        }
    }

    /// Several statements in one string, run in order, answering no rows: each statement's
    /// rows would need its own columns. Preparing the string whole would refuse a statement
    /// that depends on an earlier one, as an INSERT into a table just created does.
    async fn run_script(connection: &mut SqliteConnection, sql: &str) -> Result<Answer> {
        // Checked in the text, before anything runs: a statement that cannot be prepared
        // ahead would otherwise bind NULL.
        if Self::holds_placeholder(sql) {
            return Err(Error::ScriptPlaceholder);
        }

        (&mut *connection).execute(sqlx::raw_sql(sql)).await?;
        Ok(Answer {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
            transaction_ended: false,
            waited_ms: 0.0,
            ran_ms: 0.0,
            plugin_ms: 0.0,
        })
    }

    /// A `?`, `?NNN`, `:name`, `@name` or `$name` outside quotes, brackets and comments.
    fn holds_placeholder(sql: &str) -> bool {
        let bytes = sql.as_bytes();
        let identifier = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte >= 0x80;
        // Past `end`, or to the end of the text when it never comes.
        let past = |from: usize, end: &str| {
            sql[from..]
                .find(end)
                .map_or(bytes.len(), |found| from + found + end.len())
        };
        let mut at = 0;

        while at < bytes.len() {
            at = match bytes[at] {
                b'\'' => past(at + 1, "'"),
                b'"' => past(at + 1, "\""),
                b'`' => past(at + 1, "`"),
                b'[' => past(at + 1, "]"),
                b'-' if bytes.get(at + 1) == Some(&b'-') => past(at + 2, "\n"),
                b'/' if bytes.get(at + 1) == Some(&b'*') => past(at + 2, "*/"),
                b'?' => return true,
                b':' | b'@' if bytes.get(at + 1).is_some_and(|next| identifier(*next)) => {
                    return true;
                }
                // Inside an identifier `$` is part of its name.
                b'$' if (at == 0 || !identifier(bytes[at - 1]))
                    && bytes.get(at + 1).is_some_and(|next| identifier(*next)) =>
                {
                    return true;
                }
                _ => at + 1,
            };
        }
        false
    }

    /// The statement, then what it changed, asked of the same connection before anything else runs on it.
    /// `changes()` still holds the last INSERT, UPDATE or DELETE's count after any other statement,
    /// so it is taken only when `total_changes()` moved.
    async fn run_counted(
        connection: &mut SqliteConnection,
        sql: &str,
        params: Vec<JsonValue>,
    ) -> Result<Answer> {
        let (before,): (i64,) = sqlx::query_as("SELECT total_changes()")
            .fetch_one(&mut *connection)
            .await?;

        // One statement answers its rows; a script of several answers none.
        let alone = Self::inspect(connection, sql)
            .await
            .is_some_and(|statement| statement.alone);
        let answer = if params.is_empty() && !alone {
            Self::run_script(connection, sql).await?
        } else {
            Self::run_on_writer(connection, sql, params).await?
        };

        let (changes, after): (i64, i64) = sqlx::query_as("SELECT changes(), total_changes()")
            .fetch_one(&mut *connection)
            .await?;
        let rows_affected = if after == before { 0 } else { changes.max(0) };

        Ok(Answer {
            rows_affected: rows_affected as u64,
            ..answer
        })
    }

    /// Whether the statement belongs on the writer whatever `sqlite3_stmt_readonly` would say.
    /// The first group of keywords the flag answers wrongly: they change connection or
    /// transaction state without writing pages. The second plainly writes and is taken at its
    /// word, so an ordinary write never waits for a reader before waiting for the writer.
    fn needs_writer(sql: &str) -> bool {
        const WRITER_FIRST_WORDS: &[&str] = &[
            "PRAGMA",
            "ATTACH",
            "DETACH",
            "BEGIN",
            "COMMIT",
            "END",
            "ROLLBACK",
            "SAVEPOINT",
            "RELEASE",
            "INSERT",
            "UPDATE",
            "DELETE",
            "REPLACE",
            "CREATE",
            "DROP",
            "ALTER",
            "VACUUM",
            "ANALYZE",
            "REINDEX",
        ];

        let word: String = Self::first_word(sql)
            .chars()
            .take_while(char::is_ascii_alphabetic)
            .collect();
        WRITER_FIRST_WORDS
            .iter()
            .any(|keyword| word.eq_ignore_ascii_case(keyword))
    }

    /// Past leading whitespace and comments, so a keyword cannot hide behind one.
    fn first_word(sql: &str) -> &str {
        let mut rest = sql.trim_start();
        loop {
            if let Some(after) = rest.strip_prefix("--") {
                rest = after
                    .find('\n')
                    .map_or("", |at| &after[at + 1..])
                    .trim_start();
            } else if let Some(after) = rest.strip_prefix("/*") {
                rest = after
                    .find("*/")
                    .map_or("", |at| &after[at + 2..])
                    .trim_start();
            } else {
                return rest;
            }
        }
    }

    /// Nothing but whitespace, comments and semicolons.
    fn only_separators(sql: &str) -> bool {
        let mut rest = Self::first_word(sql);
        while let Some(after) = rest.strip_prefix(';') {
            rest = Self::first_word(after);
        }
        rest.is_empty()
    }

    /// Whether SQLite will only read, asked of the connection the statement would run on.
    /// False when it cannot be prepared there, and false for a script: the flag describes
    /// the first statement only.
    async fn reads_only(connection: &mut SqliteConnection, sql: &str) -> bool {
        Self::inspect(connection, sql)
            .await
            .is_some_and(|statement| statement.alone && statement.readonly)
    }

    /// The first statement of `sql`, prepared on `connection` without running it; None when it
    /// cannot be prepared there.
    async fn inspect(connection: &mut SqliteConnection, sql: &str) -> Option<Inspected> {
        let text = CString::new(sql).ok()?;
        let mut handle = connection.lock_handle().await.ok()?;

        // SAFETY: the handle is locked, so the connection's worker is not using it meanwhile.
        unsafe {
            let database = handle.as_raw_handle().as_ptr();
            let mut statement = std::ptr::null_mut();
            let mut tail = std::ptr::null();
            let code = libsqlite3_sys::sqlite3_prepare_v2(
                database,
                text.as_ptr(),
                -1,
                &mut statement,
                &mut tail,
            );
            if code != libsqlite3_sys::SQLITE_OK || statement.is_null() {
                return None;
            }

            let alone = tail.is_null()
                || CStr::from_ptr(tail)
                    .to_str()
                    .is_ok_and(Self::only_separators);
            let readonly = libsqlite3_sys::sqlite3_stmt_readonly(statement) != 0;
            libsqlite3_sys::sqlite3_finalize(statement);
            Some(Inspected { alone, readonly })
        }
    }

    /// Whether the connection is outside any transaction; None when that cannot be asked.
    async fn ended(connection: &mut SqliteConnection) -> Option<bool> {
        let mut handle = connection.lock_handle().await.ok()?;
        // SAFETY: the handle is locked, so the connection's worker is not using it meanwhile.
        let autocommit =
            unsafe { libsqlite3_sys::sqlite3_get_autocommit(handle.as_raw_handle().as_ptr()) };
        Some(autocommit != 0)
    }
}

/// What SQLite says of a statement it has prepared but not run.
struct Inspected {
    /// Nothing but whitespace follows it: not a script.
    alone: bool,
    readonly: bool,
}

impl Writer {
    fn open(&mut self, id: &str) -> Result<&mut SqliteConnection> {
        self.connection
            .as_mut()
            .ok_or_else(|| Error::Closed(id.to_owned()))
    }
}

/// The read-only connections, lent to one statement at a time each.
struct Readers {
    idle: std::sync::Mutex<Vec<SqliteConnection>>,
    permits: Semaphore,
}

impl Readers {
    fn new(connections: Vec<SqliteConnection>) -> Self {
        Self {
            permits: Semaphore::new(connections.len()),
            idle: std::sync::Mutex::new(connections),
        }
    }

    async fn acquire(&self, id: &str) -> Result<Reader<'_>> {
        let permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| Error::Closed(id.to_owned()))?;
        let connection = self
            .idle
            .lock()
            .expect("no reader is returned while panicking")
            .pop()
            // A close between the permit and here has taken the connections.
            .ok_or_else(|| Error::Closed(id.to_owned()))?;

        Ok(Reader {
            readers: self,
            connection: Some(connection),
            _permit: permit,
        })
    }

    /// A reader still out is dropped when it comes back.
    async fn close(&self) {
        self.permits.close();
        let idle: Vec<SqliteConnection> = self
            .idle
            .lock()
            .expect("no reader is returned while panicking")
            .drain(..)
            .collect();
        for connection in idle {
            let _ = connection.close().await;
        }
    }
}

struct Reader<'a> {
    readers: &'a Readers,
    connection: Option<SqliteConnection>,
    _permit: SemaphorePermit<'a>,
}

impl Drop for Reader<'_> {
    fn drop(&mut self) {
        if self.readers.permits.is_closed() {
            return;
        }
        if let (Some(connection), Ok(mut idle)) = (self.connection.take(), self.readers.idle.lock())
        {
            idle.push(connection);
        }
    }
}

impl Deref for Reader<'_> {
    type Target = SqliteConnection;

    fn deref(&self) -> &SqliteConnection {
        self.connection
            .as_ref()
            .expect("a reader holds its connection until it drops")
    }
}

impl DerefMut for Reader<'_> {
    fn deref_mut(&mut self) -> &mut SqliteConnection {
        self.connection
            .as_mut()
            .expect("a reader holds its connection until it drops")
    }
}

/// Exclusive use of the writer connection; every write and transaction waits until it drops.
pub struct WriterGuard(OwnedMutexGuard<Writer>);

impl Deref for WriterGuard {
    type Target = SqliteConnection;

    fn deref(&self) -> &SqliteConnection {
        self.0
            .connection
            .as_ref()
            .expect("a guard is only made for an open connection")
    }
}

impl DerefMut for WriterGuard {
    fn deref_mut(&mut self) -> &mut SqliteConnection {
        self.0
            .connection
            .as_mut()
            .expect("a guard is only made for an open connection")
    }
}

//! What the crate promises the JavaScript side, and what it does around the edges.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value as JsonValue, json};

use crate::database::Database;
use crate::databases::HandleId;
use crate::error::Failure;
use crate::{Code, DatabaseConfig, Databases, Error};

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "tauri-plugin-7otion-sqlite-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn databases(&self) -> Databases {
        Databases::new(Some(self.0.clone()), HashMap::new())
    }
}

impl Drop for TempDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn run<F: Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

/// A handle as a webview would hold one, and the database behind it.
async fn open(databases: &Databases, config: Option<DatabaseConfig>) -> (HandleId, Arc<Database>) {
    databases
        .load_handle("a.sqlite", None, config, "main")
        .await
        .unwrap()
}

async fn exec(database: &Database, handle: HandleId, sql: &str, tx: Option<u64>) {
    database.run(handle, sql, vec![], tx).await.unwrap();
}

async fn scalar(database: &Database, handle: HandleId, sql: &str, tx: Option<u64>) -> JsonValue {
    let mut rows = database.run(handle, sql, vec![], tx).await.unwrap().rows;
    rows.remove(0).remove(0)
}

async fn attempt(database: &Database, handle: HandleId, sql: &str) -> Code {
    code(database.run(handle, sql, vec![], None).await)
}

fn code<T: std::fmt::Debug>(result: Result<T, Failure>) -> Code {
    result.unwrap_err().error.code()
}

fn wire(failure: &Failure) -> JsonValue {
    serde_json::to_value(failure).unwrap()
}

#[test]
fn case_1_and_2_a_row_written_is_read_back_and_returning_hands_rows_back() {
    let directory = TempDirectory::new("rows");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(
            &database,
            handle,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)",
            None,
        )
        .await;

        let written = database
            .run(
                handle,
                "INSERT INTO t (a) VALUES (?), (?) RETURNING id, a",
                vec![json!("x"), json!("y")],
                None,
            )
            .await
            .unwrap();

        assert_eq!(written.columns, ["id", "a"]);
        assert_eq!(
            written.rows,
            [vec![json!(1), json!("x")], vec![json!(2), json!("y")]]
        );
        assert_eq!(written.rows_affected, 2);
        assert!(!written.transaction_ended);

        let read = database
            .run(handle, "SELECT a FROM t WHERE id = ?", vec![json!(2)], None)
            .await
            .unwrap();
        assert_eq!(read.columns, ["a"]);
        assert_eq!(read.rows, [vec![json!("y")]]);
        assert_eq!(read.rows_affected, 0);
        let mut wire = serde_json::to_value(&read).unwrap();
        let timing = wire.as_object_mut().unwrap();
        assert!(timing.remove("waitedMs").unwrap().as_f64().unwrap() >= 0.0);
        assert!(timing.remove("ranMs").unwrap().as_f64().unwrap() > 0.0);
        assert_eq!(timing.remove("pluginMs").unwrap().as_f64().unwrap(), 0.0);
        assert_eq!(
            wire,
            json!({ "columns": ["a"], "rows": [["y"]], "rowsAffected": 0, "transactionEnded": false })
        );

        let empty = database
            .run(handle, "SELECT id, a FROM t WHERE id = 99", vec![], None)
            .await
            .unwrap();
        assert_eq!(empty.columns, ["id", "a"]);
        assert!(empty.rows.is_empty());
    });
}

#[test]
fn case_3_a_write_reaches_the_writer_without_being_announced_as_one() {
    let directory = TempDirectory::new("routing");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        exec(&database, handle, "INSERT INTO t VALUES (1)", None).await;

        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(1)
        );
    });
}

#[test]
fn case_3_a_statement_that_only_looks_like_a_read_still_reaches_the_writer() {
    let directory = TempDirectory::new("routing-disguised");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        // The first keyword reads; SQLite is asked, and answers for the whole statement.
        exec(
            &database,
            handle,
            "WITH c AS (SELECT 1 AS n) INSERT INTO t SELECT n FROM c",
            None,
        )
        .await;

        // A script: the flag describes its first statement only, so the tail decides.
        exec(
            &database,
            handle,
            "SELECT 1; INSERT INTO t VALUES (2)",
            None,
        )
        .await;

        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(2)
        );
    });
}

#[test]
fn case_3_a_pragma_outside_a_transaction_reaches_the_writer_though_it_writes_no_pages() {
    let directory = TempDirectory::new("routing-pragma");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;

        // `sqlite3_stmt_readonly` calls this one read-only; on a reader it would be lost.
        exec(&database, handle, "PRAGMA user_version = 7", None).await;

        let tx = database.begin(handle).await.unwrap();
        assert_eq!(
            scalar(&database, handle, "PRAGMA user_version", Some(tx)).await,
            json!(7)
        );
        database.commit(handle, tx).await.unwrap();
    });
}

#[test]
fn case_3_a_keyword_hidden_behind_a_comment_is_still_found() {
    let directory = TempDirectory::new("routing-comment");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        exec(
            &database,
            handle,
            "/* a note */ -- and another\n INSERT INTO t VALUES (1)",
            None,
        )
        .await;

        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(1)
        );
    });
}

#[test]
fn case_4_and_5_a_transaction_is_seen_through_its_id_alone_until_it_commits() {
    let directory = TempDirectory::new("isolation");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;
        let count = "SELECT count(*) FROM t";

        let tx = database.begin(handle).await.unwrap();
        exec(&database, handle, "INSERT INTO t VALUES (1)", Some(tx)).await;
        assert_eq!(scalar(&database, handle, count, Some(tx)).await, json!(1));
        assert_eq!(scalar(&database, handle, count, None).await, json!(0));
        database.commit(handle, tx).await.unwrap();

        // Asked of every reader in turn.
        for _ in 0..8 {
            assert_eq!(scalar(&database, handle, count, None).await, json!(1));
        }

        let tx = database.begin(handle).await.unwrap();
        exec(&database, handle, "INSERT INTO t VALUES (2)", Some(tx)).await;
        database.rollback(handle, tx).await.unwrap();
        assert_eq!(scalar(&database, handle, count, None).await, json!(1));
    });
}

#[test]
fn case_6_and_7_a_write_and_a_begin_wait_for_the_writer_and_give_up_as_busy() {
    let directory = TempDirectory::new("busy");
    run(async {
        let config = DatabaseConfig::new().writer_wait(Duration::from_millis(80));
        let (handle, database) = open(&directory.databases(), Some(config)).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        let tx = database.begin(handle).await.unwrap();

        let failure = database
            .run(handle, "INSERT INTO t VALUES (1)", vec![], None)
            .await
            .unwrap_err();
        assert_eq!(failure.error.code(), Code::Busy);
        assert_eq!(wire(&failure)["code"], json!("busy"));
        assert!(matches!(
            database.begin(handle).await,
            Err(Error::WriterBusy { .. })
        ));

        // Ended in time, the wait succeeds.
        let waiting = {
            let database = database.clone();
            tauri::async_runtime::spawn(async move {
                database
                    .run(handle, "INSERT INTO t VALUES (2)", vec![], None)
                    .await
                    .is_ok()
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        database.commit(handle, tx).await.unwrap();

        assert!(waiting.await.unwrap());
        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(1)
        );
    });
}

#[test]
fn case_8_a_savepoint_rolled_back_undoes_only_what_followed_it() {
    let directory = TempDirectory::new("savepoint");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        let tx = database.begin(handle).await.unwrap();
        exec(&database, handle, "INSERT INTO t VALUES (1)", Some(tx)).await;
        exec(&database, handle, "SAVEPOINT sp_1", Some(tx)).await;
        exec(&database, handle, "INSERT INTO t VALUES (2)", Some(tx)).await;
        exec(&database, handle, "ROLLBACK TO SAVEPOINT sp_1", Some(tx)).await;
        exec(&database, handle, "RELEASE SAVEPOINT sp_1", Some(tx)).await;
        database.commit(handle, tx).await.unwrap();

        assert_eq!(
            scalar(&database, handle, "SELECT group_concat(a) FROM t", None).await,
            json!("1")
        );
    });
}

#[test]
fn case_9_an_unknown_or_finished_transaction_or_another_handles_is_misuse() {
    let directory = TempDirectory::new("unknown");
    run(async {
        let databases = directory.databases();
        let (handle, database) = open(&databases, None).await;
        let (other, _) = open(&databases, None).await;

        let tx = database.begin(handle).await.unwrap();
        assert_eq!(
            code(database.run(other, "SELECT 1", vec![], Some(tx)).await),
            Code::Misuse
        );
        assert!(matches!(
            database.commit(other, tx).await,
            Err(Error::UnknownTransaction(_))
        ));
        database.commit(handle, tx).await.unwrap();

        assert_eq!(
            code(database.run(handle, "SELECT 1", vec![], Some(tx)).await),
            Code::Misuse
        );
        assert_eq!(
            code(database.run(handle, "SELECT 1", vec![], Some(9_999)).await),
            Code::Misuse
        );
        assert!(matches!(
            database.rollback(handle, tx).await,
            Err(Error::UnknownTransaction(_))
        ));
    });
}

#[test]
fn case_10_each_constraint_kind_has_its_own_code() {
    let directory = TempDirectory::new("constraints");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(
            &database,
            handle,
            "CREATE TABLE p (id INTEGER PRIMARY KEY)",
            None,
        )
        .await;
        exec(
            &database,
            handle,
            "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT NOT NULL UNIQUE, \
             n INTEGER CHECK (n >= 0), p_id INTEGER REFERENCES p(id))",
            None,
        )
        .await;
        exec(
            &database,
            handle,
            "INSERT INTO t (id, a) VALUES (1, 'x')",
            None,
        )
        .await;

        let cases = [
            ("INSERT INTO t (a) VALUES ('x')", Code::Unique),
            ("INSERT INTO t (id, a) VALUES (1, 'y')", Code::Unique),
            ("INSERT INTO t (n) VALUES (1)", Code::NotNull),
            ("INSERT INTO t (a, n) VALUES ('z', -1)", Code::Check),
            ("INSERT INTO t (a, p_id) VALUES ('w', 9)", Code::ForeignKey),
            ("INSERT INTO nope VALUES (1)", Code::Unknown),
        ];
        for (sql, expected) in cases {
            assert_eq!(attempt(&database, handle, sql).await, expected, "{sql}");
        }
    });
}

#[test]
fn case_11_a_transaction_ended_under_its_id_is_reported_and_the_writer_let_go() {
    let directory = TempDirectory::new("ended");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;
        exec(
            &database,
            handle,
            "CREATE TRIGGER bomb BEFORE INSERT ON t WHEN NEW.a = 'bomb' \
             BEGIN SELECT RAISE(ROLLBACK, 'gone'); END",
            None,
        )
        .await;

        // By raw SQL, which succeeds.
        let tx = database.begin(handle).await.unwrap();
        let committed = database
            .run(handle, "COMMIT", vec![], Some(tx))
            .await
            .unwrap();
        assert!(committed.transaction_ended);
        assert_eq!(
            code(database.run(handle, "SELECT 1", vec![], Some(tx)).await),
            Code::Misuse
        );

        // By SQLite itself, on a statement that fails.
        let tx = database.begin(handle).await.unwrap();
        exec(&database, handle, "INSERT INTO t VALUES ('lost')", Some(tx)).await;
        let failure = database
            .run(handle, "INSERT INTO t VALUES ('bomb')", vec![], Some(tx))
            .await
            .unwrap_err();
        assert!(failure.transaction_ended);
        assert_eq!(wire(&failure)["transactionEnded"], json!(true));

        // A failure that leaves the transaction open says so too.
        let tx = database.begin(handle).await.unwrap();
        let failure = database
            .run(handle, "INSERT INTO nope VALUES (1)", vec![], Some(tx))
            .await
            .unwrap_err();
        assert!(!failure.transaction_ended);
        database.rollback(handle, tx).await.unwrap();

        // The writer is free, and nothing of the ended transaction stayed.
        exec(&database, handle, "INSERT INTO t VALUES ('after')", None).await;
        assert_eq!(
            scalar(&database, handle, "SELECT group_concat(a) FROM t", None).await,
            json!("after")
        );
    });
}

#[test]
fn case_12_releasing_a_handle_rolls_back_what_it_left_open_and_only_that() {
    let directory = TempDirectory::new("release");
    run(async {
        let databases = directory.databases();
        let config = DatabaseConfig::new().writer_wait(Duration::from_millis(200));
        let (first, database) = open(&databases, Some(config)).await;
        let (second, _) = open(&databases, None).await;
        exec(&database, first, "CREATE TABLE t (a)", None).await;

        let tx = database.begin(first).await.unwrap();
        exec(&database, first, "INSERT INTO t VALUES (1)", Some(tx)).await;

        databases.release_handle(first).await.unwrap();
        databases.release_handle(first).await.unwrap();

        exec(&database, second, "INSERT INTO t VALUES (2)", None).await;
        assert_eq!(
            scalar(&database, second, "SELECT group_concat(a) FROM t", None).await,
            json!("2")
        );
        assert!(matches!(
            databases.handle(first).await,
            Err(Error::UnknownHandle(_))
        ));
    });
}

#[test]
fn a_begin_still_waiting_when_its_handle_is_released_does_not_keep_the_writer() {
    let directory = TempDirectory::new("late-begin");
    run(async {
        let databases = Arc::new(directory.databases());
        let (closing, database) = open(&databases, None).await;
        let (other, _) = open(&databases, None).await;
        exec(&database, other, "CREATE TABLE t (a)", None).await;

        let held = databases.begin(closing).await.unwrap();
        let waiting = {
            let databases = databases.clone();
            tauri::async_runtime::spawn(async move { databases.begin(closing).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;

        databases.release_handle(closing).await.unwrap();

        assert!(matches!(
            waiting.await.unwrap(),
            Err(Error::UnknownHandle(_))
        ));
        assert!(matches!(
            database.rollback(closing, held).await,
            Err(Error::UnknownTransaction(_))
        ));
        exec(&database, other, "INSERT INTO t VALUES (1)", None).await;
    });
}

#[test]
fn every_statement_of_a_script_runs() {
    let directory = TempDirectory::new("script");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;

        exec(
            &database,
            handle,
            "CREATE TABLE a (x); CREATE TABLE b (x); INSERT INTO b VALUES (1)",
            None,
        )
        .await;

        assert_eq!(
            scalar(
                &database,
                handle,
                "SELECT count(*) FROM sqlite_master WHERE name IN ('a', 'b')",
                None
            )
            .await,
            json!(2)
        );
        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM b", None).await,
            json!(1)
        );
    });
}

#[test]
fn a_script_that_leaves_its_own_transaction_open_is_rolled_back() {
    let directory = TempDirectory::new("script-left-open");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE a (x UNIQUE)", None).await;

        // The second INSERT fails, so the COMMIT is never reached.
        assert_eq!(
            attempt(
                &database,
                handle,
                "BEGIN; INSERT INTO a VALUES (1); INSERT INTO a VALUES (1); COMMIT"
            )
            .await,
            Code::Unique
        );
        assert_eq!(attempt(&database, handle, "BEGIN").await, Code::Misuse);

        let tx = database.begin(handle).await.expect("the writer is free");
        database.rollback(handle, tx).await.expect("rolled back");
        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM a", None).await,
            json!(0)
        );
    });
}

#[test]
fn a_whole_number_javascript_cannot_hold_exactly_is_refused() {
    let directory = TempDirectory::new("big");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;

        let kinds = database
            .run(
                handle,
                "SELECT typeof(?), typeof(?)",
                vec![json!(9_007_199_254_740_991_i64), json!(1.5)],
                None,
            )
            .await
            .unwrap()
            .rows
            .remove(0);
        assert_eq!(kinds, [json!("integer"), json!("real")]);

        for beyond in [
            json!(9_007_199_254_740_992_i64),
            json!(1_152_921_504_606_846_976_i64),
            json!(1e21),
        ] {
            let refused = database
                .run(handle, "SELECT typeof(?)", vec![beyond], None)
                .await
                .unwrap_err();
            assert_eq!(refused.error.code(), Code::Value);
        }
    });
}

#[test]
fn a_replaced_page_has_its_handles_released() {
    let directory = TempDirectory::new("webview");
    run(async {
        let databases = directory.databases();
        let (main, database) = databases
            .load_handle("a.sqlite", None, None, "main")
            .await
            .unwrap();
        let (other, _) = databases
            .load_handle("a.sqlite", None, None, "other")
            .await
            .unwrap();
        exec(&database, main, "CREATE TABLE t (a)", None).await;
        let tx = database.begin(main).await.unwrap();
        exec(&database, main, "INSERT INTO t VALUES (1)", Some(tx)).await;

        databases.release_webview("main").await.unwrap();

        assert!(matches!(
            databases.handle(main).await,
            Err(Error::UnknownHandle(_))
        ));
        assert_eq!(
            scalar(&database, other, "SELECT count(*) FROM t", None).await,
            json!(0)
        );
    });
}

#[test]
fn case_14_values_cross_as_the_protocol_says() {
    let directory = TempDirectory::new("values");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a, b, c, d, e, f)", None).await;

        database
            .run(
                handle,
                "INSERT INTO t VALUES (?, ?, ?, ?, ?, ?)",
                vec![
                    json!(null),
                    json!(true),
                    json!(3_000_000_000_i64),
                    json!(1.5),
                    json!("text"),
                    json!({ "blob": "AQL/" }),
                ],
                None,
            )
            .await
            .unwrap();

        let row = database
            .run(
                handle,
                "SELECT a, b, typeof(c), c, d, e, f, typeof(f) FROM t",
                vec![],
                None,
            )
            .await
            .unwrap()
            .rows
            .remove(0);
        assert_eq!(
            row,
            [
                json!(null),
                json!(1),
                json!("integer"),
                json!(3_000_000_000_i64),
                json!(1.5),
                json!("text"),
                json!({ "blob": "AQL/" }),
                json!("blob"),
            ]
        );

        let infinite = database.run(handle, "SELECT 9e999", vec![], None).await;
        assert_eq!(code(infinite), Code::Value);

        for unbindable in [
            json!([1]),
            json!({ "a": 1 }),
            json!({ "blob": 5 }),
            json!({ "blob": "%%" }),
        ] {
            let result = database
                .run(handle, "SELECT ?", vec![unbindable], None)
                .await;
            assert_eq!(code(result), Code::Value);
        }
    });
}

#[test]
fn case_15_and_16_an_integer_beyond_2_53_and_a_miscounted_param_list_are_refused() {
    let directory = TempDirectory::new("refused");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;

        assert_eq!(
            scalar(&database, handle, "SELECT 9007199254740991", None).await,
            json!(9_007_199_254_740_991_i64)
        );
        assert_eq!(
            code(
                database
                    .run(handle, "SELECT 9007199254740993", vec![], None)
                    .await
            ),
            Code::Value
        );

        let too_few = database
            .run(handle, "SELECT ?, ?", vec![json!(1)], None)
            .await;
        let too_many = database.run(handle, "SELECT 1", vec![json!(1)], None).await;
        assert_eq!(code(too_few), Code::Value);
        assert_eq!(code(too_many), Code::Value);
    });
}

#[test]
fn a_failure_serialises_as_a_code_a_message_and_whether_the_transaction_ended() {
    let failure = Failure::from(Error::UnknownTransaction(7));

    assert_eq!(
        wire(&failure),
        json!({
            "code": "misuse",
            "message": "transaction 7 is not open on this handle: it ended, or it never began here",
            "transactionEnded": false,
        })
    );
}

#[test]
fn defaults_apply_and_pragmas_override_them_on_readers_too() {
    let directory = TempDirectory::new("pragmas");
    run(async {
        let databases = directory.databases();
        let (handle, database) = open(&databases, None).await;
        assert_eq!(
            scalar(&database, handle, "PRAGMA journal_mode", None).await,
            json!("wal")
        );
        assert_eq!(
            scalar(&database, handle, "PRAGMA foreign_keys", None).await,
            json!(1)
        );
        assert_eq!(
            scalar(&database, handle, "PRAGMA temp_store", None).await,
            json!(2)
        );
        databases.close(database.id()).await.unwrap();

        let config = DatabaseConfig::new()
            .pragma("busy_timeout", "1234")
            .readers(1);
        let (handle, database) = open(&databases, Some(config)).await;
        assert_eq!(
            scalar(&database, handle, "PRAGMA busy_timeout", None).await,
            json!(1234)
        );
        let tx = database.begin(handle).await.unwrap();
        assert_eq!(
            scalar(&database, handle, "PRAGMA busy_timeout", Some(tx)).await,
            json!(1234)
        );
        database.rollback(handle, tx).await.unwrap();
    });
}

#[test]
fn malformed_pragma_names_and_key_pragmas_are_refused() {
    let directory = TempDirectory::new("bad-pragmas");
    run(async {
        let databases = directory.databases();
        let injected = DatabaseConfig::new().pragma("a; DROP TABLE t", "1");
        let key = DatabaseConfig::new().pragma("KEY", "secret");

        assert!(matches!(
            databases.load("a.sqlite", None, Some(injected)).await,
            Err(Error::InvalidPragma(_))
        ));
        assert!(matches!(
            databases.load("a.sqlite", None, Some(key)).await,
            Err(Error::KeyAsPragma(_))
        ));
    });
}

#[cfg(not(feature = "encryption"))]
#[test]
fn a_key_needs_the_encryption_feature() {
    let directory = TempDirectory::new("no-encryption");
    run(async {
        let result = directory
            .databases()
            .load("a.sqlite", None, Some(DatabaseConfig::new().key("secret")))
            .await;

        assert!(matches!(result, Err(Error::EncryptionDisabled)));
    });
}

#[test]
fn two_spellings_of_one_file_share_their_connections_and_configs_are_compared() {
    let directory = TempDirectory::new("identity");
    run(async {
        let databases = directory.databases();
        let config = DatabaseConfig::new().readers(2);

        let relative = databases
            .load("a.sqlite", None, Some(config.clone()))
            .await
            .unwrap();
        let absolute = databases
            .load(directory.0.join("a.sqlite"), None, None)
            .await
            .unwrap();
        let same = databases
            .load("a.sqlite", None, Some(config))
            .await
            .unwrap();
        let different = databases
            .load("a.sqlite", None, Some(DatabaseConfig::new().readers(3)))
            .await;

        assert!(Arc::ptr_eq(&relative, &absolute));
        assert!(Arc::ptr_eq(&relative, &same));
        assert!(matches!(different, Err(Error::ConfigMismatch(_))));
        assert_eq!(Error::ConfigMismatch(String::new()).code(), Code::Misuse);
    });
}

#[test]
fn handles_share_a_database_until_the_last_is_released_unless_rust_holds_it() {
    let directory = TempDirectory::new("handles");
    run(async {
        let databases = directory.databases();
        let (first, database) = open(&databases, None).await;
        let (second, _) = open(&databases, None).await;
        exec(&database, first, "CREATE TABLE t (a)", None).await;

        databases.release_handle(first).await.unwrap();
        exec(&database, second, "INSERT INTO t VALUES (1)", None).await;
        databases.release_handle(second).await.unwrap();

        let write = database
            .run(second, "INSERT INTO t VALUES (2)", vec![], None)
            .await;
        let read = database.run(second, "SELECT 1", vec![], None).await;
        assert!(matches!(write.unwrap_err().error, Error::Closed(_)));
        assert!(matches!(read.unwrap_err().error, Error::Closed(_)));

        let held = databases.load("a.sqlite", None, None).await.unwrap();
        let (third, _) = open(&databases, None).await;
        databases.release_handle(third).await.unwrap();
        assert_eq!(
            scalar(&held, third, "SELECT count(*) FROM t", None).await,
            json!(1)
        );

        databases.close(held.id()).await.unwrap();
        assert!(held.lock().await.is_err());
    });
}

#[test]
fn rust_shares_the_writer_with_javascript() {
    let directory = TempDirectory::new("rust");
    run(async {
        let databases = directory.databases();
        let config = DatabaseConfig::new().writer_wait(Duration::from_millis(60));
        let database = databases
            .load("a.sqlite", None, Some(config))
            .await
            .unwrap();
        let (handle, _) = open(&databases, None).await;

        let mut writer = database.lock().await.unwrap();
        sqlx::query("CREATE TABLE t (a)")
            .execute(&mut *writer)
            .await
            .unwrap();
        assert_eq!(
            attempt(&database, handle, "INSERT INTO t VALUES (1)").await,
            Code::Busy
        );
        drop(writer);

        exec(&database, handle, "INSERT INTO t VALUES (1)", None).await;
    });
}

#[test]
fn a_relative_path_needs_the_data_directory() {
    run(async {
        let databases = Databases::new(None, HashMap::new());

        assert!(matches!(
            databases.load("a.sqlite", None, None).await,
            Err(Error::NoDataDirectory(_))
        ));
    });
}

#[test]
fn releasing_the_last_handle_while_a_begin_waits_does_not_hang() {
    let directory = TempDirectory::new("release-waiting-begin");
    run(async {
        let databases = Arc::new(directory.databases());
        let (handle, database) = open(&databases, None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        let _held = databases.begin(handle).await.unwrap();
        let waiting = {
            let databases = databases.clone();
            tauri::async_runtime::spawn(async move { databases.begin(handle).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;

        let released =
            tokio::time::timeout(Duration::from_secs(5), databases.release_handle(handle)).await;
        assert!(released.is_ok(), "release hung");
        assert!(matches!(
            waiting.await.unwrap(),
            Err(Error::UnknownHandle(_))
        ));
    });
}

#[test]
fn closing_a_database_while_a_begin_waits_does_not_hang() {
    let directory = TempDirectory::new("close-waiting-begin");
    run(async {
        let databases = Arc::new(directory.databases());
        let (handle, database) = open(&databases, None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        let _held = databases.begin(handle).await.unwrap();
        let waiting = {
            let databases = databases.clone();
            tauri::async_runtime::spawn(async move { databases.begin(handle).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;

        let closed =
            tokio::time::timeout(Duration::from_secs(5), databases.close(database.id())).await;
        assert!(closed.is_ok(), "close hung");
        assert!(waiting.await.unwrap().is_err());
    });
}

#[test]
fn a_statement_that_leaves_a_transaction_open_is_rolled_back_and_refused() {
    let directory = TempDirectory::new("left-open");
    run(async {
        let databases = directory.databases();
        let (handle, database) = open(&databases, Some(DatabaseConfig::new().readers(1))).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        assert_eq!(
            code(database.run(handle, "BEGIN", vec![], None).await),
            Code::Misuse
        );
        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(0)
        );
        exec(&database, handle, "INSERT INTO t VALUES (1)", None).await;
        assert_eq!(
            scalar(&database, handle, "SELECT count(*) FROM t", None).await,
            json!(1)
        );
    });
}

#[test]
fn a_statement_that_ends_its_transaction_says_so() {
    let directory = TempDirectory::new("ends-tx");
    run(async {
        let databases = directory.databases();
        let (handle, database) = open(&databases, None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;

        let tx = databases.begin(handle).await.unwrap();
        let rows = database
            .run(handle, "COMMIT", vec![], Some(tx))
            .await
            .unwrap();

        assert!(rows.transaction_ended);
        assert_eq!(
            serde_json::to_value(&rows).unwrap()["transactionEnded"],
            json!(true)
        );
        let untouched = database
            .run(handle, "SELECT 1", vec![], None)
            .await
            .unwrap();
        assert!(!untouched.transaction_ended);
    });
}

#[test]
fn a_taken_rowid_is_unique() {
    let directory = TempDirectory::new("rowid");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;
        exec(
            &database,
            handle,
            "INSERT INTO t (rowid, a) VALUES (1, 'x')",
            None,
        )
        .await;

        assert_eq!(
            attempt(
                &database,
                handle,
                "INSERT INTO t (rowid, a) VALUES (1, 'y')"
            )
            .await,
            Code::Unique
        );
    });
}

#[test]
fn rows_affected_counts_only_what_the_statement_itself_changed() {
    let directory = TempDirectory::new("affected");
    run(async {
        let (handle, database) = open(&directory.databases(), None).await;
        exec(&database, handle, "CREATE TABLE t (a)", None).await;
        let affected = |sql: &'static str| {
            let database = database.clone();
            async move {
                database
                    .run(handle, sql, vec![], None)
                    .await
                    .unwrap()
                    .rows_affected
            }
        };

        assert_eq!(affected("INSERT INTO t VALUES (1), (2), (3)").await, 3);
        assert_eq!(affected("CREATE INDEX t_a ON t (a)").await, 0);
        assert_eq!(affected("PRAGMA optimize").await, 0);
        assert_eq!(affected("UPDATE t SET a = 9 WHERE a = 1").await, 1);
        assert_eq!(affected("UPDATE t SET a = 0 WHERE a = 404").await, 0);
    });
}

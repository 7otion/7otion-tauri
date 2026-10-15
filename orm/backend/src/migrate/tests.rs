//! Migrations as a file meets them: planned when the set is built, run when the file opens.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use sqlx::{Executor, Row};

use std::collections::HashMap;

use super::{DateStorage, Migration, Migrations, Schema};
use crate::database::Database;
use crate::{Code, Databases, Error};

struct TempDirectory(PathBuf);

impl TempDirectory {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "tauri-plugin-7otion-sqlite-migrate-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    /// A registry with `migrations` under the name `app`, as an app's plugin would be.
    fn databases(&self, migrations: Migrations) -> Databases {
        Databases::new(
            Some(self.0.clone()),
            HashMap::from([("app".to_owned(), migrations)]),
        )
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

/// Opens `app.sqlite` under `migrations`, then closes it, as an app run would.
async fn session(directory: &TempDirectory, migrations: Migrations) -> crate::Result<()> {
    let databases = directory.databases(migrations);
    let database = databases.load("app.sqlite", Some("app"), None).await?;
    databases.close(database.id()).await
}

async fn open(directory: &TempDirectory, migrations: Migrations) -> (Databases, Arc<Database>) {
    let databases = directory.databases(migrations);
    let database = databases
        .load("app.sqlite", Some("app"), None)
        .await
        .unwrap();
    (databases, database)
}

async fn exec(database: &Database, sql: &str) -> Result<(), sqlx::Error> {
    let mut writer = database.lock().await.unwrap();
    (&mut *writer).execute(sqlx::raw_sql(sql)).await.map(|_| ())
}

async fn strings(database: &Database, sql: &str) -> Vec<String> {
    let mut writer = database.lock().await.unwrap();
    sqlx::query(sql)
        .fetch_all(&mut *writer)
        .await
        .unwrap()
        .iter()
        .map(|row| row.get::<String, _>(0))
        .collect()
}

async fn applied(database: &Database) -> Vec<String> {
    strings(database, "SELECT name FROM migrations ORDER BY rowid").await
}

struct CreateUsers;

impl Migration for CreateUsers {
    const NAME: &'static str = "create_users";

    fn up(schema: &mut Schema) {
        schema.create("users", |table| {
            table.id();
            table.text("name");
            table.text("email").nullable().unique();
            table.boolean("active").default(true);
        });
    }
}

struct CreatePosts;

impl Migration for CreatePosts {
    const NAME: &'static str = "create_posts";

    fn up(schema: &mut Schema) {
        schema.create("posts", |table| {
            table.id();
            table.integer("user_id").references("users");
            table.text("title");
            table.json("meta").nullable();
            table.date("created_at", DateStorage::Unix).default_now();
        });
    }
}

struct AddBio;

impl Migration for AddBio {
    const NAME: &'static str = "add_bio";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.text("bio").nullable();
        });
    }
}

struct NameOptional;

impl Migration for NameOptional {
    const NAME: &'static str = "name_optional";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.change("name").nullable();
        });
    }
}

struct RenameEmail;

impl Migration for RenameEmail {
    const NAME: &'static str = "rename_email";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.rename("email", "address");
        });
    }
}

struct DropEmail;

impl Migration for DropEmail {
    const NAME: &'static str = "drop_email";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.drop("email");
        });
    }
}

struct RenameUsers;

impl Migration for RenameUsers {
    const NAME: &'static str = "rename_users";

    fn up(schema: &mut Schema) {
        schema.rename("users", "people");
    }
}

struct Broken;

impl Migration for Broken {
    const NAME: &'static str = "broken";

    fn up(schema: &mut Schema) {
        schema.execute("INSERT INTO nowhere VALUES (1)");
    }
}

struct DanglingPost;

impl Migration for DanglingPost {
    const NAME: &'static str = "dangling_post";

    fn up(schema: &mut Schema) {
        schema.execute("INSERT INTO posts (user_id, title) VALUES (99, 'orphan')");
    }
}

fn users() -> Migrations {
    crate::migrations![CreateUsers]
}

fn users_and_posts() -> Migrations {
    crate::migrations![CreateUsers, CreatePosts]
}

#[test]
fn pending_migrations_run_in_order_and_are_recorded_once() {
    let directory = TempDirectory::new("recorded");
    run(async {
        session(&directory, users_and_posts()).await.unwrap();
        let (_databases, database) = open(&directory, users_and_posts()).await;

        assert_eq!(applied(&database).await, ["create_users", "create_posts"]);
        assert_eq!(
            strings(&database, "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'posts') ORDER BY name").await,
            ["posts", "users"]
        );
    });
}

#[test]
fn a_file_runs_only_the_migrations_it_has_not_run() {
    let directory = TempDirectory::new("later");
    run(async {
        session(&directory, users()).await.unwrap();
        let (_databases, database) = open(&directory, users_and_posts()).await;

        assert_eq!(applied(&database).await, ["create_users", "create_posts"]);
    });
}

#[test]
fn a_file_opened_through_a_handle_is_migrated_before_its_first_statement() {
    let directory = TempDirectory::new("handle");
    run(async {
        let databases = directory.databases(users());
        let (handle, database) = databases
            .load_handle("app.sqlite", Some("app"), None, "main")
            .await
            .unwrap();

        let answer = database
            .run(handle, "SELECT count(*) FROM users", vec![], None)
            .await
            .unwrap();
        assert_eq!(answer.rows, [vec![json!(0)]]);
    });
}

#[test]
fn a_table_is_strict_and_refuses_a_value_of_another_type() {
    let directory = TempDirectory::new("strict");
    run(async {
        let (_databases, database) = open(&directory, users()).await;

        let refused = exec(
            &database,
            "INSERT INTO users (name, active) VALUES ('Ann', 'yes')",
        )
        .await;

        assert!(
            refused
                .unwrap_err()
                .to_string()
                .contains("cannot store TEXT value in INTEGER column")
        );
    });
}

#[test]
fn a_boolean_column_holds_only_0_or_1_and_a_json_column_only_json() {
    let directory = TempDirectory::new("checks");
    run(async {
        let (_databases, database) = open(&directory, users_and_posts()).await;
        exec(&database, "INSERT INTO users (name) VALUES ('Ann')")
            .await
            .unwrap();

        assert!(
            exec(&database, "UPDATE users SET active = 2")
                .await
                .is_err()
        );
        assert!(
            exec(
                &database,
                "INSERT INTO posts (user_id, title, meta) VALUES (1, 'a', '{bad')"
            )
            .await
            .is_err()
        );
        exec(
            &database,
            "INSERT INTO posts (user_id, title, meta) VALUES (1, 'a', '{\"ok\":1}')",
        )
        .await
        .unwrap();
    });
}

#[test]
fn a_date_that_defaults_to_now_stamps_the_row_in_its_storage() {
    let directory = TempDirectory::new("now");
    run(async {
        let (_databases, database) = open(&directory, users_and_posts()).await;
        exec(&database, "INSERT INTO users (name) VALUES ('Ann')")
            .await
            .unwrap();
        exec(
            &database,
            "INSERT INTO posts (user_id, title) VALUES (1, 'a')",
        )
        .await
        .unwrap();

        let stamped = strings(
            &database,
            "SELECT CAST(abs(created_at - unixepoch()) <= 5 AS TEXT) FROM posts",
        )
        .await;
        assert_eq!(stamped, ["1"]);
    });
}

#[test]
fn a_migration_that_fails_leaves_the_file_as_it_was() {
    let directory = TempDirectory::new("failing");
    run(async {
        session(&directory, users()).await.unwrap();

        let failed = session(&directory, crate::migrations![CreateUsers, AddBio, Broken]).await;

        let error = failed.unwrap_err();
        assert!(matches!(&error, Error::Migration { migration, .. } if migration == "broken"));
        assert_eq!(error.code(), Code::Unknown);
        let (_databases, database) = open(&directory, users()).await;
        assert_eq!(applied(&database).await, ["create_users"]);
        assert_eq!(
            strings(
                &database,
                "SELECT name FROM pragma_table_info('users') ORDER BY cid"
            )
            .await,
            ["id", "name", "email", "active"]
        );
    });
}

#[test]
fn a_file_that_ran_a_migration_the_app_does_not_declare_is_refused() {
    let directory = TempDirectory::new("unknown");
    run(async {
        session(&directory, users_and_posts()).await.unwrap();

        let refused = session(&directory, users()).await.unwrap_err();

        assert!(
            matches!(&refused, Error::UnknownMigration { migration, .. } if migration == "create_posts")
        );
        assert_eq!(refused.code(), Code::Misuse);
    });
}

#[test]
fn adding_a_nullable_column_alters_the_table_in_place() {
    let sql = crate::migrations![CreateUsers, AddBio].sql();

    assert!(sql.contains("ALTER TABLE \"users\" ADD COLUMN \"bio\" TEXT"));
    assert!(!sql.contains("_rebuild_"));
}

#[test]
fn making_a_column_nullable_rebuilds_the_table_and_keeps_its_rows_indexes_and_references() {
    let directory = TempDirectory::new("rebuild");
    run(async {
        let (databases, database) = open(&directory, users_and_posts()).await;
        exec(
            &database,
            "INSERT INTO users (name, email) VALUES ('Ann', 'ann@x')",
        )
        .await
        .unwrap();
        exec(
            &database,
            "INSERT INTO posts (user_id, title) VALUES (1, 'a')",
        )
        .await
        .unwrap();
        databases.close(database.id()).await.unwrap();

        let migrations = crate::migrations![CreateUsers, CreatePosts, NameOptional];
        assert!(migrations.sql().contains("_rebuild_users"));
        let (_databases, database) = open(&directory, migrations).await;

        assert_eq!(strings(&database, "SELECT name FROM users").await, ["Ann"]);
        exec(&database, "INSERT INTO users (name) VALUES (NULL)")
            .await
            .unwrap();
        assert!(
            exec(
                &database,
                "INSERT INTO users (name, email) VALUES ('Bob', 'ann@x')"
            )
            .await
            .is_err()
        );
        let refused = exec(
            &database,
            "INSERT INTO posts (user_id, title) VALUES (99, 'b')",
        )
        .await;
        assert!(refused.unwrap_err().to_string().contains("FOREIGN KEY"));
    });
}

#[test]
fn renaming_a_column_renames_the_index_that_carries_its_name() {
    let directory = TempDirectory::new("rename-column");
    run(async {
        let (_databases, database) =
            open(&directory, crate::migrations![CreateUsers, RenameEmail]).await;

        assert_eq!(
            strings(
                &database,
                "SELECT name FROM pragma_index_list('users') WHERE origin = 'c'"
            )
            .await,
            ["users_address_unique"]
        );
    });
}

#[test]
fn dropping_a_unique_column_drops_its_index_and_the_column_in_place() {
    let migrations = crate::migrations![CreateUsers, DropEmail];
    let sql = migrations.sql();
    assert!(sql.contains(
        "DROP INDEX \"users_email_unique\";\nALTER TABLE \"users\" DROP COLUMN \"email\""
    ));

    let directory = TempDirectory::new("drop-column");
    run(async {
        let (_databases, database) = open(&directory, migrations).await;
        assert_eq!(
            strings(
                &database,
                "SELECT name FROM pragma_table_info('users') ORDER BY cid"
            )
            .await,
            ["id", "name", "active"]
        );
    });
}

#[test]
fn renaming_a_table_keeps_the_foreign_keys_that_point_at_it() {
    let directory = TempDirectory::new("rename-table");
    run(async {
        let migrations = crate::migrations![CreateUsers, CreatePosts, RenameUsers];
        let (_databases, database) = open(&directory, migrations).await;

        assert_eq!(
            strings(
                &database,
                "SELECT \"table\" FROM pragma_foreign_key_list('posts')"
            )
            .await,
            ["people"]
        );
        assert!(
            exec(
                &database,
                "INSERT INTO posts (user_id, title) VALUES (99, 'a')"
            )
            .await
            .is_err()
        );
    });
}

#[test]
fn a_migration_that_leaves_a_row_pointing_nowhere_is_rolled_back() {
    let directory = TempDirectory::new("dangling");
    run(async {
        session(&directory, users_and_posts()).await.unwrap();

        let refused = session(
            &directory,
            crate::migrations![CreateUsers, CreatePosts, DanglingPost],
        )
        .await
        .unwrap_err();

        assert!(
            matches!(&refused, Error::ForeignKeyCheck { table, parent, .. } if table == "posts" && parent == "users")
        );
        let (_databases, database) = open(&directory, users_and_posts()).await;
        assert_eq!(
            strings(&database, "SELECT title FROM posts").await,
            Vec::<String>::new()
        );
        assert_eq!(applied(&database).await, ["create_users", "create_posts"]);
        assert!(
            exec(
                &database,
                "INSERT INTO posts (user_id, title) VALUES (99, 'a')"
            )
            .await
            .is_err()
        );
    });
}

#[test]
fn a_file_changed_by_hand_is_refused() {
    let directory = TempDirectory::new("drift");
    run(async {
        let (databases, database) = open(&directory, users()).await;
        exec(&database, "ALTER TABLE users ADD COLUMN nickname TEXT")
            .await
            .unwrap();
        databases.close(database.id()).await.unwrap();

        let refused = session(&directory, users()).await.unwrap_err();

        assert!(
            matches!(&refused, Error::SchemaDrift { difference, .. } if difference.contains("nickname"))
        );
    });
}

#[test]
fn a_file_opened_under_no_set_is_untouched() {
    let directory = TempDirectory::new("unnamed");
    run(async {
        let databases = directory.databases(users());
        let database = databases.load("other.sqlite", None, None).await.unwrap();

        assert_eq!(
            strings(
                &database,
                "SELECT name FROM sqlite_schema WHERE type = 'table'"
            )
            .await,
            Vec::<String>::new()
        );
    });
}

#[test]
fn a_file_opened_under_a_set_nobody_registered_is_refused() {
    let directory = TempDirectory::new("unknown-set");
    run(async {
        let databases = directory.databases(users());

        let refused = databases
            .load("app.sqlite", Some("nope"), None)
            .await
            .err()
            .unwrap();

        assert!(matches!(refused, Error::UnknownMigrations(name) if name == "nope"));
    });
}

#[test]
fn an_open_file_asked_for_under_another_set_is_refused() {
    let directory = TempDirectory::new("other-set");
    run(async {
        let databases = Databases::new(
            Some(directory.0.clone()),
            HashMap::from([
                ("app".to_owned(), users()),
                ("bare".to_owned(), Migrations::new()),
            ]),
        );
        databases
            .load("app.sqlite", Some("app"), None)
            .await
            .unwrap();

        let refused = databases
            .load("app.sqlite", Some("bare"), None)
            .await
            .err()
            .unwrap();
        let attached = databases.load("app.sqlite", None, None).await;

        assert!(matches!(refused, Error::MigrationsMismatch { .. }));
        assert!(attached.is_ok());
    });
}

#[test]
fn a_rust_release_closes_the_file_once_nothing_holds_it() {
    let directory = TempDirectory::new("release");
    run(async {
        let databases = directory.databases(users());
        let database = databases
            .load("app.sqlite", Some("app"), None)
            .await
            .unwrap();
        let (handle, _) = databases
            .load_handle("app.sqlite", None, None, "main")
            .await
            .unwrap();

        databases.release(database.id()).await.unwrap();
        assert!(database.lock().await.is_ok());

        databases.release_handle(handle).await.unwrap();
        assert!(database.lock().await.is_err());
    });
}

struct Keyless;

impl Migration for Keyless {
    const NAME: &'static str = "keyless";

    fn up(schema: &mut Schema) {
        schema.create("notes", |table| {
            table.text("body");
        });
    }
}

#[test]
#[should_panic(expected = "migration keyless: table notes has no primary key")]
fn a_table_without_a_primary_key_is_refused_when_the_set_is_built() {
    let _ = crate::migrations![Keyless];
}

struct PointsNowhere;

impl Migration for PointsNowhere {
    const NAME: &'static str = "points_nowhere";

    fn up(schema: &mut Schema) {
        schema.create("posts", |table| {
            table.id();
            table.integer("user_id").references("users");
        });
    }
}

#[test]
#[should_panic(expected = "references table users, which does not exist")]
fn a_foreign_key_to_a_missing_table_is_refused_when_the_set_is_built() {
    let _ = crate::migrations![PointsNowhere];
}

struct RequiredAge;

impl Migration for RequiredAge {
    const NAME: &'static str = "required_age";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.integer("age");
        });
    }
}

#[test]
#[should_panic(expected = "column age is required and has no default")]
fn adding_a_required_column_without_a_default_is_refused_when_the_set_is_built() {
    let _ = crate::migrations![CreateUsers, RequiredAge];
}

struct DropUsers;

impl Migration for DropUsers {
    const NAME: &'static str = "drop_users";

    fn up(schema: &mut Schema) {
        schema.drop("users");
    }
}

#[test]
#[should_panic(expected = "table users is referenced by posts.user_id")]
fn dropping_a_table_another_references_is_refused_when_the_set_is_built() {
    let _ = crate::migrations![CreateUsers, CreatePosts, DropUsers];
}

#[test]
#[should_panic(expected = "migration create_users is listed twice")]
fn a_migration_listed_twice_is_refused() {
    let _ = crate::migrations![CreateUsers, CreateUsers];
}

struct IndexNames;

impl Migration for IndexNames {
    const NAME: &'static str = "index_names";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.index(&["name", "active"]);
        });
    }
}

struct DropActive;

impl Migration for DropActive {
    const NAME: &'static str = "drop_active";

    fn up(schema: &mut Schema) {
        schema.alter("users", |table| {
            table.drop("active");
        });
    }
}

#[test]
#[should_panic(
    expected = "column active is in the index on users (name, active): drop that index first"
)]
fn dropping_a_column_a_declared_index_holds_is_refused_until_the_index_is_dropped() {
    let _ = crate::migrations![CreateUsers, IndexNames, DropActive];
}

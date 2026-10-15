use sqlx::Executor;
use sqlx::sqlite::SqliteConnection;

use crate::error::{Error, Result};

use super::table::{Index, Table};
use super::{Migrations, Planned};

const LEDGER: &str = "CREATE TABLE \"migrations\" (
    \"name\" TEXT NOT NULL,
    \"applied_at\" INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (\"name\")
) STRICT";

/// A column as `PRAGMA table_xinfo` reports it: name, type, not null, default, key position.
type Reported = (String, String, bool, Option<String>, i64);

impl Migrations {
    /// Runs what the file has not run, then checks the file holds the schema they make.
    /// On the writer connection, before any handle can reach the file.
    pub(crate) async fn apply(
        &self,
        connection: &mut SqliteConnection,
        database: &str,
    ) -> Result<()> {
        let recorded: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'migrations')",
        )
        .fetch_one(&mut *connection)
        .await?;
        let applied: Vec<String> = if recorded {
            sqlx::query_scalar("SELECT name FROM migrations ORDER BY rowid")
                .fetch_all(&mut *connection)
                .await?
        } else {
            Vec::new()
        };
        self.check_applied(&applied, database)?;

        let pending = &self.planned[applied.len()..];
        if !pending.is_empty() {
            // A rebuild drops a table others reference; the keys are checked before commit.
            let enforced: bool = sqlx::query_scalar("PRAGMA foreign_keys")
                .fetch_one(&mut *connection)
                .await?;
            if enforced {
                (&mut *connection)
                    .execute(sqlx::raw_sql("PRAGMA foreign_keys = OFF"))
                    .await?;
            }
            let ran = Self::run(connection, database, pending, recorded).await;
            if ran.is_err() {
                let _ = (&mut *connection).execute(sqlx::raw_sql("ROLLBACK")).await;
            }
            if enforced {
                (&mut *connection)
                    .execute(sqlx::raw_sql("PRAGMA foreign_keys = ON"))
                    .await?;
            }
            ran?;
        }

        self.verify(connection, database).await
    }

    fn check_applied(&self, applied: &[String], database: &str) -> Result<()> {
        for (at, name) in applied.iter().enumerate() {
            match self.planned.iter().position(|planned| planned.name == name) {
                None => {
                    return Err(Error::UnknownMigration {
                        database: database.to_owned(),
                        migration: name.clone(),
                    });
                }
                Some(position) if position != at => {
                    return Err(Error::MigrationOrder {
                        database: database.to_owned(),
                        pending: self.planned[at].name.to_owned(),
                        applied: name.clone(),
                    });
                }
                Some(_) => {}
            }
        }
        Ok(())
    }

    async fn run(
        connection: &mut SqliteConnection,
        database: &str,
        pending: &[Planned],
        recorded: bool,
    ) -> Result<()> {
        (&mut *connection)
            .execute(sqlx::raw_sql("BEGIN IMMEDIATE"))
            .await?;
        if !recorded {
            (&mut *connection).execute(sqlx::raw_sql(LEDGER)).await?;
        }

        for migration in pending {
            for statement in &migration.statements {
                (&mut *connection)
                    .execute(sqlx::raw_sql(statement))
                    .await
                    .map_err(|source| Error::Migration {
                        database: database.to_owned(),
                        migration: migration.name.to_owned(),
                        source,
                    })?;
            }
            sqlx::query("INSERT INTO migrations (name) VALUES (?)")
                .bind(migration.name)
                .execute(&mut *connection)
                .await?;
            tracing::info!(database, migration = migration.name, "migrated");
        }

        let broken: Option<(String, String)> =
            sqlx::query_as("SELECT \"table\", parent FROM pragma_foreign_key_check LIMIT 1")
                .fetch_optional(&mut *connection)
                .await?;
        if let Some((table, parent)) = broken {
            return Err(Error::ForeignKeyCheck {
                database: database.to_owned(),
                table,
                parent,
            });
        }

        (&mut *connection).execute(sqlx::raw_sql("COMMIT")).await?;
        Ok(())
    }

    /// The file's tables, columns, indexes and foreign keys, against what the migrations made.
    async fn verify(&self, connection: &mut SqliteConnection, database: &str) -> Result<()> {
        let drift = |difference: String| Error::SchemaDrift {
            database: database.to_owned(),
            difference,
        };

        let held: Vec<(String, bool)> = sqlx::query_as(
            "SELECT name, strict FROM pragma_table_list
             WHERE schema = 'main' AND type = 'table'
               AND substr(name, 1, 7) <> 'sqlite_' AND name <> 'migrations'",
        )
        .fetch_all(&mut *connection)
        .await?;
        for (name, strict) in &held {
            if !self.tables.contains_key(name) {
                return Err(drift(format!(
                    "table {name} is in the file but no migration made it"
                )));
            }
            if !strict {
                return Err(drift(format!("table {name} is not STRICT")));
            }
        }
        if let Some(missing) = self
            .tables
            .keys()
            .find(|name| !held.iter().any(|(held, _)| held == *name))
        {
            return Err(drift(format!("table {missing} is missing from the file")));
        }

        for table in self.tables.values() {
            let columns: Vec<Reported> = sqlx::query_as(
                "SELECT name, type, \"notnull\", dflt_value, pk FROM pragma_table_xinfo(?)
                 WHERE hidden = 0 ORDER BY cid",
            )
            .bind(&table.name)
            .fetch_all(&mut *connection)
            .await?;
            let expected = Self::columns(table);
            if columns != expected {
                return Err(drift(Self::column_difference(table, &columns, &expected)));
            }

            let listed: Vec<(String, bool)> = sqlx::query_as(
                "SELECT name, \"unique\" FROM pragma_index_list(?) WHERE origin = 'c'",
            )
            .bind(&table.name)
            .fetch_all(&mut *connection)
            .await?;
            let mut indexes = Vec::with_capacity(listed.len());
            for (name, unique) in listed {
                let columns: Vec<String> =
                    sqlx::query_scalar("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
                        .bind(&name)
                        .fetch_all(&mut *connection)
                        .await?;
                indexes.push(Index {
                    name,
                    columns,
                    unique,
                });
            }
            let mut wanted = table.indexes();
            indexes.sort();
            wanted.sort();
            if indexes != wanted {
                return Err(drift(format!(
                    "table {}: the file has indexes {}, the migrations {}",
                    table.name,
                    Self::index_names(&indexes),
                    Self::index_names(&wanted)
                )));
            }

            let mut keys: Vec<(String, String, String)> = sqlx::query_as(
                "SELECT \"from\", \"table\", \"to\" FROM pragma_foreign_key_list(?)",
            )
            .bind(&table.name)
            .fetch_all(&mut *connection)
            .await?;
            let mut wanted: Vec<(String, String, String)> = table
                .columns
                .iter()
                .filter_map(|column| {
                    let key = table.referenced_key(column, &self.tables)?;
                    Some((
                        column.name.clone(),
                        column.references.clone()?,
                        key.to_owned(),
                    ))
                })
                .collect();
            keys.sort();
            wanted.sort();
            if keys != wanted {
                return Err(drift(format!(
                    "table {}: the file's foreign keys are {keys:?}, the migrations' {wanted:?}",
                    table.name
                )));
            }
        }
        Ok(())
    }

    fn columns(table: &Table) -> Vec<Reported> {
        table
            .columns
            .iter()
            .map(|column| {
                let key = table
                    .primary
                    .iter()
                    .position(|key| key == &column.name)
                    .map_or(0, |position| position as i64 + 1);
                (
                    column.name.clone(),
                    column.kind.sql().to_owned(),
                    !column.nullable,
                    column.reported_default(),
                    key,
                )
            })
            .collect()
    }

    fn column_difference(table: &Table, held: &[Reported], wanted: &[Reported]) -> String {
        let describe = |column: Option<&Reported>| match column {
            None => "nothing".to_owned(),
            Some((name, kind, required, default, key)) => {
                let mut text = format!("{name} {kind}");
                if *required {
                    text.push_str(" NOT NULL");
                }
                if let Some(default) = default {
                    text.push_str(&format!(" DEFAULT {default}"));
                }
                if *key > 0 {
                    text.push_str(" PRIMARY KEY");
                }
                text
            }
        };
        let at = (0..held.len().max(wanted.len()))
            .find(|at| held.get(*at) != wanted.get(*at))
            .unwrap_or(0);
        format!(
            "table {}, column {}: the file has {}, the migrations {}",
            table.name,
            at + 1,
            describe(held.get(at)),
            describe(wanted.get(at))
        )
    }

    fn index_names(indexes: &[Index]) -> String {
        let names: Vec<&str> = indexes.iter().map(|index| index.name.as_str()).collect();
        format!("[{}]", names.join(", "))
    }
}

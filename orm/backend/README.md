# tauri-plugin-7otion-sqlite

The Rust side of `@7otion-tauri/orm`: a Tauri plugin that owns the SQLite
connections and runs migrations. The ORM calls its commands directly, so there
is no separate JavaScript package.

## Install

Not on crates.io yet. Depend on it by path, from the same checkout as the ORM:

```toml
tauri-plugin-7otion-sqlite = { path = "../../7otion-tauri/orm/backend" }
```

```rust
tauri::Builder::default().plugin(tauri_plugin_7otion_sqlite::init())
```

Add `"7otion-sqlite:default"` to your capability's permissions. Requires Rust
1.88+ and Tauri 2.11+.

## Connections

Each database file gets one writer connection and a pool of read-only
connections, in WAL mode.

- Reads outside a transaction go to a reader and never wait for writes.
- Writes outside a transaction take the writer for one statement.
- A transaction holds the writer from `begin` to `commit` or `rollback`.
- Waiting for the writer times out after 10 seconds with the code `busy`.

Relative paths resolve against the app data directory. Loading the same file
twice shares its connections. Handles left open by a reloaded page are closed
and their transactions rolled back.

Default pragmas: `journal_mode = WAL`, `foreign_keys = ON`,
`synchronous = NORMAL`, `temp_store = MEMORY`, `busy_timeout = 5000`.

## Values and errors

Values are `null`, booleans, numbers, strings and `{ "blob": "<base64>" }`.
Integers beyond 2^53 are rejected rather than rounded.

Failed commands reject with `{ code, message, transactionEnded }`.

## Using it from Rust

```rust
use tauri_plugin_7otion_sqlite::SqliteExt;

let db = app.sqlite().load("app.sqlite", None, None).await?;
let mut writer = db.lock().await?;
sqlx::query("DELETE FROM sessions").execute(&mut *writer).await?;
```

`lock()` takes the writer, so JavaScript writes wait until the guard is dropped.
Keep it short.

If Rust opens a file that JavaScript also uses, pass the same migration set name
on both sides. Call `app.sqlite().release(db.id())` when Rust is done with it.

## Migrations

A migration is a struct describing the change. The plugin generates the SQL,
runs pending migrations when a file opens, and never runs one twice.

```rust
use tauri_plugin_7otion_sqlite::migrate::{DateStorage, Migration, Schema};

pub struct CreateCharacters;

impl Migration for CreateCharacters {
    const NAME: &'static str = "create_characters";

    fn up(schema: &mut Schema) {
        schema.create("characters", |table| {
            table.id();
            table.text("name").unique();
            table.boolean("is_player").default(false);
            table.json("settings").nullable();
            table.integer("group_id").nullable().references("groups");
            table.date("created_at", DateStorage::Unix).default_now();
        });
    }
}
```

Register a set under a name:

```rust
use tauri_plugin_7otion_sqlite::migrations;

tauri::Builder::default().plugin(
    tauri_plugin_7otion_sqlite::Builder::new()
        .migrations("project", migrations![CreateGroups, CreateCharacters])
        .build(),
)
```

and open a file with it: `new Database({ path, migrations: 'project' })` from
JavaScript, or `app.sqlite().load(path, Some("project"), None)` from Rust.

Tables are `STRICT`, every table needs a primary key, and columns are required
unless `nullable()`.

### Altering tables

```rust
schema.alter("characters", |table| {
    table.text("speaker_color").nullable();
    table.rename("name", "display_name");
    table.change("group_id").required();
    table.drop("legacy_flag");
    table.index(&["display_name", "is_player"]);
});
schema.rename("groups", "factions");
schema.drop("scratch");
schema.execute("UPDATE characters SET speaker_color = '#ffffff' WHERE is_player = 1");
```

Changes SQLite can't do in place are done by rebuilding the table.

To add a required column to a table that already has rows, add it as nullable,
fill it with `execute`, then `change` it to `required()`.

### On open

- Pending migrations run in a single transaction; if one fails, nothing is
  applied.
- A file with migrations the app doesn't know about, or that was changed by
  hand, is refused.
- Invalid migrations (e.g. a foreign key to a missing table) panic at startup.

## Encryption

```toml
tauri-plugin-7otion-sqlite = { path = "…", features = ["encryption"] }
```

Builds SQLCipher instead of SQLite. On Windows, set `OPENSSL_DIR`, or use the
`encryption-vendored-openssl` feature (needs Perl and NASM).

```rust
use tauri_plugin_7otion_sqlite::{DatabaseConfig, SqliteExt};

app.sqlite().load("app.sqlite", None, Some(DatabaseConfig::new().key(key))).await?;
```

## License

MIT

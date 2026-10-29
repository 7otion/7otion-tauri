# Setup

## The database

```ts
import { Database, Model } from '@7otion-tauri/orm';

const db = new Database({ path: 'app.sqlite' });
Model.connect(db);
```

A `Database` is one SQLite file. Nothing opens until the first statement.

| option          | default | meaning                                                          |
| --------------- | ------- | ---------------------------------------------------------------- |
| `path`          | —       | Relative to the app's data directory unless absolute.            |
| `migrations`    | none    | The migration set to run on open, as registered in Rust.         |
| `namespace`     | `path`  | Prefix for the keys of values its stores keep in `localStorage`. |
| `pragmas`       | none    | Extra pragmas, run after the defaults.                           |
| `writerWaitMs`  | `10000` | How long a write waits for the writer before failing as `busy`.  |
| `readers`       | `4`     | Number of read-only connections.                                 |
| `key`           | none    | SQLCipher key. Needs the crate's `encryption` feature.           |
| `loggerEnabled` | `false` | Log every statement to the console.                              |

Files open in WAL mode with foreign keys on. Prefer passing an encryption key
from Rust; one passed from JavaScript crosses IPC, and a warning is logged.

All models share the one connected database.

### Switching files

For an app with a file per project, connect a new `Database`:

```ts
const next = new Database({ path: projectPath });
Model.connect(next);
await previous.close();
```

`Model.disconnect()` closes the current database and leaves the models with
none.

Models and queries created before the switch throw if you use them afterwards.
Their keys belong to the old file, so writing them to the new one would hit
unrelated rows. Read what you need again after switching. `Model.unsaved()`
lists unsaved edits, if you want to warn before switching.

## Connections

Each file has one writer connection and a pool of readers.

- Reads outside a transaction use a reader and never wait for writes.
- Writes outside a transaction take the writer for one statement.
- A transaction holds the writer until it ends.

## Logging

```ts
const db = new Database({ path: 'app.sqlite', loggerEnabled: true });
db.loggerEnabled = false;
```

Each statement is logged as one line with its duration. Expanding it shows the
params, the rows, the transaction and a timing breakdown. Failed statements are
logged expanded.

```
[orm] SELECT * FROM `assets` — took 1.2ms
```

## Raw SQL

```ts
import { Statement } from '@7otion-tauri/orm';

const { rows } = await db.run(
	new Statement('SELECT name FROM users WHERE age > ?', [18]),
);
```

`run` returns `rows` and `affected`, and takes a transaction handle as its
second argument. Read-only statements run on a reader automatically.

Without params, `run` accepts a script of several statements, which is handy for
tests:

```ts
await db.run(
	new Statement(`
		CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
		CREATE INDEX users_name ON users (name);
	`),
);
```

`SelectBuilder` is exported too, and works anywhere a `Statement` does:

```ts
import { SelectBuilder } from '@7otion-tauri/orm';

await db.run(
	SelectBuilder.from('audit_log').where('level', '>=', 3).limit(100),
);
```

Rows changed by raw SQL are not reflected in models already loaded until they
are read again.

## Errors

Every error extends `OrmError`.

| class                | when                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `DatabaseError`      | SQLite or the plugin rejected a statement. Has `code` and `statement`. |
| `QueryError`         | A query could not be built, e.g. an unknown operator.                  |
| `TransactionError`   | A transaction handle was misused.                                      |
| `ModelNotFoundError` | `findOrFail` and `firstOrFail`.                                        |
| `AfterCommitError`   | The write committed, but a `:committed` handler threw.                 |
| `StoreError`         | A store was misused, e.g. created with `new`.                          |

`DatabaseError.code` is one of `unique`, `foreign_key`, `not_null`, `check`,
`busy`, `read_only`, `value`, `misuse`, `protocol`, `unknown`. Error messages
never include params.

# Starting an app

From an empty Tauri 2 + SvelteKit app to a model on screen. The paths below
assume the app sits next to this repository:

```
7otion-tauri/        this repository
my-app/
  vite.config.ts
  src-tauri/Cargo.toml
```

## Requirements

- Rust 1.88+
- Tauri 2.11+ and `@tauri-apps/api` 2
- Svelte 5.57+
- SvelteKit 2 with `@sveltejs/adapter-static`

## Install

Neither the package nor the crate is published yet, so the app uses them from
source.

```bash
bun add @tauri-apps/api
bun add -d svelte @sveltejs/kit @sveltejs/adapter-static @sveltejs/vite-plugin-svelte
```

```ts
// vite.config.ts
import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,
			},
			adapter: adapter({ fallback: 'index.html' }),
			alias: {
				'@7otion-tauri/orm': '../7otion-tauri/orm/api/src/index.ts',
			},
		}),
	],
	resolve: {
		dedupe: ['svelte', '@tauri-apps/api'],
	},
	server: {
		fs: {
			allow: ['../7otion-tauri/orm/api/src'],
		},
	},
});
```

- Put `alias` in SvelteKit's options, not `resolve.alias`, so TypeScript and
  `svelte-check` pick it up too.
- `resolve.dedupe` matters: with two copies of Svelte, nothing on screen
  updates after a write.

Turn off server rendering, since the library needs the webview:

```ts
// src/routes/+layout.ts
export const ssr = false;
```

And add the crate:

```toml
# src-tauri/Cargo.toml
[dependencies]
tauri-plugin-7otion-sqlite = { path = "../../7otion-tauri/orm/backend" }
```

## Migrations and the plugin

```rust
// src-tauri/src/migrations/create_notes_table.rs
use tauri_plugin_7otion_sqlite::migrate::{DateStorage, Migration, Schema};

pub struct CreateNotesTable;

impl Migration for CreateNotesTable {
    const NAME: &'static str = "create_notes_table";

    fn up(schema: &mut Schema) {
        schema.create("notes", |table| {
            table.id();
            table.text("title");
            table.boolean("pinned").default(false);
            table.json("tags");
            table.date("created_at", DateStorage::Unix).default_now();
            table.date("updated_at", DateStorage::Unix).default_now();
        });
    }
}
```

```rust
// src-tauri/src/migrations/mod.rs
use tauri_plugin_7otion_sqlite::migrate::Migrations;
use tauri_plugin_7otion_sqlite::migrations;

mod create_notes_table;

use create_notes_table::CreateNotesTable;

pub fn app() -> Migrations {
    migrations![CreateNotesTable]
}
```

```rust
// src-tauri/src/lib.rs
mod migrations;

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_7otion_sqlite::Builder::new()
                .migrations("app", migrations::app())
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

Never edit a migration once it has shipped; add a new one. The full migration
API is in [the crate's README](../../backend/README.md#migrations).

Grant the plugin's commands in your capability:

```json
"permissions": ["core:default", "7otion-sqlite:default"]
```

## A model

The ORM does not read the schema, so each model declares columns matching its
migration:

| migration (Rust)                         | model (TypeScript)                           |
| ---------------------------------------- | -------------------------------------------- |
| `table.id()`                             | `Column.integer().primary().generated()`     |
| `table.integer` / `real` / `text` / `blob` | `Column.integer()` / `real()` / `text()` / `blob()` |
| `table.boolean`                          | `Column.boolean()`                           |
| `table.json`                             | `Column.json<T>()`                           |
| `table.date("n", DateStorage::Unix)`     | `Column.date('unix')` (same for `iso`, `datetime`, `unix_ms`) |
| `.nullable()`                            | `.nullable()`                                |

```ts
// src/lib/models/note.ts
import { Column, Model } from '@7otion-tauri/orm';

export class Note extends Model<typeof Note.schema> {
	static readonly schema = this.define({
		table: 'notes',
		columns: {
			id: Column.integer().primary().generated(),
			title: Column.text(),
			pinned: Column.boolean(),
			tags: Column.json<string[]>(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
	});
}
```

## Connecting

Connect before any page asks for a store, for example in the root layout:

```ts
// src/routes/+layout.ts
import { Database, Model } from '@7otion-tauri/orm';

export const ssr = false;

Model.connect(
	new Database({
		path: 'app.sqlite',
		migrations: 'app',
		loggerEnabled: import.meta.env.DEV,
	}),
);
```

The file opens on the first query, so a failing migration shows up there.

For an app with one database file per project, see
[switching files](setup.md#switching-files) and
[how long a store lives](state.md#how-long-a-store-lives).

## On screen

```ts
// src/lib/store/notes.svelte.ts
import { ConnectionStore } from '@7otion-tauri/orm';
import { Note } from '$lib/models/note';

export class Notes extends ConnectionStore {
	readonly all = this.query(() => Note.query().orderBy('created_at', 'desc'));

	add(title: string) {
		return Note.create({ title, pinned: false, tags: [] });
	}
}
```

```svelte
<script lang="ts">
	import { Notes } from '$lib/store/notes.svelte';

	const notes = Notes.get();
</script>

<button onclick={() => notes.add('New note')}>Add</button>
{#each notes.all as note (note.id)}
	<p>{note.title}</p>
{/each}
```

The list updates by itself when a note is created, edited or deleted.

## Using the database from Rust

If Rust code needs the same file, load it from Rust first (in `setup`, or in
the command that opens a project) and keep the handle in managed state. The
JavaScript `Database` then attaches to the same connections, as long as it
names the same migration set.

```rust
let database = app.sqlite().load("app.sqlite", Some("app"), None).await?;
let mut connection = database.lock().await?;
sqlx::query("DELETE FROM sessions").execute(&mut *connection).await?;
```

`lock()` holds the writer, so keep it short. See
[the crate's README](../../backend/README.md#using-it-from-rust).

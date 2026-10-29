# @7otion-tauri/orm

An Active Record ORM and state library for Tauri desktop apps built with Svelte
and SQLite. Models live in the webview, talk to a local SQLite file through a
Rust plugin, and are reactive in Svelte out of the box.

It is built for that one setup and is not database-agnostic.

- **Typed from one declaration.** Columns are declared once and TypeScript
  infers the rest. `where('age', 'x')` and `with('postz')` don't compile.
- **Relations.** hasOne, hasMany, belongsTo, belongsToMany, morphTo and
  morphMany, with composite keys, eager or lazy loading.
- **One row, one instance.** Reading the same row twice gives the same object,
  so a write is visible everywhere. Edits go on a draft until `save()`.
- **Live collections.** Query results and loaded relations update themselves as
  rows are written.
- **Events.** `before`, `after` and `committed` hooks for every kind of write.
- **Transactions** with savepoints. Models are restored on rollback, and reads
  never wait for writes.
- **Svelte reactivity.** `{post.title}` updates when that column changes,
  `bind:value={draft.title}` edits it.
- **Stores.** Classes using `$state` and `$derived`, with live queries and
  persisted values, scoped to the app, the open database, or a tab.
- **No dependencies** besides Svelte and `@tauri-apps/api`.

## Install

Not on npm yet. Use it from source with a Vite alias to `orm/api/src/index.ts`,
together with the Rust crate in `orm/backend` from the same checkout.
[Starting an app](docs/new-app.md) walks through it.

## Example

```ts
import { Column, Database, Model, type Collection } from '@7otion-tauri/orm';

class Post extends Model<typeof Post.schema> {
	static readonly schema = this.define({
		table: 'posts',
		columns: {
			id: Column.integer().primary().generated(),
			user_id: Column.integer().nullable(),
			title: Column.text(),
			published: Column.boolean(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
	});

	declare author: User | null;
	declare comments: Collection<Comment>;

	static readonly relations = {
		author: this.belongsTo(() => User, { foreignKey: 'user_id' }),
		comments: this.hasMany(() => Comment, { foreignKey: 'post_id' }),
	};
}

Model.connect(new Database({ path: 'app.sqlite' }));

const post = await Post.create({ title: 'Hello', published: false });

post.draft().title = 'Hello, world';
await post.save();

const recent = await Post.query()
	.where('published', true)
	.with('author', 'comments')
	.orderBy('created_at', 'desc')
	.limit(10)
	.get();

await post.load('comments');
```

## In Svelte

```ts
// feed.svelte.ts
import { ConnectionStore } from '@7otion-tauri/orm';

export class Feed extends ConnectionStore {
	search = $state('');
	readonly posts = this.query(() => {
		const all = Post.query()
			.where('published', true)
			.orderBy('created_at', 'desc');
		return this.search
			? all.where('title', 'LIKE', `%${this.search}%`)
			: all;
	});
}
```

```svelte
<script lang="ts">
	const feed = Feed.get();
</script>

<input bind:value={feed.search} />
<ul>
	{#each feed.posts as post (post.id)}
		<li>{post.title}</li>
	{/each}
</ul>
```

Creating, editing or deleting a post anywhere updates the list. No manual
refetching.

## Documentation

- [Starting an app](docs/new-app.md)
- [Setup](docs/setup.md)
- [Models](docs/models.md)
- [Querying](docs/querying.md)
- [Writing](docs/writing.md)
- [Relationships](docs/relationships.md)
- [Model events](docs/events.md)
- [Transactions](docs/transactions.md)
- [Svelte](docs/svelte.md)
- [State](docs/state.md)

## Limitations

- Changes made outside the ORM (raw SQL, triggers, `ON DELETE CASCADE`) only
  show up on the next read.
- Inside a transaction, pass `tx` to reads as well as writes.
- `belongsToMany` and `morphTo` don't support composite keys.
- Integers larger than 2^53 are rejected rather than rounded.

## Development

```bash
bun install
bun run check
```

`check` builds the Tauri test harness, type-checks, and runs the tests.

## License

MIT

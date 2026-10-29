# Model events

Events are named `verb:moment`. The verbs are `create`, `update`, `delete`, and
`save` (create or update).

| moment       | runs                                   | arguments       | if it throws           |
| ------------ | -------------------------------------- | --------------- | ---------------------- |
| `:before`    | inside the write, before the statement | `(written, tx)` | the write rolls back   |
| `:after`     | inside the write, after the statement  | `(written, tx)` | the write rolls back   |
| `:committed` | after the commit                       | `(written)`     | the write still stands |

## Declaring

```ts
class Post extends Model<typeof Post.schema> {
	static readonly schema = this.define({ … });

	static readonly events: ModelEvents<Post> = {
		'delete:before': async (written, tx) => {
			await Comment.query()
				.whereIn('post_id', written.map(([post]) => post.id))
				.delete(tx);
		},
	};
}
```

Handlers can also be set at runtime. Passing `null` removes it:

```ts
File.registerEvent('delete:committed', written => removeFiles(written));
File.registerEvent('delete:committed', null);
```

Each event has one handler per class. A handler registered on `Model` runs for
every model.

## What a handler receives

`written` is a list of `[model, changes]` pairs, one per row, where `changes`
maps each written column to `{ from, to }`:

```ts
Post.registerEvent('update:committed', written => {
	for (const [post, changes] of written) {
		if (changes.title) reindex(post, changes.title.to);
	}
});
```

Bulk writes call the handler once with all their rows.

## Inside the write

`:before` and `:after` handlers run inside a transaction. **Pass `tx` to every
read and write they make**, or the read won't see the write in progress and the
write will wait on the transaction until it times out.

A `:before` handler can edit the model through its draft, and the edit is saved
with the write.

## After the commit

`:committed` handlers run after the outermost transaction commits, and never
after a rollback. If one throws, the write is kept and the call rejects with an
`AfterCommitError`, whose `result` holds what the write returned:

```ts
try {
	await Post.create(data);
} catch (error) {
	if (error instanceof AfterCommitError) {
		const post = error.result as Post;
		console.error(error.failures);
	}
}
```

You don't need events to update the UI; collections and models on screen update
by themselves.

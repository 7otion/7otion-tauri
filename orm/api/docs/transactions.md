# Transactions

```ts
const order = await db.transaction(async tx => {
	const order = await Order.create({ total }, tx);
	await OrderLine.createMany(lines(order), tx);
	return order;
});
```

`db.transaction(work)` runs `work` inside `BEGIN IMMEDIATE` and commits. If
`work` throws, it rolls back and rethrows. It returns whatever `work` returns.

## Pass the handle everywhere

**Every read and write inside the callback needs `tx`.**

```ts
await db.transaction(async tx => {
	const user = await User.findOrFail(1, tx);
	user.draft().name = 'Ann';
	await user.save(tx);
	await user.load('posts', tx);
	await db.run(new Statement('DELETE FROM sessions'), tx);
});
```

- A read without it doesn't see the transaction's uncommitted writes.
- A write without it waits for the transaction to finish, which never happens.
  After `writerWaitMs` it fails with `busy`.

Always `await` the work you start; a statement still pending when the callback
returns makes the transaction roll back.

## Savepoints

```ts
await db.transaction(async tx => {
	await Invoice.create(data, tx);
	try {
		await tx.savepoint(async () => {
			await Notification.create(note, tx);
		});
	} catch {
		// the invoice is kept; only the notification is undone
	}
});
```

`db.transaction(work, tx)` runs as a savepoint when given a handle, and as a new
transaction otherwise, so one function can serve both cases:

```ts
function archive(post: Post, tx?: Transaction) {
	return db.transaction(async inner => {
		await ArchivedPost.create(post.toObject(), inner);
		await post.delete(inner);
	}, tx);
}
```

## Models read inside a transaction

A model read with `tx` may show uncommitted data, so it is a separate instance
that is only valid inside the transaction. Return its key and read it again
afterwards:

```ts
const id = await db.transaction(async tx => {
	const user = await User.create({ name: 'Ann' }, tx);
	return user.id;
});
const user = await User.find(id);
```

## Rollbacks

When a transaction or savepoint rolls back, models written inside it are
restored: created models become new again, updates are pending again, and
deleted models exist again.

## Things that fail

- Running two pieces of work on one handle at the same time throws a
  `TransactionError`.
- If SQLite aborts the transaction itself (full disk, I/O error), the rest of it
  is refused and the models are restored.
- Reloading the page or closing the `Database` rolls back open transactions.

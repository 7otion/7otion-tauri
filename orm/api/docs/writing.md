# Writing

All writes go through the same path, so timestamps, events and rollbacks behave
the same whether you write one model or many.

## One model

```ts
const user = await User.create({ name: 'Ann' });

user.draft().name = 'Anna';
await user.save(); // only `name` and `updated_at` are written

await user.update({ age: 30 }); // writes `age` now; other edits stay pending
await user.save('name'); // writes only `name`

await user.delete(); // false if the row was already gone
```

- After an insert, the generated key and column defaults are on the instance.
- A model with no changes writes nothing.
- Updating a row that no longer exists throws, and nothing is written.

## Mass assignment

```ts
user.fill(input);
await User.create(input);
```

`fill()` only sets declared columns, and respects `fillable` and `guarded`.

## Find or create

```ts
const user = await User.firstOrCreate({ email }, { name: 'Ann' });
const same = await User.updateOrCreate({ email }, { name: 'Anna' });
```

Both run in a transaction, so concurrent calls create a single row.

## Many models

```ts
const users = await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);

for (const user of users) user.draft().active = false;
await User.updateMany(users);

const removed = await User.deleteMany(users);
```

Bulk writes are batched into as few statements as possible and wrapped in a
transaction when they need more than one.

## Many models, skipping the ones already there

```ts
const added = await PostTag.createManyOrIgnore([
	{ post_id: 1, tag: 'a' },
	{ post_id: 1, tag: 'b' },
]);
const users = await User.createManyOrIgnore(rows, { uniqueBy: ['email'] });
```

A row that clashes with a unique constraint (the primary key or any `UNIQUE`
column) is skipped instead of failing the write (`ON CONFLICT DO NOTHING`).
Every other failure, `NOT NULL` or `CHECK` included, still throws. It returns
the models that went in, in the order given; a skipped one stays unsaved.

- The models that went in are matched to their rows by key, or by `uniqueBy`
  when given. A key the app supplies needs nothing more: the rows share one
  statement.
- A key the database generates tells nothing about which row is whose, so
  without `uniqueBy` each row goes in its own statement, all in one
  transaction. With `uniqueBy` they share one.
- The same key (or `uniqueBy` value) twice in one call: the first row wins and
  the later ones are skipped without being sent. A later one is not tried even
  when the first is skipped for a clash on another column.
- A row with a NULL among those columns can't be matched by them, so it goes
  in its own statement.
- `create:after`, `save:after` and the `:committed` handlers run for the rows
  that went in only. Which rows go in is known only after the insert, so a
  model with a `create:before` or `save:before` handler is refused.

## Every matching row

```ts
const matched = await User.query().where('active', false).update({ age: null });
const removed = await User.query().where('active', false).delete();
```

Matching rows are loaded first, so events fire for each one and everything on
screen updates. Query updates skip mutators. Queries with a join, limit, offset
or `groupBy` can't update or delete.

## Inside a transaction

Pass the handle as the last argument (for `save`, before the column names):

```ts
await db.transaction(async tx => {
	const user = await User.create({ name: 'Ann' }, tx);
	user.draft().name = 'Anna';
	await user.save(tx);
	await User.query().where('active', false).delete(tx);
});
```

If the transaction rolls back, the models go back too: a created model is new
again, an edit is pending again, a deleted model exists again. See
[Transactions](transactions.md).

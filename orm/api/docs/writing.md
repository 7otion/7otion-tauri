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

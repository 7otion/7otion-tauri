# Querying

```ts
const users = await User.query()
	.where('active', true)
	.where('age', '>=', 18)
	.orderBy('name')
	.limit(20)
	.get();
```

Queries are immutable: every method returns a new query, so a base query can be
reused safely.

```ts
const active = User.query().where('active', true);
const adults = await active.where('age', '>=', 18).get();
const total = await active.count(); // still just `active`
```

Column names and value types are checked by TypeScript.

## Finding

```ts
await User.find(1); // User | null
await User.findOrFail(1); // throws ModelNotFoundError
await User.all();

await User.query().where('email', email).first();
await User.query().where('email', email).firstOrFail();
await User.query().where('email', email).exists();
```

## Collections

`get()` and `all()` return a live `Collection`: rows that start matching the
query join it, rows that stop matching leave, and the order is kept.

```ts
const open = await Task.query().where('done', false).orderBy('due').get();

await Task.create({ title: 'Call Ann', done: false }); // now in `open`
await open.first!.update({ done: true }); // gone from `open`
```

```ts
open.length;
open.first; open.last; open.at(0);
for (const task of open) { … }
open.find(task => task.id === 7);
open.pluck('title'); // string[]
open.keyBy('id'); // Map<number, Task>
open.groupBy('owner_id'); // Map<number | null, Task[]>
open.map(…); open.filter(…); open.sortBy('title', 'desc'); // plain arrays
open.toArray(); // a plain copy
```

`release()` stops a collection from following changes. If you only need the
rows once, use `toArray()` on the query instead of `get()`:

```ts
const tags = await Tag.query().whereIn('id', ids).toArray(); // Tag[]
```

## Conditions

```ts
query.where('name', 'Ann');
query.where('age', '>', 30); // = != <> > >= < <= LIKE NOT LIKE
query.where('email', null); // IS NULL
query.orWhere('role', 'admin');
query.whereNot('role', 'guest');

query.whereIn('id', [1, 2, 3]);
query.whereNotIn('id', [4]);
query.whereNull('deleted_at');
query.whereNotNull('deleted_at');

query.whereKey(7);
query.whereAttributes({ role: 'admin', active: true });
```

Each has an `or` variant. Values are converted the way the column stores them,
so a `Date` or a boolean works as expected. Passing `undefined` throws.

### Groups

```ts
query
	.where('active', true)
	.where(group => group.where('role', 'admin').orWhere('age', '>', 60));
// WHERE active = ? AND (role = ? OR age > ?)
```

### By a related table

```ts
User.query().whereHas('posts');
User.query().whereHas('posts', posts => posts.where('published', true));
User.query().whereDoesntHave('posts');
User.query().whereHas('posts.comments');
```

`orWhereHas` and `orWhereDoesntHave` exist too. Not supported for `morphTo`.

## Selecting, ordering, joins

```ts
query.select('id', 'name');
query.distinct();
query.orderBy('created_at', 'desc');
query.limit(10).offset(20);

query.join('posts', 'posts.user_id', '=', 'users.id');
query.leftJoin('profiles', 'profiles.user_id', '=', 'users.id');
query.rightJoin('teams', 'teams.id', '=', 'users.team_id');
```

With a join, qualify column names both tables share (`'posts.id'`).

## Aggregates

```ts
await query.count();
await query.sum('age');
await query.avg('age');
await query.min('created_at');
await query.max('created_at');
await query.pluck('email');
await query.value('email');
await query.paginate(2, 20); // { data, total }, pages start at 1
```

`liveCount()` returns a count that stays up to date:

```ts
const open = await Task.query().where('done', false).liveCount();
open.current;
open.release();
```

## Grouped queries

```ts
const perUser = await Post.query()
	.select('user_id')
	.selectRaw('COUNT(*) AS posts')
	.groupBy('user_id')
	.having(group => group.whereRaw('COUNT(*) > ?', [1]))
	.rows<{ user_id: number; posts: number }>();
```

Grouped rows aren't models, so read them with `rows()`, `pluck()` or `value()`.

## Raw fragments

```ts
query.whereRaw('lower(name) = ?', ['ann']);
query.selectRaw('price * ? AS gross', [1.2]);
query.havingRaw('SUM(total) > ?', [100]);
query.orderByRaw('CASE WHEN pinned THEN 0 ELSE 1 END');
```

Always bind values with `?`; never build raw SQL from user input.

## Inside a transaction

Pass the handle to the final call:

```ts
await db.transaction(async tx => {
	const user = await User.find(1, tx);
	const posts = await Post.query().where('user_id', 1).get(tx);
});
```

See [Transactions](transactions.md).

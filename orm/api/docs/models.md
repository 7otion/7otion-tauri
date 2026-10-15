# Models

```ts
import { Column, Model } from '@7otion-tauri/orm';

class User extends Model<typeof User.schema> {
	static readonly schema = this.define({
		table: 'users',
		columns: {
			id: Column.integer().primary().generated(),
			name: Column.text(),
			email: Column.text().nullable(),
			active: Column.boolean(),
			settings: Column.json<{ theme: string }>(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
	});

	static readonly mutators = this.mutate({
		name: value => value.trim(),
	});

	get label(): string {
		return `${this.name} <${this.email ?? 'no email'}>`;
	}
}
```

The class must name its own schema in `extends`; that is where the column types
come from. Declare `schema` before the other statics.

Don't redeclare columns as class fields (`id!: number`); that hides the column,
and the ORM throws when it sees it.

## Reading and the draft

Columns are read-only. Edits go on the model's **draft**, and `save()` writes
them:

```ts
const user = (await User.find(1))!;
user.name = 'Annie'; // compile error

const draft = user.draft();
draft.name = 'Annie';
user.name; // still 'Ann'
user.isDirty; // true
await user.save(); // now 'Annie' everywhere
```

There is one draft per model. `discard()` drops all edits, `discard('name')`
just one.

JSON, date and custom values read from a model are frozen. Edit them through
the draft:

```ts
user.settings.theme = 'dark'; // throws
user.draft().settings.theme = 'dark'; // fine
```

A new model has nothing in the database yet, so read it through its draft until
it is saved.

## Mutators

A mutator transforms a value when it is assigned: on the draft, in `fill()`,
`update()`, `create()` and friends. Values read from the database are not
mutated. The second argument is the draft, so a mutator can set other columns:

```ts
static readonly mutators = this.mutate({
	title: (value, post) => {
		post.slug = slugify(value);
		return value.trim();
	},
});
```

## define() options

| option       | meaning                                                              |
| ------------ | -------------------------------------------------------------------- |
| `table`      | Required.                                                            |
| `columns`    | Required. At least one `primary()`.                                  |
| `timestamps` | `true` for `created_at` / `updated_at`, or `{ createdAt, updatedAt }`. |
| `fillable`   | The only columns `fill()` and `create()` may set.                    |
| `guarded`    | Columns `fill()` and `create()` may never set.                       |

The ORM creates no tables; use the crate's
[migrations](../../backend/README.md#migrations), or `db.run` in tests.

## Columns

| factory                     | TypeScript   | stored as   |
| --------------------------- | ------------ | ----------- |
| `Column.integer()`          | `number`     | as given    |
| `Column.real()`             | `number`     | as given    |
| `Column.text()`             | `string`     | as given    |
| `Column.text<'a' \| 'b'>()` | `'a' \| 'b'` | as given    |
| `Column.blob()`             | `Uint8Array` | as given    |
| `Column.boolean()`          | `boolean`    | `1` or `0`  |
| `Column.json<T>()`          | `T`          | JSON text   |
| `Column.date(storage?)`     | `Date`       | see below   |
| `Column.custom(codec)`      | your type    | your choice |

| modifier        | effect                                               |
| --------------- | ---------------------------------------------------- |
| `nullable()`    | Allows `null`.                                       |
| `primary()`     | Part of the primary key; several make a composite key. |
| `generated()`   | The database fills the key on insert.                |
| `emptyToNull()` | Stores `''` as `NULL`.                               |
| `nocase()`      | The column is `COLLATE NOCASE`.                      |

Conversions apply everywhere, including values passed to `where()`.

The ORM does not read collations from the database. If a key column is
`COLLATE NOCASE`, also mark it `nocase()` so relations match it the same way.

### Dates

| storage    | stored value                         |
| ---------- | ------------------------------------ |
| `iso`      | `2026-03-04T05:06:07.890Z` (default) |
| `datetime` | `2026-03-04 05:06:07.890`, UTC       |
| `unix`     | seconds                              |
| `unix_ms`  | milliseconds                         |

A date column also accepts a number: milliseconds for `unix_ms`, seconds for
everything else. `unix` drops milliseconds.

### Custom codecs

```ts
import { Column, Model, type Codec } from '@7otion-tauri/orm';

class Money {
	constructor(readonly cents: number) {}
}

const MoneyCodec: Codec<Money, number> = {
	decode: cents => new Money(Number(cents)),
	encode: money => money.cents,
};

class Product extends Model<typeof Product.schema> {
	static readonly schema = this.define({
		table: 'products',
		columns: {
			id: Column.integer().primary().generated(),
			price: Column.custom(MoneyCodec),
		},
	});
}

await Product.query().where('price', new Money(250)).get();
```

A codec may also define `clone(value)` and `equals(a, b)`. `encode` must return
`null`, a boolean, a finite number, a string or a `Uint8Array`.

## Composite keys

```ts
class OrderLine extends Model<typeof OrderLine.schema> {
	static readonly schema = this.define({
		table: 'order_lines',
		columns: {
			order_id: Column.integer().primary(),
			line: Column.integer().primary(),
			sku: Column.text(),
		},
	});
}

await OrderLine.find([42, 1]);
```

A model loaded without its key columns can be read, but not saved or deleted.

## Timestamps

With `timestamps` on, the ORM sets both columns itself. You can't assign them.

## Instances

```ts
const user = new User().fill({ name: 'Ann' });

user.exists; // false until saved
user.isDirty; // true
user.getDirty(); // ['name']
user.getPending(); // { name: { from: undefined, to: 'Ann' } }
user.draft().toObject(); // { name: 'Ann' }
user.toObject(); // {}, nothing saved yet
```

Use `toObject()` rather than spreading; `{ ...user }` is empty. Assign `null`,
not `undefined`, to clear a column.

### One row, one instance

Two reads of the same row return the same object, so a change is visible
everywhere:

```ts
const a = await User.find(1);
const b = (await Post.query().with('author').first())!.author;
a === b; // true
```

`Model.unsaved()` lists every instance with pending edits.

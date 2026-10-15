# Relationships

```ts
class User extends Model<typeof User.schema> {
	static readonly schema = this.define({ table: 'users', columns: { … } });

	declare profile: Profile | null;
	declare posts: Collection<Post>;
	declare roles: Collection<Role>;
	declare notes: Collection<Note>;

	static readonly relations = {
		profile: this.hasOne(() => Profile, { foreignKey: 'user_id' }),
		posts: this.hasMany(() => Post, { foreignKey: 'user_id' }),
		roles: this.belongsToMany(() => Role, {
			pivot: 'user_roles',
			foreignPivotKey: 'user_id',
			relatedPivotKey: 'role_id',
		}),
		notes: this.morphMany(() => Note, {
			foreignKey: 'target_id',
			typeColumn: 'target_kind',
			typeValue: 'user',
		}),
	};
}
```

The `relations` object defines the relations; the `declare` fields give them
types. Use `declare`, not `!`, or the field hides the relation.

Keys are always explicit. Pass the related model as a function (`() => Post`)
so models can refer to each other.

| relation        | options                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `hasOne`        | `foreignKey`; `localKey` defaults to the primary key.                    |
| `hasMany`       | Same as `hasOne`.                                                        |
| `belongsTo`     | `foreignKey`; `ownerKey` defaults to the related primary key.            |
| `belongsToMany` | `pivot`, `foreignPivotKey`, `relatedPivotKey`; optional `parentKey`, `relatedKey`. |
| `morphMany`     | Like `hasMany`, plus `typeColumn` and `typeValue`.                       |
| `morphTo`       | `typeColumn`, `keyColumn`, and `types`.                                  |

`hasOne`, `hasMany`, `belongsTo` and `morphMany` accept composite keys as
arrays.

If the pivot table has its own model, pass it as `pivot: () => UserRole`. Then
loaded lists also update when pivot rows are created or deleted.

```ts
class Note extends Model<typeof Note.schema> {
	static readonly schema = this.define({ table: 'notes', columns: { … } });

	declare target: User | Post | null;

	static readonly relations = {
		target: this.morphTo<User | Post>({
			typeColumn: 'target_kind',
			keyColumn: 'target_id',
			types: { user: () => User, post: () => Post },
		}),
	};
}
```

## Eager loading

```ts
const users = await User.query()
	.with('posts.comments', 'profile')
	.with({ posts: query => query.where('published', true).orderBy('id') })
	.get();
```

One query per relation, however many parents. A constraint callback must return
the query it builds.

## Lazy loading

```ts
const posts = await user.load('posts');
await user.load('posts.comments');
user.posts; // now available as a property
```

Reading a relation that hasn't been loaded throws an error telling you how to
load it.

In a component:

```svelte
{#await post.load('comments') then comments}
	{#each comments as comment (comment.id)}
		<p>{comment.body}</p>
	{/each}
{/await}
```

## Changing a relation

Relations are read-only. Change the foreign key instead:

```ts
post.draft().user_id = user.id;
await post.save(); // post.author now points at `user`
```

## Loaded relations stay up to date

Once loaded, a relation follows every write made through the ORM: related rows
created, deleted or moved show up in or leave the list, and a to-one relation
follows its key.

`refresh()` re-reads the row and reloads its relations.
`refresh(['posts.comments'])` reloads only those paths.

## sync()

```ts
const result = await post.sync('tags', ['a', 'b', { tag: 'c', sort: 5 }]);
// { attached, detached, updated, unchanged }
```

`sync()` makes a `hasMany` or `morphMany` hold exactly the given set, in one
transaction: missing rows are created, extra ones deleted, changed ones updated.
Members are matched by key, or by the columns you pass as `matchOn`.

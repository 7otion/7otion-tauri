# State

A store is a class in a `.svelte.ts` file, using Svelte's own `$state` and
`$derived`. The library adds live queries, values persisted to `localStorage`,
and a lifetime.

```ts
// library.svelte.ts
import { ConnectionStore } from '@7otion-tauri/orm';

export class Library extends ConnectionStore {
	search = $state('');
	readonly view = this.stored<'grid' | 'list'>('view', 'grid', {
		validate: value => value === 'grid' || value === 'list',
	});
	readonly files = this.query(() => {
		const all = File.query().orderBy('created_at');
		return this.search
			? all.where('name', 'LIKE', `%${this.search}%`)
			: all;
	});
	readonly filesByOwner = $derived(this.files.collection.groupBy('owner_id'));
}
```

```svelte
<script lang="ts">
	import { Library } from '$lib/stores/library.svelte';

	const library = Library.get();
</script>

<input bind:value={library.search} />
{#each library.files as file (file.id)}
	<FileCard {file} />
{/each}
```

Stores are never created with `new`. `Library.get()` creates one on first call
and returns the same one afterwards. Actions are plain methods. A store can use
another one with `Other.get()`.

| field                                | what it is                     |
| ------------------------------------ | ------------------------------ |
| `$state(initial)`                    | a value you write              |
| `$derived(expression)`               | a value computed from others   |
| `this.stored(key, initial)`          | a value kept in `localStorage` |
| `this.query(() => Model.query()…)`   | a live query                   |
| `this.counted(() => Model.query()…)` | a live row count               |

### Two stores that use each other

`Other.get()` in a field runs while the store is being constructed, so two stores
can't keep each other that way: each would construct the other before either
exists, and the call stack overflows. Keep one side, or both, with `lazy()`. It
returns a function that asks for the store when it's called:

```ts
class Library extends ConnectionStore {
	readonly #groups = Groups.lazy();
	readonly grouped = $derived(this.files.rows.filter(file => this.#groups().has(file)));
}

class Groups extends ConnectionStore {
	readonly #library = Library.lazy();
	has(file: File): boolean { … }
}
```

Call it in methods, `$derived`, queries and effects, which run after both
constructors returned; calling it in a field initializer would construct the
other store right away again. Each call asks again, so a store for the whole
app that keeps a connection store gets the current database's one. A tab store
keeps the tab it was asked in; outside a component, pass the scope:
`Search.lazy(scope)`.

## Queries

A query loads itself and re-runs when state it reads changes, such as `search`
above. While a load is running, only the latest change is applied, so typing
doesn't fire a query per keystroke.

```ts
library.files.rows; // empty until the first load
library.files.first; // first row or null
library.files.collection; // the Collection
library.files.loaded;
library.files.error;
await library.files.settled();
```

A query is iterable, so `{#each library.files as file}` works directly.

A component can also own a query with `new Query(() => …)`; it ends with the
component.

### Counts

`this.counted()` ignores limit and offset, so a page and its total can share a
query:

```ts
class Library extends ConnectionStore {
	page = $state(1);
	readonly #perPage = 50;

	private matching() {
		return Entry.query().orderBy('title');
	}

	readonly entries = this.query(() =>
		this.matching()
			.limit(this.#perPage)
			.offset((this.page - 1) * this.#perPage),
	);
	readonly total = this.counted(() => this.matching());
	readonly pages = $derived(Math.ceil(this.total.current / this.#perPage));
}
```

## Persistence

```ts
library.view.current; // 'grid'
library.view.current = 'list'; // saved to localStorage
```

Values are replaced as a whole; mutating a stored array in place isn't saved.
`validate` falls back to the initial value when what's stored is no longer
valid.

Keys of a connection store are prefixed with the database's `namespace`, so
each project keeps its own values. `Stored.erase('alpha.')` removes everything
under a prefix.

## Effects

Create effects and queries in the constructor or as fields, not in methods:

```ts
constructor() {
	super();
	$effect(() => {
		if (this.files.loaded && !this.files.rows.includes(this.selected!)) this.selected = null;
	});
}
```

## How long a store lives

| extends           | lives                                      |
| ----------------- | ------------------------------------------ |
| `Store`           | for the whole app                          |
| `ConnectionStore` | while the current database stays connected |
| `TabStore`        | while its `TabScope` (one tab) is open     |

Connecting another database or calling `Model.disconnect()` ends every
connection store, and the next `get()` creates fresh ones for the new database.

When switching projects, key the project's pages on the open project, so they
are recreated and pick up the new stores:

```svelte
{#if projects.open}
	{#key projects.open}
		<ProjectPages />
	{/key}
{/if}
```

### A store per tab

For apps where pages open as tabs, a `TabStore` gives each tab its own
instance. Create a `TabScope` per tab:

```svelte
<!-- tab.svelte -->
<script lang="ts">
	import { TabScope } from '@7otion-tauri/orm';
	import { onDestroy } from 'svelte';

	const scope = new TabScope('library').provide();
	onDestroy(() => scope.end());
</script>

<LibraryPage />
```

```ts
// search.svelte.ts
import { TabStore } from '@7otion-tauri/orm';

export class Search extends TabStore {
	term = $state('');
	readonly files = this.query(() =>
		File.query().where('name', 'LIKE', `%${this.term}%`).orderBy('name'),
	);
}
```

`Search.get()` inside the tab returns that tab's instance. Outside a component,
pass the scope: `Search.get(scope)`.

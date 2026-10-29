# Svelte

Models, drafts and collections are reactive. Read them in markup, `$derived` or
`$effect` and they update; there is nothing to subscribe to.

```svelte
<script lang="ts">
	import type { Character } from '$lib/models';

	let { character }: { character: Character } = $props();
</script>

<h2>{character.name}</h2>
```

Updates are fine-grained: `{character.name}` re-renders only when that column of
that row changes, and a list re-renders only when rows join, leave or move.

| read              | updates when                                 |
| ----------------- | -------------------------------------------- |
| `model.name`      | that column is committed                     |
| `model.exists`    | the row is created or deleted                |
| `model.author`    | the relation points at another row           |
| `model.comments`  | a row joins, leaves or moves                 |
| `draft.name`      | the column is edited, discarded or committed |
| `model.isDirty`   | the draft or the row changes                 |
| `collection.rows` | a row joins, leaves or moves                 |

Models and values are handed out as they are, not wrapped in proxies, so `===`,
`structuredClone` and `invoke` work on them. Keep a model in `$state.raw`:

```ts
selected = $state.raw<Character | null>(null);
```

## Editing with bind:

```svelte
<script lang="ts">
	let { character }: { character: Character } = $props();

	const draft = $derived(character.draft());
</script>

<form onsubmit={() => character.save()}>
	<input bind:value={draft.name} />
	<button disabled={!character.isDirty}>Save</button>
	<button type="button" onclick={() => character.discard()}>Discard</button>
</form>
```

Inside `{#each}`, use `{@const draft = row.draft()}`.

## Compiling the library

The package ships its TypeScript source, including `.svelte.ts` files, which
the app's Svelte plugin compiles. See [Starting an app](new-app.md#install) for
the Vite settings.

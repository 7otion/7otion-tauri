# 7otion-tauri

Libraries for building Tauri desktop apps with Svelte and SQLite.

## orm

An Active Record ORM and state library. Models are typed from a single
declaration, stay in sync across the app, and are reactive in Svelte without
any manual refetching.

```ts
const posts = await Post.query()
	.where('published', true)
	.with('author')
	.orderBy('created_at', 'desc')
	.get();
```

It comes in two parts that are used together:

- [`orm/api`](orm/api): the TypeScript package (`@7otion-tauri/orm`)
- [`orm/backend`](orm/backend): the Rust Tauri plugin that manages SQLite
  connections and migrations

See [Starting an app](orm/api/docs/new-app.md) to set it up.

## Status

Early and not yet published to npm or crates.io. Use it from source; APIs may
still change.

## License

MIT

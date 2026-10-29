import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Codec } from '../../src/schema/codec';
import { Column } from '../../src/schema/column';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';

class Article extends Model<typeof Article.schema> {
	static readonly schema = this.define({
		table: 'articles_edits',
		columns: {
			id: Column.integer().primary().generated(),
			title: Column.text(),
			slug: Column.text(),
		},
	});

	static readonly mutators = this.mutate({
		title: (value, article) => {
			article.slug = value.trim().toLowerCase().replace(/\s+/g, '-');
			return value.trim();
		},
	});
}

const ARTICLES =
	'CREATE TABLE articles_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL)';

class Box {
	constructor(public size: number) {}
}

const BoxCodec: Codec<Box, number> = {
	decode: size => new Box(Number(size)),
	encode: box => box.size,
};

class Parcel extends Model<typeof Parcel.schema> {
	static readonly schema = this.define({
		table: 'parcels_edits',
		columns: {
			id: Column.integer().primary().generated(),
			box: Column.custom(BoxCodec),
		},
	});
}

const PARCELS =
	'CREATE TABLE parcels_edits (id INTEGER PRIMARY KEY AUTOINCREMENT, box INTEGER NOT NULL)';

/** How often a reader of each of `columns` on the draft, and one of the draft as a whole (`*`), ran again. */
function edits(model: Model, ...columns: string[]) {
	const draft = model.draft() as unknown as Record<string, unknown>;
	const readers = new Map<string, Watch<unknown>>();
	for (const column of columns)
		readers.set(column, new Watch(() => draft[column]));
	readers.set('*', new Watch(() => model.$signals.readEdits()));
	return (column: string) => readers.get(column)!.reruns;
}

describe('what a draft tells Svelte', () => {
	const orm = OrmBed.use();

	test('assigning a column on the draft tells that column and the draft as a whole', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		const heard = edits(user, 'name', 'age');

		user.draft().name = 'Annie';

		expect([heard('name'), heard('age'), heard('*')]).toEqual([1, 0, 1]);
		user.draft().age = 31;
		expect([heard('name'), heard('age'), heard('*')]).toEqual([1, 1, 2]);
	});

	test('an assignment that leaves what the draft shows unchanged is silent', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		user.draft().name = 'Annie';
		const heard = edits(user, 'name', 'age');

		user.draft().name = 'Annie';
		user.draft().age = null;

		expect([heard('name'), heard('age'), heard('*')]).toEqual([0, 0, 0]);
	});

	test('a mutator that sets another column tells each column once', async () => {
		const database = await orm.open();
		await database.run(new Statement(ARTICLES));
		const article = await Article.create({ title: 'Hello World' });
		const heard = edits(article, 'title', 'slug');

		article.draft().title = 'Second Post';

		expect([heard('title'), heard('slug'), heard('*')]).toEqual([1, 1, 1]);
	});

	test('an edit made inside a JSON value through the draft tells that column', async () => {
		await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'light', tags: [] },
		});
		const heard = edits(user, 'settings');

		user.draft().settings!.theme = 'dark';
		expect(heard('settings')).toBe(1);
		user.draft().settings!.tags.push('x');
		expect(heard('settings')).toBe(2);
	});

	test('an edit made inside a custom codec value through the draft tells that column', async () => {
		const database = await orm.open();
		await database.run(new Statement(PARCELS));
		const parcel = await Parcel.create({ box: new Box(1) });
		const heard = edits(parcel, 'box');

		parcel.draft().box.size = 5;

		expect(parcel.isDirty).toBe(true);
		expect(heard('box')).toBe(1);
	});

	test('discarding tells the columns whose edits it dropped', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'Annie';
		user.draft().age = 31;
		const heard = edits(user, 'name', 'age');

		user.discard('age');
		expect([heard('age'), heard('name'), heard('*')]).toEqual([1, 0, 1]);
		user.discard();
		expect([heard('age'), heard('name'), heard('*')]).toEqual([1, 1, 2]);
	});

	test('a save takes an edit without changing what the draft shows', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'Annie';
		user.draft().age = 31;
		const shown = new Watch(() => user.draft().name);
		const dirty = new Watch(() => user.getDirty().join());
		const heard = edits(user, 'age');

		await user.save('name');

		expect([...new Set(shown.seen)]).toEqual(['Annie']);
		expect([heard('age'), heard('*')]).toEqual([0, 0]);
		expect(dirty.seen).toEqual(['name,age', 'age']);
	});

	test('deleting a row drops its pending edits and tells them', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		user.draft().name = 'Annie';
		const heard = edits(user, 'name');

		const shown = new Watch(() => user.draft().name);

		await user.delete();

		expect(heard('*')).toBe(1);
		expect(shown.last).toBe('Ann');
	});

	test('a write that is rolled back leaves the draft showing what it showed', async () => {
		const database = await orm.open();
		const user = await User.create({ name: 'Ann' });
		user.draft().name = 'Annie';
		const heard = edits(user);
		const shown = new Watch(() => user.draft().name);

		await database
			.transaction(async tx => {
				await user.save(tx);
				throw new Error('undo');
			})
			.catch(() => {});

		expect(heard('*')).toBe(0);
		expect([...new Set(shown.seen)]).toEqual(['Annie']);
		expect(user.name).toBe('Ann');
	});

	test('an effect that edits a draft does not come to depend on the edit', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		const writer = new Watch(() => {
			user.draft().name = 'Annie';
		});

		user.draft().name = 'Anna';
		user.discard();

		expect(writer.reruns).toBe(0);
	});
});

import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Codec } from '../../src/schema/codec';
import { Column } from '../../src/schema/column';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

class Article extends Model<typeof Article.schema> {
	static readonly schema = this.define({
		table: 'edge_articles',
		columns: {
			id: Column.integer().primary().generated(),
			title: Column.text(),
			slug: Column.text(),
		},
	});

	static readonly mutators = this.mutate({
		title: (value, article) => {
			if (value === 'bad') throw new Error('refused');
			article.slug = value.trim().toLowerCase().replace(/\s+/g, '-');
			return value.trim();
		},
	});
}

class File extends Model<typeof File.schema> {
	static readonly schema = this.define({
		table: 'edge_files',
		columns: {
			id: Column.integer().primary().generated(),
			body: Column.blob().nullable(),
		},
	});
}

class Box {
	constructor(public size: number) {}
}

const BoxCodec: Codec<Box, number> = {
	decode: size => new Box(Number(size)),
	encode: box => box.size,
	clone: box => new Box(box.size),
	equals: (a, b) => a.size === b.size,
};

class Parcel extends Model<typeof Parcel.schema> {
	static readonly schema = this.define({
		table: 'edge_parcels',
		columns: {
			id: Column.integer().primary().generated(),
			box: Column.custom(BoxCodec),
		},
	});
}

const TABLES = [
	'CREATE TABLE edge_articles (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL)',
	'CREATE TABLE edge_files (id INTEGER PRIMARY KEY AUTOINCREMENT, body BLOB)',
	'CREATE TABLE edge_parcels (id INTEGER PRIMARY KEY AUTOINCREMENT, box INTEGER NOT NULL)',
];

/** Lets a write build its statement; the crate answers a turn later. */
async function untilStatementIsBuilt(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('drafts and values at their edges', () => {
	const orm = OrmBed.use();

	async function open() {
		const db = await orm.open();
		for (const sql of TABLES) await db.run(new Statement(sql));
		return db;
	}

	test('an edit made on the draft while update is on its way stays pending', async () => {
		await open();
		const user = await User.create({ name: 'Ann', age: 30 });

		const updating = user.update({ age: 31 });
		await untilStatementIsBuilt();
		user.draft().age = 40;
		await updating;

		expect(user.age).toBe(31);
		expect(user.draft().age).toBe(40);
		expect(user.getDirty()).toEqual(['age']);
	});

	test('an update(patch) whose transaction rolls back leaves the draft as it was before the update', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'typing…';

		await rejection(
			db.transaction(async tx => {
				await user.update({ age: 31 }, tx);
				throw new Error('undo');
			}),
		);

		expect(user.age).toBe(30);
		expect(user.getDirty()).toEqual(['name']);
		expect(user.draft().age).toBe(30);
	});

	test('update whose mutator throws leaves the draft as it was', async () => {
		await open();
		const article = await Article.create({ title: 'Hello', slug: 'hello' });

		expect((await rejection(article.update({ slug: 'other', title: 'bad' }))).message).toBe('refused');

		expect(article.isDirty).toBe(false);
		expect(article.draft().slug).toBe('hello');
	});

	test('update writes what a mutator sets on another column even when that value was already pending', async () => {
		await open();
		const article = await Article.create({ title: 'Old', slug: 'old' });
		article.draft().slug = 'new-title';

		await article.update({ title: 'New Title' });

		const [row] = await Article.query().rows();
		expect(row).toMatchObject({ title: 'New Title', slug: 'new-title' });
	});

	test('reading a JSON column through the draft is not an edit that outlives a write of that column', async () => {
		await open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});
		void user.draft().settings!.theme; // a form rendering the draft

		await user.update({ settings: { theme: 'light', tags: [] } });

		expect(user.settings!.theme).toBe('light');
		expect(user.draft().settings!.theme).toBe('light');
		expect(user.isDirty).toBe(false);
	});

	test('a JSON value only read through the draft stays no edit after an update of it rolls back', async () => {
		const db = await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});
		void user.draft().settings!.theme;

		await rejection(
			db.transaction(async tx => {
				await user.update({ settings: { theme: 'light', tags: [] } }, tx);
				throw new Error('undo');
			}),
		);
		await user.update({ settings: { theme: 'blue', tags: [] } });

		expect(user.isDirty).toBe(false);
		expect(user.draft().settings!.theme).toBe('blue');
	});

	test('reading a JSON column through the draft is not an edit that outlives a query update', async () => {
		await open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});
		void user.draft().settings!.theme;

		await User.query()
			.where('id', user.id)
			.update({ settings: { theme: 'light', tags: [] } });
		const again = (await User.find(user.id))!;

		expect(again).toBe(user);
		expect(user.draft().settings!.theme).toBe('light');
		expect(user.isDirty).toBe(false);
	});

	test('a JSON value assigned from another model can then be edited through the draft', async () => {
		await open();
		const source = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});
		const target = await User.create({ name: 'Bob' });

		target.draft().settings = source.settings;
		target.draft().settings!.theme = 'light';

		expect(target.draft().settings!.theme).toBe('light');
		expect(source.settings!.theme).toBe('dark');
	});

	test("the draft's toObject hands out blob copies, so an edit in place leaves the committed bytes", async () => {
		await open();
		const file = await File.create({ body: new Uint8Array([1, 2, 3]) });

		(file.draft().toObject().body as Uint8Array)[0] = 9;

		expect([...file.body!]).toEqual([1, 2, 3]);
	});

	test('an in-place edit of a custom-codec value read through the draft does not change the committed value', async () => {
		await open();
		const parcel = await Parcel.create({ box: new Box(1) });

		parcel.draft().box.size = 5;

		expect(parcel.box.size).toBe(1);
	});

	test('deleteMany given a draft deletes its model', async () => {
		await open();
		const user = await User.create({ name: 'Ann' });

		await User.deleteMany([user.draft()]);

		expect(await User.query().count()).toBe(0);
		expect(user.exists).toBe(false);
	});

	test('updateMany given a draft that rekeys it keeps the model as the shared instance', async () => {
		await open();
		const user = await User.create({ name: 'Ann' });
		const draft = user.draft();
		draft.id = 99;

		await User.updateMany([draft]);

		expect(await User.find(99)).toBe(user);
	});
});

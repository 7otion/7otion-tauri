import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Post, SCHEMA, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 20)",
	"INSERT INTO posts (user_id, title, published) VALUES (1, 'First', 1), (2, 'Second', 0)",
];

describe('identity map and transaction instances', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a rollback that puts pending edits back lists the instance as unsaved again', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		ann.draft().name = 'Annie';

		await rejection(
			db.transaction(async tx => {
				await ann.save(tx);
				throw new Error('undo');
			}),
		);

		expect(ann.isDirty).toBe(true);
		expect(Model.unsaved()).toContain(ann);
	});

	test('a rolled-back delete leaves the instance the shared one for its row', async () => {
		const db = await open();
		const ann = (await User.find(1))!;

		await rejection(
			db.transaction(async tx => {
				await ann.delete(tx);
				throw new Error('undo');
			}),
		);

		expect(ann.exists).toBe(true);
		expect(await User.find(1)).toBe(ann);
	});

	test('a rolled-back key change leaves the instance the shared one under its old key', async () => {
		const db = await open();
		const ann = (await User.find(1))!;

		await rejection(
			db.transaction(async tx => {
				await ann.update({ id: 50 }, tx);
				throw new Error('undo');
			}),
		);

		expect(ann.id).toBe(1);
		expect(await User.find(1)).toBe(ann);
	});

	test('a rolled-back update() leaves the draft as it was, with no pending edit', async () => {
		const db = await open();
		const ann = (await User.find(1))!;

		await rejection(
			db.transaction(async tx => {
				await ann.update({ name: 'Patched' }, tx);
				throw new Error('undo');
			}),
		);

		expect(ann.name).toBe('Ann');
		expect(ann.isDirty).toBe(false);
		expect(ann.draft().name).toBe('Ann');
	});

	test('a read outside an open transaction does not undo what the transaction wrote on a shared instance', async () => {
		const db = await open();
		const ann = (await User.find(1))!;

		await db.transaction(async tx => {
			await ann.update({ name: 'Written' }, tx);
			await User.find(1);
		});

		expect(
			(await db.run(new Statement('SELECT name FROM users WHERE id = 1')))
				.rows[0]!.name,
		).toBe('Written');
		expect(ann.name).toBe('Written');
	});

	test('a transaction instance whose key changes is the one read under its new key', async () => {
		const db = await open();

		await db.transaction(async tx => {
			const inside = (await Post.find(1, tx))!;
			await inside.update({ id: 50 }, tx);

			expect(await Post.find(50, tx)).toBe(inside);
		});
	});

	test('a transaction instance whose key changed does not take the values of a new row under its old key', async () => {
		const db = await open();

		await db.transaction(async tx => {
			const inside = (await Post.find(1, tx))!;
			await inside.update({ id: 50 }, tx);
			await Post.create({ id: 1, title: 'Newcomer' }, tx);

			const newcomer = (await Post.find(1, tx))!;
			expect(newcomer).not.toBe(inside);
			expect(inside.id).toBe(50);
			expect(inside.title).toBe('First');
		});
	});

	test('a key changed through a transaction instance moves the shared instance to the new key at commit', async () => {
		const db = await open();
		const shared = (await Post.find(1))!;

		await db.transaction(async tx => {
			const inside = (await Post.find(1, tx))!;
			await inside.update({ id: 50 }, tx);
		});

		expect(shared.id).toBe(50);
		expect(await Post.find(50)).toBe(shared);
	});

	test('an edit on a model of the project before is not listed as unsaved in the project now open', async () => {
		Model.connect(
			await orm.bed.databaseWith(SCHEMA, { path: 'first.sqlite' }),
		);
		const held = await User.create({ name: 'first' });
		Model.connect(
			await orm.bed.databaseWith(SCHEMA, { path: 'second.sqlite' }),
		);

		held.draft().name = 'edited after the switch';

		expect(Model.unsaved()).toEqual([]);
	});

	test('a read inside a transaction the ORM opened leaves no uncommitted value on a shared instance once it rolls back', async () => {
		await open();
		const ann = (await User.find(1))!;
		Post.registerEvent('update:after', async (_written, tx) => {
			await User.query()
				.where('id', 1)
				.update({ name: 'Uncommitted' }, tx);
			await User.find(1, tx);
			throw new Error('undo');
		});

		const post = (await Post.find(1))!;
		await rejection(post.update({ title: 'Changed' }));

		const stored = await User.database.run(
			new Statement('SELECT name FROM users WHERE id = 1'),
		);
		expect(stored.rows[0]!.name).toBe('Ann');
		expect(ann.name).toBe('Ann');
	});
});

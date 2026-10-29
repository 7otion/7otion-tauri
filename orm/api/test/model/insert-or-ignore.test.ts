import { describe, expect, test } from 'bun:test';

import { DatabaseError, OrmError } from '../../src/errors';
import type { Written } from '../../src/model/types';
import { PostTag, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const rowsIn = (sql: string) => sql.split('), (').length;

describe('createManyOrIgnore, a key the app supplies', () => {
	const orm = OrmBed.use();
	const inserts = () =>
		orm.crate.calls.filter(call => call.sql?.startsWith('INSERT'));

	test('a row whose key exists is skipped and left untouched; the rest go in, in one statement', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 5)",
		]);

		const tags = await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a', sort: 9 },
			{ post_id: 1, tag: 'b', sort: 7 },
		]);

		expect(orm.crate.statements).toHaveLength(1);
		expect(orm.crate.statements[0]).toContain(
			'ON CONFLICT DO NOTHING RETURNING',
		);
		expect(orm.crate.sql).not.toContain('BEGIN IMMEDIATE');
		expect(tags.map(tag => [tag.tag, tag.sort])).toEqual([['b', 7]]);
		expect(tags.every(tag => tag.exists && !tag.isDirty)).toBe(true);
		expect(
			(await PostTag.query().orderBy('tag').toArray()).map(tag => [
				tag.tag,
				tag.sort,
			]),
		).toEqual([
			['a', 5],
			['b', 7],
		]);
	});

	test('the same key twice in one call: the first wins, and the second is never sent', async () => {
		await orm.open();

		const tags = await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a', sort: 1 },
			{ post_id: 1, tag: 'a', sort: 2 },
			{ post_id: 1, tag: 'b', sort: 3 },
		]);

		expect(tags.map(tag => [tag.tag, tag.sort])).toEqual([
			['a', 1],
			['b', 3],
		]);
		expect(inserts()).toHaveLength(1);
		expect(inserts()[0]!.params).toEqual([1, 'a', 1, 1, 'b', 3]);
		expect(
			(await PostTag.query().orderBy('tag').toArray()).map(tag => [
				tag.tag,
				tag.sort,
			]),
		).toEqual([
			['a', 1],
			['b', 3],
		]);
	});

	test('the models that went in come back in the order given, whatever order RETURNING uses', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 0)",
		]);

		const tags = await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'd', sort: 4 },
			{ post_id: 1, tag: 'a', sort: 1 },
			{ post_id: 1, tag: 'c', sort: 3 },
			{ post_id: 1, tag: 'b', sort: 2 },
		]);

		expect(tags.map(tag => [tag.tag, tag.sort])).toEqual([
			['d', 4],
			['c', 3],
			['b', 2],
		]);
	});

	test('a default the database fills is put on each model that went in', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 5)",
		]);

		const tags = await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a' },
			{ post_id: 2, tag: 'a' },
		]);

		expect(tags.map(tag => [tag.post_id, tag.tag, tag.sort])).toEqual([
			[2, 'a', 0],
		]);
		expect(tags[0]!.isDirty).toBe(false);
	});

	test('when every row clashes, nothing comes back and no handler runs', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 0)",
		]);
		const seen: string[] = [];
		for (const event of [
			'create:after',
			'save:after',
			'create:committed',
			'save:committed',
		] as const) {
			PostTag.registerEvent(event, () => {
				seen.push(event);
			});
		}

		const tags = await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a', sort: 9 },
		]);

		expect(tags).toEqual([]);
		expect(seen).toEqual([]);
		expect(await PostTag.query().count()).toBe(1);
	});

	test('the handlers after the insert see only the rows that went in', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 0)",
		]);
		const seen: Record<string, string[]> = {};
		for (const event of [
			'create:after',
			'save:after',
			'create:committed',
			'save:committed',
		] as const) {
			PostTag.registerEvent(event, (written: Written<PostTag>) => {
				seen[event] = written.map(([tag]) => tag.tag);
			});
		}

		await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a', sort: 1 },
			{ post_id: 1, tag: 'b', sort: 2 },
			{ post_id: 1, tag: 'b', sort: 3 },
		]);

		expect(seen).toEqual({
			'create:after': ['b'],
			'save:after': ['b'],
			'create:committed': ['b'],
			'save:committed': ['b'],
		});
	});

	test('a model with a create:before or save:before handler is refused before anything is sent', async () => {
		await orm.open();

		for (const event of ['create:before', 'save:before'] as const) {
			PostTag.registerEvent(event, () => {});
			const error = await rejection(
				PostTag.createManyOrIgnore([{ post_id: 1, tag: 'a', sort: 0 }]),
			);
			PostTag.registerEvent(event, null);

			expect(error).toBeInstanceOf(OrmError);
			expect(error.message).toContain('create:before or save:before');
		}
		expect(orm.crate.calls).toEqual([]);
	});

	test('a live query gains only the rows that went in', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 0)",
		]);
		const all = await PostTag.query().orderBy('tag').get();

		await PostTag.createManyOrIgnore([
			{ post_id: 1, tag: 'a', sort: 0 },
			{ post_id: 1, tag: 'b', sort: 0 },
		]);

		expect(all.pluck('tag')).toEqual(['a', 'b']);
	});

	test('an empty list sends nothing', async () => {
		await orm.open();

		expect(await PostTag.createManyOrIgnore([])).toEqual([]);
		expect(orm.crate.calls).toEqual([]);
	});
});

describe('createManyOrIgnore, a key the database generates', () => {
	const orm = OrmBed.use();
	const inserts = () =>
		orm.crate.statements.filter(sql => sql.startsWith('INSERT'));
	const idOf = async (email: string) =>
		(await User.query().where('email', email).first())!.id;

	test('without uniqueBy each row is its own statement, all in one transaction, and only the rows that went in come back', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (name, email) VALUES ('Ann', 'a@x')",
		]);

		const users = await User.createManyOrIgnore([
			{ name: 'Anna', email: 'a@x' },
			{ name: 'Bob', email: 'b@x' },
			{ name: 'Cy', email: 'b@x' },
		]);

		expect(inserts()).toHaveLength(3);
		expect(inserts().every(sql => rowsIn(sql) === 1)).toBe(true);
		expect(orm.crate.sql[0]).toBe('BEGIN IMMEDIATE');
		expect(orm.crate.sql.at(-1)).toBe('COMMIT');
		expect(users.map(user => user.name)).toEqual(['Bob']);
		expect(users[0]!.exists).toBe(true);
		expect(users[0]!.id).toBe(await idOf('b@x'));
		expect(
			(await User.query().orderBy('id').toArray()).map(user => user.name),
		).toEqual(['Ann', 'Bob']);
	});

	test('without uniqueBy, rows with NULL in a unique column all go in', async () => {
		await orm.open();

		const users = await User.createManyOrIgnore([
			{ name: 'Dee', email: null },
			{ name: 'Eve', email: null },
		]);

		expect(users.map(user => user.name)).toEqual(['Dee', 'Eve']);
		expect(new Set(users.map(user => user.id)).size).toBe(2);
		expect(await User.query().count()).toBe(2);
	});

	test('with uniqueBy the rows share one statement, and each returned id lands on its own model', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (name, email) VALUES ('Ann', 'a@x')",
		]);

		const users = await User.createManyOrIgnore(
			[
				{ name: 'Cy', email: 'c@x' },
				{ name: 'Anna', email: 'a@x' },
				{ name: 'Bob', email: 'b@x' },
			],
			{ uniqueBy: ['email'] },
		);

		expect(users.map(user => user.name)).toEqual(['Cy', 'Bob']);
		expect(users[0]!.id).toBe(await idOf('c@x'));
		expect(users[1]!.id).toBe(await idOf('b@x'));
		expect(inserts()).toHaveLength(1);
		expect(rowsIn(inserts()[0]!)).toBe(3);
		expect(orm.crate.sql).not.toContain('BEGIN IMMEDIATE');
	});

	test('with uniqueBy, the same value twice in one call: the first wins, and the second is never sent', async () => {
		await orm.open();

		const users = await User.createManyOrIgnore(
			[
				{ name: 'Bob', email: 'b@x' },
				{ name: 'Bo', email: 'b@x' },
			],
			{ uniqueBy: ['email'] },
		);

		expect(users.map(user => user.name)).toEqual(['Bob']);
		expect(inserts()).toHaveLength(1);
		expect(rowsIn(inserts()[0]!)).toBe(1);
		expect(await User.query().pluck('name')).toEqual(['Bob']);
	});

	test('with uniqueBy, a row skipped for another clash leaves the others matched to their own models', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (id, name, email) VALUES (1, 'Ann', 'a@x')",
		]);

		const users = await User.createManyOrIgnore(
			[
				{ id: 1, name: 'Zed', email: 'z@x' },
				{ id: 5, name: 'Yan', email: 'y@x' },
			],
			{ uniqueBy: ['email'] },
		);

		expect(users.map(user => [user.id, user.name])).toEqual([[5, 'Yan']]);
		expect(
			(await User.query().orderBy('id').toArray()).map(user => [
				user.id,
				user.name,
				user.email,
			]),
		).toEqual([
			[1, 'Ann', 'a@x'],
			[5, 'Yan', 'y@x'],
		]);
	});

	test('with uniqueBy, a repeat behind a row skipped for another clash is not tried', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (id, name, email) VALUES (1, 'Ann', 'a@x')",
		]);

		const users = await User.createManyOrIgnore(
			[
				{ id: 1, name: 'Zed', email: 'z@x' },
				{ id: 5, name: 'Yan', email: 'z@x' },
			],
			{ uniqueBy: ['email'] },
		);

		expect(users).toEqual([]);
		expect(rowsIn(inserts()[0]!)).toBe(1);
		expect(await User.query().pluck('name')).toEqual(['Ann']);
	});

	test('with uniqueBy, rows with NULL in those columns go in on their own, keeping the order given', async () => {
		await orm.open();

		const users = await User.createManyOrIgnore(
			[
				{ name: 'Ann', email: null },
				{ name: 'Bob', email: 'b@x' },
				{ name: 'Cy', email: 'c@x' },
				{ name: 'Dee', email: null },
			],
			{ uniqueBy: ['email'] },
		);

		expect(users.map(user => user.name)).toEqual(['Ann', 'Bob', 'Cy', 'Dee']);
		const ids = users.map(user => user.id);
		expect([...ids].sort((a, b) => a - b)).toEqual(ids);
		expect(
			(await User.query().orderBy('id').toArray()).map(user => [
				user.id,
				user.name,
			]),
		).toEqual(users.map(user => [user.id, user.name]));
		expect(inserts().map(rowsIn)).toEqual([1, 2, 1]);
		expect(orm.crate.sql[0]).toBe('BEGIN IMMEDIATE');
	});
});

describe('createManyOrIgnore, failures it does not swallow', () => {
	const orm = OrmBed.use();

	test('a NOT NULL violation still fails, and its statement inserts nothing', async () => {
		await orm.open();

		const error = await rejection(
			User.createManyOrIgnore(
				[
					{ name: 'Bob', email: 'b@x' },
					{ name: null as unknown as string, email: 'c@x' },
				],
				{ uniqueBy: ['email'] },
			),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('not_null');
		expect(await User.query().count()).toBe(0);
	});

	test('a failure in a later statement rolls back the rows the earlier ones inserted', async () => {
		await orm.open();

		const error = await rejection(
			User.createManyOrIgnore([
				{ name: 'Bob', email: 'b@x' },
				{ name: null as unknown as string, email: 'c@x' },
			]),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(orm.crate.sql.at(-1)).toBe('ROLLBACK');
		expect(await User.query().count()).toBe(0);
	});

	test("inside the caller's transaction, a rollback returns the inserted models to unsaved", async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO post_tags (post_id, tag, sort) VALUES (1, 'a', 0)",
		]);
		const made: PostTag[] = [];

		await rejection(
			db.transaction(async tx => {
				made.push(
					...(await PostTag.createManyOrIgnore(
						[
							{ post_id: 1, tag: 'a', sort: 0 },
							{ post_id: 1, tag: 'b', sort: 0 },
						],
						{},
						tx,
					)),
				);
				throw new Error('stop');
			}),
		);

		expect(made.map(tag => [tag.draft().tag, tag.exists])).toEqual([
			['b', false],
		]);
		expect(await PostTag.query().count()).toBe(1);
	});
});

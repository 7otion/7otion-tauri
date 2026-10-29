import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { OrmError } from '../../src/errors';
import { Order, Post, PostTag, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

describe('bulk writes', () => {
	const orm = OrmBed.use();

	test('createMany writes one statement and returns keyed models in order', async () => {
		await orm.open();

		const users = await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob' },
			{ name: 'Cy' },
		]);

		expect(users.map(user => [user.id, user.name, user.active])).toEqual([
			[1, 'Ann', true],
			[2, 'Bob', true],
			[3, 'Cy', true],
		]);
		expect(users.every(user => user.exists && !user.isDirty)).toBe(true);
		expect(orm.crate.statements).toHaveLength(1);
		expect(orm.crate.sql).not.toContain('BEGIN IMMEDIATE');
	});

	test('rows setting different columns go in separate statements, keeping defaults, in one transaction', async () => {
		await orm.open();

		const users = await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob', active: false },
			{ name: 'Cy' },
		]);

		expect(users.map(user => user.active)).toEqual([true, false, true]);
		expect(users.map(user => user.name)).toEqual(['Ann', 'Bob', 'Cy']);
		expect(orm.crate.statements).toHaveLength(2);
		expect(orm.crate.sql[0]).toBe('BEGIN IMMEDIATE');
		expect(orm.crate.sql.at(-1)).toBe('COMMIT');
	});

	test('supplied and composite keys are kept, and defaults are matched to their rows', async () => {
		await orm.open();

		const tags = await PostTag.createMany([
			{ post_id: 1, tag: 'b' },
			{ post_id: 1, tag: 'a' },
		]);
		const orders = await Order.createMany([
			{ tenant: 'acme', number: 2, total: 9 },
		]);

		expect(tags.map(tag => [tag.tag, tag.sort])).toEqual([
			['b', 0],
			['a', 0],
		]);
		expect(orders[0]!.total).toBe(9);
		expect(await PostTag.query().count()).toBe(2);
	});

	test('createMany of nothing writes nothing', async () => {
		await orm.open();

		expect(await User.createMany([])).toEqual([]);
		expect(orm.crate.calls).toEqual([]);
	});

	test('a bulk insert past the param limit is split, and runs in one transaction', async () => {
		await orm.open();
		const rows = Array.from({ length: 12_000 }, (_, index) => ({
			title: `Post ${index}`,
			user_id: index,
			published_at: null,
		}));

		const posts = await Post.createMany(rows);

		expect(orm.crate.statements.length).toBeGreaterThan(1);
		expect(orm.crate.sql[0]).toBe('BEGIN IMMEDIATE');
		expect(posts.at(-1)!.title).toBe('Post 11999');
		expect(posts.at(-1)!.id).toBe(12_000);
		expect(await Post.query().count()).toBe(12_000);
	});

	test('updateMany writes every pending change in one statement', async () => {
		await orm.open();
		const users = await User.createMany([
			{ name: 'Ann', age: 1 },
			{ name: 'Bob', age: 2 },
			{ name: 'Cy', age: 3 },
		]);
		orm.crate.calls.length = 0;

		users[0]!.draft().name = 'Anna';
		users[1]!.draft().age = 20;
		await User.updateMany(users);

		expect(orm.crate.statements).toHaveLength(1);
		expect(users.every(user => !user.isDirty)).toBe(true);
		expect(
			(await User.query().orderBy('id').get())
				.toArray()
				.map(user => [user.name, user.age]),
		).toEqual([
			['Anna', 1],
			['Bob', 20],
			['Cy', 3],
		]);
	});

	test('updateMany with nothing pending writes nothing', async () => {
		await orm.open();
		const users = await User.createMany([{ name: 'Ann' }]);
		orm.crate.calls.length = 0;

		await User.updateMany(users);

		expect(orm.crate.calls).toEqual([]);
	});

	test('updateMany works on a composite key', async () => {
		await orm.open();
		const orders = await Order.createMany([
			{ tenant: 'acme', number: 1, total: 1 },
			{ tenant: 'acme', number: 2, total: 2 },
			{ tenant: 'zeta', number: 1, total: 3 },
		]);

		orders[0]!.draft().total = 10;
		orders[2]!.draft().total = 30;
		await Order.updateMany(orders);

		expect(await Order.query().orderBy('total').pluck('total')).toEqual([
			2, 10, 30,
		]);
	});

	test('deleteMany removes the rows of the models given, and those models no longer exist', async () => {
		await orm.open();
		const users = await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob' },
			{ name: 'Cy' },
		]);
		const heard: string[] = [];
		User.registerEvent('delete:before', written => {
			heard.push(`before ${written.length}`);
		});
		User.registerEvent('delete:committed', written => {
			heard.push(`committed ${written.length}`);
		});

		const removed = await User.deleteMany([users[0]!, users[2]!]);

		expect(removed).toBe(2);
		expect(users.map(user => user.exists)).toEqual([false, true, false]);
		expect(await User.query().pluck('name')).toEqual(['Bob']);
		expect(heard).toEqual(['before 2', 'committed 2']);
	});

	test('deleteMany counts a row already gone as not removed, and still marks its model gone', async () => {
		const db = await orm.open();
		const users = await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		await db.run(new Statement("DELETE FROM users WHERE name = 'Bob'"));

		expect(await User.deleteMany(users)).toBe(1);
		expect(users.map(user => user.exists)).toEqual([false, false]);
	});

	test('a bulk update with a row found gone never reaches its :committed handler', async () => {
		const db = await orm.open();
		const users = await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		await db.run(new Statement("DELETE FROM users WHERE name = 'Bob'"));
		let committed = 0;
		User.registerEvent('update:committed', () => void committed++);

		users[0]!.draft().age = 1;
		users[1]!.draft().age = 2;
		const error = await rejection(User.updateMany(users));

		expect(error.message).toContain('1 of 2 users rows no longer exist');
		expect(committed).toBe(0);
		expect(await User.query().pluck('age')).toEqual([null]);
	});

	test('a bulk update refuses a model never saved, and one without its key', async () => {
		await orm.open();
		await Order.createMany([{ tenant: 'acme', number: 1, total: 1 }]);
		const [partial] = await Order.query().select('total').get();

		partial!.draft().total = 5;

		expect(
			(await rejection(Order.updateMany([partial!]))).message,
		).toContain('without its primary key');
		expect(
			(await rejection(User.updateMany([new User()]))).message,
		).toContain('not in the database');
	});

	test('a bulk update writes a changed key, as save() does', async () => {
		await orm.open();
		const [moved, kept] = await Order.createMany([
			{ tenant: 'acme', number: 1, total: 1 },
			{ tenant: 'acme', number: 2, total: 2 },
		]);

		moved!.draft().number = 7;
		kept!.draft().total = 20;
		await Order.updateMany([moved!, kept!]);

		expect(
			(await Order.query().orderBy('number').get())
				.toArray()
				.map(order => [order.number, order.total]),
		).toEqual([
			[2, 20],
			[7, 1],
		]);
		expect(moved!.isDirty).toBe(false);
		expect(await Order.find(['acme', 7])).not.toBeNull();
	});

	test('a bulk update with a row found gone writes none of them', async () => {
		const db = await orm.open();
		const users = await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		await db.run(new Statement("DELETE FROM users WHERE name = 'Bob'"));

		users[0]!.draft().age = 1;
		users[1]!.draft().age = 2;
		const error = await rejection(User.updateMany(users));

		expect(error).toBeInstanceOf(OrmError);
		expect(error.message).toContain('1 of 2 users rows no longer exist');
		expect(users.map(user => [user.exists, user.isDirty])).toEqual([
			[true, true],
			[true, true],
		]);
		expect(
			await User.query().where('id', users[0]!.id).pluck('age'),
		).toEqual([null]);
	});

	test('a rolled-back bulk write reverts every model', async () => {
		const db = await orm.open();
		const made: User[] = [];

		await rejection(
			db.transaction(async tx => {
				made.push(
					...(await User.createMany(
						[{ name: 'Ann' }, { name: 'Bob' }],
						tx,
					)),
				);
				throw new Error('stop');
			}),
		);

		expect(made.map(user => user.exists)).toEqual([false, false]);
		expect(made.map(user => 'id' in user.toObject())).toEqual([
			false,
			false,
		]);
	});
});

describe('query writes', () => {
	const orm = OrmBed.use();

	test('a query update reads the rows it matches, then writes them in one statement, stamping updated_at and skipping timestamps given', async () => {
		await orm.open();
		await User.createMany([{ name: 'Ann', age: 1 }, { name: 'Bob' }]);
		orm.crate.calls.length = 0;

		const matched = await User.query()
			.where('name', 'Ann')
			.update({ age: 5, created_at: new Date(0) } as never);

		expect(matched).toBe(1);
		expect(orm.crate.sql).toEqual([
			'BEGIN IMMEDIATE',
			'SELECT * FROM `users` WHERE `name` = ?',
			'UPDATE `users` SET `age` = ?, `updated_at` = ? WHERE `name` = ?',
			'COMMIT',
		]);
		expect((await User.find(1))!.age).toBe(5);
	});

	test('an empty query update writes nothing', async () => {
		await orm.open();

		expect(await User.query().update({})).toBe(0);
		expect(orm.crate.calls).toEqual([]);
	});

	test('a query update refuses a key column and an unknown one', async () => {
		await orm.open();

		expect(
			(await rejection(User.query().update({ id: 5 } as never))).message,
		).toContain('is a key column');
		expect(
			(await rejection(User.query().update({ nope: 1 } as never)))
				.message,
		).toContain("no column named 'nope'");
	});

	test('a query delete returns how many rows went', async () => {
		await orm.open();
		await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob' },
			{ name: 'Cy' },
		]);

		expect(await User.query().whereIn('name', ['Ann', 'Cy']).delete()).toBe(
			2,
		);
		expect(await User.query().pluck('name')).toEqual(['Bob']);
	});

	test('a query with a limit, a join or a group cannot update or delete', async () => {
		await orm.open();

		for (const query of [
			User.query().limit(1),
			User.query().offset(1),
			User.query().join('posts', 'posts.user_id', '=', 'users.id'),
			User.query().groupBy('name'),
		]) {
			expect(await rejection(query.delete())).toBeInstanceOf(OrmError);
			expect(await rejection(query.update({ age: 1 }))).toBeInstanceOf(
				OrmError,
			);
		}
	});

	test('a qualified column in a query update is written as its own table', async () => {
		await orm.open();
		await User.createMany([{ name: 'Ann' }]);

		expect(
			await User.query().where('users.name', 'Ann').update({ age: 9 }),
		).toBe(1);
		expect((await User.find(1))!.age).toBe(9);
	});
});

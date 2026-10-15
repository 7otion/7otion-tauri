import { describe, expect, test } from 'bun:test';

import { Statement } from '../src/database/statement';
import { OrmError, QueryError } from '../src/errors';
import { Model } from '../src/model/model';
import { Column } from '../src/schema/column';
import { Comment, Post, User } from './harness/models';
import { OrmBed } from './harness/orm';
import { rejection } from './harness/rejection';

describe('security', () => {
	const orm = OrmBed.use();

	test('SQL given where a column, table or patch key goes is refused or quoted whole, and runs nothing', async () => {
		const db = await orm.open();
		await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		const query = User.query() as any;

		const attempts: (() => Promise<unknown>)[] = [
			() => query.where('1=1 OR name IS NOT NULL --', 'x').get(),
			() => query.whereIn('id) OR 1=1 --', [1]).get(),
			() => query.orderBy('name; DROP TABLE users--').get(),
			() => query.select('* FROM users; --').get(),
			() => query.join('roles; DROP TABLE users--', 'a', '=', 'b').get(),
			() => query.join('roles', 'a OR 1=1', '=', 'b').get(),
			() => query.where('LOWER(name)', 'ann').get(),
			() => query.where('name` = `name` OR 1=1 --', 'x').get(),
			() => query.groupBy('name; DROP TABLE users--').rows(),
			() => query.pluck('name FROM users; DROP TABLE users --'),
			() => query.sum('age) FROM users; DROP TABLE users --'),
			() =>
				User.firstOrCreate(
					JSON.parse('{"name\\" OR 1=1 --": "x"}') as never,
				),
			() =>
				query.where('id', 1).update(JSON.parse('{"name = 1, age": 5}')),
		];

		for (const attempt of attempts) {
			let outcome: unknown;
			try {
				outcome = await rejection(attempt() as Promise<unknown>);
			} catch (error) {
				outcome = error;
			}
			expect(outcome).toBeInstanceOf(OrmError);
		}

		expect(
			(
				await db.run(
					new Statement('SELECT name FROM users ORDER BY id'),
				)
			).rows,
		).toEqual([{ name: 'Ann' }, { name: 'Bob' }]);
	});

	test('an operator, a direction, a limit and an offset are written into the SQL, so only real ones pass', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });
		const query = User.query() as any;

		expect(() => query.where('id', 'IS NOT NULL OR 1=1 --', 1)).toThrow(
			QueryError,
		);
		expect(() =>
			query.join('roles', 'users.id', '= 1 OR 1=1 --', 'roles.id'),
		).toThrow(QueryError);
		expect(() => query.orderBy('name', 'asc; DROP TABLE users')).toThrow(
			QueryError,
		);
		expect(() => query.limit('1; DROP TABLE users')).toThrow(QueryError);
		expect(() => query.offset('1; DROP TABLE users')).toThrow(QueryError);
		expect(await query.where('name', 'like', 'A%').get()).toHaveLength(1);
	});

	test('values holding SQL are bound', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });

		await User.query().where('name', "'); DROP TABLE users;--").get();

		expect(orm.crate.statements.at(-1)).not.toContain('DROP');
		expect(await User.query().count()).toBe(1);
	});

	test('a reserved word names a table and a column', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE "order" (id INTEGER PRIMARY KEY, "group" TEXT)',
			),
		);
		class Reserved extends Model<typeof Reserved.schema> {
			static readonly schema = this.define({
				table: 'order',
				columns: {
					id: Column.integer().primary().generated(),
					group: Column.text().nullable(),
				},
			});
		}

		await Reserved.create({ group: 'a' });

		expect(await Reserved.query().where('group', 'a').count()).toBe(1);
	});

	test('mass assignment reaches declared, fillable columns only: no internals, no prototype, no relation, no method', async () => {
		await orm.open();

		const post = await Post.create({
			title: 'T',
			published: true,
		} as never);
		expect(post.published).toBe(false);

		const comment = await Comment.create({
			post_id: post.id,
			body: 'b',
			id: 9999,
		} as never);
		expect(comment.id).not.toBe(9999);

		const hostile = JSON.parse(
			'{"$exists": false, "$attributes": {}, "$relations": {}, ' +
				'"__proto__": {"polluted": 1}, "constructor": {"prototype": {"polluted": 1}}, ' +
				'"prototype": {}, "relations": {}, "events": {}, "table": "x", ' +
				'"author": {"id": 9}, "save": 1, "toObject": 1, "title": "Ok"}',
		);

		post.fill(hostile as never);
		expect(post.draft().title).toBe('Ok');
		expect(post.title).toBe('T');
		expect(post.exists).toBe(true);
		expect(({} as any).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(post)).toBe(Post.prototype);
		expect(typeof post.save).toBe('function');
		expect(Object.keys(post)).toEqual([]);

		const made = await Post.create(hostile as never);
		expect(made.toObject()).toEqual({
			id: 2,
			title: 'Ok',
			user_id: null,
			published: false,
			published_at: null,
		});

		const [bulk] = await Post.createMany([hostile as never]);
		expect(bulk!.exists).toBe(true);
		expect(({} as any).polluted).toBeUndefined();

		expect(
			await rejection(
				Post.query()
					.where('id', 1)
					.update(hostile as never),
			),
		).toBeInstanceOf(OrmError);
	});
});

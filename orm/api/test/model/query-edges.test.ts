import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { QueryError } from '../../src/errors';
import { SelectBuilder } from '../../src/sql/select';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 40), ('Cy', 50)",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'First', 1), (1, 'Second', 0), (2, 'Third', 1)`,
	"INSERT INTO comments (post_id, body, sort) VALUES (1, 'a', 1), (3, 'b', 1)",
];

describe('query edges', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('an empty group beside an OR makes the whole true, whichever side it is on', async () => {
		await open();

		expect(
			await User.query()
				.where('name', 'Ann')
				.orWhere(group => group)
				.count(),
		).toBe(3);
		expect(
			await User.query()
				.where(group => group)
				.orWhere('name', 'Ann')
				.count(),
		).toBe(3);
	});

	test('an empty group among ANDs is dropped, and alone writes no WHERE', () => {
		expect(
			SelectBuilder.from('users')
				.where('a', 1)
				.where(group => group)
				.toStatement().sql,
		).toBe('SELECT * FROM `users` WHERE `a` = ?');
		expect(
			SelectBuilder.from('users')
				.where(group => group)
				.toStatement().sql,
		).toBe('SELECT * FROM `users`');
	});

	test('exists(), first() and value() keep the limit and offset the query carries', async () => {
		await open();
		const past = User.query().orderBy('id').offset(99);

		expect(await past.exists()).toBe(false);
		expect(await past.first()).toBeNull();
		expect(await User.query().limit(0).exists()).toBe(false);
		expect(await User.query().limit(0).first()).toBeNull();
		expect(await User.query().limit(0).value('name')).toBeNull();
		expect(await User.query().orderBy('id').offset(1).exists()).toBe(true);
	});

	test('select() under a join names this table, so a shared column name is not ambiguous', async () => {
		await open();

		const posts = await Post.query()
			.join('comments', 'comments.post_id', '=', 'posts.id')
			.select('id', 'title')
			.orderBy('posts.id')
			.get();

		expect(posts.toArray().map(post => [post.id, post.title])).toEqual([
			[1, 'First'],
			[3, 'Third'],
		]);
	});

	test('a query keeps its own copy of the arrays it was given', () => {
		const params = [1];
		const ids = [1, 2];
		const raw = User.query().whereRaw('age = ?', params);
		const among = SelectBuilder.from('users').whereIn('id', ids);

		params.push(2);
		ids.push(3);

		expect(raw.toStatement().params).toEqual([1]);
		expect(among.toStatement().params).toEqual([1, 2]);
	});

	test('a statement binding more values than SQLite takes is refused before it is sent, saying why', async () => {
		await open();
		const ids = Array.from({ length: 32767 }, (_, index) => index);

		const error = await rejection(User.query().whereIn('id', ids).get());

		expect(error).toBeInstanceOf(QueryError);
		expect(error.message).toContain('at most 32766');
		expect(await User.query().whereIn('id', ids.slice(1)).count()).toBe(3);
	});

	test('toObject() hands back copies, so editing them leaves the model as it was', async () => {
		await open();
		const user = await User.create({
			name: 'Dee',
			settings: { theme: 'dark', tags: ['a'] },
		});

		const plain = user.toObject() as { settings: { tags: string[] } };
		plain.settings.tags.push('b');

		expect(user.settings!.tags).toEqual(['a']);
		expect(user.getDirty()).toEqual([]);
	});

	test('small refusals name what is wrong', async () => {
		await open();
		const query = User.query() as any;

		expect(() => query.with(['posts'])).toThrow('spread it');
		expect(await rejection(User.query().paginate(0))).toBeInstanceOf(
			QueryError,
		);
		expect((await rejection(User.query().paginate(0))).message).toContain(
			'page of 1 or more',
		);
		expect(() =>
			Post.query().where('published_at', new Date(Number.NaN)),
		).toThrow('An invalid Date cannot be stored');
		expect(
			(await User.query().orderBy('name', 'DESC').pluck('name'))[0],
		).toBe('Cy');
	});

	test('a query write with a handler loads none of the relations the query names', async () => {
		await open();
		Post.registerEvent('update:before', () => {});
		Post.registerEvent('delete:before', () => {});
		orm.crate.calls.length = 0;

		await Post.query()
			.with('comments')
			.where('id', 2)
			.update({ title: 'x' });
		await Post.query().with('comments').where('id', 2).delete();

		expect(
			orm.crate.statements.filter(sql => sql.includes('`comments`')),
		).toEqual([]);
	});
});

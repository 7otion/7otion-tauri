import { afterEach, describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import type { Transaction } from '../../src/database/transaction';
import { Collection } from '../../src/query/collection.svelte';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
];

/** `published` is guarded on Post, so it is set through the draft. */
async function publish(
	title: string,
	user_id: number | null = null,
	tx?: Transaction,
): Promise<Post> {
	const post = new Post().fill({ title, user_id });
	post.draft().published = true;
	await post.save(tx);
	return post;
}

describe('a collection follows its query', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a row that starts to match joins, in the order the query asks', async () => {
		await open();
		const published = await Post.query()
			.where('published', true)
			.orderBy('title')
			.get();
		expect(published.pluck('title')).toEqual(['A1', 'B1']);

		await (await Post.find(2))!.update({ published: true });
		await publish('A0');

		expect(published.pluck('title')).toEqual(['A0', 'A1', 'A2', 'B1']);
	});

	test('a row that stops matching leaves, and a deleted row leaves without a query', async () => {
		await open();
		const published = await Post.query()
			.where('published', true)
			.orderBy('id')
			.get();
		const before = published.rows;

		await (await Post.find(1))!.update({ published: false });
		expect(published.pluck('title')).toEqual(['B1']);

		const last = (await Post.find(3))!;
		orm.crate.calls.length = 0;
		await last.delete();

		expect(published.length).toBe(0);
		expect(published.rows).not.toBe(before);
		expect(
			orm.crate.statements.filter(sql =>
				sql.startsWith('SELECT * FROM `posts`'),
			),
		).toHaveLength(0);
	});

	test('a change to a column the query does not decide by asks the database for nothing', async () => {
		await open();
		const published = await Post.query()
			.where('published', true)
			.orderBy('id')
			.get();
		const rows = published.rows;
		orm.crate.calls.length = 0;

		await published.at(0)!.update({ title: 'Renamed' });

		expect(published.rows).toBe(rows);
		expect(published.at(0)!.title).toBe('Renamed');
		expect(
			orm.crate.statements.filter(sql =>
				sql.startsWith('SELECT * FROM `posts`'),
			),
		).toHaveLength(0);
	});

	test('the rows array is replaced only when the list itself changed', async () => {
		await open();
		const all = await Post.query().orderBy('id').get();
		const rows = all.rows;

		await all.at(0)!.update({ published: false });

		expect(all.rows).toBe(rows);
	});

	test('a query with a join follows every change of its model', async () => {
		await open();
		const posts = await Post.query()
			.join('users', 'users.id', '=', 'posts.user_id')
			.where('users.name', 'Ann')
			.orderBy('posts.title')
			.get();

		await Post.create({ title: 'A3', user_id: 1 });
		await posts.at(0)!.update({ title: 'Z' });

		expect(posts.pluck('title')).toEqual(['A2', 'A3', 'Z']);
	});

	test('a collection read inside a transaction is a plain list that does not follow', async () => {
		const db = await open();
		let inside!: Collection<Post>;
		await db.transaction(async tx => {
			inside = await Post.query().where('published', true).get(tx);
			await publish('New', null, tx);
			expect(inside.length).toBe(2);
		});

		await publish('Later');

		expect(inside.length).toBe(2);
	});

	test('a rolled-back transaction leaves a collection as it was', async () => {
		const db = await open();
		const published = await Post.query()
			.where('published', true)
			.orderBy('id')
			.get();
		const rows = published.rows;

		await rejection(
			db.transaction(async tx => {
				await publish('Undone', null, tx);
				await (await Post.find(1, tx))!.delete(tx);
				throw new Error('undo');
			}),
		);

		expect(published.rows).toBe(rows);
	});

	test('a collection that was released stops following', async () => {
		await open();
		const published = await Post.query().where('published', true).get();
		published.release();

		await publish('New');

		expect(published.length).toBe(2);
	});

	test('a garbage-collected collection is not put right, and holds nothing back', async () => {
		await open();
		let seen = 0;
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (sql.startsWith('SELECT * FROM `posts`')) seen += 1;
			return original(command, args);
		};

		await (async () => {
			await Post.query().where('published', true).get();
		})();
		Bun.gc(true);
		await new Promise(resolve => setTimeout(resolve, 0));
		Bun.gc(true);
		seen = 0;

		await publish('New');

		expect(seen).toBe(0);
	});
});

describe('what is made from a collection', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('map, filter and sortBy answer over the rows of this moment', async () => {
		await open();
		const posts = await Post.query().orderBy('id').get();

		expect(posts.map(post => post.title)).toEqual(['A1', 'A2', 'B1']);
		expect(
			posts.filter(post => post.published).map(post => post.title),
		).toEqual(['A1', 'B1']);
		expect(posts.sortBy('title', 'desc').map(post => post.title)).toEqual([
			'B1',
			'A2',
			'A1',
		]);
	});

	test('sortBy takes a function, and orders ascending by default', async () => {
		await open();
		const posts = await Post.query().get();

		expect(posts.sortBy(post => -post.id).map(post => post.id)).toEqual([
			3, 2, 1,
		]);
		expect(posts.sortBy('title').map(post => post.title)).toEqual([
			'A1',
			'A2',
			'B1',
		]);
	});

	test('toArray is a copy that no longer follows', async () => {
		await open();
		const posts = await Post.query().get();
		const copy = posts.toArray();

		await Post.create({ title: 'New' });

		expect(copy).toHaveLength(3);
		expect(posts).toHaveLength(4);
	});

	test('reading helpers answer over the rows', async () => {
		await open();
		const posts = await Post.query().orderBy('id').get();

		expect(posts.first!.title).toBe('A1');
		expect(posts.last!.title).toBe('B1');
		expect(posts.at(-1)!.title).toBe('B1');
		expect(posts.find(post => post.title === 'A2')!.id).toBe(2);
		expect(posts.some(post => post.published)).toBe(true);
		expect(posts.every(post => post.published)).toBe(false);
		expect(posts.includes(posts.at(1)!)).toBe(true);
		expect(posts.reduce((total, post) => total + post.id, 0)).toBe(6);
		expect([...posts].map(post => post.id)).toEqual([1, 2, 3]);
		expect([...posts.keyBy('id').keys()]).toEqual([1, 2, 3]);
		expect(
			[...posts.groupBy('user_id').entries()].map(([key, group]) => [
				key,
				group.length,
			]),
		).toEqual([
			[1, 2],
			[2, 1],
		]);
		expect(
			JSON.parse(JSON.stringify(posts)).map(
				(post: { title: string }) => post.title,
			),
		).toEqual(['A1', 'A2', 'B1']);
	});
});

describe('a loaded to-many relation is a collection', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a related row created or deleted shows in the parent', async () => {
		await open();
		const post = (await Post.query()
			.with('comments')
			.where('id', 1)
			.first())!;
		expect(post.comments.pluck('body')).toEqual(['c1', 'c2']);

		await Comment.create({ post_id: 1, body: 'c0', sort: 0 });
		await post.comments.at(0)!.delete();

		expect(post.comments.pluck('body')).toEqual(['c2', 'c0']);
	});

	test('a constraint given to with() still shapes what joins', async () => {
		await open();
		const ann = (await User.query()
			.with({
				posts: query => query.where('published', true).orderBy('title'),
			})
			.where('id', 1)
			.first())!;

		await publish('A0', 1);
		await Post.create({ title: 'A9', user_id: 1 });

		expect(ann.posts.pluck('title')).toEqual(['A0', 'A1']);
	});

	test('a related row re-keyed to another parent moves between their lists', async () => {
		await open();
		const [ann, bob] = (
			await User.query().with('posts').orderBy('id').get()
		).toArray();
		const moving = bob!.posts.at(0)!;

		await moving.update({ user_id: 1 });

		expect(ann!.posts.pluck('title')).toEqual(['A1', 'A2', 'B1']);
		expect(bob!.posts.length).toBe(0);
	});

	test('a belongsToMany list follows its related rows, but not the pivot alone', async () => {
		const db = await open();
		await db.run(
			new Statement(
				"INSERT INTO roles (name) VALUES ('admin'), ('editor'); " +
					'INSERT INTO user_roles (user_id, role_id) VALUES (1, 1)',
			),
		);
		const ann = (await User.query().with('roles').where('id', 1).first())!;

		await db.run(
			new Statement(
				'INSERT INTO user_roles (user_id, role_id) VALUES (1, 2)',
			),
		);
		expect(ann.roles.pluck('name')).toEqual(['admin']);

		await ann.roles.at(0)!.update({ name: 'owner' });
		expect(ann.roles.pluck('name')).toEqual(['owner']);
	});

	test('a lazy load hands out the same collection the property holds, kept live', async () => {
		await open();
		const post = (await Post.find(1))!;
		const comments = await post.load('comments');

		await Comment.create({ post_id: 1, body: 'c0', sort: 0 });

		expect(comments).toBe(post.comments);
		expect(comments.length).toBe(3);
	});

	test('a relation refreshed drops the old collection, which stops following', async () => {
		await open();
		const post = (await Post.query()
			.with('comments')
			.where('id', 1)
			.first())!;
		const old = post.comments;

		await post.refresh(['comments']);
		await Comment.create({ post_id: 1, body: 'c0', sort: 0 });

		expect(old).not.toBe(post.comments);
		expect(old.length).toBe(2);
		expect(post.comments.length).toBe(3);
	});
});

describe('a commit names the collections it changed', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('the list whose rows changed tells what reads it; no other does', async () => {
		await open();
		const published = await Post.query().where('published', true).get();
		const users = await User.query().get();
		const readers = [published, users].map(
			list => new Watch(() => list.length),
		);

		await publish('New');

		expect(readers.map(reader => reader.reruns)).toEqual([1, 0]);
	});

	test('a member change that keeps the list as it was tells nothing', async () => {
		await open();
		const posts = await Post.query().orderBy('id').get();
		const reader = new Watch(() => posts.length);

		await posts.at(0)!.update({ title: 'Renamed' });

		expect(reader.reruns).toBe(0);
	});
});

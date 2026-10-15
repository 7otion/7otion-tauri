import { afterEach, describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Comment, Post, Role, User, UserRole } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	"INSERT INTO comments (post_id, body, sort) VALUES (1, 'c1', 1), (3, 'c3', 1)",
	"INSERT INTO roles (name) VALUES ('admin'), ('editor')",
	'INSERT INTO user_roles (user_id, role_id) VALUES (1, 1)',
];

describe('a commit reaches only the loaded relations it concerns', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};
	const selects = (table: string) =>
		orm.crate.statements.filter(sql => sql.startsWith(`SELECT * FROM \`${table}\``));
	const watch = <T>(read: () => T): Watch<T> => {
		const watching = new Watch(read);
		stops.push(watching.stop);
		return watching;
	};

	test('a row created for one parent asks for that parent’s rows alone, in one statement', async () => {
		await open();
		const [ann, bob, cy] = (await User.query().with('posts').orderBy('id').get()).toArray();
		const bobs = watch(() => bob!.posts.length);
		const cys = watch(() => cy!.posts.length);
		orm.crate.calls.length = 0;

		await Post.create({ title: 'A3', user_id: 1 });

		expect(ann!.posts.pluck('title')).toEqual(['A1', 'A2', 'A3']);
		expect(selects('posts')).toHaveLength(1);
		expect(orm.crate.calls.find(call => call.sql?.startsWith('SELECT * FROM `posts`'))?.params).toEqual([1]);
		expect(bobs.reruns).toBe(0);
		expect(cys.reruns).toBe(0);
	});

	test('rows created for several parents in one commit are asked for together', async () => {
		await open();
		const [ann, bob, cy] = (await User.query().with('posts').orderBy('id').get()).toArray();
		orm.crate.calls.length = 0;

		await Post.createMany([
			{ title: 'A3', user_id: 1 },
			{ title: 'B2', user_id: 2 },
			{ title: 'C1', user_id: 3 },
		]);

		expect(ann!.posts.length).toBe(3);
		expect(bob!.posts.length).toBe(2);
		expect(cy!.posts.length).toBe(1);
		expect(selects('posts')).toHaveLength(1);
	});

	test('a row created for a parent nobody loaded asks for nothing', async () => {
		await open();
		const ann = (await User.query().with('posts').where('id', 1).first())!;
		orm.crate.calls.length = 0;

		await Post.create({ title: 'B2', user_id: 2 });

		expect(ann.posts.length).toBe(2);
		expect(selects('posts')).toHaveLength(0);
	});

	test('a row re-keyed to another parent asks for both, in one statement', async () => {
		await open();
		const [ann, bob, cy] = (await User.query().with('posts').orderBy('id').get()).toArray();
		const cys = watch(() => cy!.posts.length);
		orm.crate.calls.length = 0;

		await bob!.posts.at(0)!.update({ user_id: 1 });

		expect(ann!.posts.pluck('title')).toEqual(['A1', 'A2', 'B1']);
		expect(bob!.posts.length).toBe(0);
		expect(selects('posts')).toHaveLength(1);
		expect(cys.reruns).toBe(0);
	});

	test('a deleted row leaves its parent’s list without a query', async () => {
		await open();
		const [ann, bob] = (await User.query().with('posts').orderBy('id').get()).toArray();
		orm.crate.calls.length = 0;

		await ann!.posts.at(0)!.delete();

		expect(ann!.posts.pluck('title')).toEqual(['A2']);
		expect(bob!.posts.length).toBe(1);
		expect(selects('posts')).toHaveLength(0);
	});

	test('a relation loaded under a raw constraint asks for every parent, in one statement', async () => {
		await open();
		const [ann, bob] = (await User.query()
			.with({ posts: query => query.whereRaw('title <> ?', ['A2']) })
			.orderBy('id')
			.get()).toArray();
		orm.crate.calls.length = 0;

		await Post.create({ title: 'B2', user_id: 2 });

		expect(ann!.posts.pluck('title')).toEqual(['A1']);
		expect(bob!.posts.pluck('title')).toEqual(['B1', 'B2']);
		expect(selects('posts')).toHaveLength(1);
	});

	test('a relation loaded under a limit is asked for one parent at a time', async () => {
		await open();
		const ann = (await User.query()
			.with({ posts: query => query.orderBy('title', 'desc').limit(1) })
			.where('id', 1)
			.first())!;
		expect(ann.posts.pluck('title')).toEqual(['A2']);

		await Post.create({ title: 'A3', user_id: 1 });

		expect(ann.posts.pluck('title')).toEqual(['A3']);
	});

	test('a related row created for a belongsToMany asks for nothing: no pivot row links it yet', async () => {
		await open();
		const users = await User.query().with('roles').orderBy('id').get();
		orm.crate.calls.length = 0;

		await Role.create({ name: 'guest' });

		expect(users.at(0)!.roles.pluck('name')).toEqual(['admin']);
		expect(selects('roles')).toHaveLength(0);
		expect(orm.crate.statements.filter(sql => sql.includes('`user_roles`'))).toHaveLength(0);
	});

	test('a belongsToMany whose pivot is a model follows the pivot rows written through it', async () => {
		await open();
		const [ann, bob] = (await User.query().with('duties').orderBy('id').get()).toArray();
		expect(ann!.duties.pluck('name')).toEqual(['admin']);
		const bobs = watch(() => bob!.duties.length);

		const link = await UserRole.create({ user_id: 1, role_id: 2 });
		expect(ann!.duties.pluck('name')).toEqual(['admin', 'editor']);
		expect(bobs.reruns).toBe(0);

		await link.delete();
		expect(ann!.duties.pluck('name')).toEqual(['admin']);
	});

	test('a pivot row moved to another parent moves the related row between their lists', async () => {
		await open();
		const [ann, bob] = (await User.query().with('duties').orderBy('id').get()).toArray();

		const link = (await UserRole.query().where('user_id', 1).first())!;
		await link.update({ user_id: 2 });

		expect(ann!.duties.length).toBe(0);
		expect(bob!.duties.pluck('name')).toEqual(['admin']);
	});

	test('a pivot row written around its model is not followed', async () => {
		const db = await open();
		const ann = (await User.query().with('duties').where('id', 1).first())!;

		await db.run(new Statement('INSERT INTO user_roles (user_id, role_id) VALUES (1, 2)'));
		await Role.create({ name: 'guest' });

		expect(ann.duties.pluck('name')).toEqual(['admin']);
	});

	test('a constrained to-one asks for the parents pointing at the changed row alone', async () => {
		await open();
		const posts = await Post.query()
			.with({ author: query => query.where('name', '<>', 'Bob') })
			.orderBy('id')
			.get();
		expect(posts.at(2)!.author).toBeNull();
		const bob = (await User.find(2))!;
		orm.crate.calls.length = 0;

		await bob.update({ name: 'Rob' });

		expect(posts.at(2)!.author).toBe(bob);
		expect(posts.at(0)!.author!.name).toBe('Ann');
		const asked = orm.crate.calls.filter(call => call.sql?.startsWith('SELECT * FROM `users`'));
		expect(asked).toHaveLength(1);
		expect(asked[0]!.params).toEqual(['Bob', 2]);
	});

	test('a row created beneath a nested parent asks for that parent alone', async () => {
		await open();
		const users = await User.query().with('posts.comments').orderBy('id').get();
		const first = users.at(0)!.posts.at(0)!;
		const third = users.at(1)!.posts.at(0)!;
		const thirds = watch(() => third.comments.length);
		orm.crate.calls.length = 0;

		await Comment.create({ post_id: 1, body: 'c2', sort: 2 });

		expect(first.comments.length).toBe(2);
		expect(selects('comments')).toHaveLength(1);
		expect(thirds.reruns).toBe(0);
	});
});

describe('a list asked again keeps the relations its rows hold', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};
	const selects = (table: string) =>
		orm.crate.statements.filter(sql => sql.startsWith(`SELECT * FROM \`${table}\``));

	test('a row that joins the list is loaded; the rows already in it are not loaded again', async () => {
		await open();
		const users = await User.query().with('posts').orderBy('name').get();
		const ann = users.at(0)!;
		const held = ann.posts;
		const pointed = new Watch(() => ann.posts);
		stops.push(pointed.stop);
		orm.crate.calls.length = 0;

		const dee = await User.create({ name: 'Dee' });

		expect(users.pluck('name')).toEqual(['Ann', 'Bob', 'Cy', 'Dee']);
		expect(dee.posts.length).toBe(0);
		expect(ann.posts).toBe(held);
		expect(pointed.reruns).toBe(0);
		expect(selects('posts')).toHaveLength(1);
		expect(orm.crate.calls.find(call => call.sql?.startsWith('SELECT * FROM `posts`'))?.params).toEqual([dee.id]);
	});

	test('a change that reorders the list asks for no relation again', async () => {
		await open();
		const users = await User.query().with('posts').orderBy('name').get();
		orm.crate.calls.length = 0;

		await users.at(0)!.update({ name: 'Zed' });

		expect(users.pluck('name')).toEqual(['Bob', 'Cy', 'Zed']);
		expect(selects('posts')).toHaveLength(0);
	});

	test('toArray reads the rows once, as models that are in no live list', async () => {
		await open();
		const users = await User.query().orderBy('id').toArray();
		orm.crate.calls.length = 0;

		await User.create({ name: 'Dee' });

		expect(Array.isArray(users)).toBe(true);
		expect(users.map(user => user.name)).toEqual(['Ann', 'Bob', 'Cy']);
		expect(selects('users')).toHaveLength(0);
	});
});

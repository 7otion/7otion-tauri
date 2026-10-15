import { afterEach, describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Comment, Note, Post, Role, User, UserRole } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';
import { Watch } from '../harness/watch.svelte';

const SEED = [
	"INSERT INTO users (name, active) VALUES ('Ann', 1), ('Bob', 1), ('Cy', 0)",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	"INSERT INTO comments (post_id, body, sort) VALUES (1, 'c1', 1), (3, 'c3', 1)",
	"INSERT INTO roles (name) VALUES ('admin'), ('editor')",
	'INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (2, 2)',
	"INSERT INTO notes (target_kind, target_id, body) VALUES ('user', 3, 'on cy')",
];

describe('whereHas filters by a related table', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};
	const names = async (query: { toArray(): Promise<User[]> }) =>
		(await query.toArray()).map(user => user.name);

	test('a hasMany: the rows that have a related row, or one the callback accepts', async () => {
		await open();

		expect(await names(User.query().whereHas('posts').orderBy('id'))).toEqual(['Ann', 'Bob']);
		expect(
			await names(User.query().whereHas('posts', posts => posts.where('title', 'B1'))),
		).toEqual(['Bob']);
	});

	test('whereDoesntHave gives the rows with none', async () => {
		await open();

		expect(await names(User.query().whereDoesntHave('posts'))).toEqual(['Cy']);
		expect(
			await names(
				User.query()
					.whereDoesntHave('posts', posts => posts.where('title', 'A1'))
					.orderBy('id'),
			),
		).toEqual(['Bob', 'Cy']);
	});

	test('a dotted path asks through each relation in turn', async () => {
		await open();
		await Post.create({ title: 'C1', user_id: 3 });

		expect(await names(User.query().whereHas('posts').orderBy('id'))).toEqual([
			'Ann',
			'Bob',
			'Cy',
		]);
		expect(await names(User.query().whereHas('posts.comments').orderBy('id'))).toEqual([
			'Ann',
			'Bob',
		]);
		expect(
			await names(
				User.query().whereHas('posts.comments', comments => comments.where('body', 'c3')),
			),
		).toEqual(['Bob']);
	});

	test('a belongsTo, a belongsToMany and a morphMany each ask their own way', async () => {
		await open();

		const posts = await Post.query()
			.whereHas('author', author => author.where('name', 'Bob'))
			.toArray();
		expect(posts.map(post => post.title)).toEqual(['B1']);
		expect(
			await names(User.query().whereHas('roles', roles => roles.where('name', 'admin'))),
		).toEqual(['Ann']);
		expect(await names(User.query().whereHas('notes'))).toEqual(['Cy']);
	});

	test('it joins the other conditions, and its values bind where it stands', async () => {
		await open();

		const query = User.query()
			.where('active', true)
			.whereHas('posts', posts => posts.where('title', 'LIKE', 'A%'))
			.orWhereHas('notes')
			.orderBy('id');

		expect(await names(query)).toEqual(['Ann', 'Cy']);
		expect(await query.count()).toBe(2);
		expect(query.toStatement().params).toEqual([1, 'A%', 'user']);
	});

	test('a morphTo is refused: it has no single related table', async () => {
		await open();

		expect(() => Note.query().whereHas('target')).toThrow(/polymorphic/);
	});

	test('a relation that is not declared is refused by name', async () => {
		await open();

		const error = await rejection(
			(async () => User.query().whereHas('nothing' as 'posts'))(),
		);
		expect(String(error)).toMatch(/declares no relation named 'nothing'/);
	});
});

describe('a list filtered by whereHas follows the related table', () => {
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

	test('a related row created or deleted lets a row into the list or out of it', async () => {
		await open();
		const users = await User.query().whereHas('posts').orderBy('id').get();
		expect(users.pluck('name')).toEqual(['Ann', 'Bob']);

		const made = await Post.create({ title: 'C1', user_id: 3 });
		expect(users.pluck('name')).toEqual(['Ann', 'Bob', 'Cy']);

		await made.delete();
		expect(users.pluck('name')).toEqual(['Ann', 'Bob']);
	});

	test('a related row re-keyed to another parent moves the list with it', async () => {
		await open();
		const users = await User.query().whereHas('posts').orderBy('id').get();
		const bobs = (await Post.query().where('user_id', 2).first())!;

		await bobs.update({ user_id: 3 });

		expect(users.pluck('name')).toEqual(['Ann', 'Cy']);
	});

	test('a change to a related column the callback does not filter on asks for nothing', async () => {
		await open();
		const filtered = await User.query()
			.whereHas('posts', posts => posts.where('title', 'LIKE', 'A%'))
			.get();
		const post = (await Post.find(3))!;
		orm.crate.calls.length = 0;

		await post.update({ published_at: new Date(0) });
		expect(selects('users')).toHaveLength(0);

		await post.update({ title: 'A9' });
		expect(selects('users')).toHaveLength(1);
		expect(filtered.pluck('name').sort()).toEqual(['Ann', 'Bob']);
	});

	test('a dotted path follows the table at its end', async () => {
		await open();
		const users = await User.query().whereHas('posts.comments').orderBy('id').get();
		expect(users.pluck('name')).toEqual(['Ann', 'Bob']);

		await (await Comment.query().where('post_id', 3).first())!.delete();

		expect(users.pluck('name')).toEqual(['Ann']);
	});

	test('a belongsToMany follows pivot rows written through the pivot’s model', async () => {
		await open();
		const users = await User.query()
			.whereHas('duties', roles => roles.where('name', 'admin'))
			.orderBy('id')
			.get();
		expect(users.pluck('name')).toEqual(['Ann']);

		await UserRole.create({ user_id: 3, role_id: 1 });
		expect(users.pluck('name')).toEqual(['Ann', 'Cy']);

		await (await Role.find(2))!.update({ name: 'admin' });
		expect(users.pluck('name')).toEqual(['Ann', 'Bob', 'Cy']);
	});

	test('a relation loaded under a whereHas constraint follows the table it asks about', async () => {
		await open();
		const ann = (await User.query()
			.with({ posts: posts => posts.whereHas('comments').orderBy('id') })
			.where('id', 1)
			.first())!;
		expect(ann.posts.pluck('title')).toEqual(['A1']);
		const shown = new Watch(() => ann.posts.pluck('title').join());
		stops.push(shown.stop);

		await Comment.create({ post_id: 2, body: 'c2', sort: 1 });

		expect(shown.last).toBe('A1,A2');
	});
});

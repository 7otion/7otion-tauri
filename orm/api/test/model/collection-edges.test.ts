import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import type { Transaction } from '../../src/database/transaction';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
];

async function publish(title: string, user_id: number | null = null, tx?: Transaction): Promise<Post> {
	const post = new Post().fill({ title, user_id });
	post.draft().published = true;
	await post.save(tx);
	return post;
}

describe('collections at their edges', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a limited collection takes in the next row when a member is deleted', async () => {
		await open();
		const firstTwo = await Post.query().orderBy('id').limit(2).get();
		expect(firstTwo.pluck('title')).toEqual(['A1', 'A2']);

		await firstTwo.at(0)!.delete();

		expect(firstTwo.pluck('title')).toEqual(['A2', 'B1']);
	});

	test('a later page shifts when a row on an earlier page is deleted', async () => {
		await open();
		const { data: second } = await Post.query().orderBy('id').paginate(2, 1);
		expect(second.pluck('title')).toEqual(['A2']);

		await (await Post.find(1))!.delete();

		expect(second.pluck('title')).toEqual(['B1']);
	});

	test('a collection ordered by updated_at follows an update, which moves the stamp', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (name, created_at, updated_at) VALUES ('Ann', 100, 100), ('Bob', 200, 200)",
		]);
		const recent = await User.query().orderBy('updated_at', 'desc').get();
		expect(recent.pluck('name')).toEqual(['Bob', 'Ann']);

		await recent.at(1)!.update({ name: 'Anne' });

		expect(recent.pluck('name')).toEqual(['Anne', 'Bob']);
	});

	test('sortBy on a nullable text column orders the values and groups the nulls', async () => {
		const db = await orm.open();
		await orm.seed(db, [
			"INSERT INTO users (name, email) VALUES ('A', 'b@x'), ('B', NULL), ('C', 'a@x'), ('D', NULL), ('E', 'c@x')",
		]);
		const users = await User.query().orderBy('id').get();

		const emails = users.sortBy('email').map(user => user.email);

		expect(emails.filter(email => email !== null)).toEqual(['a@x', 'b@x', 'c@x']);
		const nulls = emails.map((email, index) => (email === null ? index : -1)).filter(index => index >= 0);
		expect(nulls).toSatisfy(indices => indices.join() === '0,1' || indices.join() === '3,4');
	});

	test('map, filter and sortBy answer with arrays of this moment, which do not follow', async () => {
		await open();
		const posts = await Post.query().orderBy('id').get();
		const titles = posts.map(post => post.title);
		const published = posts.filter(post => post.published);

		await Post.create({ title: 'New' });
		await posts.at(1)!.update({ title: 'Renamed' });

		expect(posts.length).toBe(4);
		expect(titles).toEqual(['A1', 'A2', 'B1']);
		expect(published.map(post => post.title)).toEqual(['A1', 'B1']);
	});

	test('a collection read while a row is created holds that row once both are done', async () => {
		await open();
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let creating: Promise<Post> | null = null;
		let landed!: () => void;
		const insertLanded = new Promise<void>(resolve => (landed = resolve));
		// The posts are read before the create lands; the INSERT lands before the read finishes.
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (creating !== null && sql.startsWith('SELECT * FROM `comments`')) await insertLanded;
			const result = await original(command, args);
			if (sql.startsWith('INSERT')) landed();
			if (creating === null && sql.startsWith('SELECT * FROM `posts`')) creating = publish('New');
			return result;
		};

		const published = await Post.query().with('comments').where('published', true).orderBy('id').get();
		await creating;
		crate.invoke = original;

		expect(published.pluck('title')).toEqual(['A1', 'B1', 'New']);
	});

	test('a row deleted while another commit re-reads the list does not come back', async () => {
		await open();
		const published = await Post.query().with('comments').where('published', true).orderBy('id').get();
		const doomed = published.at(0)!;
		const two = (await Post.find(2))!;
		two.draft().published = true;
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let deleting: Promise<unknown> | null = null;
		let landed!: () => void;
		const deleteLanded = new Promise<void>(resolve => (landed = resolve));
		// The re-read of the posts lands before the delete; the DELETE lands before the re-read finishes.
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (deleting !== null && sql.startsWith('SELECT * FROM `comments`')) await deleteLanded;
			const result = await original(command, args);
			if (sql.startsWith('DELETE')) landed();
			if (deleting === null && sql.startsWith('SELECT * FROM `posts`')) {
				deleting = doomed.delete();
			}
			return result;
		};

		await two.save();
		await deleting;
		crate.invoke = original;

		expect(published.includes(doomed)).toBe(false);
		expect(published.pluck('title')).toEqual(['A2', 'B1']);
	});

	test('one collection whose query can no longer run does not keep the others from following', async () => {
		const db = await open();
		const stale = await Post.query().get();
		Model.connect(db);
		const fresh = await Post.query().where('published', true).orderBy('id').get();

		await publish('New').catch(() => {});

		expect(fresh.pluck('title')).toEqual(['A1', 'B1', 'New']);
		expect(stale).toBeDefined();
	});

	test('a collection read inside a write is a snapshot of its transaction, and follows nothing after', async () => {
		await open();
		let inside: Collection<Post> | null = null;
		Post.registerEvent('create:after', async (_written, tx) => {
			inside = await Post.query().orderBy('id').get(tx);
			throw new Error('undo');
		});

		await Post.create({ title: 'Undone' }).catch(() => {});
		Post.registerEvent('create:after', null);
		await Post.create({ title: 'Later' });

		expect(inside!.length).toBe(4);
		expect(inside!.at(3)!.exists).toBe(false);
	});

	test('a collection released while a commit re-reads it keeps its rows', async () => {
		await open();
		const published = await Post.query().where('published', true).orderBy('id').get();
		const rows = published.rows;
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (sql.startsWith('SELECT * FROM `posts`')) published.release();
			return original(command, args);
		};

		await publish('New');
		crate.invoke = original;

		expect(published.rows === rows).toBe(true);
	});
});

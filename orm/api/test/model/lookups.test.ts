import { afterEach, describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Note, Post, Profile, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name, active) VALUES ('Ann', 1), ('Bob', 0)",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	"INSERT INTO profiles (user_id, bio) VALUES (1, 'ann bio')",
	"INSERT INTO notes (target_kind, target_id, body) VALUES ('user', 1, 'on ann')",
];

describe('a loaded to-one relation follows its row', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};
	const selects = (table: string) =>
		orm.crate.statements.filter(sql =>
			sql.startsWith(`SELECT * FROM \`${table}\``),
		);

	test('a belongsTo whose row is deleted reads null, without a query', async () => {
		await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;
		const ann = post.author!;
		orm.crate.calls.length = 0;

		await ann.delete();

		expect(post.author).toBeNull();
		expect(selects('users')).toHaveLength(0);
	});

	test('a belongsTo whose row is deleted inside a transaction reads null there, and is back after a rollback', async () => {
		const db = await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;

		await rejection(
			db.transaction(async tx => {
				await post.author!.delete(tx);
				expect(post.author).toBeNull();
				throw new Error('undo');
			}),
		);

		expect(post.author!.name).toBe('Ann');
	});

	test('a change to the related row that does not decide the relation asks for nothing', async () => {
		await open();
		const posts = await Post.query().with('author').orderBy('id').get();
		orm.crate.calls.length = 0;

		await posts.at(0)!.author!.update({ name: 'Annie' });

		expect(posts.at(1)!.author!.name).toBe('Annie');
		expect(selects('users')).toHaveLength(0);
	});

	test('a hasOne gains a row created for it, and loses one moved to another parent, both without a query', async () => {
		await open();
		const [ann, bob] = (
			await User.query().with('profile').orderBy('id').get()
		).toArray();
		expect(bob!.profile).toBeNull();
		orm.crate.calls.length = 0;

		const made = await Profile.create({ user_id: 2, bio: 'bob bio' });
		expect(bob!.profile).toBe(made);
		expect(selects('profiles')).toHaveLength(0);

		await ann!.profile!.update({ user_id: 2 });
		// Ann's went elsewhere, and Bob now has two: each asks the database which it holds.
		expect(bob!.profile!.bio).toBe('ann bio');
		expect(ann!.profile).toBeNull();
		expect(selects('profiles')).toHaveLength(1);
	});

	test('a to-one loaded under a constraint asks again when a deciding column changes', async () => {
		await open();
		const post = (await Post.query()
			.with({ author: query => query.where('active', true) })
			.where('id', 3)
			.first())!;
		expect(post.author).toBeNull();

		await (await User.find(2))!.update({ active: true });

		expect(post.author!.name).toBe('Bob');
	});

	test('a belongsTo re-pointed inside a transaction holds the shared row once it commits', async () => {
		const db = await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;
		const bob = (await User.find(2))!;
		orm.crate.calls.length = 0;

		await db.transaction(async tx => {
			post.draft().user_id = 2;
			await post.save(tx);
			expect(post.author).not.toBe(bob);
		});

		expect(post.author).toBe(bob);
		expect(selects('users')).toHaveLength(1);

		await bob.update({ name: 'Robert' });
		expect(post.author!.name).toBe('Robert');
	});

	test('a row written through a transaction’s own instance re-points the shared one, from the identity map', async () => {
		const db = await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;
		const bob = (await User.find(2))!;
		orm.crate.calls.length = 0;

		await db.transaction(async tx => {
			const own = (await Post.find(1, tx))!;
			own.draft().user_id = 2;
			await own.save(tx);
		});

		expect(post.user_id).toBe(2);
		expect(post.author).toBe(bob);
		expect(selects('users')).toHaveLength(0);
	});

	test('a morphTo whose target is deleted reads null', async () => {
		await open();
		const note = (await Note.query().with('target').first())!;
		expect((note.target as User).name).toBe('Ann');

		await (await User.find(1))!.delete();

		expect(note.target).toBeNull();
	});

	test('a commit tells the readers of the relations that now point elsewhere, and no other', async () => {
		await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;
		const other = (await Post.query()
			.with('author')
			.where('id', 3)
			.first())!;
		const pointed = new Watch(() => post.author);
		const untouched = new Watch(() => other.author);

		await post.author!.delete();

		expect([pointed.reruns, untouched.reruns]).toEqual([1, 0]);
		expect(pointed.last).toBeNull();
		expect(other.author!.name).toBe('Bob');
	});
});

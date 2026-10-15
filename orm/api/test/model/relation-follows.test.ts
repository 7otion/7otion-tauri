import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import {
	Comment,
	Note,
	Order,
	OrderLine,
	Post,
	Profile,
	User,
} from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	"INSERT INTO profiles (user_id, bio) VALUES (1, 'ann bio')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
];

describe('a loaded relation follows the database', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a load answered after a commit it did not see holds that commit’s rows', async () => {
		await open();
		const ann = (await User.find(1))!;
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let reached!: () => void;
		const atRead = new Promise<void>(resolve => (reached = resolve));
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		let held = false;
		// The load reads the posts, and its answer is held while a post is created and settles.
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			const answer = await original(command, args);
			if (!held && sql.startsWith('SELECT * FROM `posts`')) {
				held = true;
				reached();
				await gate;
			}
			return answer;
		};

		try {
			const loading = ann.load('posts');
			await atRead;
			await Post.create({ title: 'A3', user_id: 1 });
			release();
			await loading;
		} finally {
			crate.invoke = original;
		}

		expect(ann.posts.pluck('title')).toEqual(['A1', 'A2', 'A3']);
	});

	test('a to-many put back by a rollback still follows the database', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		await ann.load('posts');

		await rejection(
			db.transaction(async tx => {
				await ann.refresh(['posts'], tx);
				throw new Error('undo');
			}),
		);
		await Post.create({ user_id: 1, title: 'A3' });

		expect(ann.posts.pluck('title')).toEqual(['A1', 'A2', 'A3']);
	});

	test('a to-one put back by a rollback still follows the database', async () => {
		const db = await open();
		const bob = (await User.find(2))!;
		expect(await bob.load('profile')).toBeNull();

		await rejection(
			db.transaction(async tx => {
				await bob.refresh(['profile'], tx);
				throw new Error('undo');
			}),
		);
		const made = await Profile.create({ user_id: 2, bio: 'bob bio' });

		expect(bob.profile).toBe(made);
	});

	test('a to-one whose key change rolls back is not re-pointed later by the value it rolled back', async () => {
		await open();
		const comment = (await Comment.query().with('post').where('id', 1).first())!;
		const first = comment.post!;
		Post.registerEvent('update:after', async (_written, tx) => {
			await comment.update({ post_id: 3 }, tx);
			throw new Error('undo');
		});

		await rejection(first.update({ title: 'renamed' }));
		Post.registerEvent('update:after', null);
		expect([comment.post_id, comment.post]).toEqual([1, first]);

		await (await Post.find(3))!.delete();

		expect(comment.post).toBe(first);
	});

	test('a to-many loaded with a transaction that commits holds the shared rows and follows', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		const a1 = (await Post.find(1))!;

		await db.transaction(async tx => {
			await ann.load('posts', tx);
		});
		expect(ann.posts.at(0)).toBe(a1);

		await Post.create({ user_id: 1, title: 'A3' });
		expect(ann.posts.pluck('title')).toEqual(['A1', 'A2', 'A3']);
	});

	test('a new model saved in a transaction holds the shared related row once it commits', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		const profile = new Profile();
		expect(await profile.load('user')).toBeNull();

		await db.transaction(async tx => {
			profile.fill({ user_id: 1, bio: 'second' });
			await profile.save(tx);
		});

		expect(profile.user).toBe(ann);
	});

	test('a to-many loaded on a new model saved in a transaction follows once it commits', async () => {
		const db = await open();
		const user = new User().fill({ name: 'Dee' });
		expect(await user.load('posts')).toHaveLength(0);

		await db.transaction(async tx => {
			await user.save(tx);
		});
		await Post.create({ user_id: user.id, title: 'D1' });

		expect(user.posts.pluck('title')).toEqual(['D1']);
	});

	test('a hasOne whose held row is deleted reads the other row that still matches', async () => {
		const db = await open();
		await orm.seed(db, ["INSERT INTO profiles (user_id, bio) VALUES (1, 'ann second')"]);
		const ann = (await User.query().with('profile').where('id', 1).first())!;
		expect(ann.profile!.bio).toBe('ann bio');

		await ann.profile!.delete();

		expect(ann.profile?.bio).toBe('ann second');
	});

	test('a hasOne keeps its row when another is created and deleted in one transaction', async () => {
		const db = await open();
		const ann = (await User.query().with('profile').where('id', 1).first())!;
		const held = ann.profile!;

		await db.transaction(async tx => {
			const passing = await Profile.create({ user_id: 1, bio: 'passing' }, tx);
			await passing.delete(tx);
		});

		expect(ann.profile).toBe(held);
	});

	test('a hasOne replaced in one transaction, the new row created before the old is deleted, holds the new row', async () => {
		const db = await open();
		const ann = (await User.query().with('profile').where('id', 1).first())!;
		const old = ann.profile!;
		let made!: Profile;

		await db.transaction(async tx => {
			made = await Profile.create({ user_id: 1, bio: 'new bio' }, tx);
			await old.delete(tx);
		});

		expect(ann.profile).toBe(made);
	});

	test('load() of a to-one whose row was deleted resolves to null, as the property reads', async () => {
		const db = await open();
		await orm.seed(db, ["INSERT INTO notes (target_kind, target_id, body) VALUES ('user', 1, 'on ann')"]);
		const note = (await Note.find(1))!;
		expect(((await note.load('target')) as User).name).toBe('Ann');

		await (await User.find(1))!.delete();

		expect(note.target).toBeNull();
		expect(await note.load('target')).toBeNull();
	});

	test('a belongsTo whose row was re-keyed through a transaction’s own instance no longer holds it', async () => {
		const db = await open();
		await orm.seed(db, [
			"INSERT INTO orders (tenant, number, total) VALUES ('acme', 1, 10)",
			"INSERT INTO order_lines (tenant, order_number, sku) VALUES ('acme', 1, 'a')",
		]);
		const line = (await OrderLine.query().with('order').first())!;
		const order = line.order!;

		await db.transaction(async tx => {
			const own = (await Order.find(['acme', 1], tx))!;
			own.draft().number = 2;
			await own.save(tx);
		});

		expect(line.order).toBeNull();
		expect(order.number).toBe(2);
	});

	/** Holds the answer to the first statement matching `pattern` until `release()`. */
	const gateFirst = (pattern: string) => {
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		const state = { held: false, release: () => release() };
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (!state.held && sql.includes(pattern)) {
				state.held = true;
				crate.invoke = original;
				const answer = await original(command, args);
				await gate;
				return answer;
			}
			return original(command, args);
		};
		return state;
	};
	const tick = () => new Promise(resolve => setTimeout(resolve, 1));

	test('a to-one reloading for its new key is not dropped by a commit that settles meanwhile', async () => {
		await open();
		const post = (await Post.query().with('author').where('id', 1).first())!;
		const ann = post.author!;

		const gate = gateFirst('FROM `users`');
		const moving = post.update({ user_id: 2 });
		while (!gate.held) await tick();
		await ann.delete();
		gate.release();
		await moving;

		expect(post.user_id).toBe(2);
		expect(post.author?.name).toBe('Bob');
	});

	test('a to-one that settles late does not overwrite the value its key change loaded since', async () => {
		await open();
		const post = (await Post.query()
			.with({ author: query => query.where('active', true) })
			.where('id', 1)
			.first())!;
		const ann = post.author!;

		const gate = gateFirst('FROM `users`');
		const deactivating = ann.update({ active: false });
		while (!gate.held) await tick();
		const moving = post.update({ user_id: 2 });
		while ((post.$relations.held('author') as User | null)?.id !== 2) await tick();
		gate.release();
		await Promise.all([deactivating, moving]);

		expect(post.user_id).toBe(2);
		expect(post.author?.name).toBe('Bob');
	});

	test('a row that joins a to-many loaded with a nested path has that path loaded', async () => {
		await open();
		const ann = (await User.query().with('posts.comments').where('id', 1).first())!;

		await Post.create({ user_id: 1, title: 'A3' });

		expect(ann.posts.map(post => post.comments.length)).toEqual([2, 0, 0]);
	});

	test('a row a to-one takes up has the nested path it was loaded with', async () => {
		await open();
		const bob = (await User.query().with('profile.user').where('id', 2).first())!;
		expect(bob.profile).toBeNull();

		await Profile.create({ user_id: 2, bio: 'bob bio' });

		expect(bob.profile!.user).toBe(bob);
	});

	test('a to-one re-pointed in a transaction keeps its nested path once it commits', async () => {
		const db = await open();
		const post = (await Post.query().with('author.profile').where('id', 3).first())!;
		const ann = (await User.find(1))!;

		await db.transaction(async tx => {
			await post.update({ user_id: 1 }, tx);
		});

		expect(post.author).toBe(ann);
		expect(post.author!.profile!.bio).toBe('ann bio');
	});
});

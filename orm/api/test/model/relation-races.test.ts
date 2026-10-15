import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import type { Transaction } from '../../src/database/transaction';
import type { Collection } from '../../src/query/collection.svelte';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1), (NULL, 'Orphan', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
];

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
	return Promise.race([
		promise,
		new Promise<'pending'>(resolve =>
			setTimeout(() => resolve('pending'), ms),
		),
	]);
}

describe('lazy loads racing', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a dropped load waiting on a later one that rejects still settles and resolves', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		let ended!: Transaction;
		await db.transaction(async tx => {
			ended = tx;
		});

		const first = ann.load('posts');
		ann.$relations.clear('posts');
		const second = ann.load('posts', ended);

		const secondError = await rejection(second);
		const settled = await within(first, 2000);

		expect(secondError).toBeInstanceOf(Error);
		expect(settled).not.toBe('pending');
		expect((settled as Collection<Post>).length).toBe(2);
	});

	test('a rollback does not put back an older value over one loaded outside the transaction afterwards', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		await ann.load('posts');
		let outside: Collection<Post> | undefined;

		await rejection(
			db.transaction(async tx => {
				await ann.refresh(['posts'], tx);
				// Another flow of the app refreshes outside the transaction.
				await ann.refresh(['posts.comments']);
				outside = ann.posts;
				throw new Error('undo');
			}),
		);

		expect(ann.posts).toBe(outside!);
		expect(() => ann.posts.at(0)!.comments).not.toThrow();
	});

	test('two loads in one rolled-back transaction put back the value from before it', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		const before = await ann.load('posts');

		await rejection(
			db.transaction(async tx => {
				await ann.refresh(['posts'], tx);
				await tx.savepoint(async () => {
					await ann.refresh(['posts'], tx);
				});
				throw new Error('undo');
			}),
		);

		expect(ann.posts).toBe(before);
	});

	test('a failed savepoint puts back the value loaded inside it, and the outer transaction commits', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		const before = await ann.load('posts');

		await db.transaction(async tx => {
			await rejection(
				tx.savepoint(async () => {
					await ann.refresh(['posts'], tx);
					throw new Error('undo inner');
				}),
			);
		});

		expect(ann.posts).toBe(before);
	});

	test('a nested load whose child segment is cleared while its query is answered loads it again', async () => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		const ann = (await User.find(1))!;
		await ann.load('posts');
		const post = ann.posts.at(0)!;

		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		let held = false;
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			if (!held && sql.includes('FROM `comments`')) {
				held = true;
				const answer = await original(command, args);
				await gate;
				return answer;
			}
			return original(command, args);
		};

		const loading = ann.load('posts.comments');
		while (!held) await new Promise(resolve => setTimeout(resolve, 0));
		post.$relations.clear('comments');
		release();
		await loading;

		expect(post.comments).toHaveLength(2);
	});
});

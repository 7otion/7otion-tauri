import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { OrmError } from '../../src/errors';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const T = 10_000;

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (2, 'c3', 1), (2, 'c4', 2)`,
];

/** What `promise` gave, or 'pending' after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> {
	return Promise.race([
		promise,
		new Promise<'pending'>(resolve =>
			setTimeout(() => resolve('pending'), ms),
		),
	]);
}

describe('relation loading edges', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test(
		'two loads of one path, both in flight, settle instead of looping forever',
		async () => {
			await open();
			const ann = (await User.find(1))!;
			orm.crate.calls.length = 0;

			const first = ann.load('posts');
			ann.$relations.clear('posts');
			const second = ann.load('posts');

			const settled = await within(Promise.all([first, second]), 500);
			const queries = orm.crate.statements.filter(sql =>
				sql.includes('FROM `posts`'),
			).length;

			expect(queries).toBeLessThan(10);
			expect(settled).not.toBe('pending');
		},
		T,
	);

	test(
		'a load still running when sync() clears the relation does not stall the next load',
		async () => {
			await open();
			const post = (await Post.find(1))!;

			// One reader answers late, as one of several readers may.
			const crate = orm.crate;
			const original = crate.invoke.bind(crate);
			let release!: () => void;
			const gate = new Promise<void>(resolve => (release = resolve));
			let held = false;
			crate.invoke = async (command: string, args: unknown) => {
				const sql = (args as { sql?: string } | undefined)?.sql ?? '';
				if (
					!held &&
					command.endsWith('run') &&
					sql.includes('FROM `comments`')
				) {
					held = true;
					const answer = await original(command, args);
					await gate;
					return answer;
				}
				return original(command, args);
			};

			const stale = post.load('comments');
			await new Promise(resolve => setTimeout(resolve, 20));
			expect(held).toBe(true);

			// sync() clears the relation as it ends; the next load asks again.
			await post.sync('comments', [{ body: 'only', sort: 0 }], {
				matchOn: ['body'],
			});
			const fresh = post.load('comments');
			release();

			const settled = await within(Promise.all([stale, fresh]), 500);
			expect(settled).not.toBe('pending');
		},
		T,
	);

	test(
		'a middle segment a lazy load fills in keeps the constraint it was loaded with',
		async () => {
			await open();
			const ann = (await User.query()
				.with({ 'posts.comments': query => query.where('sort', 1) })
				.where('id', 1)
				.first())!;
			expect(ann.posts.toArray().map(post => post.comments.length)).toEqual([1, 1]);

			// One post's comments are dropped; its recorded path stays.
			ann.posts.at(0)!.$relations.clear('comments');
			await ann.load('posts.comments.post');

			expect(ann.posts.at(0)!.comments.pluck('body')).toEqual(['c2']);
		},
		T,
	);

	test(
		'a nested load whose head is cleared as it resolves reloads the head under its constraint',
		async () => {
			await open();
			const ann = (await User.query()
				.with({ posts: query => query.where('published', true) })
				.where('id', 1)
				.first())!;

			ann.$relations.clear('posts');
			const head = ann.load('posts');
			void head.then(() => ann.$relations.clear('posts'));

			expect((await ann.load('posts.comments')).pluck('title')).toEqual(['A1']);
		},
		T,
	);

	test(
		'sync() refuses a member whose identifying value stores as null',
		async () => {
			const db = await orm.open();
			await db.run(
				new Statement(
					'CREATE TABLE bins (id INTEGER PRIMARY KEY); ' +
						'CREATE TABLE labels (id INTEGER PRIMARY KEY AUTOINCREMENT, bin_id INTEGER NOT NULL, tag TEXT)',
				),
			);
			class Label extends Model<typeof Label.schema> {
				static readonly schema = this.define({
					table: 'labels',
					columns: {
						id: Column.integer().primary().generated(),
						bin_id: Column.integer(),
						tag: Column.text().nullable().emptyToNull(),
					},
				});
			}
			class Bin extends Model<typeof Bin.schema> {
				static readonly schema = this.define({
					table: 'bins',
					columns: { id: Column.integer().primary() },
				});

				declare labels: Collection<Label>;
				static readonly relations = {
					labels: this.hasMany(() => Label, { foreignKey: 'bin_id' }),
				};
			}
			await Bin.createMany([{ id: 1 }]);
			const bin = (await Bin.find(1))!;

			const refused = await rejection(
				bin.sync('labels', [{ tag: '' }], { matchOn: ['tag'] }),
			);

			expect(refused).toBeInstanceOf(OrmError);
			expect(await Label.query().count()).toBe(0);
		},
		T,
	);

	test(
		'a key whose two sides store it differently still finds its rows',
		async () => {
			const db = await orm.open();
			await db.run(
				new Statement(
					'CREATE TABLE slots (at INTEGER PRIMARY KEY); ' +
						'CREATE TABLE bookings (id INTEGER PRIMARY KEY, at TEXT NOT NULL)',
				),
			);
			class Booking extends Model<typeof Booking.schema> {
				static readonly schema = this.define({
					table: 'bookings',
					columns: {
						id: Column.integer().primary().generated(),
						at: Column.date('iso'),
					},
				});
			}
			class Slot extends Model<typeof Slot.schema> {
				static readonly schema = this.define({
					table: 'slots',
					columns: { at: Column.date('unix').primary() },
				});

				declare bookings: Collection<Booking>;
				static readonly relations = {
					bookings: this.hasMany(() => Booking, { foreignKey: 'at' }),
				};
			}
			const at = new Date(1_000_000_000_000);
			await Slot.createMany([{ at }]);
			await Booking.createMany([{ at }]);

			const slots = await Slot.query().with('bookings').get();
			expect(slots.at(0)!.bookings).toHaveLength(1);
		},
		T,
	);

	test(
		'a relation loaded inside a transaction that rolls back goes back to what it was',
		async () => {
			const db = await open();
			const [first, second] = await Post.query().orderBy('id').get();
			await second!.load('comments');

			await rejection(
				db.transaction(async tx => {
					await Comment.create(
						{ post_id: first!.id, body: 'hi', sort: 9 },
						tx,
					);
					await Comment.create(
						{ post_id: second!.id, body: 'hi', sort: 9 },
						tx,
					);
					await first!.load('comments', tx);
					await second!.refresh(['comments'], tx);
					throw new Error('abort');
				}),
			);

			expect(() => first!.comments).toThrow(OrmError);
			expect(second!.comments.pluck('body')).toEqual(['c3', 'c4']);
			expect((await first!.load('comments')).pluck('body')).toEqual(['c1', 'c2']);
		},
		T,
	);

	test(
		'a relation loaded inside a savepoint that rolls back goes back, and one loaded outside it stays',
		async () => {
			const db = await open();
			const [first, second] = await Post.query().orderBy('id').get();

			await db.transaction(async tx => {
				await first!.load('comments', tx);
				await rejection(
					tx.savepoint(async () => {
						await second!.load('comments', tx);
						throw new Error('abort');
					}),
				);
			});

			expect(first!.comments).toHaveLength(2);
			expect(() => second!.comments).toThrow(OrmError);
		},
		T,
	);
});

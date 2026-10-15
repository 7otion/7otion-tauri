import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
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

describe('relation regressions', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a nested path loads again what a sync cleared beneath it', async () => {
		await open();
		const ann = (await User.find(1))!;
		const first = ann.load('posts.comments');
		await first;
		const post = ann.posts.at(0)!;

		await post.sync('comments', []);
		const again = ann.load('posts.comments');
		await again;

		// The path promises posts.comments loaded; comments on post 1 are not.
		expect(() => ann.posts.at(0)!.comments).not.toThrow();
	});

	test('a nested path loads again what a rolled-back load had loaded', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		await ann.load('posts');

		await rejection(
			db.transaction(async tx => {
				await ann.load('posts.comments', tx);
				throw new Error('undo');
			}),
		);

		await ann.load('posts.comments');
		expect(() => ann.posts.at(0)!.comments).not.toThrow();
	});

	test('a nested lazy load whose child segment is cleared meanwhile does not resolve with it unloaded', async () => {
		await open();
		const ann = (await User.find(1))!;
		await ann.load('posts');
		const post = ann.posts.at(0)!;

		const loading = ann.load('posts.comments');
		post.$relations.clear('comments');
		await loading;

		expect(() => post.comments).not.toThrow();
	});

	test('a load outside a transaction is not handed the in-flight load of one inside it', async () => {
		const db = await open();
		const ann = (await User.find(1))!;
		let outside: Promise<Collection<Post>> | undefined;

		await rejection(
			db.transaction(async tx => {
				await Post.create({ title: 'Ghost', user_id: 1 }, tx);
				const inside = ann.load('posts', tx);
				// Another part of the app, not in the transaction.
				outside = ann.load('posts');
				await inside;
				throw new Error('undo');
			}),
		);

		const seen = (await outside!).map(post => post.title);
		expect(seen).not.toContain('Ghost');
	});

	test('refresh() racing a lazy load still reloads what was loaded beneath', async () => {
		await open();
		const ann = (await User.query()
			.with('posts.comments')
			.where('id', 1)
			.first())!;

		ann.$relations.clear('posts');
		const lazy = ann.load('posts');
		const refreshing = ann.refresh();
		const settled = await within(Promise.all([lazy, refreshing]), 2000);

		expect(settled).not.toBe('pending');
		expect(() => ann.posts.map(post => post.comments.length)).not.toThrow();
	});

	test('sync scopes the rows by the key as the related column stores it, as loading does', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE days (day INTEGER PRIMARY KEY, label TEXT); ' +
					'CREATE TABLE entries (id INTEGER PRIMARY KEY, day INTEGER, body TEXT)',
			),
		);
		class Entry extends Model<typeof Entry.schema> {
			static readonly schema = this.define({
				table: 'entries',
				columns: {
					id: Column.integer().primary().generated(),
					day: Column.integer(),
					body: Column.text(),
				},
			});
		}
		class Day extends Model<typeof Day.schema> {
			static readonly schema = this.define({
				table: 'days',
				columns: {
					day: Column.date('unix').primary(),
					label: Column.text().nullable(),
				},
			});

			declare entries: Collection<Entry>;
			static readonly relations = {
				entries: this.hasMany(() => Entry, { foreignKey: 'day' }),
			};
		}

		const when = new Date(1_700_000_000_000);
		await Day.create({ day: when, label: 'd' });
		await db.run(
			new Statement(
				"INSERT INTO entries (day, body) VALUES (1700000000, 'x')",
			),
		);
		const day = (await Day.find(when))!;
		expect((await day.load('entries')).pluck('body')).toEqual(['x']);

		await day.sync('entries', [{ body: 'x' }], { matchOn: ['body'] });

		const { rows } = await db.run(
			new Statement(
				'SELECT day, typeof(day) AS t, body FROM entries',
			) as never,
		);
		expect(rows).toEqual([{ day: 1700000000, t: 'integer', body: 'x' }]);
	});

	test('morphTo resolves a type value that its nocase type column matches for morphMany', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE memos (id INTEGER PRIMARY KEY, kind TEXT COLLATE NOCASE, ref INTEGER, body TEXT); ' +
					"INSERT INTO memos (kind, ref, body) VALUES ('USER', 1, 'm')",
			),
		);
		class Memo extends Model<typeof Memo.schema> {
			static readonly schema = this.define({
				table: 'memos',
				columns: {
					id: Column.integer().primary().generated(),
					kind: Column.text().nullable().nocase(),
					ref: Column.integer().nullable(),
					body: Column.text(),
				},
			});

			declare target: Model | null;
			static readonly relations = {
				target: this.morphTo({
					typeColumn: 'kind',
					keyColumn: 'ref',
					types: { user: () => Owner },
				}),
			};
		}
		class Owner extends Model<typeof Owner.schema> {
			static readonly schema = this.define({
				table: 'users',
				columns: { id: Column.integer().primary(), name: Column.text() },
			});

			declare memos: Collection<Memo>;
			static readonly relations = {
				memos: this.morphMany(() => Memo, {
					foreignKey: 'ref',
					typeColumn: 'kind',
					typeValue: 'user',
				}),
			};
		}

		const owner = (await Owner.query()
			.with('memos')
			.where('id', 1)
			.first())!;
		const memo = (await Memo.query().with('target').first())!;

		expect(owner.memos).toHaveLength(1);
		expect(memo.target).not.toBeNull();
	});

	test('sync of another parent’s member models creates copies instead of failing on their ids', async () => {
		await open();
		const ann = (await User.query().with('posts').where('id', 1).first())!;
		const cy = (await User.find(3))!;

		const result = await cy.sync('posts', ann.posts.rows, { matchOn: ['title'] });

		expect(result).toEqual({
			attached: 2,
			detached: 0,
			updated: 0,
			unchanged: 0,
		});
	});
});

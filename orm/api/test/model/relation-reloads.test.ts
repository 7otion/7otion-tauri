import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
];

describe('a loaded relation follows the row it hangs off', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('an insert reloads a loaded relation keyed off the id the database generated', async () => {
		await open();
		Post.registerEvent('create:after', async (written, tx) => {
			for (const [post] of written) {
				await Comment.create({ post_id: post.id, body: 'first', sort: 0 }, tx);
			}
		});
		const post = new Post().fill({ title: 'Draft', user_id: 1 });
		expect(await post.load('comments')).toHaveLength(0);

		await post.save();

		expect(post.comments.pluck('body')).toEqual(['first']);
	});

	test('a refresh inside a transaction that rolls back leaves the row and its relation as committed', async () => {
		const db = await open();
		const post = (await Post.query().with('author').where('id', 1).first())!;

		await rejection(
			db.transaction(async tx => {
				const other = (await Post.find(1, tx))!;
				other.draft().user_id = 2;
				await other.save(tx);
				await post.refresh(undefined, tx);
				expect(post.author!.name).toBe('Bob');
				throw new Error('undo');
			}),
		);

		expect([post.user_id, post.author!.id]).toEqual([1, 1]);
	});

	test('load() during a refresh, once the relation is replaced, is handed the new value', async () => {
		await open();
		const slow =
			'(WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000) ' +
			'SELECT count(*) FROM c) > 0';
		const ann = (await User.query()
			.with('posts', { 'posts.comments': query => query.whereRaw(slow) })
			.where('id', 1)
			.first())!;
		const old = await ann.load('posts');

		const refreshing = ann.refresh();
		while (ann.$relations.held('posts') === old) {
			await new Promise(resolve => setTimeout(resolve, 1));
		}
		const again = await ann.load('posts');
		const now = ann.posts;
		await refreshing;

		expect(again === old).toBe(false);
		expect(again).toBe(now);
	});

	test('a load on its way when its key is saved ends on the new key', async () => {
		const db = await open();
		const post = (await Post.find(1))!;

		// Every reader busy, so the load waits for one while the save runs on the writer.
		const slow = Array.from({ length: 4 }, () =>
			db.run(
				new Statement(
					'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3000000) ' +
						'SELECT count(*) AS n FROM c',
				),
			),
		);
		const loading = post.load('author');
		post.draft().user_id = 2;
		await post.save();
		await Promise.all([loading, ...slow]);

		expect(post.author!.id).toBe(2);
	});
});

describe('sync tells members apart as the rows already there are', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('a match column’s mutator runs first, so an unchanged set stays unchanged', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE items (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL, name TEXT NOT NULL)',
			),
		);
		class Item extends Model<typeof Item.schema> {
			static readonly schema = this.define({
				table: 'items',
				columns: {
					id: Column.integer().primary().generated(),
					owner_id: Column.integer(),
					name: Column.text(),
				},
			});

			static readonly mutators = this.mutate({
				name: value => value.trim().toLowerCase(),
			});
		}
		class Owner extends Model<typeof Owner.schema> {
			static readonly schema = this.define({
				table: 'users',
				columns: { id: Column.integer().primary(), name: Column.text() },
			});

			declare items: Collection<Item>;
			static readonly relations = {
				items: this.hasMany(() => Item, { foreignKey: 'owner_id' }),
			};
		}

		const owner = (await Owner.find(1))!;
		await owner.sync('items', ['Red'], { matchOn: ['name'] });
		const second = await owner.sync('items', [' red '], { matchOn: ['name'] });

		expect(second).toEqual({ attached: 0, detached: 0, updated: 0, unchanged: 1 });
	});

	test('a morph’s type column in the key is the ORM’s, so bare members are taken', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE labels (kind TEXT NOT NULL, ref INTEGER NOT NULL, tag TEXT NOT NULL, ' +
					'PRIMARY KEY (kind, ref, tag))',
			),
		);
		class Label extends Model<typeof Label.schema> {
			static readonly schema = this.define({
				table: 'labels',
				columns: {
					kind: Column.text().primary(),
					ref: Column.integer().primary(),
					tag: Column.text().primary(),
				},
			});
		}
		class Owner extends Model<typeof Owner.schema> {
			static readonly schema = this.define({
				table: 'users',
				columns: { id: Column.integer().primary(), name: Column.text() },
			});

			declare labels: Collection<Label>;
			static readonly relations = {
				labels: this.morphMany(() => Label, {
					foreignKey: 'ref',
					typeColumn: 'kind',
					typeValue: 'owner',
				}),
			};
		}

		const owner = (await Owner.find(1))!;

		expect(await owner.sync('labels', ['a', 'b'])).toEqual({
			attached: 2,
			detached: 0,
			updated: 0,
			unchanged: 0,
		});
	});
});

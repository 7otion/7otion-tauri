import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import { Note, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1), (NULL, 'Orphan', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
	`INSERT INTO notes (target_kind, target_id, body) VALUES
		('user', 1, 'on ann'), ('post', 1, 'on post 1')`,
];

describe('relation edges', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('aggregates and paginate work on a query that has a join', async () => {
		await open();
		const query = Post.query()
			.join('users', 'users.id', '=', 'posts.user_id')
			.where('users.name', 'Ann')
			.orderBy('posts.id');

		expect(await query.count()).toBe(2);
		const page = await query.paginate(1, 1);
		expect(page.total).toBe(2);
		expect(page.data.pluck('title')).toEqual(['A1']);
	});

	test('load(a) and load(a.b) begun together resolve to the one list the property holds', async () => {
		await open();
		const ann = (await User.find(1))!;

		const [fromPosts, fromNested] = await Promise.all([
			ann.load('posts'),
			ann.load('posts.comments'),
		]);

		expect(fromPosts).toBe(ann.posts);
		expect(fromNested).toBe(ann.posts);
		expect(
			fromPosts.toArray().map(post => post.$relations.has('comments')),
		).toEqual([true, true]);
		expect(
			orm.crate.statements.filter(sql => sql.includes('FROM `posts`')),
		).toHaveLength(1);
	});

	test('a load whose result was dropped by a clear loads again, rather than resolving to nothing', async () => {
		await open();
		const ann = (await User.find(1))!;

		const loading = ann.load('posts');
		ann.$relations.clear('posts');

		expect(await loading).toHaveLength(2);
		expect(ann.posts).toHaveLength(2);
	});

	test('a listener that starts a load during sync() is handed the synced relation', async () => {
		await open();
		const ann = (await User.find(1))!;
		let started: Promise<Collection<Post>> | undefined;
		Post.registerEvent('create:committed', () => {
			started = ann.load('posts');
		});

		await ann.sync('posts', ['A1', 'A2', 'New'], { matchOn: ['title'] });

		expect((await started!).pluck('title').sort()).toEqual([
			'A1',
			'A2',
			'New',
		]);
	});

	test('a load begun before a sync, answered after it, does not overwrite the fresh relation', async () => {
		await open();
		const ann = (await User.find(1))!;

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
				sql.includes('FROM `posts`')
			) {
				held = true;
				const answer = await original(command, args);
				await gate;
				return answer;
			}
			return original(command, args);
		};

		const stale = ann.load('posts');
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(held).toBe(true);

		await ann.sync('posts', ['A1', 'A2', 'New'], { matchOn: ['title'] });
		const fresh = await ann.load('posts');
		release();
		await stale;

		const titles = (posts: Collection<Post>) => posts.pluck('title').sort();
		expect(titles(fresh)).toEqual(['A1', 'A2', 'New']);
		expect(titles(ann.posts)).toEqual(['A1', 'A2', 'New']);
	});

	test('a lazy nested load after a clear reloads the head under the constraint it was loaded with', async () => {
		await open();
		const ann = (await User.query()
			.with({ posts: query => query.where('published', true) })
			.where('id', 1)
			.first())!;

		ann.$relations.clear('posts');
		const posts = await ann.load('posts.comments');

		expect(posts.pluck('title')).toEqual(['A1']);
		expect(posts.at(0)!.comments).toHaveLength(2);
	});

	test('a path that cannot be loaded loads and records nothing, so refresh() still works', async () => {
		await open();
		const ann = (await User.find(1))!;

		const error = await rejection(ann.load('posts.nope' as never));

		expect(error.message).toContain(
			"Post declares no relation named 'nope'",
		);
		expect(ann.$relations.has('posts')).toBe(true);
		expect([...ann.$relations.paths.keys()]).toEqual(['posts']);
		await ann.refresh();
	});

	test('an insert reloads a loaded relation whose key it wrote, as an update does', async () => {
		await open();
		const post = new Post().fill({ title: 'Draft', user_id: 1 });
		// A relation follows committed values, of which a row never saved has none.
		expect(await post.load('author')).toBeNull();

		post.draft().user_id = 2;
		await post.save();

		expect(post.author!.name).toBe('Bob');
	});

	test('a rollback that puts a key change back as pending puts the relation back too', async () => {
		const db = await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;

		await rejection(
			db.transaction(async tx => {
				post.draft().user_id = 2;
				await post.save(tx);
				expect(post.author!.name).toBe('Bob');
				throw new Error('undo');
			}),
		);

		expect(post.getPending()).toEqual({ user_id: { from: 1, to: 2 } });
		expect(post.author!.name).toBe('Ann');

		await post.save();
		expect(post.author!.name).toBe('Bob');
	});

	test('sync never lets a member row move a morphMany row to another type or parent', async () => {
		await open();
		const ann = (await User.find(1))!;

		await ann.sync(
			'notes',
			[{ body: 'on ann', target_kind: 'post', target_id: 9 }],
			{ matchOn: ['body'] },
		);

		const note = (await Note.query().where('body', 'on ann').first())!;
		expect([note.target_kind, note.target_id]).toEqual(['user', 1]);
	});

	test('composite text keys holding the signature separator do not collide', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE shelves (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b)); ' +
					'CREATE TABLE volumes (id INTEGER PRIMARY KEY, a TEXT NOT NULL, b TEXT NOT NULL)',
			),
		);
		class Volume extends Model<typeof Volume.schema> {
			static readonly schema = this.define({
				table: 'volumes',
				columns: {
					id: Column.integer().primary().generated(),
					a: Column.text(),
					b: Column.text(),
				},
			});
		}
		class Shelf extends Model<typeof Shelf.schema> {
			static readonly schema = this.define({
				table: 'shelves',
				columns: {
					a: Column.text().primary(),
					b: Column.text().primary(),
				},
			});

			declare volumes: Collection<Volume>;
			static readonly relations = {
				volumes: this.hasMany(() => Volume, { foreignKey: ['a', 'b'] }),
			};
		}

		const nul = String.fromCharCode(0);
		await Shelf.createMany([
			{ a: `x${nul}y`, b: 'z' },
			{ a: 'x', b: `y${nul}z` },
		]);
		await Volume.createMany([{ a: `x${nul}y`, b: 'z' }]);

		const shelves = await Shelf.query().with('volumes').orderBy('a').get();

		expect(shelves.toArray().map(shelf => shelf.volumes.length)).toEqual([
			0, 1,
		]);
	});
});

/** Never run: the compiler is the test. */
export async function typesAreChecked(): Promise<void> {
	const post = new Post();
	await post.sync('comments', [{ body: 'x', sort: 1 }, 7]);
	await post.sync('comments', ['first', { body: 'second' }], {
		matchOn: ['body'],
	});
	await post.sync('comments', [3], { matchOn: ['sort'] });
	await post.sync('comments', [{ sort: 1, body: 'x' }], {
		matchOn: ['sort', 'body'],
	});

	// @ts-expect-error a member row names the related model's columns
	await post.sync('comments', [{ nope: 1 }]);
	// @ts-expect-error a bare member is the match column's value: `id` is a number
	await post.sync('comments', ['bare']);
	// @ts-expect-error `sort` is a number
	await post.sync('comments', ['x'], { matchOn: ['sort'] });
	// @ts-expect-error two match columns take no bare member
	await post.sync('comments', [1], { matchOn: ['sort', 'body'] });
	// @ts-expect-error not a column
	await post.sync('comments', [], { matchOn: ['nope'] });
	// @ts-expect-error a to-one relation has no set
	await post.sync('author', []);
}

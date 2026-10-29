import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { OrmError } from '../../src/errors';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import {
	Comment,
	Note,
	Order,
	OrderLine,
	Post,
	Profile,
	Role,
	User,
} from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	"INSERT INTO users (name) VALUES ('Ann'), ('Bob'), ('Cy')",
	"INSERT INTO profiles (user_id, bio) VALUES (1, 'ann bio')",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'A1', 1), (1, 'A2', 0), (2, 'B1', 1), (NULL, 'Orphan', 1)`,
	`INSERT INTO comments (post_id, body, sort) VALUES
		(1, 'c1', 2), (1, 'c2', 1), (3, 'c3', 1)`,
	"INSERT INTO roles (name) VALUES ('admin'), ('editor'), ('viewer')",
	'INSERT INTO user_roles (user_id, role_id) VALUES (1, 1), (1, 2), (2, 2), (1, 2)',
	`INSERT INTO notes (target_kind, target_id, body) VALUES
		('user', 1, 'on ann'), ('post', 1, 'on post 1'), ('user', 2, 'on bob'),
		('ghost', 1, 'unmapped'), (NULL, NULL, 'loose')`,
	"INSERT INTO orders (tenant, number, total) VALUES ('acme', 1, 10), ('zeta', 1, 20)",
	`INSERT INTO order_lines (tenant, order_number, sku) VALUES
		('acme', 1, 'a'), ('acme', 1, 'b'), ('zeta', 1, 'z')`,
];

describe('relations', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('an unloaded relation is an error to read, and says how to load it', async () => {
		await open();
		const ann = (await User.find(1))!;

		expect(() => ann.posts).toThrow(OrmError);
		expect(() => ann.posts).toThrow(
			"User.posts is not loaded. Load it with with('posts') on the query, or await load('posts') on the instance.",
		);
	});

	test('with() loads each relation in one query, however many parents', async () => {
		await open();

		const users = await User.query()
			.with('posts', 'profile')
			.orderBy('id')
			.get();

		expect(users.toArray().map(user => user.posts.pluck('title'))).toEqual([
			['A1', 'A2'],
			['B1'],
			[],
		]);
		expect(users.toArray().map(user => user.profile?.bio ?? null)).toEqual([
			'ann bio',
			null,
			null,
		]);
		expect(orm.crate.statements).toHaveLength(3);
	});

	test('dotted paths load through, and a shared prefix loads once', async () => {
		await open();

		const [ann] = await User.query()
			.where('id', 1)
			.with('posts.comments', 'posts.author', 'posts')
			.get();

		expect(ann!.posts.at(0)!.comments.pluck('body')).toEqual(['c1', 'c2']);
		expect(ann!.posts.at(1)!.author!.name).toBe('Ann');
		// users, posts, comments, authors.
		expect(orm.crate.statements).toHaveLength(4);
	});

	test('a constraint shapes the query of its path, and must return the query it built', async () => {
		await open();

		const [ann] = await User.query()
			.where('id', 1)
			.with({
				posts: query => query.where('published', true),
				'posts.comments': query => query.orderBy('sort'),
			})
			.get();

		expect(ann!.posts.pluck('title')).toEqual(['A1']);
		expect(ann!.posts.at(0)!.comments.pluck('body')).toEqual(['c2', 'c1']);

		const error = await rejection(
			User.query()
				.with({ posts: (() => undefined) as never })
				.get(),
		);
		expect(error.message).toContain(
			"The constraint on 'posts' returned nothing",
		);
	});

	test('a constraint holding an OR cannot widen the load past its own parents', async () => {
		await open();

		const [bob] = await User.query()
			.where('id', 2)
			.with({
				posts: query =>
					query.where('published', true).orWhere('title', 'A2'),
			})
			.get();

		expect(bob!.posts.pluck('title')).toEqual(['B1']);
	});

	test('a constraint that selects its own columns still matches its parents', async () => {
		await open();

		const [ann] = await User.query()
			.where('id', 1)
			.with({ posts: query => query.select('title') })
			.get();
		const [post] = await Post.query()
			.where('id', 1)
			.with({ author: query => query.select('name') })
			.get();

		expect(ann!.posts.pluck('title')).toEqual(['A1', 'A2']);
		expect(post!.author!.name).toBe('Ann');
		expect(
			orm.crate.statements.some(sql =>
				sql.includes('`posts`.`title`, `posts`.`user_id`'),
			),
		).toBe(true);
	});

	test('a parent selected without the column its relation keys off is refused', async () => {
		await open();

		const error = await rejection(
			Post.query().select('id', 'title').with('author').get(),
		);

		expect(error.message).toContain(
			"Post rows were selected without user_id, which 'author' is keyed on",
		);
	});

	test('belongsTo resolves the owner, and null when the key is unset', async () => {
		await open();

		const posts = await Post.query().with('author').orderBy('id').get();

		expect(posts.toArray().map(post => post.author?.name ?? null)).toEqual([
			'Ann',
			'Ann',
			'Bob',
			null,
		]);
		// One related instance for both of Ann's posts.
		expect(posts.at(0)!.author).toBe(posts.at(1)!.author);
	});

	test('two parents on one key each get their own list', async () => {
		await open();

		const lines = await OrderLine.query().with('order.lines').get();
		const [first, second] = lines
			.toArray()
			.filter(line => line.tenant === 'acme');

		expect(first!.order).toBe(second!.order);
		expect(first!.order!.lines).toHaveLength(2);
	});

	test('belongsToMany goes through the pivot, each related row once, in the order asked', async () => {
		await open();

		const users = await User.query()
			.with({ roles: query => query.orderBy('name', 'desc') })
			.orderBy('id')
			.get();

		expect(users.toArray().map(user => user.roles.pluck('name'))).toEqual([
			['editor', 'admin'],
			['editor'],
			[],
		]);
		expect(users.at(0)!.roles.at(0)).toBeInstanceOf(Role);
	});

	test('morphMany matches the type as well as the key', async () => {
		await open();

		const users = await User.query().with('notes').orderBy('id').get();

		expect(users.toArray().map(user => user.notes.pluck('body'))).toEqual([
			['on ann'],
			['on bob'],
			[],
		]);
	});

	test('morphTo picks the target model per row, and null where nothing is aimed at', async () => {
		await open();
		const warned: unknown[] = [];
		const warn = console.warn;
		console.warn = (...args: unknown[]) => void warned.push(args[0]);

		try {
			const notes = await Note.query().with('target').orderBy('id').get();

			expect(
				notes.toArray().map(note => note.target?.constructor.name),
			).toEqual(['User', 'Post', 'User', undefined, undefined]);
			expect((notes.at(1)!.target as Post).title).toBe('A1');
			expect(warned).toEqual([
				'[orm] No model is mapped for target_kind = "ghost".',
			]);
		} finally {
			console.warn = warn;
		}
	});

	test('a path cannot go on through a polymorphic relation', async () => {
		await open();

		const error = await rejection(
			Note.query()
				.where('target_kind', 'user')
				.with('target.posts' as never)
				.get(),
		);

		expect(error.message).toContain("'target' is polymorphic");
	});

	test('relations match on composite keys', async () => {
		await open();

		const orders = await Order.query()
			.with('lines')
			.orderBy('tenant')
			.get();
		const lines = await OrderLine.query().with('order').get();

		expect(orders.toArray().map(order => order.lines.pluck('sku'))).toEqual(
			[['a', 'b'], ['z']],
		);
		expect(lines.toArray().map(line => line.order!.total)).toEqual([
			10, 10, 20,
		]);
	});

	test('keys whose two sides declare different codecs match in the form they are stored', async () => {
		await open();
		class Flagged extends Model<typeof Flagged.schema> {
			static readonly schema = this.define({
				table: 'comments',
				columns: {
					id: Column.integer().primary(),
					post_id: Column.boolean(),
					body: Column.text(),
				},
			});
		}
		class FirstPost extends Model<typeof FirstPost.schema> {
			static readonly schema = this.define({
				table: 'posts',
				columns: {
					id: Column.integer().primary(),
					title: Column.text(),
				},
			});

			declare flagged: Collection<Flagged>;
			static readonly relations = {
				flagged: this.hasMany(() => Flagged, { foreignKey: 'post_id' }),
			};
		}

		const [post] = await FirstPost.query()
			.where('id', 1)
			.with('flagged')
			.get();

		expect(post!.flagged.pluck('body')).toEqual(['c1', 'c2']);
	});

	test('a batch larger than SQLite allows in one statement is loaded in several', async () => {
		await open();
		await Post.createMany(
			Array.from({ length: 33_000 }, (_, index) => ({
				title: `Bulk ${index}`,
				user_id: null,
				published_at: null,
			})),
		);
		orm.crate.calls.length = 0;

		const posts = await Post.query().with('comments').get();

		expect(posts.length).toBe(33_004);
		expect(
			orm.crate.statements.filter(sql => sql.includes('`comments`')),
		).toHaveLength(2);
		expect(posts.at(0)!.comments).toHaveLength(2);
	}, 30_000);

	test('a never-saved model still loads an empty relation', async () => {
		await open();

		expect(await new User().load('posts')).toHaveLength(0);
	});

	test('a relation that is not declared is refused by name', async () => {
		await open();
		const ann = (await User.find(1))!;

		expect((await rejection(ann.load('nope' as never))).message).toContain(
			"User declares no relation named 'nope'",
		);
		expect(
			(
				await rejection(
					User.query()
						.with('nope' as never)
						.get(),
				)
			).message,
		).toContain("User declares no relation named 'nope'");
	});

	test('a relation cannot be assigned, while a column of the row it holds can', async () => {
		await open();
		const post = (await Post.query()
			.with('author')
			.where('id', 1)
			.first())!;
		const cy = (await User.find(3))!;

		expect(() => {
			post.author = cy;
		}).toThrow('cannot be assigned');
		post.author!.draft().name = 'John';

		expect(post.author!.draft().name).toBe('John');
		expect(post.author!.id).toBe(1);
	});

	test('a relation cannot take the name of a column or of a model member', () => {
		class Clash extends Model<typeof Clash.schema> {
			static readonly schema = this.define({
				table: 'posts',
				columns: {
					id: Column.integer().primary(),
					title: Column.text(),
				},
			});

			static readonly relations = {
				title: this.hasMany(() => Comment, { foreignKey: 'post_id' }),
			};
		}
		class Member extends Model<typeof Member.schema> {
			static readonly schema = this.define({
				table: 'posts',
				columns: { id: Column.integer().primary() },
			});

			static readonly relations = {
				save: this.hasMany(() => Comment, { foreignKey: 'post_id' }),
			};
		}

		expect(() => new Clash()).toThrow('both a column and a relation');
		expect(() => new Member()).toThrow(
			"'save' cannot name a column or relation",
		);
	});

	test('a class field named after a relation is refused, since it hides the relation', async () => {
		await open();
		class Shadowed extends Model<typeof Shadowed.schema> {
			static readonly schema = this.define({
				table: 'posts',
				columns: { id: Column.integer().primary() },
			});

			comments!: Comment[];
			static readonly relations = {
				comments: this.hasMany(() => Comment, {
					foreignKey: 'post_id',
				}),
			};
		}

		expect((await rejection(Shadowed.all())).message).toContain(
			'declare comments: …',
		);
	});

	test('key lists of different lengths are refused', () => {
		expect(() =>
			Order.hasMany(() => OrderLine, {
				foreignKey: ['tenant'],
			}),
		).toThrow('both sides need the same number of columns');
	});
});

describe('lazy loading', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('load() resolves to the relation, which then reads as a property', async () => {
		await open();
		const ann = (await User.find(1))!;

		const posts = await ann.load('posts');

		expect(posts.pluck('title')).toEqual(['A1', 'A2']);
		expect(ann.posts).toBe(posts);
		expect(await (await Post.find(4))!.load('author')).toBeNull();
	});

	test('a second load of a path joins the one on its way, and one made after it landed asks nothing', async () => {
		await open();
		const ann = (await User.find(1))!;

		const first = ann.load('posts');
		const second = ann.load('posts');
		const posts = await first;
		const third = ann.load('posts');

		expect(second).toBe(first);
		expect(await third).toBe(posts);
		expect(
			orm.crate.statements.filter(sql => sql.includes('`posts`')),
		).toHaveLength(1);
	});

	test('a relation already loaded by with() is handed over without a query', async () => {
		await open();
		const [ann] = await User.query().where('id', 1).with('posts').get();
		orm.crate.calls.length = 0;

		const posts = await ann!.load('posts');

		expect(posts).toBe(ann!.posts);
		expect(ann!.load('posts')).toBe(ann!.load('posts'));
		expect(orm.crate.calls).toEqual([]);
	});

	test('a dotted path loads only what is missing, on the instances already held', async () => {
		await open();
		const ann = (await User.find(1))!;
		const posts = await ann.load('posts');
		orm.crate.calls.length = 0;

		const again = await ann.load('posts.comments');

		expect(again).toBe(posts);
		expect(posts.at(0)!.comments.pluck('body')).toEqual(['c1', 'c2']);
		expect(orm.crate.statements).toHaveLength(1);
	});

	test('a failed load is forgotten, so the next call tries again', async () => {
		await open();
		const ann = (await User.find(1))!;
		orm.crate.failNext('run', {
			code: 'unknown',
			message: 'disk I/O error',
			transactionEnded: false,
		});

		const failed = ann.load('posts');
		expect((await rejection(failed)).message).toContain('disk I/O error');

		const retried = ann.load('posts');
		expect(retried).not.toBe(failed);
		expect(await retried).toHaveLength(2);
	});

	test('a key assigned while its relation loads does not lose the rows', async () => {
		await open();
		const post = (await Post.find(1))!;

		const loading = post.load('comments');
		post.draft().id = 99;
		await loading;

		expect(post.comments).toHaveLength(2);
	});

	test('a load inside a transaction reads through its handle', async () => {
		const db = await open();

		await db.transaction(async tx => {
			const ann = (await User.find(1, tx))!;
			await Post.create({ title: 'New', user_id: 1 }, tx);

			expect(await ann.load('posts', tx)).toHaveLength(3);
		});
	});
});

describe('reloading', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('changing a key a loaded relation depends on reloads that relation, under its constraint', async () => {
		await open();
		const [post] = await Post.query()
			.where('id', 3)
			.with({ author: query => query.select('id', 'name') }, 'comments')
			.get();
		const before = post!.load('author');
		orm.crate.calls.length = 0;

		post!.draft().user_id = 1;
		await post!.save();

		expect(post!.author!.toObject()).toEqual({ id: 1, name: 'Ann' });
		expect(post!.load('author')).not.toBe(before);
		// The update and the author; comments are keyed off id, which did not move.
		expect(orm.crate.statements).toHaveLength(2);
	});

	test('updateMany reloads a relation whose key moved, as save does', async () => {
		await open();
		const posts = await Post.query().with('author').orderBy('id').get();

		posts.at(2)!.draft().user_id = 1;
		posts.at(3)!.draft().title = 'Renamed';
		await Post.updateMany(posts.rows);

		expect(posts.at(2)!.author!.name).toBe('Ann');
	});

	test('refresh re-reads the row and replays what was loaded, constraints included', async () => {
		const db = await open();
		const [ann] = await User.query()
			.where('id', 1)
			.with({ posts: query => query.where('published', true) })
			.get();
		ann!.draft().name = 'pending edit';
		await Post.create({
			title: 'A3',
			user_id: 1,
			published: true,
		} as never);
		await Post.query().where('title', 'A3').update({ published: true });
		await User.query().where('id', 1).update({ age: 44 });
		void db;

		await ann!.refresh();

		// A pending edit is nobody's to override but discard's.
		expect(ann!.draft().name).toBe('pending edit');
		expect(ann!.name).toBe('Ann');
		expect(ann!.age).toBe(44);
		expect(ann!.getDirty()).toEqual(['name']);
		expect(ann!.posts.pluck('title')).toEqual(['A1', 'A3']);
	});

	test('refresh of named paths reloads those, and the path above them as it was loaded', async () => {
		await open();
		const [ann] = await User.query()
			.where('id', 1)
			.with({ posts: query => query.where('published', true) }, 'profile')
			.get();
		await Comment.create({ post_id: 1, body: 'c4', sort: 9 });
		orm.crate.calls.length = 0;

		await ann!.refresh(['posts.comments']);

		expect(ann!.posts.pluck('title')).toEqual(['A1']);
		expect(ann!.posts.at(0)!.comments).toHaveLength(3);
		// The row, the posts, the comments; the profile was not asked for.
		expect(orm.crate.statements).toHaveLength(3);
	});

	test('refresh needs the key, and a row that still exists', async () => {
		await open();
		const [partial] = await User.query().select('name').get();
		const ann = (await User.find(1))!;
		await User.query().where('id', 1).delete();

		expect((await rejection(partial!.refresh())).message).toContain(
			'without its primary key',
		);
		expect((await rejection(ann.refresh())).message).toContain(
			'no longer exists',
		);
	});
});

describe('sync', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('sync makes the far side hold exactly the given set', async () => {
		await open();
		const post = (await Post.query().where('id', 1).with('tags').first())!;
		await post.sync('tags', ['a', 'b']);

		const result = await post.sync('tags', [{ tag: 'b', sort: 5 }, 'c']);

		expect(result).toEqual({
			attached: 1,
			detached: 1,
			updated: 1,
			unchanged: 0,
		});
		expect(
			(await post.load('tags'))
				.toArray()
				.map(tag => [tag.tag, tag.sort])
				.sort(),
		).toEqual([
			['b', 5],
			['c', 0],
		]);
	});

	test('sync matches on the columns given, and sets the foreign key past fillable', async () => {
		await open();
		const post = (await Post.find(1))!;

		const result = await post.sync(
			'comments',
			[
				{ body: 'c1', sort: 7 },
				{ body: 'new', sort: 1, post_id: 999 },
			],
			{ matchOn: ['body'] },
		);

		expect(result).toEqual({
			attached: 1,
			detached: 1,
			updated: 1,
			unchanged: 0,
		});
		expect(
			await Comment.query()
				.where('post_id', 1)
				.orderBy('id')
				.pluck('body'),
		).toEqual(['c1', 'new']);
		expect(await Comment.query().where('post_id', 3).count()).toBe(1);
	});

	test('sync keeps a morph to its own type', async () => {
		await open();
		const ann = (await User.find(1))!;

		await ann.sync('notes', [{ body: 'fresh' }], {
			matchOn: ['body'],
		});

		expect(
			await Note.query()
				.where('target_id', 1)
				.orderBy('id')
				.pluck('body'),
		).toEqual(['on post 1', 'unmapped', 'fresh']);
		expect(
			await Note.query().where('body', 'fresh').value('target_kind'),
		).toBe('user');
	});

	test('sync rolls back as a whole, and the loaded relation stays as it was', async () => {
		await open();
		const post = (await Post.query()
			.where('id', 1)
			.with('comments')
			.first())!;
		const comments = post.comments;

		// The rows it replaces are deleted first; then the insert breaks NOT NULL.
		const error = await rejection(
			post.sync('comments', [{ sort: 5, body: null }], {
				matchOn: ['sort'],
			}),
		);

		expect(error).toBeInstanceOf(OrmError);
		expect(await Comment.query().where('post_id', 1).count()).toBe(2);
		expect(post.comments).toBe(comments);
		expect(comments.pluck('body')).toEqual(['c1', 'c2']);
	});

	test('sync leaves the loaded relation loaded, showing the synced set', async () => {
		await open();
		const post = (await Post.query()
			.where('id', 1)
			.with('comments')
			.first())!;
		const comments = post.comments;

		await post.sync('comments', [{ body: 'only', sort: 0 }], {
			matchOn: ['body'],
		});

		expect(post.comments).toBe(comments);
		expect(comments.pluck('body')).toEqual(['only']);
	});

	test('sync refuses two members with one identity', async () => {
		await open();
		const post = (await Post.find(1))!;

		const error = await rejection(post.sync('tags', ['a', 'a']));

		expect(error.message).toContain('two members identified by tag = a');
	});

	test('a to-one relation, and a parent without its key, have no set to sync', async () => {
		await open();
		const post = (await Post.find(1))!;

		expect(
			(await rejection(post.sync('author' as never, []))).message,
		).toContain('has no set to sync');
		expect(
			(await rejection(new Post().sync('tags', ['a']))).message,
		).toContain('has no value, so nothing can point at it');
	});
});

/** Never run: the compiler is the test. */
export async function typesAreChecked(): Promise<void> {
	User.query().with('posts', 'posts.comments', 'posts.comments.post.author');
	User.query().with({ posts: query => query.where('title', 'x') });

	// @ts-expect-error not a relation
	User.query().with('nope');
	// @ts-expect-error not a relation of Post
	User.query().with('posts.nope');
	// @ts-expect-error title is text
	User.query().with({ posts: query => query.where('title', 1) });

	const user = new User();
	const posts: Collection<Post> = await user.load('posts');
	const samePosts: Collection<Post> = await user.load('posts.comments');
	const profile: Profile | null = await user.load('profile');
	await user.refresh(['posts.author']);
	await user.sync('posts', []);

	// @ts-expect-error not a relation
	await user.load('nope');
	// @ts-expect-error not a relation of Post
	await user.load('posts.nope');
	// @ts-expect-error a column is not a relation
	await user.load('name');
	// @ts-expect-error a to-one relation has no set
	await user.sync('profile', []);

	void [posts, samePosts, profile];
}

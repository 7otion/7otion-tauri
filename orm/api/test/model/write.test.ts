import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { DatabaseError, OrmError } from '../../src/errors';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import {
	Article,
	Comment,
	Money,
	MoneyCodec,
	Order,
	Post,
	User,
} from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

describe('writing', () => {
	const orm = OrmBed.use();

	test('saving a new model inserts it and adopts what the database filled in', async () => {
		await orm.open();
		const user = new User().fill({ name: 'Ann' });

		await user.save();

		expect(user.id).toBe(1);
		expect(user.exists).toBe(true);
		expect(user.isDirty).toBe(false);
		// Left out of the insert, so they come back with the row: a default, and NULLs.
		expect(user.active).toBe(true);
		expect(user.email).toBeNull();
		expect(orm.crate.statements).toEqual([
			'INSERT INTO `users` (`name`, `created_at`, `updated_at`) VALUES (?, ?, ?) ' +
				'RETURNING `id`, `email`, `active`, `age`, `settings`',
		]);
	});

	test('an insert that sets every column asks nothing back', async () => {
		await orm.open();

		await Order.create({ tenant: 'acme', number: 1, total: 5 });

		expect(orm.crate.statements).toEqual([
			'INSERT INTO `orders` (`tenant`, `number`, `total`) VALUES (?, ?, ?)',
		]);
	});

	test('a supplied key is kept as it is', async () => {
		await orm.open();

		const user = await User.create({ id: 40, name: 'Ann' });

		expect(user.id).toBe(40);
		expect((await User.find(40))!.name).toBe('Ann');
	});

	test('an update writes only the columns that changed', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		orm.crate.calls.length = 0;

		user.draft().age = 31;
		await user.save();

		expect(orm.crate.statements).toEqual([
			'UPDATE `users` SET `age` = ?, `updated_at` = ? WHERE `id` = ?',
		]);
		expect(user.isDirty).toBe(false);
		expect((await User.find(user.id))!.age).toBe(31);
	});

	test('a clean model is not written', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		orm.crate.calls.length = 0;

		user.draft().name = 'Ann';
		await user.save();

		expect(orm.crate.calls).toEqual([]);
	});

	test('dirty tracking reports what changed and from what', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });

		user.draft().name = 'Anna';
		user.draft().age = null;

		expect(user.isDirty).toBe(true);
		expect(user.getDirty().sort()).toEqual(['age', 'name']);
		expect(user.getPending()).toEqual({
			name: { from: 'Ann', to: 'Anna' },
			age: { from: 30, to: null },
		});
	});

	test('an object value edited in place on the draft is dirty, and the committed one cannot be reached through getPending', async () => {
		await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: ['a'] },
		});

		user.draft().settings!.tags.push('b');
		expect(user.isDirty).toBe(true);
		expect(user.settings!.tags).toEqual(['a']);

		(user.getPending().settings!.from as { tags: string[] }).tags.push('x');
		expect(user.getPending().settings!.from).toEqual({
			theme: 'dark',
			tags: ['a'],
		});

		await user.save();
		expect(user.settings!.tags).toEqual(['a', 'b']);
		expect(await User.query().where('id', user.id).pluck('settings')).toEqual([
			{ theme: 'dark', tags: ['a', 'b'] },
		]);
	});

	test('a committed object value is frozen: an edit in place on the model throws', async () => {
		await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: ['a'] },
		});

		expect(() => {
			user.settings!.theme = 'light';
		}).toThrow();
		expect(() => user.settings!.tags.push('b')).toThrow();
		expect(user.settings).toEqual({ theme: 'dark', tags: ['a'] });
	});

	test('a custom codec converts both ways and decides what counts as a change', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE products (id INTEGER PRIMARY KEY, price INTEGER)',
			),
		);
		class Product extends Model<typeof Product.schema> {
			static readonly schema = this.define({
				table: 'products',
				columns: {
					id: Column.integer().primary().generated(),
					price: Column.custom(MoneyCodec),
				},
			});
		}

		const product = await Product.create({ price: new Money(250) });
		expect(
			(await db.run(new Statement('SELECT price FROM products'))).rows,
		).toEqual([{ price: 250 }]);

		product.draft().price = new Money(250);
		expect(product.isDirty).toBe(false);
		product.draft().price = new Money(300);
		expect(product.isDirty).toBe(true);

		expect(
			await Product.query().where('price', new Money(250)).count(),
		).toBe(1);
	});

	test('timestamps are stamped on insert and refreshed on update, as they are stored', async () => {
		await orm.open();
		const before = Math.floor(Date.now() / 1000) * 1000;

		const user = await User.create({ name: 'Ann' });
		const created = user.created_at.getTime();
		expect(created).toBeGreaterThanOrEqual(before);
		expect(created % 1000).toBe(0);
		expect(user.updated_at.getTime()).toBe(created);

		user.draft().name = 'Anna';
		await user.save();
		expect(user.created_at.getTime()).toBe(created);
		expect(user.updated_at.getTime()).toBeGreaterThanOrEqual(created);
	});

	test('fill honours guarded and fillable', async () => {
		await orm.open();

		const post = new Post().fill({
			title: 'Hello',
			published: true,
		} as never);
		const comment = new Comment().fill({
			id: 9,
			post_id: 1,
			body: 'x',
			sort: 1,
		} as never);

		expect(post.draft().toObject()).toEqual({ title: 'Hello' });
		expect(comment.draft().toObject()).toEqual({ post_id: 1, body: 'x', sort: 1 });
	});

	test('fill, create, firstOrCreate and sync run a column’s mutator, and a read does not', async () => {
		const db = await orm.open();
		class Reply extends Model<typeof Reply.schema> {
			static readonly schema = this.define({
				table: 'comments',
				columns: {
					id: Column.integer().primary().generated(),
					post_id: Column.integer(),
					body: Column.text(),
					sort: Column.integer(),
				},
			});

			static readonly mutators = this.mutate({ body: value => value.trim() });
		}
		class Thread extends Model<typeof Thread.schema> {
			static readonly schema = this.define({
				table: 'posts',
				columns: {
					id: Column.integer().primary().generated(),
					title: Column.text(),
				},
			});

			declare replies: Collection<Reply>;
			static readonly relations = {
				replies: this.hasMany(() => Reply, { foreignKey: 'post_id' }),
			};
		}

		const thread = await Thread.create({ title: 't' });
		const created = await Reply.create({
			post_id: thread.id,
			body: '  created ',
			sort: 0,
		});
		const filled = new Reply().fill({
			post_id: thread.id,
			body: ' filled ',
			sort: 1,
		});
		await filled.save();

		expect([created.body, filled.body]).toEqual(['created', 'filled']);
		expect(await Reply.query().orderBy('sort').pluck('body')).toEqual([
			'created',
			'filled',
		]);

		const lookedUp = await Reply.firstOrCreate(
			{ body: ' looked up ' },
			{ post_id: thread.id, sort: 2 },
		);
		expect(lookedUp.body).toBe('looked up');

		await thread.sync('replies', [' synced '], { matchOn: ['body'] });
		expect(await Reply.query().pluck('body')).toEqual(['synced']);

		await db.run(
			new Statement(
				"INSERT INTO comments (post_id, body, sort) VALUES (1, '  raw ', 5)",
			),
		);
		expect((await Reply.query().where('sort', 5).first())!.body).toBe(
			'  raw ',
		);
	});

	test('deleting removes the row, and says when it was already gone', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		const other = await User.create({ name: 'Bob' });

		expect(await user.delete()).toBe(true);
		expect(user.exists).toBe(false);
		expect(await User.find(user.id)).toBeNull();

		await db.run(new Statement('DELETE FROM users WHERE id = ?', [other.id]));
		expect(await other.delete()).toBe(false);
		expect(other.exists).toBe(false);
	});

	test('a model that is not in the database cannot be deleted', async () => {
		await orm.open();

		const error = await rejection(new User().delete());

		expect(error).toBeInstanceOf(OrmError);
		expect(error.message).toContain('not in the database');
	});

	test('saving a model whose row is missing is an error, and leaves the model as it was', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));

		user.draft().name = 'Anna';
		const error = await rejection(user.save());

		expect(error.message).toContain('no longer exist');
		expect([user.exists, user.isDirty]).toEqual([true, true]);
	});

	test('a save whose row is missing rolls back its handlers’ writes too', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));
		User.registerEvent('update:before', async (_batch, tx) => {
			await Post.create({ title: 'undone' }, tx);
		});

		user.draft().name = 'Anna';
		const error = await rejection(user.save());

		expect(error.message).toContain('1 of 1 users rows no longer exist');
		expect(await Post.query().count()).toBe(0);
	});

	test('a committed date cannot be edited in place', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });

		expect(() => user.updated_at.setFullYear(2000)).toThrow();
		expect(user.isDirty).toBe(false);
	});

	test('a model selected without its key cannot be updated or deleted', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });
		const [partial] = await User.query().select('name').get();

		partial!.draft().name = 'Anna';
		partial!.draft().id = 99;

		expect((await rejection(partial!.save())).message).toContain(
			'without its primary key',
		);
		expect((await rejection(partial!.delete())).message).toContain(
			'without its primary key',
		);
	});

	test('a reassigned key is written against the old one', async () => {
		await orm.open();
		const order = await Order.create({
			tenant: 'acme',
			number: 1,
			total: 5,
		});

		order.draft().number = 2;
		await order.save();

		expect(await Order.find(['acme', 1])).toBeNull();
		expect((await Order.find(['acme', 2]))!.total).toBe(5);

		order.draft().total = 6;
		await order.save();
		expect((await Order.find(['acme', 2]))!.total).toBe(6);
	});

	test('an empty string is stored as null where the column says so, and reads so at once', async () => {
		const db = await orm.open();

		const article = await Article.create({ ref: 'a1', summary: '' });

		expect(article.summary).toBeNull();
		expect(article.isDirty).toBe(false);
		expect(
			(await db.run(new Statement('SELECT summary FROM articles')))
				.rows,
		).toEqual([{ summary: null }]);
	});

	test('a column assigned while its statement is on its way is not marked clean', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });

		user.draft().name = 'Anna';
		const saving = user.save();
		// The statement is built within microtasks; the crate answers a turn later.
		for (let i = 0; i < 20; i++) await Promise.resolve();
		user.draft().name = 'Annabel';
		user.draft().age = 40;
		await saving;

		expect(user.name).toBe('Anna');
		expect(user.draft().name).toBe('Annabel');
		expect(user.getDirty().sort()).toEqual(['age', 'name']);
	});

	test('saving a new model twice at once inserts one row', async () => {
		await orm.open();
		const user = new User().fill({ name: 'Ann' });

		await Promise.all([user.save(), user.save()]);

		expect(await User.query().count()).toBe(1);
	});

	test('saving a new model twice at once on one transaction inserts one row', async () => {
		const db = await orm.open();
		const user = new User().fill({ name: 'Ann' });

		await db.transaction(async tx => {
			await Promise.all([user.save(tx), user.save(tx)]);
		});

		expect(await User.query().count()).toBe(1);
	});

	test('a constraint failure is a DatabaseError with its code', async () => {
		await orm.open();
		await User.create({ name: 'Ann', email: 'a@x.io' });

		const error = await rejection(
			User.create({ name: 'Bob', email: 'a@x.io' }),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('unique');
	});
});

describe('writing inside a transaction', () => {
	const orm = OrmBed.use();

	test('a write given a transaction rolls back with it', async () => {
		const db = await orm.open();

		await rejection(
			db.transaction(async tx => {
				await User.create({ name: 'Ann' }, tx);
				expect(await User.query().count(tx)).toBe(1);
				throw new Error('stop');
			}),
		);

		expect(await User.query().count()).toBe(0);
	});

	test('a rolled-back create leaves the model new again', async () => {
		const db = await orm.open();
		const user = new User().fill({ name: 'Ann' });

		await rejection(
			db.transaction(async tx => {
				await user.save(tx);
				expect(user.id).toBe(1);
				throw new Error('stop');
			}),
		);

		expect(user.exists).toBe(false);
		expect(() => user.id).toThrow('not saved yet');
		expect(user.draft().id).toBeUndefined();
		expect(user.draft().toObject()).toEqual({ name: 'Ann' });

		await user.save();
		expect(await User.query().count()).toBe(1);
	});

	test('a rolled-back update leaves the edit pending, and keeps what was assigned meanwhile', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });

		await rejection(
			db.transaction(async tx => {
				user.draft().name = 'Anna';
				await user.save(tx);
				expect(user.name).toBe('Anna');
				user.draft().age = 2;
				throw new Error('stop');
			}),
		);

		expect(user.getPending()).toEqual({
			name: { from: 'Ann', to: 'Anna' },
			age: { from: 1, to: 2 },
		});

		await user.save();
		expect((await User.find(user.id))!.toObject()).toMatchObject({
			name: 'Anna',
			age: 2,
		});
	});

	test('a rolled-back delete leaves the model in place', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });

		await rejection(
			db.transaction(async tx => {
				await user.delete(tx);
				throw new Error('stop');
			}),
		);

		expect(user.exists).toBe(true);
		expect(await User.find(user.id)).not.toBeNull();
	});

	test('a savepoint that rolls back reverts only the models written inside it', async () => {
		const db = await orm.open();
		const kept = new User().fill({ name: 'Kept' });
		const undone = new User().fill({ name: 'Undone' });

		await db.transaction(async tx => {
			await kept.save(tx);
			await rejection(
				tx.savepoint(async () => {
					await undone.save(tx);
					throw new Error('stop');
				}),
			);
		});

		expect(kept.exists).toBe(true);
		expect(undone.exists).toBe(false);
		expect(await User.query().pluck('name')).toEqual(['Kept']);
	});

	test('a write without the handle inside a transaction fails, and says what it forgot', async () => {
		const db = await orm.open({ writerWaitMs: 30 });

		const error = await rejection(
			db.transaction(async () => {
				await User.create({ name: 'Ann' });
			}),
		);

		expect(error.code).toBe('busy');
		expect(error.message).toContain('missing the tx handle');
		expect(await User.query().count()).toBe(0);
	});
});

describe('finders that write', () => {
	const orm = OrmBed.use();

	test('firstOrCreate finds a row or makes one', async () => {
		await orm.open();

		const made = await User.firstOrCreate(
			{ email: 'a@x.io' },
			{ name: 'Ann' },
		);
		const found = await User.firstOrCreate(
			{ email: 'a@x.io' },
			{ name: 'Other' },
		);

		expect(made.id).toBe(1);
		expect(found.id).toBe(1);
		expect(found.name).toBe('Ann');
		expect(await User.query().count()).toBe(1);
	});

	test('firstOrCreate finds what it made, even by a column fill would drop', async () => {
		await orm.open();

		const first = await Post.firstOrCreate({ published: true } as never, {
			title: 'A',
		});
		const second = await Post.firstOrCreate({ published: true } as never, {
			title: 'B',
		});

		expect(first.published).toBe(true);
		expect(second.id).toBe(first.id);
	});

	test('updateOrCreate also saves the row it finds', async () => {
		await orm.open();

		await User.updateOrCreate({ email: 'a@x.io' }, { name: 'Ann' });
		const updated = await User.updateOrCreate(
			{ email: 'a@x.io' },
			{ name: 'Anna' },
		);

		expect(updated.name).toBe('Anna');
		expect(await User.query().pluck('name')).toEqual(['Anna']);
	});

	test('callers racing to firstOrCreate one row make one row, with no unique index to help', async () => {
		await orm.open();

		const users = await Promise.all(
			[1, 2, 3].map(() =>
				User.firstOrCreate({ name: 'Ann' }, { age: 30 }),
			),
		);

		expect(await User.query().count()).toBe(1);
		expect(new Set(users.map(user => user.id)).size).toBe(1);
	});

	test('a lookup by nothing, or by undefined, is refused', async () => {
		await orm.open();

		expect(() => User.firstOrCreate({})).toThrow('no columns');
		expect(() =>
			User.firstOrCreate({ email: undefined }, { name: 'x' }),
		).toThrow('an undefined email');
	});

	test('a handle given where the values go is still a handle', async () => {
		const db = await orm.open();

		await rejection(
			db.transaction(async tx => {
				await User.firstOrCreate({ name: 'Ann' }, tx as never);
				throw new Error('stop');
			}),
		);

		expect(await User.query().count()).toBe(0);
	});
});

import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { ModelNotFoundError, OrmError, QueryError } from '../../src/errors';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Order, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const SEED = [
	`INSERT INTO users (name, email, active, age, settings, created_at, updated_at) VALUES
		('Ann', 'ann@x.io', 1, 30, '{"theme":"dark","tags":["a"]}', 1772600767, 1772600767),
		('Bob', NULL, 0, 20, NULL, 1772600000, 1772600000),
		('Cy', 'cy@x.io', 1, NULL, NULL, 1772500000, 1772500000)`,
	`INSERT INTO posts (user_id, title, published, published_at) VALUES
		(1, 'First', 1, '2026-01-02T03:04:05.000Z'),
		(1, 'Second', 0, NULL),
		(2, 'Third', 1, '2026-02-02T00:00:00.000Z')`,
	"INSERT INTO orders (tenant, number, total) VALUES ('acme', 1, 100), ('acme', 2, 50), ('zeta', 1, 7)",
];

describe('reading', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('find returns the row for a key, or null', async () => {
		await open();

		const ann = await User.find(1);
		expect(ann).toBeInstanceOf(User);
		expect(ann!.name).toBe('Ann');
		expect(ann!.exists).toBe(true);
		expect(ann!.isDirty).toBe(false);

		expect(await User.find(99)).toBeNull();
	});

	test('findOrFail names the model and key it could not find', async () => {
		await open();

		const error = await rejection(User.findOrFail(99));

		expect(error).toBeInstanceOf(ModelNotFoundError);
		expect(error.message).toBe('[orm] No User with id = 99.');
	});

	test('a composite key is found by its values in order', async () => {
		await open();

		expect((await Order.find(['acme', 2]))!.total).toBe(50);
		expect(await Order.find(['zeta', 2])).toBeNull();
		expect(await rejection(Order.find('acme' as never))).toBeInstanceOf(
			QueryError,
		);
	});

	test('two reads of one row are one instance', async () => {
		await open();

		const [first, second] = [await User.find(1), await User.find(1)];
		const [inList] = await User.query().where('id', 1).get();
		const post = await Post.query().where('id', 1).with('author').first();

		expect(first).toBe(second);
		expect(inList).toBe(first!);
		expect(post!.author).toBe(first!);
	});

	test('instances with unsaved edits are listed, and held, until saved or deleted', async () => {
		await open();
		const ann = (await User.find(1))!;
		const bob = (await User.find(2))!;

		ann.draft().name = 'Annie';
		bob.draft().age = 21;
		expect(User.unsaved()).toEqual([ann, bob]);

		await ann.save();
		await bob.delete();
		expect(User.unsaved()).toEqual([]);
	});

	test('a read inside a transaction gives an instance of that transaction, not the shared one', async () => {
		const db = await open();
		const shared = (await User.find(1))!;

		await db.transaction(async tx => {
			const inside = (await User.find(1, tx))!;
			expect(inside).not.toBe(shared);
			expect(await User.find(1, tx)).toBe(inside);
		});
	});

	test('an instance of a transaction lives only inside it, whether it committed or rolled back', async () => {
		const db = await open();
		let undone!: User;

		await rejection(
			db.transaction(async tx => {
				undone = (await User.find(1, tx))!;
				throw new Error('undo');
			}),
		);
		const committed = (await db.transaction(tx => User.find(1, tx)))!;

		for (const inside of [undone, committed]) {
			expect(() => inside.name).toThrow('has ended');
			expect((await rejection(inside.save())).message).toContain(
				'has ended',
			);
		}
	});

	test('columns read in their logical type', async () => {
		await open();

		const [ann, bob] = await User.query().orderBy('id').limit(2).get();

		expect(ann!.active).toBe(true);
		expect(bob!.active).toBe(false);
		expect(ann!.settings).toEqual({ theme: 'dark', tags: ['a'] });
		expect(bob!.settings).toBeNull();
		expect(ann!.created_at).toEqual(new Date('2026-03-04T05:06:07.000Z'));
	});

	test('where takes logical values and stores them as the column does', async () => {
		await open();

		const active = await User.query().where('active', true).pluck('name');
		const since = await User.query()
			.where('created_at', '>=', new Date(1772600000 * 1000))
			.orderBy('id')
			.pluck('name');

		expect(active).toEqual(['Ann', 'Cy']);
		expect(since).toEqual(['Ann', 'Bob']);
		expect(orm.crate.calls[0]!.params).toEqual([1]);
	});

	test('null matches with IS NULL, and != null with IS NOT NULL', async () => {
		await open();

		expect(await User.query().where('email', null).pluck('name')).toEqual([
			'Bob',
		]);
		expect(await User.query().where('email', '!=', null).count()).toBe(2);
		expect(await User.query().whereNull('age').pluck('name')).toEqual([
			'Cy',
		]);
	});

	test('groups, or and not combine as written', async () => {
		await open();

		const names = await User.query()
			.where('active', true)
			.where(group => group.where('age', '>', 25).orWhereNull('age'))
			.whereNot('name', 'Cy')
			.pluck('name');

		expect(names).toEqual(['Ann']);
	});

	test('whereIn and its variants', async () => {
		await open();

		expect(await User.query().whereIn('id', [1, 3]).count()).toBe(2);
		expect(await User.query().whereNotIn('id', [1, 3]).count()).toBe(1);
		expect(await User.query().whereIn('id', []).count()).toBe(0);
		expect(await User.query().whereIn('email', [null]).count()).toBe(1);
		expect(
			await User.query()
				.where('id', 1)
				.orWhereIn('name', ['Bob'])
				.count(),
		).toBe(2);
	});

	test('a pattern is matched as text, whatever the column holds', async () => {
		await open();

		expect(await User.query().where('name', 'like', 'A%').count()).toBe(1);
		expect(await User.query().where('age', 'LIKE', '3%').count()).toBe(1);
	});

	test('a condition on undefined is refused rather than read as NULL or dropped', async () => {
		await open();

		expect(() => User.query().where('email', undefined as never)).toThrow(
			'compared with undefined',
		);
		expect(await rejection(User.find(undefined as never))).toBeInstanceOf(
			QueryError,
		);
	});

	test('order, limit and offset shape the result', async () => {
		await open();

		const names = await User.query()
			.orderBy('name', 'desc')
			.limit(2)
			.offset(1)
			.pluck('name');

		expect(names).toEqual(['Bob', 'Ann']);
	});

	test('a query is immutable, so a base query branches', async () => {
		await open();
		const active = User.query().where('active', true);

		expect(await active.where('age', 30).count()).toBe(1);
		expect(await active.count()).toBe(2);
	});

	test('first and firstOrFail', async () => {
		await open();

		expect((await User.query().orderBy('id', 'desc').first())!.name).toBe(
			'Cy',
		);
		expect(await User.query().where('id', 99).first()).toBeNull();
		expect(
			await rejection(User.query().where('id', 99).firstOrFail()),
		).toBeInstanceOf(ModelNotFoundError);
	});

	test('exists asks without building a model', async () => {
		await open();

		expect(await User.query().where('name', 'Ann').exists()).toBe(true);
		expect(await User.query().where('name', 'Zed').exists()).toBe(false);
		expect(orm.crate.sql[0]).toBe(
			'SELECT 1 FROM `users` WHERE `name` = ? LIMIT 1',
		);
	});

	test('aggregates ignore order and limit, and read as the column reads', async () => {
		await open();
		const query = User.query().orderBy('name').limit(1);

		expect(await query.count()).toBe(3);
		expect(await query.sum('age')).toBe(50);
		expect(await query.avg('age')).toBe(25);
		expect(await query.min('name')).toBe('Ann');
		expect(await query.max('created_at')).toEqual(
			new Date('2026-03-04T05:06:07.000Z'),
		);
		expect(await User.query().where('id', 99).sum('age')).toBe(0);
		expect(await User.query().where('id', 99).avg('age')).toBeNull();
		expect(await User.query().where('id', 99).max('age')).toBeNull();
	});

	test('pluck and value read one column', async () => {
		await open();

		expect(await User.query().orderBy('id').pluck('active')).toEqual([
			true,
			false,
			true,
		]);
		expect(await User.query().orderBy('id').value('name')).toBe('Ann');
		expect(await User.query().where('id', 99).value('name')).toBeNull();
	});

	test('paginate returns a page and the total; a distinct query is refused', async () => {
		await open();

		const page = await User.query().orderBy('id').paginate(2, 2);

		expect(page.total).toBe(3);
		expect(page.data.pluck('name')).toEqual(['Cy']);
		expect(
			await rejection(User.query().distinct().paginate()),
		).toBeInstanceOf(OrmError);
	});

	test('a grouped query yields rows, not models', async () => {
		await open();
		const grouped = Post.query()
			.select('user_id')
			.selectRaw('COUNT(*) AS posts')
			.groupBy('user_id')
			.having(group => group.whereRaw('COUNT(*) > ?', [1]));

		expect(await grouped.rows()).toEqual([{ user_id: 1, posts: 2 }]);
		expect(await rejection(grouped.get())).toBeInstanceOf(OrmError);
		expect(await rejection(grouped.count())).toBeInstanceOf(OrmError);
	});

	test('select adds to what is already selected, and a partial model knows its key is missing', async () => {
		await open();

		const [user] = await User.query().select('name').select('age').get();

		expect(user!.toObject()).toEqual({ name: 'Ann', age: 30 });
		expect(user!.$attributes.persistedKeySignature()).toBeNull();
	});

	test('a computed column is not a property, but is in toObject()', async () => {
		await open();

		const [user] = await User.query()
			.select('id')
			.selectRaw('41 + 1 AS extra')
			.orderBy('id')
			.get();

		expect((user as unknown as Record<string, unknown>).extra).toBe(
			undefined,
		);
		expect(user!.toObject()).toEqual({ id: 1, extra: 42 });
	});

	test('a join still makes models of this table only', async () => {
		await open();

		const posts = await Post.query()
			.join('users', 'users.id', '=', 'posts.user_id')
			.where('users.name', 'Ann')
			.orderBy('posts.id')
			.get();

		expect(posts.toArray().map(post => post.toObject())).toEqual([
			{
				id: 1,
				user_id: 1,
				title: 'First',
				published: true,
				published_at: new Date('2026-01-02T03:04:05.000Z'),
			},
			{
				id: 2,
				user_id: 1,
				title: 'Second',
				published: false,
				published_at: null,
			},
		]);
		expect(
			await Post.query()
				.join('users', 'users.id', '=', 'posts.user_id')
				.where('users.name', 'Ann')
				.max('id'),
		).toBe(2);
	});

	test('a read inside a transaction sees its uncommitted rows; one without the handle does not', async () => {
		const db = await open();

		await db.transaction(async tx => {
			await db.run(
				new Statement("UPDATE users SET name = 'Anna' WHERE id = 1"),
				tx,
			);

			expect((await User.find(1, tx))!.name).toBe('Anna');
			expect((await User.find(1))!.name).toBe('Ann');
			expect(await User.query().where('name', 'Anna').count(tx)).toBe(1);
		});
	});

	test('a class field named after a column is refused, since it hides the column', async () => {
		await open();
		class Shadowed extends Model<typeof Shadowed.schema> {
			static readonly schema = this.define({
				table: 'users',
				columns: {
					id: Column.integer().primary(),
					name: Column.text(),
				},
			});

			name = 'field';
		}

		const error = await rejection(Shadowed.all());

		expect(error).toBeInstanceOf(OrmError);
		expect(error.message).toContain("declares 'name' as a class field");
	});

	test('Model.connect switches every model, and only Model may be given it', async () => {
		await open();
		const next = await orm.bed.databaseWith(
			[
				'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
				"INSERT INTO users (name) VALUES ('next')",
			],
			{ path: 'next.sqlite' },
		);

		expect(() => User.connect(next)).toThrow(OrmError);
		Model.connect(next);

		expect(User.database).toBe(next);
		expect(await User.query().pluck('name')).toEqual(['next']);
	});
});

/** Never run: the compiler is the test. */
export function typesAreChecked(): void {
	User.query().where('name', 'ann').where('age', '>', 3).where('age', null);
	User.query().where('users.name', 'ann');
	User.query().whereIn('id', [1, 2]).orderBy('name').select('id', 'name');
	User.query().sum('age');

	// @ts-expect-error not a column
	User.query().where('nickname', 'x');
	// @ts-expect-error name is text
	User.query().where('name', 1);
	// @ts-expect-error not nullable
	User.query().where('name', null);
	// @ts-expect-error an ordering against null means nothing
	User.query().where('age', '>', null);
	// @ts-expect-error name is text
	User.query().whereIn('name', [1]);
	// @ts-expect-error not numeric
	User.query().sum('name');
	// @ts-expect-error not a column
	User.query().orderBy('nickname');

	const found: Promise<User | null> = User.find(1);
	const name: Promise<string | null> = User.query().value('name');
	const at: Promise<Date | null> = User.query().max('created_at');
	void [found, name, at];
}

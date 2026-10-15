import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Comment, Order, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

async function untilStatementIsBuilt(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('update(patch)', () => {
	const orm = OrmBed.use();

	test('update() with a patch equal to a pending edit writes only that column', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });

		user.draft().age = 5;
		user.draft().name = 'Draft';
		await user.update({ age: 5 });

		expect(await User.query().pluck('name')).toEqual(['Ann']);
		expect(user.getDirty()).toEqual(['name']);
	});

	test('update() with an empty patch writes nothing', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });

		user.draft().name = 'Draft';
		await user.update({});

		expect(await User.query().pluck('name')).toEqual(['Ann']);
		expect(user.getDirty()).toEqual(['name']);
	});
});

describe('a :before handler’s edit is part of the write', () => {
	const orm = OrmBed.use();

	test('update(patch) writes what a save:before handler set on another column', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });
		User.registerEvent('save:before', written => {
			for (const [model] of written) model.draft().age = 42;
		});

		await user.update({ name: 'Anna' });

		expect(await User.query().pluck('age')).toEqual([42]);
		expect(user.isDirty).toBe(false);
	});

	test('a query update writes what a save:before handler set on another column, and leaves no edit behind', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });
		User.registerEvent('save:before', written => {
			for (const [model] of written) model.draft().age = 42;
		});

		await User.query().update({ name: 'Anna' });

		expect(await User.query().pluck('age')).toEqual([42]);
		expect(user.isDirty).toBe(false);
	});
});

describe('rollback', () => {
	const orm = OrmBed.use();

	test('update(patch, tx) rolled back leaves no edit on the draft', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });

		await rejection(
			db.transaction(async tx => {
				await user.update({ age: 30 }, tx);
				throw new Error('stop');
			}),
		);

		expect(user.age).toBe(1);
		expect(user.isDirty).toBe(false);
	});

	test('a query update with a handler, rolled back by a savepoint, leaves no edit on the rows it read', async () => {
		const db = await orm.open();
		await User.create({ name: 'Ann', age: 1 });
		User.registerEvent('update:before', () => {});

		let dirty: string[] = [];
		await db.transaction(async tx => {
			const inside = (await User.find(1, tx))!;
			await rejection(
				tx.savepoint(async () => {
					await User.query().update({ age: 5 }, tx);
					throw new Error('stop');
				}),
			);
			dirty = inside.getDirty();
		});

		expect(dirty).toEqual([]);
	});

	test('a delete rolled back leaves the model the row’s one instance', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		User.registerEvent('delete:after', () => {
			throw new Error('stop');
		});

		await rejection(user.delete());

		expect(user.exists).toBe(true);
		expect(await User.find(user.id)).toBe(user);
	});

	test('a key change rolled back leaves the model the row’s one instance', async () => {
		await orm.open();
		const [order] = await Order.createMany([
			{ tenant: 'acme', number: 1, total: 1 },
		]);
		Order.registerEvent('update:after', () => {
			throw new Error('stop');
		});

		order!.draft().number = 7;
		await rejection(order!.save());

		expect(order!.number).toBe(1);
		expect(await Order.find(['acme', 1])).toBe(order!);
	});
});

describe('key changes inside a transaction', () => {
	const orm = OrmBed.use();

	test('a transaction’s own instance whose key changed is still the one read by its new key', async () => {
		const db = await orm.open();
		await Order.createMany([{ tenant: 'acme', number: 1, total: 1 }]);

		const same = await db.transaction(async tx => {
			const order = (await Order.find(['acme', 1], tx))!;
			order.draft().number = 7;
			await order.save(tx);
			return (await Order.find(['acme', 7], tx)) === order;
		});

		expect(same).toBe(true);
	});

	test('a transaction’s own instance whose key changed is not taken over by a new row at its old key', async () => {
		const db = await orm.open();
		await Order.createMany([{ tenant: 'acme', number: 1, total: 1 }]);

		const number = await db.transaction(async tx => {
			const order = (await Order.find(['acme', 1], tx))!;
			order.draft().number = 7;
			await order.save(tx);
			await Order.create({ tenant: 'acme', number: 1, total: 50 }, tx);
			await Order.find(['acme', 1], tx);
			return order.number;
		});

		expect(number).toBe(7);
	});
});

describe('query writes keep instances and lists right', () => {
	const orm = OrmBed.use();

	test('a query update without a handler shows on the row’s instance', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });

		await User.query().where('id', user.id).update({ age: 5 });

		expect(user.age).toBe(5);
	});

	test('a save made while a failing query update runs does not write the query’s values', async () => {
		await orm.open();
		const [ann] = await User.createMany([
			{ name: 'Ann', email: 'a@x' },
			{ name: 'Bob', email: 'b@x' },
		]);
		User.registerEvent('update:committed', () => {});

		// Holds the query's UPDATE until the save below has built its statement.
		const crate = orm.crate;
		const invoke = crate.invoke.bind(crate);
		let reached!: () => void;
		const atUpdate = new Promise<void>(resolve => (reached = resolve));
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		crate.invoke = async (command: string, args: unknown) => {
			if (JSON.stringify(args).includes('UPDATE `users` SET `email`')) {
				reached();
				await gate;
			}
			return invoke(command, args);
		};

		try {
			const failing = rejection(User.query().update({ email: 'same@x' }));
			await atUpdate;
			ann!.draft().name = 'Anna';
			const saving = ann!.save();
			await untilStatementIsBuilt();
			release();
			await saving;
			expect((await failing).message).toContain('UNIQUE');
		} finally {
			crate.invoke = invoke;
		}

		expect(await User.query().orderBy('id').pluck('email')).toEqual(['a@x', 'b@x']);
	});

	test('a query delete without a handler leaves a list that held the row', async () => {
		await orm.open();
		await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		const all = await User.query().get();

		await User.query().where('name', 'Ann').delete();

		expect(all.length).toBe(1);
	});
});

describe('find or write', () => {
	const orm = OrmBed.use();

	test('updateOrCreate writes the values given, not other pending edits of the row found', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', email: 'a@x', age: 1 });

		user.draft().age = 99;
		await User.updateOrCreate({ email: 'a@x' }, { name: 'Anna' });

		expect(await User.query().pluck('age')).toEqual([1]);
		expect(user.getDirty()).toEqual(['age']);
	});

	test('firstOrCreate finds the row it created, when a mutator changes the lookup column', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE tagged (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)',
			),
		);
		class Tagged extends Model<typeof Tagged.schema> {
			static readonly schema = this.define({
				table: 'tagged',
				columns: {
					id: Column.integer().primary().generated(),
					label: Column.text(),
				},
			});

			static readonly mutators = this.mutate({
				label: value => value.toLowerCase(),
			});
		}

		const first = await Tagged.firstOrCreate({ label: 'Red' });
		const second = await Tagged.firstOrCreate({ label: 'Red' });

		expect(await Tagged.query().count()).toBe(1);
		expect(second).toBe(first);
	});
});

describe('sync', () => {
	const orm = OrmBed.use();

	test('sync leaves a member’s unrelated pending edit pending and counts it unchanged', async () => {
		await orm.open();
		const post = await Post.create({ title: 'P' });
		const comment = await Comment.create({ post_id: post.id, body: 'a', sort: 1 });

		comment.draft().sort = 9;
		const result = await post.sync('comments', [{ id: comment.id, body: 'a' }]);

		expect(result.unchanged).toBe(1);
		expect(await Comment.query().pluck('sort')).toEqual([1]);
		expect(comment.getDirty()).toEqual(['sort']);
	});
});

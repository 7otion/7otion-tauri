import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';
import { rejection } from '../harness/rejection';

const delay = (ms: number) =>
	new Promise<void>(resolve => setTimeout(resolve, ms));

describe('what happens once a commit is through', () => {
	const orm = OrmBed.use();

	test('a transaction whose first write was in a savepoint that rolled back still reports what it committed', async () => {
		const db = await orm.open();
		const heard: string[] = [];
		User.registerEvent('create:committed', written => {
			heard.push(...written.map(([user]) => user.name));
		});

		await db.transaction(async tx => {
			await rejection(
				tx.savepoint(async () => {
					await User.create({ name: 'Undone' }, tx);
					throw new Error('undo');
				}),
			);
			await User.create({ name: 'Kept' }, tx);
		});

		expect(await User.query().count()).toBe(1);
		expect(heard).toEqual(['Kept']);
	});

	test('a commit that lands while another settles is reported after it, not inside it', async () => {
		await orm.open();
		let entered!: () => void;
		const handlerEntered = new Promise<void>(
			resolve => (entered = resolve),
		);
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		User.registerEvent('create:committed', async () => {
			entered();
			await gate;
		});
		const heard: string[] = [];
		Model.registerEvent('create:committed', written => {
			heard.push(...written.map(([model]) => model.constructor.name));
		});

		const first = User.create({ name: 'Ann' });
		await handlerEntered;
		const second = Post.create({ title: 'Unrelated' });
		await delay(100);
		expect(heard).toEqual(['User', 'Post']);
		release();
		await Promise.all([first, second]);
	});

	test('a :committed handler of a row updated then deleted in a transaction gets the shared instance', async () => {
		const db = await orm.open();
		const shared = await User.create({ name: 'Ann' });
		const heard: User[] = [];
		User.registerEvent('update:committed', written => {
			heard.push(...written.map(([user]) => user));
		});

		await db.transaction(async tx => {
			const inside = (await User.find(shared.id, tx))!;
			await inside.update({ age: 5 }, tx);
			await inside.delete(tx);
		});

		expect(heard).toHaveLength(1);
		expect({
			isShared: heard[0] === shared,
			exists: heard[0]!.exists,
		}).toEqual({
			isShared: true,
			exists: false,
		});
	});

	test('a delete:committed handler can read a row deleted through a transaction’s own instance', async () => {
		const db = await orm.open();
		await orm.seed(db, ["INSERT INTO users (name) VALUES ('Ann')"]);
		const heard: string[] = [];
		User.registerEvent('delete:committed', written => {
			heard.push(...written.map(([user]) => user.name));
		});

		const outcome = await db
			.transaction(async tx => {
				const inside = (await User.find(1, tx))!;
				await inside.delete(tx);
			})
			.then(
				() => null,
				error => error.failures?.[0]?.error?.message ?? String(error),
			);

		expect(outcome).toBeNull();
		expect(heard).toEqual(['Ann']);
	});

	test('a :committed handler that writes the shared instance is not undone by the next handler of the same write', async () => {
		const db = await orm.open();
		const shared = await User.create({ name: 'Ann' });
		const seen: (number | null)[] = [];
		User.registerEvent('update:committed', async written => {
			for (const [user] of written) {
				if (user.age === 5) await user.update({ age: 6 });
			}
		});
		User.registerEvent('save:committed', written => {
			seen.push(...written.map(([user]) => user.age));
		});

		await db.transaction(async tx => {
			const inside = (await User.find(shared.id, tx))!;
			await inside.update({ age: 5 }, tx);
		});

		const [row] = (
			await db.run(
				new Statement('SELECT age FROM users WHERE id = ?', [
					shared.id,
				]),
			)
		).rows;
		// The nested write's own save:committed hears 6, then the outer write's.
		expect({ row: row?.age, shared: shared.age, seen }).toEqual({
			row: 6,
			shared: 6,
			seen: [6, 6],
		});
	});

	test('a row rekeyed through a transaction’s own instance moves the shared instance to its new key', async () => {
		const db = await orm.open();
		const shared = await User.create({ name: 'Ann' });
		const oldId = shared.id;
		const id = new Watch(() => shared.id);

		await db.transaction(async tx => {
			const inside = (await User.find(oldId, tx))!;
			inside.draft().id = oldId + 100;
			await inside.save(tx);
		});

		const found = await User.find(oldId + 100);
		expect({
			sharedId: shared.id,
			bumped: id.reruns,
			foundIsShared: found === shared,
		}).toEqual({ sharedId: oldId + 100, bumped: 1, foundIsShared: true });
	});

	test(':committed handlers run in the order their writes began, a :before handler’s write after the write that made it', async () => {
		const db = await orm.open();
		const order: string[] = [];
		User.registerEvent('create:before', async (_written, tx) => {
			await Post.create({ title: 'side' }, tx);
		});
		User.registerEvent('create:committed', () => void order.push('user'));
		Post.registerEvent('create:committed', () => void order.push('post'));

		await db.transaction(async tx => {
			await User.create({ name: 'Ann' }, tx);
		});

		expect(order).toEqual(['user', 'post']);
	});

	test('a query delete with no handler is reported, and a live collection lets its rows go', async () => {
		await orm.open();
		await User.create({ name: 'Ann', active: false });
		await User.create({ name: 'Bob' });
		const all = await User.query().orderBy('id').get();
		const ann = all.at(0)!;
		const row = new Watch(() => ann.exists);

		const removed = await User.query().where('active', false).delete();

		expect(removed).toBe(1);
		expect({
			bumped: row.reruns,
			exists: ann.exists,
			listed: all.pluck('name'),
		}).toEqual({ bumped: 1, exists: false, listed: ['Bob'] });
	});

	test('a query update with no handler is reported, and the shared instances show it', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const age = new Watch(() => ann.age);

		const changed = await User.query()
			.where('id', ann.id)
			.update({ age: 9 });

		expect(changed).toBe(1);
		expect({ bumped: age.reruns, age: ann.age }).toEqual({
			bumped: 1,
			age: 9,
		});
	});
});

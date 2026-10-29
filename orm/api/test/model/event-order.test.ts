import { describe, expect, test } from 'bun:test';

import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';

describe('what handlers are told, and in which order', () => {
	const orm = OrmBed.use();

	test("an :after handler's own write runs its :committed handlers after this write's", async () => {
		await orm.open();
		const order: string[] = [];
		User.registerEvent('create:after', async (_batch, tx) => {
			await Post.create({ title: 'side' }, tx);
		});
		User.registerEvent('save:committed', () => void order.push('user'));
		Post.registerEvent('save:committed', () => void order.push('post'));

		await User.create({ name: 'Ann' });

		expect(order).toEqual(['user', 'post']);
	});

	test('a createMany batch lists the models in the order given', async () => {
		await orm.open();
		let names: string[] = [];
		User.registerEvent('create:committed', written => {
			names = written.map(([model]) => model.name);
		});

		await User.createMany([
			{ name: 'a' },
			{ name: 'b', age: 1 },
			{ name: 'c' },
		]);

		expect(names).toEqual(['a', 'b', 'c']);
	});

	test('deleteMany given two instances of one row counts it once, and announces it once', async () => {
		const db = await orm.open();
		const a = await User.create({ name: 'Ann' });
		const b = await User.create({ name: 'Bob' });
		let heard = 0;
		User.registerEvent('delete:committed', written => {
			heard += written.length;
		});

		const outside = await User.deleteMany([a, (await User.find(a.id))!]);
		const inside = await db.transaction(async tx =>
			User.deleteMany([b, (await User.find(b.id, tx))!], tx),
		);

		expect([outside, inside, heard]).toEqual([1, 1, 2]);
	});

	test('a delete:before handler that changes its model’s key leaves no claim behind on the old key', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		const oldId = user.id;
		let second: boolean | undefined;

		await db.transaction(async tx => {
			User.registerEvent('delete:before', async (written, inner) => {
				for (const [model] of written) {
					if (model.id !== oldId) continue;
					model.draft().id = oldId + 100;
					await model.save(inner);
				}
			});
			expect(await user.delete(tx)).toBe(true);
			User.registerEvent('delete:before', null);

			const again = await User.create(
				{ id: oldId, name: 'Bob' } as never,
				tx,
			);
			second = await again.delete(tx);
		});

		expect(second).toBe(true);
		expect(await User.query().count()).toBe(0);
	});
});

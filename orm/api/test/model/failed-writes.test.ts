import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

describe('a write that fails leaves its models as they were', () => {
	const orm = OrmBed.use();

	test('an update whose row is missing leaves a save:before edit off the model', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann', age: 1 });
		await db.run(new Statement('DELETE FROM users WHERE id = ?', [user.id]));
		User.registerEvent('save:before', written => {
			for (const [model] of written) model.draft().age = 99;
		});

		user.draft().name = 'Anna';
		const error = await rejection(user.save());

		expect(error.message).toContain('no longer exist');
		expect(user.age).toBe(1);
	});

	test('an insert that failed inside its transaction leaves no timestamps on the model', async () => {
		await orm.open();
		await User.create({ name: 'Ann', email: 'a@x' });
		User.registerEvent('save:before', () => {});

		const user = new User().fill({ name: 'Bob', email: 'a@x' });
		const error = await rejection(user.save());

		expect(error.message).toContain('UNIQUE');
		expect(user.exists).toBe(false);
		expect(user.getDirty().sort()).toEqual(['email', 'name']);
	});

	test('an insert that failed without a transaction leaves no timestamps on the model', async () => {
		await orm.open();
		await User.create({ name: 'Ann', email: 'a@x' });

		const user = new User().fill({ name: 'Bob', email: 'a@x' });
		const error = await rejection(user.save());

		expect(error.message).toContain('UNIQUE');
		expect(user.getDirty().sort()).toEqual(['email', 'name']);
	});
});

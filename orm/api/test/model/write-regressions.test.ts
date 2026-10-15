import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { OrmError } from '../../src/errors';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

describe('write regressions', () => {
	const orm = OrmBed.use();

	test('delete of a row already missing, inside a tx that rolls back, puts the model back as it was', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));

		await rejection(
			db.transaction(async tx => {
				expect(await user.delete(tx)).toBe(false);
				expect(user.exists).toBe(false);
				throw new Error('boom');
			}),
		);
		expect(user.exists).toBe(true);
	});

	test('a rolled-back createMany leaves its models as a rolled-back create does', async () => {
		const db = await orm.open();
		let single!: User;
		let many!: User[];
		await rejection(
			db.transaction(async tx => {
				single = await User.create({ name: 'A' }, tx);
				many = await User.createMany([{ name: 'B' }], tx);
				throw new Error('boom');
			}),
		);
		for (const user of [single, many[0]!]) {
			expect(user.exists).toBe(false);
			expect(user.draft().created_at).toBeUndefined();
			expect(user.getDirty()).toEqual(['name']);
		}
	});

	test('updateMany whose rows are all gone runs no :committed handler', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));
		const heard: string[] = [];
		User.registerEvent('save:committed', () => void heard.push('save'));
		User.registerEvent('update:committed', () => void heard.push('update'));
		user.draft().name = 'B';
		const error = await rejection(User.updateMany([user]));
		expect(error).toBeInstanceOf(OrmError);
		expect(heard).toEqual([]);
	});

	test('save of a gone row runs no :committed handler', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));
		const heard: string[] = [];
		User.registerEvent('save:committed', () => void heard.push('save'));
		user.draft().name = 'B';
		await rejection(user.save());
		expect(heard).toEqual([]);
	});

	test('updateMany given one instance twice writes it', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		user.draft().name = 'B';
		const result = await rejection(User.updateMany([user, user]));
		expect(result).not.toBeInstanceOf(Error);
	});

	test('a query update with a handler gives each model its own JSON value', async () => {
		await orm.open();
		await User.createMany([{ name: 'A' }, { name: 'B' }]);
		User.registerEvent('update:before', written => {
			written[0]![0].draft().settings = { theme: 'only-first', tags: [] };
		});
		const patch = { settings: { theme: 'dark', tags: [] as string[] } };
		await User.query().update(patch);
		const rows = await User.query().orderBy('id').get();
		expect(rows.toArray().map(u => u.settings!.theme)).toEqual([
			'only-first',
			'dark',
		]);
		expect(rows.at(1)!.settings).not.toBe(patch.settings);
		expect(patch.settings.theme).toBe('dark');
	});
});

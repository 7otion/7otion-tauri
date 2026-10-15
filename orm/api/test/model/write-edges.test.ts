import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

const TIMEOUT = 8000;

/** Lets a write build its statement; the crate answers a turn later. */
async function untilStatementIsBuilt(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('an insert and columns assigned while it is on its way', () => {
	const orm = OrmBed.use();

	test(
		'a column the insert left out, assigned while it ran, keeps what was assigned',
		async () => {
			await orm.open();
			const user = new User().fill({ name: 'Ann' });

			const saving = user.save();
			await untilStatementIsBuilt();
			// Neither was sent, so both come back through RETURNING.
			user.draft().age = 40;
			user.draft().email = 'a@x.io';
			await saving;

			expect([user.age, user.email]).toEqual([null, null]);
			expect([user.draft().age, user.draft().email]).toEqual([40, 'a@x.io']);
			expect(user.getDirty().sort()).toEqual(['age', 'email']);
		},
		TIMEOUT,
	);
});

describe('query().delete() announces only the rows it removed', () => {
	const orm = OrmBed.use();

	test(
		'a row a delete:before handler removed first is not announced as deleted',
		async () => {
			const db = await orm.open();
			await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
			const announced: string[] = [];
			User.registerEvent('delete:committed', written => {
				announced.push(...written.map(([u]) => u.name));
			});
			User.registerEvent('delete:before', async (_written, tx) => {
				await db.run(
					new Statement("DELETE FROM users WHERE name = 'Bob'"),
					tx,
				);
			});

			const removed = await User.query().delete();

			expect(removed).toBe(1);
			expect(announced).toEqual(['Ann']);
		},
		TIMEOUT,
	);

	test(
		'a query delete that removed nothing announces nothing, as save() and delete() do',
		async () => {
			const db = await orm.open();
			await User.createMany([{ name: 'Ann' }]);
			const announced: string[] = [];
			User.registerEvent('delete:committed', written => {
				announced.push(...written.map(([u]) => u.name));
			});
			User.registerEvent('delete:before', async (_written, tx) => {
				await db.run(new Statement('DELETE FROM users'), tx);
			});

			const removed = await User.query().delete();

			expect(removed).toBe(0);
			expect(announced).toEqual([]);
		},
		TIMEOUT,
	);
});

describe('query().update() writes rows whose values already match', () => {
	const orm = OrmBed.use();

	test(
		'it stamps updated_at on every matched row, as it does with no handler',
		async () => {
			await orm.open();
			await User.createMany([{ name: 'Ann', age: 9 }]);
			User.registerEvent('update:committed', () => {});
			const before = (await User.find(1))!.updated_at.getTime();
			await Bun.sleep(1100);

			const matched = await User.query().update({ age: 9 });

			expect(matched).toBe(1);
			expect((await User.find(1))!.updated_at.getTime()).toBeGreaterThan(
				before,
			);
		},
		TIMEOUT,
	);

	test(
		'it tells its update:committed handler about every row it matched',
		async () => {
			await orm.open();
			await User.createMany([
				{ name: 'Ann', age: 9 },
				{ name: 'Bob', age: 1 },
			]);
			const heard: string[] = [];
			User.registerEvent('update:committed', written => {
				heard.push(...written.map(([u]) => u.name));
			});

			const matched = await User.query().update({ age: 9 });

			expect(matched).toBe(2);
			expect(heard.sort()).toEqual(['Ann', 'Bob']);
		},
		TIMEOUT,
	);
});

describe('a rollback and a model whose row was missing', () => {
	const orm = OrmBed.use();

	test(
		'an update of a missing row inside a transaction, with no handler, leaves the model as it was',
		async () => {
			const db = await orm.open();
			const user = await User.create({ name: 'Ann' });
			await db.run(new Statement('DELETE FROM users'));

			await rejection(
				db.transaction(async tx => {
					user.draft().name = 'Anna';
					await user.save(tx);
				}),
			);

			expect([user.exists, user.isDirty]).toEqual([true, true]);
		},
		TIMEOUT,
	);

	test(
		'the same model with a handler inside its write is left as it was too',
		async () => {
			const db = await orm.open();
			const user = await User.create({ name: 'Ann' });
			await db.run(new Statement('DELETE FROM users'));
			User.registerEvent('save:before', () => {});

			await rejection(
				db.transaction(async tx => {
					user.draft().name = 'Anna';
					await user.save(tx);
				}),
			);

			expect([user.exists, user.isDirty]).toEqual([true, true]);
		},
		TIMEOUT,
	);
});

describe('an update when one of its rows is missing', () => {
	const orm = OrmBed.use();

	test(
		'updateMany writes nothing, and a handler’s delete that caused it is undone',
		async () => {
			await orm.open();
			const users = await User.createMany([
				{ name: 'Ann' },
				{ name: 'Bob' },
			]);
			User.registerEvent('update:before', async (_batch, tx) => {
				await User.query().where('name', 'Bob').delete(tx);
			});

			users[0]!.draft().age = 1;
			users[1]!.draft().age = 2;
			const error = await rejection(User.updateMany(users));

			expect(error.message).toContain('not in the database');
			expect(await User.query().pluck('age')).toEqual([null, null]);
			expect(users.map(user => user.exists)).toEqual([true, true]);
		},
		TIMEOUT,
	);

	test(
		'query().update() writes nothing either',
		async () => {
			await orm.open();
			await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
			User.registerEvent('update:before', async (_batch, tx) => {
				await User.query().where('name', 'Bob').delete(tx);
			});

			const error = await rejection(User.query().update({ age: 5 }));

			expect(error.message).toContain('not in the database');
			expect(await User.query().pluck('age')).toEqual([null, null]);
		},
		TIMEOUT,
	);
});

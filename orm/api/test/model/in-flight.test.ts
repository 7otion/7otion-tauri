import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { AfterCommitError, OrmError } from '../../src/errors';
import type { ModelEvents } from '../../src/events/events';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

/** Resolves to 'hung' when `promise` has not settled within `ms`. */
function settled<T>(promise: Promise<T>, ms = 1500): Promise<T | 'hung'> {
	return Promise.race([
		promise,
		new Promise<'hung'>(resolve => setTimeout(() => resolve('hung'), ms)),
	]);
}

/** Lets a write build its statement; the crate answers a turn later. */
async function untilStatementIsBuilt(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The theme as the database holds it, past the instance the app holds. */
async function stored(user: User): Promise<string | undefined> {
	const [settings] = await User.query().where('id', user.id).pluck('settings');
	return settings?.theme;
}

describe('writes that cross each other', () => {
	const orm = OrmBed.use();

	test('a create:committed handler may save the model it was told about', async () => {
		await orm.open();
		User.registerEvent('create:committed', async written => {
			const [user] = written[0]!;
			user.draft().age = 1;
			await user.save();
		});

		const outcome = await settled(User.create({ name: 'Ann' }));

		expect(outcome).not.toBe('hung');
		expect((await User.query().first())!.age).toBe(1);
	});

	test('a create:after handler that saves its own new model without the handle fails, rather than hangs', async () => {
		await orm.open({ writerWaitMs: 100 });
		User.registerEvent('create:after', async written => {
			const [user] = written[0]!;
			user.draft().age = 1;
			await user.save();
		});

		const outcome = await settled(rejection(User.create({ name: 'Ann' })));

		expect(outcome).not.toBe('hung');
		expect(outcome.code).toBe('busy');
		expect(outcome.message).toContain('missing the tx handle');
		expect(await User.query().count()).toBe(0);
	});

	test('a create:after handler that saves its own new model with the handle updates the row it made', async () => {
		await orm.open();
		User.registerEvent('create:after', async (written, tx) => {
			const [user] = written[0]!;
			user.draft().age = 1;
			await user.save(tx);
		});

		await User.create({ name: 'Ann' });

		expect(await User.query().pluck('age')).toEqual([1]);
	});

	test('a new model with a handler inside its write saved twice at once inserts one row', async () => {
		await orm.open();
		User.registerEvent('save:before', () => {});
		const user = new User().fill({ name: 'Ann' });

		await Promise.all([user.save(), user.save()]);

		expect(await User.query().count()).toBe(1);
	});

	test('an object value edited in place while its insert is on its way stays dirty', async () => {
		await orm.open();
		const user = new User().fill({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});

		const saving = user.save();
		await untilStatementIsBuilt();
		user.draft().settings!.theme = 'light';
		await saving;

		expect(await stored(user)).toBe('dark');
		expect(user.settings!.theme).toBe('dark');
		expect(user.draft().settings!.theme).toBe('light');
		expect(user.getDirty()).toEqual(['settings']);
	});

	test('an object value edited in place while its update is on its way stays dirty', async () => {
		await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: [] },
		});

		user.draft().settings!.theme = 'light';
		const saving = user.save();
		await untilStatementIsBuilt();
		user.draft().settings!.theme = 'blue';
		await saving;

		expect(await stored(user)).toBe('light');
		expect(user.getDirty()).toEqual(['settings']);
	});

	test('bytes edited in place while updateMany is on its way stay dirty', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE files (id INTEGER PRIMARY KEY, body BLOB)',
			),
		);
		class File extends Model<typeof File.schema> {
			static readonly schema = this.define({
				table: 'files',
				columns: {
					id: Column.integer().primary().generated(),
					body: Column.blob().nullable(),
				},
			});
		}
		const file = await File.create({ body: new Uint8Array([1, 2, 3]) });

		file.draft().body = new Uint8Array([9, 2, 3]);
		const saving = File.updateMany([file]);
		await untilStatementIsBuilt();
		file.draft().body = new Uint8Array([7, 2, 3]);
		await saving;

		const [body] = await File.query().where('id', file.id).pluck('body');
		expect([...body!]).toEqual([9, 2, 3]);
		expect(file.getDirty()).toEqual(['body']);
	});

	test('a committed blob is handed out as a copy, so an edit in place changes nothing', async () => {
		const db = await orm.open();
		await db.run(
			new Statement('CREATE TABLE files (id INTEGER PRIMARY KEY, body BLOB)'),
		);
		class File extends Model<typeof File.schema> {
			static readonly schema = this.define({
				table: 'files',
				columns: {
					id: Column.integer().primary().generated(),
					body: Column.blob().nullable(),
				},
			});
		}
		const file = await File.create({ body: new Uint8Array([1, 2, 3]) });

		file.body![0] = 9;

		expect([...file.body!]).toEqual([1, 2, 3]);
		expect(file.isDirty).toBe(false);
	});

	test('a saved model no longer holds the object the caller gave it, so their later edits change nothing', async () => {
		await orm.open();
		const settings = { theme: 'dark', tags: [] as string[] };
		const user = await User.create({ name: 'Ann', settings });

		settings.theme = 'light';
		expect(user.isDirty).toBe(false);
		expect(user.settings!.theme).toBe('dark');
	});

	test('a model with a handler whose row is missing is left as it was, as one without is', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users'));
		User.registerEvent('save:before', () => {});

		user.draft().name = 'Anna';
		const error = await rejection(user.save());

		expect(error.message).toContain('no longer exist');
		expect([user.exists, user.isDirty]).toEqual([true, true]);
	});

	test('a failing :committed handler on updateMany carries the models it wrote', async () => {
		await orm.open();
		const users = await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		User.registerEvent('update:committed', () => {
			throw new Error('handler broke');
		});

		users[0]!.draft().age = 1;
		users[1]!.draft().age = 2;
		const error = await rejection(User.updateMany(users));

		expect(error).toBeInstanceOf(AfterCommitError);
		expect(error.result).toEqual(users);
	});

	test('updateMany refuses two changed instances of one row, of which one would win unseen', async () => {
		const db = await orm.open();
		const shared = await User.create({ name: 'Ann' });

		// The one other instance a row can have: the one a transaction reads for itself.
		const error = await rejection(
			db.transaction(async tx => {
				const inside = (await User.find(shared.id, tx))!;
				shared.draft().name = 'First';
				inside.draft().name = 'Second';
				await User.updateMany([shared, inside], tx);
			}),
		);

		expect(error).toBeInstanceOf(OrmError);
		expect(error.message).toContain('Two User instances of the row');
		expect(await User.query().where('id', shared.id).pluck('name')).toEqual(['Ann']);
	});
});

describe('deletes that cascade back', () => {
	const orm = OrmBed.use();

	test('a row a cascade deletes back through a query is still deleted, counted and announced by the delete that began it', async () => {
		await orm.open();
		const post = await Post.create({ title: 'Hello' });
		await Comment.create({ post_id: post.id, body: 'a', sort: 0 });
		const deleted: string[] = [];
		Post.registerEvent('delete:committed', written => {
			deleted.push(...written.map(([gone]) => gone.title));
		});
		Post.registerEvent('delete:before', async (written, tx) => {
			await Comment.query()
				.whereIn(
					'post_id',
					written.map(([gone]) => gone.id),
				)
				.delete(tx);
		});
		Comment.registerEvent('delete:before', async (written, tx) => {
			await Post.query()
				.whereIn(
					'id',
					written.map(([comment]) => comment.post_id),
				)
				.delete(tx);
		});

		const result = await post.delete();

		expect(result).toBe(true);
		expect(deleted).toEqual(['Hello']);
		expect(await Post.query().count()).toBe(0);
		expect(await Comment.query().count()).toBe(0);
	});

	test('a query delete whose handler cascades into rows it matched still counts them', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE categories (id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT)',
			),
		);
		class Category extends Model<typeof Category.schema> {
			static readonly schema = this.define({
				table: 'categories',
				columns: {
					id: Column.integer().primary().generated(),
					parent_id: Column.integer().nullable(),
					name: Column.text(),
				},
			});

			static readonly events: ModelEvents<Category> = {
				'delete:before': async (written, tx) => {
					await Category.query()
						.whereIn(
							'parent_id',
							written.map(([category]) => category.id),
						)
						.delete(tx);
				},
			};
		}
		const root = await Category.create({ name: 'root' });
		await Category.create({ name: 'child', parent_id: root.id });
		await Category.create({ name: 'grandchild', parent_id: 2 });

		expect(await Category.query().where('id', '<=', 2).delete()).toBe(2);
		expect(await Category.query().count()).toBe(0);
	});
});

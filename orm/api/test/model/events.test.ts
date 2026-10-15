import { describe, expect, test } from 'bun:test';

import {
	AfterCommitError,
	OrmError,
	TransactionError,
} from '../../src/errors';
import { Statement } from '../../src/database/statement';
import type { ModelEvent, ModelEvents } from '../../src/events/events';
import type { Written } from '../../src/model/types';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

describe('model events', () => {
	const orm = OrmBed.use();

	/** Registers a handler on each event that logs the event's name. */
	const log = (into: string[], ...events: ModelEvent[]) => {
		for (const event of events) {
			User.registerEvent(event, (_written: Written<User>) => {
				into.push(event);
			});
		}
	};

	test('an insert, an update and a delete fire :before and :after inside the write, and :committed after it', async () => {
		await orm.open();
		const seen: string[] = [];
		log(
			seen,
			'save:before',
			'create:before',
			'create:after',
			'save:after',
			'create:committed',
			'save:committed',
			'update:before',
			'update:after',
			'update:committed',
			'delete:before',
			'delete:after',
			'delete:committed',
		);

		const user = await User.create({ name: 'Ann' });
		expect(seen.splice(0)).toEqual([
			'save:before',
			'create:before',
			'create:after',
			'save:after',
			'create:committed',
			'save:committed',
		]);

		user.draft().name = 'Anna';
		await user.save();
		expect(seen.splice(0)).toEqual([
			'save:before',
			'update:before',
			'update:after',
			'save:after',
			'update:committed',
			'save:committed',
		]);

		await user.delete();
		expect(seen.splice(0)).toEqual([
			'delete:before',
			'delete:after',
			'delete:committed',
		]);
	});

	test('a clean save fires nothing, and deleting a row already gone runs delete:before only', async () => {
		const db = await orm.open();
		const user = await User.create({ name: 'Ann' });
		await db.run(new Statement('DELETE FROM users WHERE id = ?', [user.id]));

		const seen: string[] = [];
		log(seen, 'save:before', 'save:committed', 'delete:before', 'delete:committed');

		await (await User.create({ name: 'Bob' })).save();
		expect(seen.splice(0)).toEqual(['save:before', 'save:committed']);

		await user.delete();
		expect(seen).toEqual(['delete:before']);
	});

	test('a write with no handler is exactly one statement', async () => {
		await orm.open();

		await User.create({ name: 'Ann' });

		expect(orm.crate.sql).toHaveLength(1);
	});

	test('a change made in save:before reaches the row', async () => {
		await orm.open();
		User.registerEvent('save:before', written => {
			for (const [user] of written) {
				const draft = user.draft();
				draft.name = draft.name.trim();
			}
		});

		const user = await User.create({ name: '  Ann ' });
		user.draft().email = 'a@x.io';
		user.draft().name = ' Anna';
		await user.save();

		expect((await User.find(user.id))!.name).toBe('Anna');
		expect(user.isDirty).toBe(false);
	});

	test('an :after handler reads and writes inside the write, and a throw rolls both back', async () => {
		await orm.open();
		Post.registerEvent('create:after', async (written, tx) => {
			const [post] = written[0]!;
			expect(await Post.find(post!.id, tx)).not.toBeNull();
			await Comment.create({ post_id: post!.id, body: 'first', sort: 0 }, tx);
			if (post!.title === 'bad') throw new Error('refused');
		});

		await Post.create({ title: 'good' });
		const error = await rejection(Post.create({ title: 'bad' }));

		expect(error.message).toBe('refused');
		expect(await Post.query().pluck('title')).toEqual(['good']);
		expect(await Comment.query().count()).toBe(1);
	});

	test('a write with a handler inside it, given a transaction, joins it as a savepoint', async () => {
		const db = await orm.open();
		User.registerEvent('save:before', () => {});

		await db.transaction(async tx => {
			await User.create({ name: 'Ann' }, tx);
		});

		expect(
			orm.crate.sql.filter(sql => sql.startsWith('BEGIN')),
		).toHaveLength(1);
		expect(orm.crate.sql).toContain('SAVEPOINT sp_1');
		expect(await User.query().count()).toBe(1);
	});

	test('a :committed handler runs after the commit, and never for a rollback', async () => {
		const db = await orm.open();
		const seen: number[] = [];
		User.registerEvent('save:committed', async () => {
			seen.push(await User.query().count());
		});

		await db.transaction(async tx => {
			await User.create({ name: 'Ann' }, tx);
			await User.create({ name: 'Bob' }, tx);
			expect(seen).toEqual([]);
		});
		await rejection(
			db.transaction(async tx => {
				await User.create({ name: 'Cy' }, tx);
				throw new Error('stop');
			}),
		);

		expect(seen).toEqual([2, 2]);
	});

	test('a :committed handler inside a savepoint that rolls back never runs', async () => {
		const db = await orm.open();
		const names: string[] = [];
		User.registerEvent('create:committed', written => {
			names.push(...written.map(([user]) => user.name));
		});

		await db.transaction(async tx => {
			await User.create({ name: 'Kept' }, tx);
			await rejection(
				tx.savepoint(async () => {
					await User.create({ name: 'Undone' }, tx);
					throw new Error('stop');
				}),
			);
		});

		expect(names).toEqual(['Kept']);
	});

	test('a write that failed inside a transaction runs no :committed handler', async () => {
		const db = await orm.open();
		const seen: string[] = [];
		log(seen, 'create:committed');
		await User.create({ name: 'Ann', email: 'a@x.io' });
		seen.length = 0;

		await db.transaction(async tx => {
			await rejection(User.create({ name: 'Bob', email: 'a@x.io' }, tx));
		});

		expect(seen).toEqual([]);
	});

	test('a failing :committed handler does not undo the write, the others still run, and the error carries the model', async () => {
		await orm.open();
		const ran: string[] = [];
		Model.registerEvent('create:committed', () => {
			throw new Error('handler broke');
		});
		User.registerEvent('create:committed', () => void ran.push('User'));

		const error = await rejection(User.create({ name: 'Ann' }));

		expect(error).toBeInstanceOf(AfterCommitError);
		expect(error.committed).toBe(true);
		expect(error.result).toBeInstanceOf(User);
		expect(error.result.id).toBe(1);
		expect(error.failures[0].source).toBe('create:committed on User');
		expect(ran).toEqual(['User']);
		expect(await User.query().count()).toBe(1);
	});

	test('a handler is told, per row, which columns the write carries and what each was, updated_at once it is stamped', async () => {
		await orm.open();
		const seen: unknown[] = [];
		User.registerEvent('update:before', written => {
			const [user, changes] = written[0]!;
			seen.push(['update:before', user.name, changes]);
		});
		User.registerEvent('update:committed', written => {
			const [user, changes] = written[0]!;
			seen.push(['update:committed', user.name, changes, user.isDirty]);
		});

		const user = await User.create({ name: 'Ann', age: 1 });
		user.draft().name = 'Anna';
		await user.save();

		expect(seen).toEqual([
			['update:before', 'Ann', { name: { from: 'Ann', to: 'Anna' } }],
			[
				'update:committed',
				'Anna',
				{
					name: { from: 'Ann', to: 'Anna' },
					updated_at: { from: expect.any(Date), to: expect.any(Date) },
				},
				false,
			],
		]);
	});

	test('a create is told every column from nothing, the generated key included once it is known', async () => {
		await orm.open();
		const seen: unknown[] = [];
		User.registerEvent('create:before', written => {
			seen.push(Object.keys(written[0]![1]));
		});
		User.registerEvent('create:committed', written => {
			const [, changes] = written[0]!;
			seen.push([changes.name, changes.id]);
		});

		await User.create({ name: 'Ann' });

		expect(seen).toEqual([
			['name'],
			[{ from: undefined, to: 'Ann' }, { from: undefined, to: 1 }],
		]);
	});

	test('a handler on Model runs for every model, before the model’s own', async () => {
		await orm.open();
		const heard: string[] = [];
		Model.registerEvent(
			'save:committed',
			written => void heard.push(`Model ${written[0]![0].constructor.name}`),
		);
		User.registerEvent(
			'save:committed',
			written => void heard.push(`User ${written[0]![0].constructor.name}`),
		);

		await User.create({ name: 'Ann' });
		await Post.create({ title: 'Hello' });

		expect(heard).toEqual(['Model User', 'User User', 'Model Post']);
	});

	test('registering an event again replaces its handler, and null removes it', async () => {
		await orm.open();
		const seen: string[] = [];
		User.registerEvent('create:committed', () => void seen.push('first'));
		User.registerEvent('create:committed', () => void seen.push('second'));

		await User.create({ name: 'Ann' });
		User.registerEvent('create:committed', null);
		await User.create({ name: 'Bob' });

		expect(seen).toEqual(['second']);
	});

	test('a model declares its events once, a registered one stands in for it, and null brings it back', async () => {
		await orm.open();
		const seen: string[] = [];
		class Page extends Model<typeof Page.schema> {
			static readonly schema = this.define({
				table: 'articles',
				columns: {
					ref: Column.text().primary(),
					title: Column.text().nullable(),
				},
			});

			static readonly events: ModelEvents<Page> = {
				'create:committed': written =>
					void seen.push(`declared ${written[0]![0].ref}`),
			};
		}

		await Page.create({ ref: 'a' });
		Page.registerEvent('create:committed', written =>
			void seen.push(`registered ${written[0]![0].ref}`),
		);
		await Page.create({ ref: 'b' });
		Page.registerEvent('create:committed', null);
		await Page.create({ ref: 'c' });

		expect(seen).toEqual(['declared a', 'registered b', 'declared c']);
		expect(() => {
			(Page as { events?: unknown }).events = {};
		}).toThrow(TypeError);
	});

	test('an event that does not exist is refused, whether registered or declared', async () => {
		await orm.open();
		class Page extends Model<typeof Page.schema> {
			static readonly schema = this.define({
				table: 'articles',
				columns: { ref: Column.text().primary() },
			});

			static readonly events = { saving: () => {} } as ModelEvents<Page>;
		}

		expect(() =>
			User.registerEvent('saving' as ModelEvent, () => {}),
		).toThrow(OrmError);
		for (const ref of ['a', 'b']) {
			const error = await rejection(Page.create({ ref }));
			expect(error).toBeInstanceOf(OrmError);
			expect(error.message).toContain("no event 'saving'");
		}
	});

	test('bulk writes fire once for the whole batch', async () => {
		await orm.open();
		const sizes: string[] = [];
		User.registerEvent(
			'create:before',
			written => void sizes.push(`create ${written.length}`),
		);
		User.registerEvent(
			'update:before',
			written => void sizes.push(`update ${written.length}`),
		);
		User.registerEvent(
			'save:committed',
			written => void sizes.push(`saved ${written.length}`),
		);

		const users = await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob' },
			{ name: 'Cy' },
		]);
		users[0]!.draft().age = 1;
		users[2]!.draft().age = 3;
		await User.updateMany(users);

		expect(sizes).toEqual(['create 3', 'saved 3', 'update 2', 'saved 2']);
	});

	test('a query update with a handler writes through the models, so each is seen', async () => {
		await orm.open();
		await User.createMany([
			{ name: 'Ann' },
			{ name: 'Bob' },
			{ name: 'Cy' },
		]);
		const seen: string[] = [];
		User.registerEvent('update:committed', written => {
			seen.push(
				...written.map(
					([user, changes]) => `${changes.age?.from}→${user.age} ${user.name}`,
				),
			);
		});

		const matched = await User.query()
			.whereIn('name', ['Ann', 'Cy'])
			.select('name')
			.update({ age: 9 });

		expect(matched).toBe(2);
		expect(seen).toEqual(['null→9 Ann', 'null→9 Cy']);
	});

	test('a query delete with a handler announces the rows it deletes and marks them gone', async () => {
		await orm.open();
		await User.createMany([{ name: 'Ann' }, { name: 'Bob' }]);
		const gone: [string, boolean][] = [];
		User.registerEvent('delete:committed', written => {
			gone.push(
				...written.map(([user]) => [user.name, user.exists] as [string, boolean]),
			);
		});

		expect(await User.query().where('name', 'Ann').delete()).toBe(1);
		expect(gone).toEqual([['Ann', false]]);
	});

	test('a query delete removes the rows it announced, not ones a handler made match since', async () => {
		await orm.open();
		await User.createMany([{ name: 'Ann', age: 1 }]);
		User.registerEvent('delete:before', async (_written, tx) => {
			await User.create({ name: 'Late', age: 1 }, tx);
		});

		expect(await User.query().where('age', 1).delete()).toBe(1);
		expect(await User.query().pluck('name')).toEqual(['Late']);
	});

	test('a delete cascades through handlers, and a row already claimed is skipped', async () => {
		await orm.open();
		const post = await Post.create({ title: 'Hello' });
		await Comment.createMany([
			{ post_id: post.id, body: 'a', sort: 0 },
			{ post_id: post.id, body: 'b', sort: 1 },
		]);
		Post.registerEvent('delete:before', async (written, tx) => {
			await Comment.query()
				.whereIn(
					'post_id',
					written.map(([deleted]) => deleted.id),
				)
				.delete(tx);
		});
		// Deleting a comment deletes its post back, which is already being deleted.
		const deletedBack: [boolean, boolean][] = [];
		Comment.registerEvent('delete:before', async (written, tx) => {
			for (const [comment] of written) {
				const parent = (await Post.find(comment.post_id, tx))!;
				deletedBack.push([await parent.delete(tx), parent.exists]);
			}
		});

		expect(await post.delete()).toBe(true);
		expect(await Post.query().count()).toBe(0);
		expect(await Comment.query().count()).toBe(0);
		// The delete that began it removes the row; one claimed by it removes nothing itself.
		expect(deletedBack).toEqual([
			[false, false],
			[false, false],
		]);
	});

	test('a key may be deleted, made and deleted again in one transaction', async () => {
		const db = await orm.open();
		User.registerEvent('delete:before', () => {});

		await db.transaction(async tx => {
			const first = await User.create({ id: 5, name: 'Ann' }, tx);
			expect(await first.delete(tx)).toBe(true);
			const second = await User.create({ id: 5, name: 'Again' }, tx);
			expect(await second.delete(tx)).toBe(true);
		});

		expect(await User.query().count()).toBe(0);
	});

	test('handlers that write each other without end are stopped', async () => {
		await orm.open();
		User.registerEvent('create:after', async (written, tx) => {
			await User.create({ name: `${written[0]![0].name}+` }, tx);
		});

		const error = await rejection(User.create({ name: 'Ann' }));

		expect(error).toBeInstanceOf(TransactionError);
		expect(error.message).toContain('nested 32 deep');
		expect(await User.query().count()).toBe(0);
	});

	test('a handler registered while a write runs leaves that write alone, and its :committed handler still runs', async () => {
		await orm.open();
		const seen: string[] = [];
		log(seen, 'create:committed');

		const creating = User.create({ name: 'Ann' });
		User.registerEvent('create:after', () => void seen.push('create:after'));
		await creating;

		expect(seen).toEqual(['create:committed']);
	});
});

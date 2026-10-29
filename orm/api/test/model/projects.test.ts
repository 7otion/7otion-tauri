import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { OrmError } from '../../src/errors';
import { Model } from '../../src/model/model';
import { Post, SCHEMA, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

/**
 * One SQLite file per project, opened and left open while the app runs, and changed
 * for another when the user opens a different project.
 */
describe('a database file per project', () => {
	const orm = OrmBed.use();

	/** Opens a project file and points every model at it, as the app does on a switch. */
	const open = async (path: string): Promise<Database> => {
		const database = await orm.bed.databaseWith(SCHEMA, { path });
		Model.connect(database);
		return database;
	};

	const names = async (database: Database): Promise<string[]> =>
		(
			await database.run(
				new Statement('SELECT name FROM users ORDER BY id'),
			)
		).rows.map(row => row.name as string);

	const titles = async (database: Database): Promise<string[]> =>
		(
			await database.run(
				new Statement('SELECT title FROM posts ORDER BY id'),
			)
		).rows.map(row => row.title as string);

	test('each project keeps its own rows, and writes go to the one now connected', async () => {
		const first = await open('first.sqlite');
		await User.create({ name: 'in the first' });

		const second = await open('second.sqlite');
		await User.create({ name: 'in the second' });

		expect(await names(first)).toEqual(['in the first']);
		expect(await names(second)).toEqual(['in the second']);
	});

	test('a model read from the project before is refused, rather than saved into the one now open', async () => {
		const first = await open('first.sqlite');
		const held = await User.create({ name: 'belongs to the first' });

		const second = await open('second.sqlite');
		await User.create({ name: 'belongs to the second' });

		held.draft().name = 'edited after the switch';
		const error = await rejection(held.save());

		expect(error).toBeInstanceOf(OrmError);
		expect(await names(second)).toEqual(['belongs to the second']);
		expect(await names(first)).toEqual(['belongs to the first']);
	});

	test('a model read from the project before is refused, rather than deleting a row of the one now open', async () => {
		await open('first.sqlite');
		const held = await User.create({ name: 'belongs to the first' });

		const second = await open('second.sqlite');
		await User.create({ name: 'belongs to the second' });

		const error = await rejection(held.delete());

		expect(error).toBeInstanceOf(OrmError);
		expect(await names(second)).toEqual(['belongs to the second']);
	});

	test('closing the project before does not leave its models pointing at the one now open', async () => {
		const first = await open('first.sqlite');
		const held = await User.create({ name: 'belongs to the first' });

		const second = await open('second.sqlite');
		await User.create({ name: 'belongs to the second' });
		await first.close();

		held.draft().name = 'edited after the switch';
		const error = await rejection(held.save());

		expect(error).toBeInstanceOf(OrmError);
		expect(await names(second)).toEqual(['belongs to the second']);
	});

	test('a query built against the project before is refused, rather than reading the one now open', async () => {
		await open('first.sqlite');
		await User.create({ name: 'shared name' });
		const query = User.query().where('name', 'shared name');

		await open('second.sqlite');
		await User.createMany([
			{ name: 'shared name' },
			{ name: 'shared name' },
			{ name: 'shared name' },
		]);

		expect(await rejection(query.get())).toBeInstanceOf(OrmError);
		// Refined after the switch, it is still the query that was built before it.
		expect(await rejection(query.orderBy('name').get())).toBeInstanceOf(
			OrmError,
		);
	});

	test('a query built against the project before is refused, rather than updating or deleting rows of the one now open', async () => {
		await open('first.sqlite');
		const query = User.query().where('name', 'shared name');

		const second = await open('second.sqlite');
		await User.create({ name: 'shared name' });

		expect(
			await rejection(query.update({ name: 'renamed' })),
		).toBeInstanceOf(OrmError);
		expect(await rejection(query.delete())).toBeInstanceOf(OrmError);
		expect(await names(second)).toEqual(['shared name']);
	});

	test('a model read from the project before is refused, rather than syncing into the one now open', async () => {
		await open('first.sqlite');
		const post = await Post.create({ title: 'in the first' });

		const second = await open('second.sqlite');
		await Post.create({ title: 'in the second' });

		expect(await rejection(post.sync('tags', ['a']))).toBeInstanceOf(
			OrmError,
		);
		expect(
			(await second.run(new Statement('SELECT tag FROM post_tags'))).rows,
		).toEqual([]);
	});

	test('a relation loaded after the switch is refused, rather than reaching into the project now open', async () => {
		const first = await open('first.sqlite');
		const author = await User.create({ name: 'the author' });
		await Post.create({
			user_id: author.id,
			title: 'written in the first',
		});

		const second = await open('second.sqlite');
		const other = await User.create({ name: 'another author' });
		await Post.create({
			user_id: other.id,
			title: 'written in the second',
		});

		expect(await rejection(author.load('posts'))).toBeInstanceOf(OrmError);
		expect(await titles(first)).toEqual(['written in the first']);
		expect(await titles(second)).toEqual(['written in the second']);
	});

	test('a statement already on its way when the switch happens finishes on its own project', async () => {
		const first = await open('first.sqlite');
		const writing = User.create({ name: 'started on the first' });

		const second = await open('second.sqlite');
		await writing;

		expect(await names(first)).toEqual(['started on the first']);
		expect(await names(second)).toEqual([]);
	});

	test('a read on its way when the switch happens gives models of its own project, refused a save into the one now open', async () => {
		await open('first.sqlite');
		await User.create({ name: 'in the first' });

		const second = await orm.bed.databaseWith(SCHEMA, {
			path: 'second.sqlite',
		});
		await second.run(
			new Statement("INSERT INTO users (name) VALUES ('in the second')"),
		);

		const reading = User.query().first();
		Model.connect(second);
		const held = (await reading)!;

		expect(held.name).toBe('in the first');
		held.draft().name = 'edited after the switch';
		expect(await rejection(held.save())).toBeInstanceOf(OrmError);
		expect(await names(second)).toEqual(['in the second']);
	});

	test('a with() on its way when the switch happens is refused, rather than loading children from the one now open', async () => {
		await open('first.sqlite');
		const author = await User.create({ name: 'in the first' });
		await Post.create({ user_id: author.id, title: 'post of the first' });

		const second = await orm.bed.databaseWith(SCHEMA, {
			path: 'second.sqlite',
		});
		await second.run(
			new Statement("INSERT INTO users (name) VALUES ('in the second')"),
		);
		await second.run(
			new Statement(
				"INSERT INTO posts (user_id, title) VALUES (1, 'post of the second')",
			),
		);

		const reading = User.query().with('posts').get();
		Model.connect(second);

		expect(await rejection(reading)).toBeInstanceOf(OrmError);
	});

	test('a project reopened after it was closed still holds what was written', async () => {
		const first = await open('first.sqlite');
		await User.create({ name: 'written before closing' });
		await first.close();

		const again = orm.bed.database({ path: 'first.sqlite' });
		Model.connect(again);

		expect(await names(again)).toEqual(['written before closing']);
	});

	test('a transaction of the project before cannot be carried on after the switch', async () => {
		const first = await open('first.sqlite');

		const error = await rejection(
			first.transaction(async tx => {
				await User.create({ name: 'inside the transaction' }, tx);
				await open('second.sqlite');
				// The handle belongs to the first project, which is no longer connected.
				await User.create({ name: 'after the switch' }, tx);
			}),
		);

		expect(error).toBeInstanceOf(OrmError);
		expect(await names(first)).toEqual([]);
	});
});

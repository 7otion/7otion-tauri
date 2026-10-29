import { afterEach, describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Users } from '../harness/stores.svelte';
import { Watch } from '../harness/watch.svelte';

const SEED = [
	"INSERT INTO users (name, active) VALUES ('Ann', 1), ('Bob', 1), ('Cy', 0)",
	"INSERT INTO posts (user_id, title, published) VALUES (1, 'A1', 1)",
];

describe('a live count follows the rows it counts', () => {
	const orm = OrmBed.use();
	const stops: (() => void)[] = [];
	afterEach(() => stops.splice(0).forEach(stop => stop()));
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};
	const counts = () =>
		orm.crate.statements.filter(sql => sql.startsWith('SELECT COUNT('));

	test('a row created, deleted, or changed in a column the query filters on moves it', async () => {
		await open();
		const active = await User.query().where('active', true).liveCount();
		const shown = new Watch(() => active.current);
		stops.push(shown.stop);

		const dee = await User.create({ name: 'Dee', active: true });
		await (await User.find(3))!.update({ active: true });
		await dee.delete();

		expect(shown.seen).toEqual([2, 3, 4, 3]);
	});

	test('a change to a column the query does not filter on asks for nothing', async () => {
		await open();
		const active = await User.query()
			.where('active', true)
			.orderBy('name')
			.liveCount();
		orm.crate.calls.length = 0;

		await (await User.find(1))!.update({ name: 'Zed' });

		expect(active.current).toBe(2);
		expect(counts()).toHaveLength(0);

		await (await User.find(3))!.update({ active: true });

		expect(active.current).toBe(3);
		expect(counts()).toHaveLength(1);
	});

	test('it counts the whole result of a query with a limit, as count() does', async () => {
		await open();

		const total = await User.query()
			.orderBy('id')
			.limit(1)
			.offset(1)
			.liveCount();

		expect(total.current).toBe(3);
	});

	test('under whereHas it follows the related table', async () => {
		await open();
		const authors = await User.query().whereHas('posts').liveCount();
		expect(authors.current).toBe(1);

		await Post.create({ title: 'B1', user_id: 2 });

		expect(authors.current).toBe(2);
	});

	test('released, it stops following', async () => {
		await open();
		const total = await User.query().liveCount();

		total.release();
		await User.create({ name: 'Dee' });

		expect(total.current).toBe(3);
	});

	test('as a store’s field it is zero until loaded, follows commits, and is counted again when state it read changes', async () => {
		await open();
		const users = Users.get();
		expect(users.total.current).toBe(0);
		expect(users.total.loaded).toBe(false);

		expect(await users.total.settled()).toBe(3);
		expect(users.total.loaded).toBe(true);

		await User.create({ name: 'Dee', active: false });
		expect(users.total.current).toBe(4);

		users.onlyActive = true;
		expect(await users.total.settled()).toBe(2);
	});
});

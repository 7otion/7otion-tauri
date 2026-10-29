import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { Query } from '../../src/store/query.svelte';
import { Model } from '../../src/model/model';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Users } from '../harness/stores.svelte';
import { mounted, State, Watch } from '../harness/watch.svelte';

describe('a query', () => {
	const orm = OrmBed.use();
	const made: { unmount(): void }[] = [];
	const query = <T>(make: () => T): T => {
		const mount = mounted(make);
		made.push(mount);
		return mount.made;
	};
	afterEach(() => made.splice(0).forEach(mount => mount.unmount()));

	test('loads itself: empty and not loaded until the first result lands', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });
		const users = query(
			() => new Query(() => User.query().orderBy('name')),
		);

		expect(users.rows.length).toBe(0);
		expect(users.loaded).toBe(false);

		await users.settled();

		expect(users.collection.pluck('name')).toEqual(['Ann']);
		expect(users.loaded).toBe(true);
	});

	test('follows commits: what reads it is shown each commit that changed the rows', async () => {
		await orm.open();
		const users = query(
			() => new Query(() => User.query().orderBy('name')),
		);
		await users.settled();
		const names = new Watch(() => [...users].map(user => user.name).join());

		await User.create({ name: 'Bob' });
		await User.create({ name: 'Ann' });

		expect(names.seen).toEqual(['', 'Bob', 'Ann,Bob']);
	});

	test('is built again when state it read changes, and the collection follows the new query', async () => {
		await orm.open();
		await User.create({ name: 'Ann', active: true });
		await User.create({ name: 'Bob', active: false });
		const onlyActive = new State(false);
		const users = query(
			() =>
				new Query(() =>
					onlyActive.value
						? User.query().where('active', true)
						: User.query(),
				),
		);
		await users.settled();
		expect(users.rows.length).toBe(2);

		onlyActive.value = true;
		await users.settled();

		expect(users.collection.pluck('name')).toEqual(['Ann']);
		await User.create({ name: 'Cid', active: true });
		expect(users.collection.pluck('name')).toEqual(['Ann', 'Cid']);
	});

	test('gives its first row, and follows that row’s own commits as well as which row it is', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const users = query(
			() => new Query(() => User.query().orderBy('name').limit(1)),
		);
		const first = new Watch(() => users.first?.name ?? null);
		await users.settled();

		await ann.update({ name: 'Bea' });
		await User.create({ name: 'Al' });

		expect(first.seen).toEqual([null, 'Ann', 'Bea', 'Al']);
	});

	test('a failed load keeps the rows it had and reports the error', async () => {
		await orm.open();
		const users = query(
			() =>
				new Query(() =>
					User.query().whereRaw('no_such_column = ?', [1]),
				),
		);
		await users.settled();

		expect(users.rows.length).toBe(0);
		expect(users.error).toBeInstanceOf(Error);
		expect(users.loaded).toBe(false);
	});

	test('rebuilt several times while a load runs, it loads the latest build alone after it', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });
		await User.create({ name: 'Bob' });
		const term = new State('A');
		const crate = orm.crate;
		const original = crate.invoke.bind(crate);
		let reached!: () => void;
		const atRead = new Promise<void>(resolve => (reached = resolve));
		let release!: () => void;
		const gate = new Promise<void>(resolve => (release = resolve));
		let held = false;
		crate.invoke = async (command: string, args: unknown) => {
			const sql = (args as { sql?: string } | undefined)?.sql ?? '';
			const answer = await original(command, args);
			if (!held && sql.startsWith('SELECT * FROM `users`')) {
				held = true;
				reached();
				await gate;
			}
			return answer;
		};
		crate.calls.length = 0;

		try {
			const users = query(
				() =>
					new Query(() =>
						User.query().where('name', 'LIKE', `${term.value}%`),
					),
			);
			await atRead;
			for (const typed of ['B', 'Bo', 'Bob']) {
				term.value = typed;
				flushSync();
			}
			release();
			await users.settled();

			expect(users.collection.pluck('name')).toEqual(['Bob']);
			const asked = crate.calls.filter(call =>
				call.sql?.startsWith('SELECT * FROM `users`'),
			);
			expect(asked.map(call => call.params)).toEqual([['A%'], ['Bob%']]);
		} finally {
			crate.invoke = original;
		}
	});

	test('stops following once what made it is gone', async () => {
		await orm.open();
		const mount = mounted(() => new Query(() => User.query()));
		const users = mount.made;
		await users.settled();

		mount.unmount();
		await User.create({ name: 'Ann' });

		expect(users.rows.length).toBe(0);
	});

	test('made outside a store or a component, it is refused by Svelte', async () => {
		await orm.open();
		expect(() => new Query(() => User.query())).toThrow(/effect_orphan/);
	});

	test('as a store’s field it loads with the store, feeds what the store derives, and ends with its database', async () => {
		const database = await orm.open();
		await User.create({ name: 'Ann', active: true });
		await User.create({ name: 'Bob', active: false });
		const users = Users.get();
		await users.all.settled();
		expect(users.names).toBe('Ann,Bob');

		users.onlyActive = true;
		await users.all.settled();
		expect(users.names).toBe('Ann');

		await database.close();
		Model.connect(orm.bed.database());
		await User.create({ name: 'Cy', active: true });
		expect(users.names).toBe('Ann');
	});
});

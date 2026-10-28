import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import type { Database, DatabaseOptions } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { StoreError } from '../../src/errors';
import { Model } from '../../src/model/model';
import { Stored } from '../../src/store/stored.svelte';
import { OrmBed } from '../harness/orm';
import { storage } from '../harness/storage';
import {
	Breaks,
	Counter,
	KeepsThrows,
	Library,
	Ping,
	Pong,
	Settings,
	Shell,
	Throws,
} from '../harness/stores.svelte';
import { Watch } from '../harness/watch.svelte';

describe('how long a store lives', () => {
	const orm = OrmBed.use();
	const opened: Database[] = [];
	const connect = (options: Partial<DatabaseOptions> = {}): Database => {
		const database = orm.bed.database(options);
		opened.push(database);
		Model.connect(database);
		return database;
	};

	afterEach(async () => {
		for (const database of opened.splice(0)) await database.close().catch(() => {});
		storage.clear();
	});

	test('a store is one instance for the app’s whole run', async () => {
		const settings = Settings.get();
		expect(Settings.get()).toBe(settings);

		await connect().close();
		connect();

		expect(Settings.get()).toBe(settings);
	});

	test('a database store is one instance per database, ended as it closes', async () => {
		const first = connect();
		const library = Library.get();
		expect(Library.get()).toBe(library);
		expect(library.database).toBe(first);

		await first.close();
		expect(() => Library.get()).toThrow(
			new StoreError('[store] Library lives while a database is connected; none is.'),
		);

		connect();
		expect(Library.get()).not.toBe(library);
		expect(Library.get().count).toBe(0);
	});

	test('a database store asked for before any database is connected says so', () => {
		Model.$default = null;
		expect(() => Library.get()).toThrow(
			new StoreError('[store] Library lives while a database is connected; none is.'),
		);
	});

	test('a store is made by get(), never with new', () => {
		expect(() => new Settings()).toThrow(
			new StoreError('[store] Settings is made by Settings.get(), not with new.'),
		);
		connect();
		expect(() => new Library()).toThrow(
			new StoreError('[store] Library is made by Library.get(), not with new.'),
		);
	});

	test('a store reads another, and what it derives follows', () => {
		connect();
		const doubled = new Watch(() => Counter.get().doubled);

		Library.get().count = 2;

		expect(doubled.last).toBe(4);
		doubled.stop();
	});

	test('two stores that keep each other lazily are each the one get() returns', () => {
		connect();
		const ping = Ping.get();

		expect(ping.pong()).toBe(Pong.get());
		expect(Pong.get().ping()).toBe(ping);
	});

	test('what a store derives from one it keeps lazily follows it', () => {
		connect();
		const hits = new Watch(() => Pong.get().pingHits);

		Ping.get().hits = 3;

		expect(hits.last).toBe(3);
		hits.stop();
	});

	test('a store kept lazily is not made until it is first asked for', () => {
		connect();
		const keeps = KeepsThrows.get();

		expect(() => keeps.throws()).toThrow('constructor bug');
	});

	test('a store kept lazily is asked for again on each call, so it follows the connected database', () => {
		const first = connect();
		expect(Shell.get().library().database).toBe(first);

		const second = connect();

		expect(Shell.get().library().database).toBe(second);
	});

	test('a store made by the expression that first reads it is followed by that expression', () => {
		connect();
		const count = new Watch(() => Library.get().count);

		Library.get().count = 5;

		expect(count.seen).toEqual([0, 5]);
		count.stop();
	});

	test('an effect made in a store’s constructor runs until its database closes', async () => {
		const database = connect();
		const counter = Counter.get();
		const library = Library.get();
		flushSync();

		library.count = 1;
		flushSync();
		await database.close();
		library.count = 2;
		flushSync();

		expect(counter.shown).toEqual([0, 1]);
	});

	test('a store whose database closed makes no more queries and stored values', async () => {
		const database = connect();
		const library = Library.get();

		await database.close();

		expect(() => library.later()).toThrow(
			new StoreError('[store] Library has ended: its database is no longer connected.'),
		);
	});

	test('connecting another database ends the stores of the one before, which stays open', async () => {
		const first = connect();
		const counter = Counter.get();
		const library = Library.get();
		flushSync();

		const second = connect();
		library.count = 1;
		flushSync();

		expect(counter.shown).toEqual([0]);
		expect(() => library.later()).toThrow(StoreError);
		expect(Library.get()).not.toBe(library);
		expect(Library.get().database).toBe(second);
		expect(first.isOpen).toBe(true);
	});

	test('disconnect closes the connected database, ends its stores and leaves the models with none', async () => {
		const database = connect();
		const counter = Counter.get();
		flushSync();

		await Model.disconnect();
		counter.library.count = 1;
		flushSync();

		expect(database.isOpen).toBe(false);
		expect(counter.shown).toEqual([0]);
		expect(() => Library.get()).toThrow(StoreError);
		expect(() => Model.database).toThrow('Call Model.connect(database) first');
		await Model.disconnect();
	});

	test('a store whose constructor throws is not kept, and the next ask makes it again', () => {
		connect();
		expect(() => Throws.get()).toThrow('constructor bug');
		expect(() => Throws.get()).toThrow('constructor bug');
		expect(Library.get().count).toBe(0);
	});

	test('a close ends every store and closes the file when a cleanup throws, then rethrows', async () => {
		const database = connect();
		Breaks.get();
		const counter = Counter.get();
		flushSync();

		await expect(database.close()).rejects.toThrow('cleanup bug');

		counter.library.count = 9;
		flushSync();
		expect(counter.shown).toEqual([0]);
		await expect(database.run(new Statement('SELECT 1'))).rejects.toThrow(/closed/);
	});

	test('stored values of a database store begin with the database’s path, or its namespace; the app’s with nothing', () => {
		const database = connect();
		expect(Library.get().view.key).toBe(`${database.path}.view`);

		Settings.get().theme.current = 'light';
		expect(storage.getItem('theme')).toBe('"light"');
	});

	test('a namespace keeps one database’s stored values from another’s', async () => {
		const alpha = connect({ namespace: 'alpha' });
		Library.get().view.current = 'list';
		await alpha.close();

		connect({ namespace: 'beta' });

		expect(Library.get().view.current).toBe('grid');
		expect(storage.getItem('alpha.view')).toBe('"list"');
	});

	test('erase drops every stored value under a prefix and no other', () => {
		storage.setItem('alpha.view', '"list"');
		storage.setItem('alpha.refs', '[]');
		storage.setItem('beta.view', '"grid"');

		Stored.erase('alpha.');

		expect(storage.getItem('alpha.view')).toBeNull();
		expect(storage.getItem('alpha.refs')).toBeNull();
		expect(storage.getItem('beta.view')).toBe('"grid"');
	});
});

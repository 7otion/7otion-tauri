import { afterEach, describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import type { Database, DatabaseOptions } from '../../src/database/database';
import { StoreError } from '../../src/errors';
import { Model } from '../../src/model/model';
import { TabScope } from '../../src/store/tab-scope';
import { OrmBed } from '../harness/orm';
import { storage } from '../harness/storage';
import { Library, Results, Search, TabBreaks } from '../harness/stores.svelte';

describe('a store per tab', () => {
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

	test('a tab store is one instance per scope, and another scope gets its own', () => {
		connect();
		const first = new TabScope();
		const second = new TabScope();

		const search = Search.get(first);
		expect(Search.get(first)).toBe(search);
		expect(Search.get(second)).not.toBe(search);
		expect(search.scope).toBe(first);
	});

	test('a tab store reads a sibling of its tab and the connection store of its database', () => {
		const database = connect();
		const scope = new TabScope();

		const results = Results.get(scope);

		expect(results.search).toBe(Search.get(scope));
		expect(results.library).toBe(Library.get());
		expect(results.database).toBe(database);
		expect(Search.get(new TabScope())).not.toBe(results.search);
	});

	test('a scope asked for with no database connected is refused', () => {
		Model.$default = null;
		expect(() => new TabScope()).toThrow(
			new StoreError('[store] A tab scope lives while a database is connected; none is.'),
		);
	});

	test('a tab store asked for outside a component with no scope given says so', () => {
		connect();
		expect(() => Search.get()).toThrow(
			new StoreError(
				"[store] Search lives in a tab: asked for outside a component's script, it needs its " +
					'TabScope passed, as Search.get(scope).',
			),
		);
	});

	test('a tab store is made by get(), never with new', () => {
		connect();
		expect(() => new Search()).toThrow(
			new StoreError('[store] Search is made by Search.get(), not with new.'),
		);
	});

	test('ending a scope ends its stores and their effects, and they make no more stored values', () => {
		connect();
		const scope = new TabScope();
		const results = Results.get(scope);
		flushSync();

		results.search.term = 'a';
		flushSync();
		scope.end();
		results.search.term = 'b';
		flushSync();

		expect(results.shown).toEqual(['', 'a']);
		expect(scope.isOpen).toBe(false);
		expect(() => results.search.later()).toThrow(
			new StoreError('[store] Search has ended: its tab has closed.'),
		);
	});

	test('a tab store asked of an ended scope is refused', () => {
		connect();
		const scope = new TabScope();
		scope.end();

		expect(() => Search.get(scope)).toThrow(
			new StoreError('[store] Search lives while its tab is open; the tab has closed.'),
		);
	});

	test('ending a scope twice does nothing more', () => {
		connect();
		const scope = new TabScope();
		TabBreaks.get(scope);
		flushSync();

		expect(() => scope.end()).toThrow('tab cleanup bug');
		expect(() => scope.end()).not.toThrow();
	});

	test('a scope ends when the models connect elsewhere, and its stores stay apart from the next database’s', () => {
		connect();
		const scope = new TabScope();
		const results = Results.get(scope);
		flushSync();

		connect();
		results.search.term = 'a';
		flushSync();

		expect(scope.isOpen).toBe(false);
		expect(results.shown).toEqual(['']);
		expect(() => Search.get(scope)).toThrow(StoreError);
		expect(Search.get(new TabScope())).not.toBe(results.search);
	});

	test('a scope ends when its database closes, and the first failure among its stores is thrown after all of it ran', async () => {
		const database = connect();
		const scope = new TabScope();
		TabBreaks.get(scope);
		const results = Results.get(scope);
		flushSync();

		await expect(database.close()).rejects.toThrow('tab cleanup bug');

		results.search.term = 'a';
		flushSync();
		expect(scope.isOpen).toBe(false);
		expect(results.shown).toEqual(['']);
	});

	test('disconnect ends every scope with its database', async () => {
		connect();
		const scope = new TabScope();
		Search.get(scope);

		await Model.disconnect();

		expect(scope.isOpen).toBe(false);
		expect(() => Search.get(scope)).toThrow(StoreError);
	});

	test('stored values of a tab store begin with the database’s namespace and the scope’s', () => {
		const database = connect({ namespace: 'alpha' });

		expect(Search.get(new TabScope('library')).view.key).toBe('alpha.library.view');
		expect(Search.get(new TabScope()).view.key).toBe(`${database.namespace}.view`);
	});

	test('two tabs of one kind share a stored value, as one preference', () => {
		connect({ namespace: 'alpha' });
		const first = Search.get(new TabScope('library'));
		first.view.current = 'list';

		const second = Search.get(new TabScope('library'));

		expect(second.view.current).toBe('list');
		expect(storage.getItem('alpha.library.view')).toBe('"list"');
	});
});

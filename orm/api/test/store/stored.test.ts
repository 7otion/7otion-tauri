import { afterEach, describe, expect, test } from 'bun:test';

import { Stored } from '../../src/store/stored.svelte';
import { storage } from '../harness/storage';
import { State, Watch } from '../harness/watch.svelte';

afterEach(() => storage.clear());

describe('a stored value', () => {
	test('starts from the initial value and writes every change as JSON', () => {
		const view = new Stored('view', 'grid');
		expect(view.current).toBe('grid');

		view.current = 'list';
		expect(storage.getItem('view')).toBe('"list"');
	});

	test('tells what reads it', () => {
		const view = new Stored('view', 'grid');
		const shown = new Watch(() => view.current);

		view.current = 'list';

		expect(shown.seen).toEqual(['grid', 'list']);
	});

	test('an effect that assigns it does not come to depend on it', () => {
		const names = new State<string[]>([]);
		const recent = new Stored<string[]>('recent', []);
		const writer = new Watch(() => {
			recent.current = [...names.value];
		});

		names.value = ['a'];

		expect(writer.reruns).toBe(1);
		expect(storage.getItem('recent')).toBe('["a"]');
	});

	test('hands back the value it was given, not a wrapper around it', () => {
		const refs = ['a'];
		const selection = new Stored<string[]>('selection', []);

		selection.current = refs;

		expect(selection.current).toBe(refs);
	});

	test('loads a value written before it was made', () => {
		storage.setItem('count', '7');
		expect(new Stored('count', 0).current).toBe(7);
	});

	test('falls back to the initial value when the stored one is refused or is not JSON', () => {
		storage.setItem('view', '"table"');
		const isView = (value: unknown) => value === 'grid' || value === 'list';
		expect(new Stored('view', 'grid', { validate: isView }).current).toBe('grid');

		storage.setItem('view', 'not json');
		expect(new Stored('view', 'grid').current).toBe('grid');
	});

	test('a write that is no change writes nothing', () => {
		const view = new Stored('view', 'grid');
		storage.setItem('view', 'untouched');

		view.current = 'grid';

		expect(storage.getItem('view')).toBe('untouched');
	});

	test('undefined removes the key', () => {
		const value = new Stored<string | undefined>('value', 'x');
		value.current = undefined;
		expect(storage.getItem('value')).toBeNull();
	});
});

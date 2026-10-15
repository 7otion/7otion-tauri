import { describe, expect, test } from 'bun:test';

import { OrmError } from '../../src/errors';
import {
	BooleanCodec,
	DateCodec,
	JsonCodec,
	type Codec,
} from '../../src/schema/codec';
import { Column } from '../../src/schema/column';
import { PrimaryKey } from '../../src/schema/primary-key';
import { Table } from '../../src/schema/table';

const moment = new Date('2026-03-04T05:06:07.890Z');

class Money {
	constructor(readonly cents: number) {}
}

const MoneyCodec: Codec<Money, number> = {
	decode: cents => new Money(Number(cents)),
	encode: money => money.cents,
};

describe('codecs', () => {
	test('a date is stored in the shape its column names', () => {
		expect(new DateCodec('iso').encode(moment)).toBe(
			'2026-03-04T05:06:07.890Z',
		);
		expect(new DateCodec('datetime').encode(moment)).toBe(
			'2026-03-04 05:06:07.890',
		);
		expect(new DateCodec('unix').encode(moment)).toBe(1772600767);
		expect(new DateCodec('unix_ms').encode(moment)).toBe(1772600767890);
	});

	test('every date shape reads back as the moment it stored', () => {
		for (const storage of ['iso', 'datetime', 'unix_ms'] as const) {
			const codec = new DateCodec(storage);
			expect(codec.decode(codec.encode(moment), 'at').getTime()).toBe(
				moment.getTime(),
			);
		}

		const unix = new DateCodec('unix');
		expect(unix.decode(unix.encode(moment), 'at').toISOString()).toBe(
			'2026-03-04T05:06:07.000Z',
		);
	});

	test("text without a zone is read as UTC, as SQLite's CURRENT_TIMESTAMP writes it, and a zone is honoured", () => {
		const codec = new DateCodec('datetime');
		expect(codec.decode('2026-03-04 05:06:07', 'at').toISOString()).toBe(
			'2026-03-04T05:06:07.000Z',
		);
		expect(
			codec.decode('2026-03-04T07:06:07+02:00', 'at').toISOString(),
		).toBe('2026-03-04T05:06:07.000Z');
		expect(codec.decode('2026-03-04', 'at').toISOString()).toBe(
			'2026-03-04T00:00:00.000Z',
		);
	});

	test('a value that is no date names its column', () => {
		expect(() => new DateCodec('iso').decode('soon', 'due_at')).toThrow(
			'"due_at"',
		);
		expect(() => new DateCodec('unix').decode('', 'due_at')).toThrow(
			OrmError,
		);
	});

	test('a boolean is stored as 1 or 0 and read back from either spelling', () => {
		const codec = new BooleanCodec();
		expect([codec.encode(true), codec.encode(false)]).toEqual([1, 0]);
		for (const truthy of [1, '1', 'true']) {
			expect(codec.decode(truthy)).toBe(true);
		}
		for (const falsy of [0, '0', 'false', '']) {
			expect(codec.decode(falsy)).toBe(false);
		}
	});

	test('json serialises strings too, and names a column that holds none', () => {
		const codec = new JsonCodec();
		expect(codec.encode('text')).toBe('"text"');
		expect(codec.decode('{"a":1}', 'meta')).toEqual({ a: 1 });
		expect(() => codec.decode('{oops', 'meta')).toThrow('"meta"');
	});
});

describe('Table', () => {
	const table = new Table({
		table: 'products',
		columns: {
			id: Column.integer().primary().generated(),
			name: Column.text(),
			nickname: Column.text().emptyToNull(),
			active: Column.boolean(),
			meta: Column.json<{ tags: string[] }>(),
			price: Column.custom(MoneyCodec),
			body: Column.blob().nullable(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
		guarded: ['id'],
	});

	test('values are encoded as their columns store them, and undefined is left out', () => {
		expect(
			table.encode({
				name: 'a',
				nickname: '',
				active: true,
				meta: { tags: ['x'] },
				price: new Money(250),
				created_at: moment,
				updated_at: undefined,
				joined: 5,
			}),
		).toEqual({
			name: 'a',
			nickname: null,
			active: 1,
			meta: '{"tags":["x"]}',
			price: 250,
			created_at: 1772600767,
			joined: 5,
		});
	});

	test('a row is decoded into logical values, nulls and undeclared columns untouched', () => {
		expect(
			table.decode({
				id: 1,
				active: 0,
				meta: '{"tags":[]}',
				price: 99,
				body: null,
				created_at: 1772600767,
				extra: 'kept',
			}),
		).toEqual({
			id: 1,
			active: false,
			meta: { tags: [] },
			price: new Money(99),
			body: null,
			created_at: new Date('2026-03-04T05:06:07.000Z'),
			extra: 'kept',
		});
	});

	test('a value as it reads back once stored', () => {
		expect(table.column('created_at').readBack(moment)).toEqual(
			new Date('2026-03-04T05:06:07.000Z'),
		);
		expect(table.column('nickname').readBack('')).toBeNull();
		expect(table.column('active').readBack(true)).toBe(true);
		expect(table.column('name').readBack('a')).toBe('a');
	});

	test('a column copies its object values detached, and compares them by content', () => {
		const meta = { tags: ['a'] };
		const copy = table.column('meta').copy(meta) as typeof meta;
		expect(copy).toEqual(meta);
		expect(copy).not.toBe(meta);

		expect(table.column('meta').same(meta, copy)).toBe(true);
		meta.tags.push('b');
		expect(table.column('meta').same(meta, copy)).toBe(false);

		expect(table.column('price').same(new Money(1), new Money(1))).toBe(true);
		expect(table.column('price').copy(new Money(1))).toBeInstanceOf(Money);

		const bytes = new Uint8Array([1, 2]);
		const body = table.column('body');
		expect(body.copy(bytes)).not.toBe(bytes);
		expect(body.same(bytes, new Uint8Array([1, 2]))).toBe(true);
		expect(body.same(bytes, new Uint8Array([1, 3]))).toBe(false);
		expect(table.column('name').same('a', null)).toBe(false);
	});

	test('a name the table does not declare still copies and compares, with no codec', () => {
		const extra = table.column('joined_total');
		const value = { n: 1 };
		expect(extra.copy(value)).toEqual(value);
		expect(extra.copy(value)).not.toBe(value);
		expect(extra.same({ n: 1 }, { n: 1 })).toBe(true);
	});

	test('fill may set a declared column that is neither guarded nor a timestamp', () => {
		expect(table.fillable('name')).toBe(true);
		expect(table.fillable('id')).toBe(false);
		expect(table.fillable('updated_at')).toBe(false);
		expect(table.fillable('nope')).toBe(false);

		const listed = new Table({
			table: 't',
			columns: { id: Column.integer().primary(), a: Column.text() },
			fillable: ['a'],
			guarded: ['a'],
		});
		expect(listed.fillable('a')).toBe(true);
		expect(listed.fillable('id')).toBe(false);
	});

	test('a key signature is taken from the stored form, and is null while any part is missing', () => {
		const keyed = new Table({
			table: 'flags',
			columns: {
				on: Column.boolean().primary(),
				at: Column.date('unix').primary(),
			},
		});

		expect(keyed.keySignature({ on: true, at: moment })).toBe(
			PrimaryKey.signature([1, 1772600767]),
		);
		expect(keyed.keySignature({ on: true })).toBeNull();
		expect(keyed.keySignature({ on: true, at: null })).toBeNull();
		expect(PrimaryKey.signature([0, ''])).not.toBeNull();
	});

	test('a column is qualified with its table only when the table declares it', () => {
		expect(table.qualified('name')).toBe('products.name');
		expect(table.qualified('other.name')).toBe('other.name');
	});

	test('a table without a primary key is refused', () => {
		expect(
			() => new Table({ table: 't', columns: { a: Column.text() } }),
		).toThrow('declares no primary key');
	});

	test('generated() is for a single-column primary key', () => {
		expect(
			() =>
				new Table({
					table: 't',
					columns: {
						a: Column.integer().primary().generated(),
						b: Column.integer().primary(),
					},
				}),
		).toThrow('single-column');
		expect(
			() =>
				new Table({
					table: 't',
					columns: {
						a: Column.integer().primary(),
						b: Column.integer().generated(),
					},
				}),
		).toThrow('single-column');
	});

	test('timestamps must be declared, as date columns', () => {
		expect(
			() =>
				new Table({
					table: 't',
					columns: { id: Column.integer().primary() },
					timestamps: true,
				}),
		).toThrow('must declare created_at');
		expect(
			() =>
				new Table({
					table: 't',
					columns: {
						id: Column.integer().primary(),
						made: Column.text(),
						changed: Column.date(),
					},
					timestamps: { createdAt: 'made', updatedAt: 'changed' },
				}),
		).toThrow('must be a date column');
	});

	test('the generated key is left to the database only while it is unset', () => {
		expect(table.primaryKey.generatedIn({ name: 'a' })).toBe('id');
		expect(table.primaryKey.generatedIn({ id: null })).toBe('id');
		expect(table.primaryKey.generatedIn({ id: 7 })).toBeNull();
	});

	test('timestamps stamp both columns at one instant on insert, and one on update', () => {
		expect(table.timestamps.insertStamp(moment)).toEqual({
			created_at: moment,
			updated_at: moment,
		});
		expect(table.timestamps.updateStamp(moment)).toEqual({
			updated_at: moment,
		});
		expect(table.timestamps.without(['name', 'updated_at'])).toEqual([
			'name',
		]);
	});
});

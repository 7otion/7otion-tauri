import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { InsertBuilder } from '../../src/sql/insert';
import { SelectBuilder } from '../../src/sql/select';
import { UpdateManyBuilder } from '../../src/sql/update-many';
import { TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = [
	`CREATE TABLE items (
		order_id INTEGER NOT NULL,
		line INTEGER NOT NULL,
		qty INTEGER NOT NULL DEFAULT 1,
		note TEXT,
		PRIMARY KEY (order_id, line)
	)`,
	"CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL DEFAULT 'empty')",
];

describe('what the builders write, run on SQLite', () => {
	const bed = TestBed.use();

	test('row values match several columns together', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(
			InsertBuilder.into('items').values([
				{ order_id: 1, line: 1 },
				{ order_id: 1, line: 2 },
				{ order_id: 2, line: 1 },
			]),
		);

		const { rows } = await db.run(
			SelectBuilder.from('items')
				.select('order_id', 'line')
				.whereTuplesIn(
					['items.order_id', 'items.line'],
					[
						[1, 2],
						[2, 1],
						[9, 9],
					],
				)
				.orderBy('order_id'),
		);

		expect(rows).toEqual([
			{ order_id: 1, line: 2 },
			{ order_id: 2, line: 1 },
		]);
	});

	test('a bulk update on a composite key touches only its rows', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(
			InsertBuilder.into('items').values([
				{ order_id: 1, line: 1 },
				{ order_id: 1, line: 2 },
				{ order_id: 2, line: 1 },
			]),
		);

		const { affected } = await db.run(
			UpdateManyBuilder.table('items', ['order_id', 'line'])
				.rows([
					{ key: [1, 1], set: { qty: 5 } },
					{ key: [2, 1], set: { qty: 7, note: 'x' } },
				])
				.shared({ note: 'shared' }),
		);

		expect(affected).toBe(2);
		expect(
			(
				await db.run(
					SelectBuilder.from('items')
						.orderBy('order_id')
						.orderBy('line'),
				)
			).rows,
		).toEqual([
			{ order_id: 1, line: 1, qty: 5, note: 'shared' },
			{ order_id: 1, line: 2, qty: 1, note: null },
			{ order_id: 2, line: 1, qty: 7, note: 'shared' },
		]);
	});

	test('a row of defaults comes back whole', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const { rows } = await db.run(
			InsertBuilder.into('notes').values({}).returning('*'),
		);

		expect(rows).toEqual([{ id: 1, body: 'empty' }]);
	});

	test('hand-written SQL given the wrong number of params is refused, not run half bound', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const tooFew = await rejection(
			db.run(
				SelectBuilder.from('notes').whereRaw('id = ? OR id = ?', [1]),
			),
		);
		const tooMany = await rejection(
			db.run(new Statement('SELECT 1', [1])),
		);

		expect(tooFew.code).toBe('value');
		expect(tooMany.code).toBe('value');
	});
});

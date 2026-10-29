import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { QueryError } from '../../src/errors';
import { InsertBuilder } from '../../src/sql/insert';
import { SelectBuilder } from '../../src/sql/select';
import { FILE, TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const PREFIX = 'plugin:7otion-sqlite|';

describe('database edges', () => {
	const bed = TestBed.use();

	const call = (command: string, args: Record<string, unknown>) =>
		bed.crate.invoke(PREFIX + command, args) as Promise<any>;

	const load = async () =>
		(await call('load', { path: FILE, config: null })).handle as number;

	test('run() rejects, rather than throwing, when the statement cannot be written', async () => {
		const db = bed.database();
		// toStatement() throws: an insert needs at least one row.
		const source = InsertBuilder.into('notes');

		let thrown: unknown = null;
		let promise: Promise<unknown> | null = null;
		try {
			promise = db.run(source);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeNull();
		expect(await rejection(promise!)).toBeInstanceOf(QueryError);
		expect(await rejection(db.run(source))).toBeInstanceOf(QueryError);
	});

	test('a begin still waiting for the writer when its handle closes is refused, and keeps nothing', async () => {
		const closing = await load();
		// A second handle keeps the file open, as a second window does.
		const other = await load();
		await call('run', {
			handle: other,
			sql: 'CREATE TABLE notes (body TEXT)',
			params: [],
			tx: null,
		});

		await call('begin', { handle: closing });
		const waiting = rejection(call('begin', { handle: closing }));
		await new Promise(resolve => setTimeout(resolve, 10));
		await call('close', { handle: closing });

		expect((await waiting).code).toBe('misuse');
		expect(bed.crate.openTransactions).toBe(0);
		await call('run', {
			handle: other,
			sql: "INSERT INTO notes VALUES ('free')",
			params: [],
			tx: null,
		});
	});

	test('a script of several statements runs whole, a later one leaning on an earlier', async () => {
		const db = bed.database();

		await db.run(
			new Statement(
				'CREATE TABLE a (x); CREATE TABLE b (x); INSERT INTO b VALUES (1)',
			),
		);

		expect((await db.run(new Statement('SELECT x FROM b'))).rows).toEqual([
			{ x: 1 },
		]);
		expect((await db.run(new Statement('SELECT x FROM a'))).rows).toEqual(
			[],
		);
	});

	test('an empty blob reads back as an empty blob', async () => {
		const db = bed.database();

		const [row] = (
			await db.run(
				new Statement('SELECT ? AS value, typeof(?) AS kind', [
					new Uint8Array(),
					new Uint8Array(),
				]),
			)
		).rows;

		expect(row).toEqual({ value: new Uint8Array(), kind: 'blob' });
	});

	test('a whole number JavaScript cannot hold exactly is refused, and nothing is written', async () => {
		const db = await bed.databaseWith([
			'CREATE TABLE numbers (value INTEGER)',
		]);

		await db.run(
			new Statement('INSERT INTO numbers VALUES (?)', [
				Number.MAX_SAFE_INTEGER,
			]),
		);
		const error = await rejection(
			db.run(new Statement('INSERT INTO numbers VALUES (?)', [2 ** 60])),
		);

		expect(error.code).toBe('value');
		expect(
			(await db.run(new Statement('SELECT value FROM numbers'))).rows,
		).toEqual([{ value: Number.MAX_SAFE_INTEGER }]);
	});

	test('an insert of a whole number beyond 2^53 into an INTEGER column is refused, and the table stays readable', async () => {
		const db = await bed.databaseWith([
			'CREATE TABLE counters (id INTEGER PRIMARY KEY, total INTEGER)',
		]);

		const error = await rejection(
			db.run(InsertBuilder.into('counters').values({ total: 2 ** 53 })),
		);

		expect(error.code).toBe('value');
		expect((await db.run(SelectBuilder.from('counters'))).rows).toEqual([]);
	});

	test('a write whose RETURNING row cannot be read back is not kept', async () => {
		const db = await bed.databaseWith(['CREATE TABLE numbers (value)']);

		const error = await rejection(
			db.run(
				new Statement(
					'INSERT INTO numbers VALUES (9007199254740993) RETURNING value',
				),
			),
		);
		const { rows } = await db.run(
			new Statement('SELECT count(*) AS n FROM numbers'),
		);

		expect({ code: error.code, rows }).toEqual({
			code: 'value',
			rows: [{ n: 0 }],
		});
	});

	test('a statement queued on a transaction that SQLite then ended is refused, not run outside it', async () => {
		const handle = await load();
		const run = (sql: string, tx: number | null = null) =>
			call('run', { handle, sql, params: [], tx });
		await run('CREATE TABLE u (id INTEGER PRIMARY KEY)');

		const { tx } = await call('begin', { handle });
		await run('INSERT INTO u (id) VALUES (1)', tx);

		// Slow, then a conflict that ON CONFLICT ROLLBACK answers by ending the transaction.
		const ending = rejection(
			run(
				'INSERT OR ROLLBACK INTO u (id) ' +
					'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 3000000) ' +
					'SELECT count(*) * 0 + 1 FROM c',
				tx,
			),
		);
		await new Promise(resolve => setTimeout(resolve, 50));
		const queued = rejection(run('INSERT INTO u (id) VALUES (99)', tx));

		expect((await ending).transactionEnded).toBe(true);
		expect((await queued).code).toBe('misuse');
		expect((await run('SELECT id FROM u')).rows).toEqual([]);
	});
});

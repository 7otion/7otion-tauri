import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { DatabaseError, TransactionError } from '../../src/errors';
import { FILE, TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'];

describe('the stand-in keeps to the crate', () => {
	const bed = TestBed.use();

	test('a script ending in a trailing comment runs', async () => {
		const db = bed.database();
		const result = await rejection(
			db.run(new Statement('CREATE TABLE a (x); -- done')),
		);
		expect(result).not.toBeInstanceOf(Error);
	});

	test('a statement followed by a comment holding a semicolon runs', async () => {
		const db = bed.database();
		const result = await rejection(
			db.run(new Statement('CREATE TABLE b (x) -- one; two\n')),
		);
		expect(result).not.toBeInstanceOf(Error);
	});

	test('a script whose later statement has a placeholder is refused with value, as the crate does', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const error = await rejection(
			db.run(
				new Statement(
					"INSERT INTO notes (body) VALUES ('x'); INSERT INTO notes (body) VALUES (?)",
				),
			),
		);
		const { rows } = await db.run(new Statement('SELECT body FROM notes'));
		expect({ code: error?.code, rows }).toEqual({
			code: 'value',
			rows: [],
		});
	});

	test('several statements with params all run, as the crate runs them', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const result = await rejection(
			db.run(
				new Statement(
					"INSERT INTO notes (body) VALUES (?); INSERT INTO notes (body) VALUES ('b')",
					['a'],
				),
			),
		);
		const { rows } = await db.run(new Statement('SELECT body FROM notes'));
		expect({ failed: result instanceof Error, rows }).toEqual({
			failed: false,
			rows: [{ body: 'a' }, { body: 'b' }],
		});
	});
});

describe('scratch: readers', () => {
	const bed = TestBed.use();

	test('a statement without tx that runs BEGIN does not leave the reader on a stale snapshot', async () => {
		const db = await bed.databaseWith(SCHEMA, { readers: 1 });

		await rejection(db.run(new Statement('BEGIN')));
		await db.run(new Statement('SELECT count(*) AS n FROM notes'));
		await db.run(
			new Statement("INSERT INTO notes (body) VALUES ('a')"),
		);

		expect(
			(await db.run(new Statement('SELECT count(*) AS n FROM notes')))
				.rows,
		).toEqual([{ n: 1 }]);
	});

	test('the crate applies its default pragmas to readers; the stand-in does too', async () => {
		const db = bed.database();
		expect((await db.run(new Statement('PRAGMA foreign_keys'))).rows).toEqual([
			{ foreign_keys: 1 },
		]);
	});

	test('a configured pragma reaches the readers, as in the crate', async () => {
		const db = bed.database({ pragmas: { cache_size: -1234 } });
		expect((await db.run(new Statement('PRAGMA cache_size'))).rows).toEqual([
			{ cache_size: -1234 },
		]);
	});
});

describe('scratch: transactions', () => {
	const bed = TestBed.use();

	test('a statement that ends the transaction is reported whether it read or wrote', async () => {
		const db = await bed.databaseWith(SCHEMA);

		let after: unknown = null;
		const outcome = await rejection(
			db.transaction(async tx => {
				await db.run(
					new Statement("INSERT INTO notes (body) VALUES ('a')"),
					tx,
				);
				await db.run(new Statement('ROLLBACK'), tx);
				after = await rejection(
					db.run(
						new Statement("INSERT INTO notes (body) VALUES ('b')"),
						tx,
					),
				);
			}),
		);

		expect(after).toBeInstanceOf(TransactionError);
		expect(outcome).toBeInstanceOf(TransactionError);
	});

	test('a duplicate rowid is classified unique', async () => {
		const db = await bed.databaseWith(['CREATE TABLE r (a TEXT)']);
		await db.run(
			new Statement("INSERT INTO r (rowid, a) VALUES (1, 'x')"),
		);
		const error = await rejection(
			db.run(
				new Statement("INSERT INTO r (rowid, a) VALUES (1, 'y')"),
			),
		);
		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('unique');
	});

	test('a key is refused when the crate has no encryption feature', async () => {
		const db = bed.database({ key: 'secret' });
		const error = await rejection(db.run(new Statement('SELECT 1')));
		expect(error).toBeInstanceOf(DatabaseError);
	});
});

void FILE;

describe('scripts the stand-in splits as SQLite does', () => {
	const bed = TestBed.use();

	test('a comment holding a semicolon between statements', async () => {
		const db = bed.database();
		const result = await rejection(
			db.run(
				new Statement(
					'CREATE TABLE a (x);\n-- next: b; then c\nCREATE TABLE b (x);\n',
				),
			),
		);
		expect(result).not.toBeInstanceOf(Error);
	});

	test('a schema file ending in a comment line', async () => {
		const db = bed.database();
		const result = await rejection(
			db.run(
				new Statement(
					'CREATE TABLE a (x);\nCREATE TABLE b (x);\n-- end\n',
				),
			),
		);
		expect(result).not.toBeInstanceOf(Error);
	});

	test('a script of two selects answers no rows, as the crate does', async () => {
		const db = bed.database();
		expect(
			(await db.run(new Statement('SELECT 1 AS a; SELECT 2 AS a'))).rows,
		).toEqual([]);
	});

	test('2^53 is refused with value, as in the crate', async () => {
		const db = bed.database();
		const error = await rejection(
			db.run(new Statement('SELECT typeof(?) AS t', [2 ** 53])),
		);
		expect(error.code).toBe('value');
	});
});

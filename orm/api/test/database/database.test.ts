import { describe, expect, test } from 'bun:test';

import { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { DatabaseError, OrmError } from '../../src/errors';
import { FILE, TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = [
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY,
		email TEXT NOT NULL UNIQUE,
		age INTEGER CHECK (age >= 0),
		team_id INTEGER REFERENCES teams(id)
	)`,
	'CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT)',
	'CREATE TABLE files (id INTEGER PRIMARY KEY, body BLOB, size REAL)',
];

const insert = (email: string, age: number | null = null) =>
	new Statement('INSERT INTO users (email, age) VALUES (?, ?)', [email, age]);

describe('Database', () => {
	const bed = TestBed.use();

	test('a row inserted through execute is read back through select', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const written = await db.run(insert('a@x.io', 30));
		expect(written).toEqual({
			rows: [],
			affected: 1,
			transactionEnded: false,
			timing: {
				waitedMs: expect.any(Number),
				ranMs: expect.any(Number),
				pluginMs: expect.any(Number),
			},
		});

		const { rows } = await db.run(
			new Statement('SELECT email, age FROM users WHERE id = ?', [1]),
		);
		expect(rows).toEqual([{ email: 'a@x.io', age: 30 }]);
	});

	test('affected counts only what the statement itself changed, not an earlier write', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const affected = async (sql: string) =>
			(await db.run(new Statement(sql))).affected;

		await db.run(insert('a@x.io'));
		await db.run(insert('b@x.io'));

		expect(await affected('UPDATE users SET age = 1')).toBe(2);
		expect(await affected('CREATE INDEX users_age ON users (age)')).toBe(0);
		expect(await affected('UPDATE users SET age = 2 WHERE id = 404')).toBe(
			0,
		);
	});

	test('execute returns what a RETURNING clause produced', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const written = await db.run(
			new Statement(
				'INSERT INTO users (email) VALUES (?), (?) RETURNING id, email',
				['a@x.io', 'b@x.io'],
			),
		);

		expect(written.affected).toBe(2);
		expect(written.rows).toEqual([
			{ id: 1, email: 'a@x.io' },
			{ id: 2, email: 'b@x.io' },
		]);
	});

	test('update and delete report the rows they touched', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(insert('a@x.io', 1));
		await db.run(insert('b@x.io', 1));

		const updated = await db.run(
			new Statement('UPDATE users SET age = 2 WHERE age = 1'),
		);
		expect(updated.affected).toBe(2);

		const deleted = await db.run(
			new Statement('DELETE FROM users WHERE email = ?', ['a@x.io']),
		);
		expect(deleted.affected).toBe(1);
	});

	test('a statement is routed by what it does, so raw SQL cannot pick the wrong connection', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const written = await db.run(insert('a@x.io'));
		expect(written.affected).toBe(1);

		// The first keyword reads, and the statement still reaches the writer.
		await db.run(
			new Statement(
				'WITH c AS (SELECT ? AS email) INSERT INTO users (email) SELECT email FROM c',
				['b@x.io'],
			),
		);

		expect(
			(await db.run(new Statement('SELECT email FROM users ORDER BY id')))
				.rows,
		).toEqual([{ email: 'a@x.io' }, { email: 'b@x.io' }]);
	});

	test('anything with toStatement() is accepted as a statement', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const { rows } = await db.run({
			toStatement: () => new Statement('SELECT 1 + ? AS n', [2]),
		});

		expect(rows).toEqual([{ n: 3 }]);
	});

	test('each constraint kind fails with its own code', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(insert('a@x.io'));

		const codes = [
			await rejection(db.run(insert('a@x.io'))),
			await rejection(
				db.run(new Statement('INSERT INTO users (age) VALUES (1)')),
			),
			await rejection(db.run(insert('b@x.io', -1))),
			await rejection(
				db.run(
					new Statement(
						'INSERT INTO users (email, team_id) VALUES (?, ?)',
						['c@x.io', 99],
					),
				),
			),
		].map(error => error.code);

		expect(codes).toEqual(['unique', 'not_null', 'check', 'foreign_key']);
	});

	test('a failed statement names the SQL it was running, and not its params', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(insert('secret@x.io'));

		const error = await rejection(db.run(insert('secret@x.io')));

		expect(error.message).toContain(
			'while running: INSERT INTO users (email, age) VALUES (?, ?)',
		);
		expect(error.message).not.toContain('secret@x.io');
		expect(error.statement.params).toEqual(['secret@x.io', null]);
	});

	test('a column that does not exist is an error, not a match', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const error = await rejection(
			db.run(new Statement('SELECT * FROM users WHERE nope = 1')),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('unknown');
	});

	test('a boolean is stored as 1 or 0', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const { rows } = await db.run(
			new Statement('SELECT ? AS yes, ? AS no', [true, false]),
		);

		expect(rows).toEqual([{ yes: 1, no: 0 }]);
	});

	test('a blob reads back byte for byte', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const body = new Uint8Array(70_000).map((_, index) => index % 256);

		await db.run(
			new Statement('INSERT INTO files (body) VALUES (?)', [body]),
		);
		const [row] = (await db.run(new Statement('SELECT body FROM files')))
			.rows;

		expect(row!.body).toBeInstanceOf(Uint8Array);
		expect(row!.body).toEqual(body);
	});

	test('a whole number is stored as an integer and any other as a real', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const { rows } = await db.run(
			new Statement(
				'SELECT typeof(?) AS whole, typeof(?) AS part',
				[3_000_000_000, 1.5],
			),
		);

		expect(rows).toEqual([{ whole: 'integer', part: 'real' }]);
	});

	test('a number that is not finite is refused before it is sent', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const error = await rejection(
			db.run(
				new Statement('INSERT INTO files (size) VALUES (?)', [NaN]),
			),
		);

		expect(error).toBeInstanceOf(OrmError);
		expect(error).not.toBeInstanceOf(DatabaseError);
		expect(bed.crate.statements).toEqual([]);
	});

	test('a stored integer beyond 2^53 fails rather than being rounded', async () => {
		const db = await bed.databaseWith(SCHEMA);
		bed.crate
			.direct(FILE)
			.exec('INSERT INTO teams (id) VALUES (9007199254740993)');

		const error = await rejection(
			db.run(new Statement('SELECT id FROM teams')),
		);

		expect(error.code).toBe('value');
	});

	test('the file opens at first use, and a failed open is tried again', async () => {
		const db = bed.database();
		expect(bed.crate.calls).toEqual([]);

		bed.crate.failNext('load', {
			code: 'unknown',
			message: 'unable to open database file',
			transactionEnded: false,
		});
		const error = await rejection(db.run(new Statement('SELECT 1')));
		expect(error.message).toContain('unable to open database file');

		expect((await db.run(new Statement('SELECT 1 AS n'))).rows).toEqual([
			{ n: 1 },
		]);
		expect(
			bed.crate.calls.filter(call => call.command === 'load'),
		).toHaveLength(2);
	});

	test('statements started together share one open', async () => {
		const db = bed.database();

		await Promise.all([
			db.run(new Statement('SELECT 1')),
			db.run(new Statement('SELECT 2')),
		]);

		expect(
			bed.crate.calls.filter(call => call.command === 'load'),
		).toHaveLength(1);
	});

	test('a closed database refuses further use', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.close();

		const error = await rejection(db.run(new Statement('SELECT 1')));

		expect(error).toBeInstanceOf(OrmError);
		expect(error.message).toContain('is closed');
	});

	test('closing a database that never opened sends nothing', async () => {
		await bed.database().close();

		expect(bed.crate.calls).toEqual([]);
	});

	test('options reach the crate as its config, and none means attach', async () => {
		await bed.database().run(new Statement('SELECT 1'));
		await new Database({
			path: 'other.sqlite',
			pragmas: { synchronous: 'NORMAL', cache_size: 2000 },
			writerWaitMs: 50,
		}).run(new Statement('SELECT 1'));

		const configs = bed.crate.calls
			.filter(call => call.command === 'load')
			.map(call => call.args.config);
		expect(configs).toEqual([
			null,
			{
				key: null,
				pragmas: [
					['synchronous', 'NORMAL'],
					['cache_size', '2000'],
				],
				writerWaitMs: 50,
				readers: null,
			},
		]);
	});
});

import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { DatabaseError } from '../../src/errors';
import { FILE, TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = ['CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)'];
const PREFIX = 'plugin:7otion-sqlite|';

describe('scripts', () => {
	const bed = TestBed.use();

	const tables = async (
		db: Awaited<ReturnType<typeof bed.databaseWith>>,
		...names: string[]
	) =>
		(
			await db.run(
				new Statement(
					`SELECT name FROM sqlite_master WHERE name IN (${names.map(() => '?').join(', ')}) ORDER BY name`,
					names,
				),
			)
		).rows.map(row => row.name);

	test('a statement that fails at run time fails the call, and nothing after it runs', async () => {
		const db = await bed.databaseWith(SCHEMA);
		await db.run(
			new Statement("INSERT INTO notes (id, body) VALUES (1, 'a')"),
		);

		const error = await rejection(
			db.run(
				new Statement(
					'CREATE TABLE first (a);' +
						" INSERT INTO notes (id, body) VALUES (1, 'clash');" +
						' CREATE TABLE second (a)',
				),
			),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('unique');
		expect(await tables(db, 'first', 'second')).toEqual(['first']);
	});

	test('a script headed by a statement that returns rows runs whole', async () => {
		const db = bed.database();

		await db.run(
			new Statement('PRAGMA journal_mode; CREATE TABLE z (a)'),
		);
		await db.run(new Statement('SELECT 1; CREATE TABLE y (a)'));

		expect(await tables(db, 'y', 'z')).toEqual(['y', 'z']);
	});

	test('a trigger body and a semicolon inside a string do not cut a statement short', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await db.run(
			new Statement(
				'CREATE TABLE log (body TEXT);' +
					' CREATE TRIGGER noted AFTER INSERT ON notes BEGIN' +
					'   INSERT INTO log VALUES (new.body);' +
					' END;' +
					" INSERT INTO notes (body) VALUES ('a;b')",
			),
		);

		expect((await db.run(new Statement('SELECT body FROM log'))).rows).toEqual([
			{ body: 'a;b' },
		]);
	});

	test('a script that fails inside its own BEGIN is rolled back, and the writer is free', async () => {
		const db = await bed.databaseWith(SCHEMA, { writerWaitMs: 50 });

		const error = await rejection(
			db.run(
				new Statement(
					"BEGIN; INSERT INTO notes (id, body) VALUES (1, 'a');" +
						' INSERT INTO nope VALUES (1); COMMIT',
				),
			),
		);
		expect(error).toBeInstanceOf(DatabaseError);
		expect(bed.crate.direct(FILE).inTransaction).toBe(false);

		await db.transaction(async tx => {
			await db.run(
				new Statement("INSERT INTO notes (id, body) VALUES (2, 'b')"),
				tx,
			);
		});
		expect((await db.run(new Statement('SELECT id FROM notes'))).rows).toEqual([
			{ id: 2 },
		]);
	});

	test('a script of several statements answers no rows', async () => {
		const db = bed.database();

		const { rows } = await db.run(
			new Statement("SELECT 1 AS a; SELECT 'x' AS b, 2 AS c"),
		);

		expect(rows).toEqual([]);
	});

	test('a script holding a placeholder is refused before anything in it runs', async () => {
		const db = bed.database();

		const error = await rejection(
			db.run(new Statement('CREATE TABLE z (x); INSERT INTO z VALUES (?)')),
		);

		expect(error.code).toBe('value');
		expect(await tables(db, 'z')).toEqual([]);
	});

	test('a placeholder written inside a string or a comment of a script is none', async () => {
		const db = bed.database();

		await db.run(
			new Statement(
				"CREATE TABLE q (x); -- is it? :yes\n INSERT INTO q VALUES ('?, :a, @b, $c') /* ? */",
			),
		);

		expect((await db.run(new Statement('SELECT x FROM q'))).rows).toEqual([
			{ x: '?, :a, @b, $c' },
		]);
	});

	test('a statement that leaves a transaction open is refused as misuse and rolled back', async () => {
		const db = await bed.databaseWith(SCHEMA, { writerWaitMs: 50 });

		const error = await rejection(
			db.run(
				new Statement(
					"BEGIN; INSERT INTO notes (id, body) VALUES (1, 'a')",
				),
			),
		);

		expect(error.code).toBe('misuse');
		expect(bed.crate.direct(FILE).inTransaction).toBe(false);
		expect((await db.run(new Statement('SELECT id FROM notes'))).rows).toEqual(
			[],
		);
	});
});

describe('the stand-in keeps to what the crate does', () => {
	const bed = TestBed.use();

	const call = (command: string, args: Record<string, unknown>) =>
		bed.crate.invoke(PREFIX + command, args) as Promise<any>;

	const load = async () =>
		(await call('load', { path: FILE, config: null }))
			.handle as number;

	test('a select names one column per value, a repeated name included', async () => {
		const handle = await load();
		await call('run', {
			handle,
			sql: 'CREATE TABLE a (id, x); CREATE TABLE b (id, y); INSERT INTO a VALUES (1, 2); INSERT INTO b VALUES (3, 4)',
			params: [],
			tx: null,
		});

		const wire = await call('run', {
			handle,
			sql: 'SELECT * FROM a JOIN b',
			params: [],
			tx: null,
		});

		expect(wire.columns).toEqual(['id', 'x', 'id', 'y']);
		expect(wire.rows).toEqual([[1, 2, 3, 4]]);
	});

	test('readers: 0 opens one reader', async () => {
		const db = bed.database({ readers: 0 });

		expect((await db.run(new Statement('SELECT 1 AS n'))).rows).toEqual([
			{ n: 1 },
		]);
	});

	test('a blob that is not base64, or carries another key, is refused with value', async () => {
		const handle = await load();

		for (const param of [{ blob: '%%' }, { blob: 'AQID', extra: 1 }]) {
			const error = await rejection(
				call('run', {
					handle,
					sql: 'SELECT ?',
					params: [param],
					tx: null,
				}),
			);
			expect(error.code).toBe('value');
		}
	});

	test('a statement already waiting for the writer runs before close() closes the file', async () => {
		const db = await bed.databaseWith(SCHEMA);

		let letGo!: () => void;
		const held = db.transaction(
			() => new Promise<void>(resolve => (letGo = resolve)),
		);
		await new Promise(resolve => setTimeout(resolve, 10));

		const waiting = db.run(
			new Statement("INSERT INTO notes (id, body) VALUES (1, 'a')"),
		);
		await new Promise(resolve => setTimeout(resolve, 10));
		letGo();
		await held;
		const closing = db.close();

		expect((await waiting).affected).toBe(1);
		await closing;
	});
});

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = [
	'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE)',
];

const insert = (body: string) =>
	new Statement('INSERT INTO notes (body) VALUES (?)', [body]);

describe('statement logging', () => {
	const bed = TestBed.use();
	const printed: { method: string; text: string }[] = [];
	const spies: { mockRestore(): void }[] = [];

	beforeEach(() => {
		printed.length = 0;
		for (const method of [
			'log',
			'error',
			'group',
			'groupCollapsed',
			'groupEnd',
		] as const) {
			spies.push(
				spyOn(console, method).mockImplementation(
					(...args: unknown[]) => {
						printed.push({
							method,
							text: args
								.map(arg =>
									typeof arg === 'string'
										? arg
										: arg instanceof Error
											? arg.message
											: JSON.stringify(arg),
								)
								.join(' '),
						});
					},
				),
			);
		}
	});

	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	// Timings vary, and transaction ids are the crate's own count, which no test starts.
	const normal = (text: string) =>
		text.replace(/\d+\.\d+ms/g, 'Nms').replace(/tx \d+/g, 'tx N');
	const lines = () =>
		printed
			.filter(line => line.method !== 'groupEnd')
			.map(line => `${line.method}: ${normal(line.text)}`);
	const headers = () =>
		printed
			.filter(line => line.text.startsWith('[orm]'))
			.map(line => normal(line.text));

	test('nothing is printed while logging is off', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await db.run(insert('a'));

		expect(printed).toEqual([]);
	});

	test('a statement is one line, the SQL and the time SQLite took; the rest is under it', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		printed.length = 0;

		await db.run(insert("it's"));
		await db.run(new Statement('SELECT body\n\tFROM notes'));

		expect(lines()).toEqual([
			'groupCollapsed: [orm] INSERT INTO notes (body) VALUES (?) — took Nms',
			"log: params  1: 'it''s'",
			'log: affected 1',
			'log: db Nms · wait Nms · plugin Nms · render Nms · total Nms',
			'groupCollapsed: [orm] SELECT body FROM notes — took Nms',
			'log: 1 row',
			'log: [{"body":"it\'s"}]',
			'log: db Nms · wait Nms · plugin Nms · render Nms · total Nms',
		]);
	});

	test('the time on the line is what SQLite took, not the round trip', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		printed.length = 0;

		const result = await db.run(new Statement('SELECT body FROM notes'));

		expect(printed[0]!.text).toBe(
			`[orm] SELECT body FROM notes — took ${result.timing.ranMs.toFixed(1)}ms`,
		);
		expect(result.timing.ranMs).toBeGreaterThan(0);
	});

	test('the four parts of the timing add up to the total, and wait counts a held writer', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		printed.length = 0;

		let outside!: Promise<unknown>;
		await db.transaction(async tx => {
			await db.run(insert('inside'), tx);
			outside = db.run(insert('outside'));
			await new Promise(resolve => setTimeout(resolve, 40));
		});
		const { timing } = (await outside) as {
			timing: Record<string, number>;
		};

		expect(timing.waitedMs).toBeGreaterThanOrEqual(30);
		const line = printed
			.map(line => line.text)
			.find(text => text.startsWith('db '))!;
		const parts = [...line.matchAll(/(\w+) (\d+\.\d+)ms/g)].map(m => [
			m[1],
			Number(m[2]),
		]);
		const [db_, wait, plugin, render, total] = parts.map(
			([, n]) => n as number,
		);
		expect(parts.map(([name]) => name)).toEqual([
			'db',
			'wait',
			'plugin',
			'render',
			'total',
		]);
		expect(
			Math.abs(db_! + wait! + plugin! + render! - total!),
		).toBeLessThan(0.3);
	});

	test('a failing statement is printed expanded, with its error', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		await db.run(insert('a'));
		printed.length = 0;

		await rejection(db.run(insert('a')));

		expect(lines().slice(0, 2)).toEqual([
			'group: [orm] INSERT INTO notes (body) VALUES (?) — FAILED after Nms',
			"log: params  1: 'a'",
		]);
		expect(printed.find(line => line.method === 'error')!.text).toContain(
			'UNIQUE',
		);
	});

	test('transaction control is a plain line naming the transaction; statements inside carry it', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		printed.length = 0;

		await db.transaction(async tx => {
			await tx.savepoint(async () => {
				await db.run(insert('a'), tx);
			});
		});

		expect(lines()).toEqual([
			'log: [orm] BEGIN IMMEDIATE (tx N) — took Nms',
			'groupCollapsed: [orm] SAVEPOINT sp_1 — took Nms',
			'log: tx N',
			'log: db Nms · wait Nms · plugin Nms · render Nms · total Nms',
			'groupCollapsed: [orm] INSERT INTO notes (body) VALUES (?) — took Nms',
			"log: params  1: 'a'",
			'log: affected 1',
			'log: tx N',
			'log: db Nms · wait Nms · plugin Nms · render Nms · total Nms',
			'groupCollapsed: [orm] RELEASE SAVEPOINT sp_1 — took Nms',
			'log: tx N',
			'log: db Nms · wait Nms · plugin Nms · render Nms · total Nms',
			'log: [orm] COMMIT (tx N) — took Nms',
		]);
	});

	test('logging can be turned off and on', async () => {
		const db = await bed.databaseWith(SCHEMA);
		expect(db.loggerEnabled).toBe(false);

		db.loggerEnabled = true;
		await db.run(insert('a'));
		db.loggerEnabled = false;
		await db.run(insert('b'));
		db.loggerEnabled = true;
		await db.run(insert('c'));

		expect(headers()).toEqual([
			'[orm] INSERT INTO notes (body) VALUES (?) — took Nms',
			'[orm] INSERT INTO notes (body) VALUES (?) — took Nms',
		]);
	});

	test('long strings, blobs and long results are cut short', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		for (let i = 0; i < 60; i++) await db.run(insert(`note ${i}`));
		printed.length = 0;

		await db.run(
			new Statement('INSERT INTO notes (body) VALUES (?), (?)', [
				'x'.repeat(250),
				new Uint8Array(12),
			]),
		);
		await db.run(new Statement('SELECT id FROM notes'));

		const logged = printed
			.filter(line => line.method === 'log')
			.map(line => line.text);
		expect(logged[0]).toBe(
			`params  1: '${'x'.repeat(200)}… (+50 chars)'   2: <12 bytes>`,
		);
		expect(logged[3]).toBe('62 rows');
		expect(JSON.parse(logged[4]!)).toHaveLength(50);
		expect(logged[5]).toBe('…and 12 more rows');
	});

	test('a statement binding many values prints the first fifty and says how many more', async () => {
		const db = await bed.databaseWith(SCHEMA, { loggerEnabled: true });
		const ids = Array.from({ length: 60 }, (_, index) => index + 1);
		printed.length = 0;

		await db.run(
			new Statement(
				`SELECT id FROM notes WHERE id IN (${ids.map(() => '?').join(', ')})`,
				ids,
			),
		);

		const params = printed.find(line =>
			line.text.startsWith('params'),
		)!.text;
		expect(params.startsWith('params  1: 1   2: 2   ')).toBe(true);
		expect(params.endsWith('50: 50   …and 10 more')).toBe(true);
	});
});

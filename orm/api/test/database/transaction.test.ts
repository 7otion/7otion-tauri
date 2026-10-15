import { describe, expect, spyOn, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import type { Transaction } from '../../src/database/transaction';
import {
	AfterCommitError,
	DatabaseError,
	TransactionError,
} from '../../src/errors';
import { FILE, TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

const SCHEMA = [
	'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE)',
];

const insert = (body: string) =>
	new Statement('INSERT INTO notes (body) VALUES (?)', [body]);

const bodies = async (db: Database, tx?: Transaction) =>
	(
		await db.run(new Statement('SELECT body FROM notes ORDER BY id'), tx)
	).rows.map(row => row.body);

describe('Transaction', () => {
	const bed = TestBed.use();

	test('a transaction commits when its callback returns', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const result = await db.transaction(async tx => {
			await db.run(insert('a'), tx);
			await db.run(insert('b'), tx);
			return 'done';
		});

		expect(result).toBe('done');
		expect(await bodies(db)).toEqual(['a', 'b']);
		expect(bed.crate.sql).toEqual([
			'BEGIN IMMEDIATE',
			'INSERT INTO notes (body) VALUES (?)',
			'INSERT INTO notes (body) VALUES (?)',
			'COMMIT',
			'SELECT body FROM notes ORDER BY id',
		]);
	});

	test('a throw rolls everything back and is rethrown', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const failure = new Error('stop');

		const error = await rejection(
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				throw failure;
			}),
		);

		expect(error).toBe(failure);
		expect(await bodies(db)).toEqual([]);
		expect(bed.crate.sql).toContain('ROLLBACK');
		expect(bed.crate.openTransactions).toBe(0);
	});

	test('a failed statement rolls the transaction back', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const error = await rejection(
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				await db.run(insert('a'), tx);
			}),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('unique');
		expect(await bodies(db)).toEqual([]);
	});

	test('a read with the handle sees the uncommitted rows; a read without it does not', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await db.transaction(async tx => {
			await db.run(insert('a'), tx);

			expect(await bodies(db, tx)).toEqual(['a']);
			expect(await bodies(db)).toEqual([]);
		});

		expect(await bodies(db)).toEqual(['a']);
	});

	test('a read outside the transaction does not wait for it', async () => {
		const db = await bed.databaseWith(SCHEMA, { writerWaitMs: 5_000 });
		await db.run(insert('before'));

		await db.transaction(async tx => {
			await db.run(insert('a'), tx);
			const started = performance.now();
			expect(await bodies(db)).toEqual(['before']);
			expect(performance.now() - started).toBeLessThan(1_000);
		});
	});

	test('a write without the handle waits for the transaction to end', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const order: string[] = [];

		let outside: Promise<unknown> = Promise.resolve();
		await db.transaction(async tx => {
			await db.run(insert('inside'), tx);
			outside = db.run(insert('outside')).then(() => {
				order.push('outside');
			});
			await new Promise(resolve => setTimeout(resolve, 20));
			order.push('inside');
		});
		await outside;

		expect(order).toEqual(['inside', 'outside']);
		expect(await bodies(db)).toEqual(['inside', 'outside']);
	});

	test('a write that forgot the handle fails once the wait is over, and says what it probably forgot', async () => {
		const db = await bed.databaseWith(SCHEMA, { writerWaitMs: 30 });

		const error = await rejection(
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				await db.run(insert('b'));
			}),
		);

		expect(error).toBeInstanceOf(DatabaseError);
		expect(error.code).toBe('busy');
		expect(error.message).toContain('missing the tx handle');
		expect(await bodies(db)).toEqual([]);
		expect(bed.crate.openTransactions).toBe(0);
	});

	test('statements made on one handle run in the order they were made, awaited or not', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const made = Array.from({ length: 40 }, (_, n) => `note ${n}`);

		await db.transaction(async tx => {
			await Promise.all(made.map(body => db.run(insert(body), tx)));
		});

		expect(await bodies(db)).toEqual(made);
	});

	test('a second transaction waits for the first, so their writes do not interleave', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await Promise.all([
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				await new Promise(resolve => setTimeout(resolve, 10));
				await db.run(insert('b'), tx);
			}),
			db.transaction(async tx => {
				await db.run(insert('c'), tx);
			}),
		]);

		// Which of the two takes the writer first is a race, and neither waits for the other's rows.
		const written = await bodies(db);
		expect([...written].sort()).toEqual(['a', 'b', 'c']);
		expect(written.indexOf('b')).toBe(written.indexOf('a') + 1);
	});

	test('a throw inside a savepoint undoes only that savepoint', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await db.transaction(async tx => {
			await db.run(insert('kept'), tx);
			const error = await rejection(
				tx.savepoint(async () => {
					await db.run(insert('undone'), tx);
					throw new Error('stop');
				}),
			);
			expect(error.message).toBe('stop');
			await db.run(insert('also kept'), tx);
		});

		expect(await bodies(db)).toEqual(['kept', 'also kept']);
	});

	test('savepoints nest, each undoing only its own writes', async () => {
		const db = await bed.databaseWith(SCHEMA);

		await db.transaction(async tx => {
			await tx.savepoint(async () => {
				await db.run(insert('outer'), tx);
				await rejection(
					tx.savepoint(async () => {
						await db.run(insert('inner'), tx);
						throw new Error('stop');
					}),
				);
			});
		});

		expect(await bodies(db)).toEqual(['outer']);
	});

	test('a function taking an optional handle is atomic with or without one', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const pair = (first: string, second: string, tx?: Transaction) =>
			db.transaction(async inner => {
				await db.run(insert(first), inner);
				await db.run(insert(second), inner);
			}, tx);

		await rejection(pair('a', 'a'));
		expect(await bodies(db)).toEqual([]);

		await db.transaction(async tx => {
			await db.run(insert('kept'), tx);
			await rejection(pair('b', 'b', tx));
		});
		expect(await bodies(db)).toEqual(['kept']);
	});

	test('a handle is refused once its transaction has ended', async () => {
		const db = await bed.databaseWith(SCHEMA);
		let kept!: Transaction;
		await db.transaction(async tx => {
			kept = tx;
		});

		expect(kept.isOpen).toBe(false);
		const error = await rejection(db.run(insert('late'), kept));

		expect(error).toBeInstanceOf(TransactionError);
		expect(error.message).toContain('has ended');
		expect(await bodies(db)).toEqual([]);
	});

	test('a handle of another database is refused', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const other = bed.database({ path: 'other.sqlite' });

		const error = await rejection(
			db.transaction(tx => other.run(insert('a'), tx)),
		);

		expect(error).toBeInstanceOf(TransactionError);
		expect(error.message).toContain('another Database');
	});

	test('a statement the callback left running cannot land after the rollback', async () => {
		const db = await bed.databaseWith(SCHEMA);
		let stray: Promise<unknown> = Promise.resolve();

		await rejection(
			db.transaction(async tx => {
				stray = rejection(db.run(insert('stray'), tx));
				throw new Error('stop');
			}),
		);
		await stray;

		expect(await bodies(db)).toEqual([]);
	});

	test('a statement still queued when the callback returns rolls the whole transaction back', async () => {
		const db = await bed.databaseWith(SCHEMA);
		let queued: Promise<any> = Promise.resolve();

		const outcome = await rejection(
			db.transaction(async tx => {
				void rejection(db.run(insert('first'), tx));
				queued = rejection(db.run(insert('second'), tx));
			}),
		);

		expect(outcome).toBeInstanceOf(TransactionError);
		expect(await queued).toBeInstanceOf(TransactionError);
		// The one that did run is undone with the rest, rather than committing alone.
		expect(await bodies(db)).toEqual([]);
	});

	test('savepoints overlapping on one handle fail the whole transaction, unless they end as nesting would', async () => {
		const db = await bed.databaseWith(SCHEMA);

		// Each waits for the other to end, so the order is chosen, not timed.
		for (const firstEndsFirst of [true, false]) {
			let outcomes: PromiseSettledResult<unknown>[] = [];
			const transaction = db.transaction(async tx => {
				let first!: Promise<unknown>;
				let second!: Promise<unknown>;
				first = tx.savepoint(async () => {
					await db.run(insert(`first ${firstEndsFirst}`), tx);
					if (!firstEndsFirst) await second.catch(() => {});
				});
				second = tx.savepoint(async () => {
					await db.run(insert(`second ${firstEndsFirst}`), tx);
					if (firstEndsFirst) await first.catch(() => {});
				});
				outcomes = await Promise.allSettled([first, second]);
			});

			if (firstEndsFirst) {
				// The first ended under the second: neither can be undone alone.
				const error = await rejection(transaction);
				expect(error).toBeInstanceOf(TransactionError);
				expect(error.message).toContain('Two pieces of work');
				expect(outcomes.map(outcome => outcome.status)).toEqual([
					'rejected',
					'rejected',
				]);
				expect(await bodies(db)).toEqual([]);
			} else {
				// They ended innermost first, which nesting would also produce.
				await transaction;
				expect(await bodies(db)).toEqual([
					'first false',
					'second false',
				]);
			}
		}
	});

	test('savepoints nested without end are refused', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const nest = (tx: Transaction): Promise<void> =>
			tx.savepoint(() => nest(tx));

		const error = await rejection(db.transaction(nest));

		expect(error).toBeInstanceOf(TransactionError);
		expect(error.message).toContain('nested 32 deep');
	});

	test('after-commit work runs once the rows are visible, and never after a rollback', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const seen: unknown[][] = [];

		await db.transaction(async tx => {
			await db.run(insert('a'), tx);
			tx.onCommit('reader', async () => {
				seen.push(await bodies(db));
			});
		});
		await rejection(
			db.transaction(async tx => {
				tx.onCommit('never', () => {
					seen.push(['never']);
				});
				throw new Error('stop');
			}),
		);

		expect(seen).toEqual([['a']]);
	});

	test('after-commit work may write without waiting on the transaction it followed', async () => {
		const db = await bed.databaseWith(SCHEMA, { writerWaitMs: 200 });

		await db.transaction(async tx => {
			tx.onCommit('writer', () => db.run(insert('after')));
		});

		expect(await bodies(db)).toEqual(['after']);
	});

	test('failed after-commit work rejects with the result of the committed write', async () => {
		const db = await bed.databaseWith(SCHEMA);

		const error = await rejection(
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				tx.onCommit('saved on Note', () => {
					throw new Error('listener');
				});
				tx.onCommit('another', () => {
					throw new Error('thrown');
				});
				return 'the result';
			}),
		);

		expect(error).toBeInstanceOf(AfterCommitError);
		expect(error.committed).toBe(true);
		expect(error.result).toBe('the result');
		expect(error.failures).toHaveLength(2);
		expect(error.message).toContain('saved on Note: listener');
		expect(await bodies(db)).toEqual(['a']);
	});

	test('rollback work runs newest first, for the transaction and for a savepoint alone', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const reverted: string[] = [];

		await db.transaction(async tx => {
			tx.onRollback(() => reverted.push('outer'));
			await rejection(
				tx.savepoint(async () => {
					tx.onRollback(() => reverted.push('inner 1'));
					tx.onRollback(() => reverted.push('inner 2'));
					throw new Error('stop');
				}),
			);
		});
		expect(reverted).toEqual(['inner 2', 'inner 1']);

		await rejection(
			db.transaction(async tx => {
				tx.onRollback(() => reverted.push('whole'));
				throw new Error('stop');
			}),
		);
		expect(reverted).toEqual(['inner 2', 'inner 1', 'whole']);
	});

	test('a journal forgets what a rolled-back savepoint added', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const owner = {};

		await db.transaction(async tx => {
			tx.journal<string>(owner).push('kept');
			await rejection(
				tx.savepoint(async () => {
					tx.journal<string>(owner).push('dropped');
					throw new Error('stop');
				}),
			);
			expect(tx.journal<string>(owner)).toEqual(['kept']);
		});
	});

	test('a transaction SQLite ended by itself refuses the rest and rolls back in memory', async () => {
		const db = await bed.databaseWith([
			...SCHEMA,
			`CREATE TRIGGER no_bombs BEFORE INSERT ON notes WHEN NEW.body = 'bomb'
			 BEGIN SELECT RAISE(ROLLBACK, 'the whole transaction is gone'); END`,
		]);
		const reverted: string[] = [];

		const error = await rejection(
			db.transaction(async tx => {
				tx.onRollback(() => reverted.push('memory'));
				await db.run(insert('a'), tx);

				const failed = await rejection(db.run(insert('bomb'), tx));
				expect(failed.transactionEnded).toBe(true);

				const refused = await rejection(db.run(insert('b'), tx));
				expect(refused).toBeInstanceOf(TransactionError);
			}),
		);

		expect(error).toBeInstanceOf(TransactionError);
		expect(error.message).toContain('ended on the database');
		expect(reverted).toEqual(['memory']);
		expect(await bodies(db)).toEqual([]);
		// The crate has already let go of it, so no ROLLBACK is sent for an id it does not know.
		expect(bed.crate.sql).not.toContain('ROLLBACK');
		expect(bed.crate.openTransactions).toBe(0);
	});

	test('a failed COMMIT is not followed by a ROLLBACK, which the crate has already done', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const reverted: string[] = [];
		const complaint = spyOn(console, 'error').mockImplementation(() => {});

		bed.crate.failNext('commit', {
			code: 'unknown',
			message: 'disk I/O error',
			transactionEnded: false,
		});
		const error = await rejection(
			db.transaction(async tx => {
				tx.onRollback(() => reverted.push('memory'));
			}),
		);

		expect(error.message).toContain('disk I/O error');
		expect(error.message).toContain('while running: COMMIT');
		expect(reverted).toEqual(['memory']);
		expect(bed.crate.sql).not.toContain('ROLLBACK');
		expect(complaint).not.toHaveBeenCalled();
		complaint.mockRestore();
	});

	test('closing the database rolls back a transaction left open', async () => {
		const db = await bed.databaseWith(SCHEMA);
		const other = bed.database();
		let release!: () => void;

		const open = rejection(
			db.transaction(async tx => {
				await db.run(insert('a'), tx);
				await new Promise<void>(resolve => (release = resolve));
			}),
		);
		await new Promise(resolve => setTimeout(resolve, 10));
		await db.close();

		await other.run(insert('free'));
		expect(await bodies(other)).toEqual(['free']);

		release();
		await open;
		expect(bed.crate.direct(FILE).inTransaction).toBe(false);
	});
});

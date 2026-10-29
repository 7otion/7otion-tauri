import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { DatabaseError } from '../../src/errors';
import { TestBed } from '../harness/database';
import { rejection } from '../harness/rejection';

describe('migrations named at open', () => {
	const bed = TestBed.use();

	test('a database opened under a set has the tables the set makes', async () => {
		const db = bed.database({ migrations: 'notes' });

		await db.run(
			new Statement("INSERT INTO notes (body) VALUES ('first')"),
		);

		const { rows } = await db.run(new Statement('SELECT body FROM notes'));
		expect(rows).toEqual([{ body: 'first' }]);
		const { rows: applied } = await db.run(
			new Statement('SELECT name FROM migrations'),
		);
		expect(applied).toEqual([{ name: 'create_notes' }]);
	});

	test('a database opened under no set runs nothing', async () => {
		const db = bed.database();

		const failed = await rejection(
			db.run(new Statement('SELECT body FROM notes')),
		);
		expect(failed).toBeInstanceOf(DatabaseError);
		expect(failed.message).toMatch(/no such table: notes/);
	});

	test('a set nobody registered is refused at the first statement', async () => {
		const db = bed.database({ migrations: 'nope' });

		const refused = await rejection(db.run(new Statement('SELECT 1')));
		expect(refused).toBeInstanceOf(DatabaseError);
		expect(refused.message).toMatch(
			/no migrations are registered under "nope"/,
		);
	});

	test('a file open under one set is refused under another, and attaches under none', async () => {
		const opened = bed.database({ migrations: 'notes' });
		await opened.run(new Statement('SELECT 1'));

		const other = bed.database({ migrations: 'other' });
		const refused = await rejection(other.run(new Statement('SELECT 1')));
		expect(refused).toBeInstanceOf(DatabaseError);
		expect(refused.message).toMatch(
			/open under the migrations Some\("notes"\), and was asked for under "other"/,
		);

		const attached = bed.database();
		const { rows } = await attached.run(
			new Statement('SELECT name FROM migrations'),
		);
		expect(rows).toEqual([{ name: 'create_notes' }]);
	});
});

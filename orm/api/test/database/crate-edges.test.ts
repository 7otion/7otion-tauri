import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { FILE, TestBed } from '../harness/database';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

class Child extends Model<typeof Child.schema> {
	static readonly schema = this.define({
		table: 'children',
		columns: {
			id: Column.integer().primary().generated(),
			parent_id: Column.integer(),
		},
	});
}

describe('schema changes while connections are open', () => {
	const orm = OrmBed.use();

	test('a model read before a column is added is still found afterwards', async () => {
		const db = await orm.open({ readers: 1 });
		await orm.seed(db, ["INSERT INTO users (name) VALUES ('ann')"]);
		expect(await User.find(1)).not.toBeNull();

		await db.run(
			new Statement('ALTER TABLE users ADD COLUMN nickname TEXT'),
		);

		expect(await User.find(1)).not.toBeNull();
	});

	test('a SELECT * run in a transaction before a column is added leaves the writer usable', async () => {
		const db = await orm.open();
		await orm.seed(db, ["INSERT INTO users (name) VALUES ('ann')"]);
		await db.transaction(tx => User.find(1, tx));

		await db.run(
			new Statement('ALTER TABLE users ADD COLUMN nickname TEXT'),
		);
		await rejection(db.transaction(tx => User.find(1, tx)));

		const written = await rejection(
			db.run(new Statement("INSERT INTO users (name) VALUES ('bob')")),
		);
		expect(written).not.toBeInstanceOf(Error);
	});

	test('a SELECT * read before a column is renamed answers the new name', async () => {
		const db = await orm.open({ readers: 1 });
		await orm.seed(db, ["INSERT INTO roles (name) VALUES ('admin')"]);
		await db.run(new Statement('SELECT * FROM roles'));

		await db.run(
			new Statement('ALTER TABLE roles RENAME COLUMN name TO title'),
		);

		const { rows } = await db.run(new Statement('SELECT * FROM roles'));
		expect(rows).toEqual([{ id: 1, title: 'admin' }]);
	});
});

describe('values crossing the plugin', () => {
	const bed = TestBed.use();

	test('a REAL bound from JavaScript is stored exactly', async () => {
		const db = await bed.databaseWith(['CREATE TABLE r (v REAL)']);
		const value = 0.058606709357277964;

		await db.run(new Statement('INSERT INTO r VALUES (?)', [value]));

		const [stored] = bed.crate
			.direct(FILE)
			.query('SELECT v FROM r')
			.all() as {
			v: number;
		}[];
		expect(stored!.v).toBe(value);
	});

	test('a result column named __proto__ is kept', async () => {
		const db = bed.database();

		const { rows } = await db.run(new Statement('SELECT 1 AS "__proto__"'));

		expect(Object.keys(rows[0]!)).toEqual(['__proto__']);
	});

	test('an infinite REAL fails the statement rather than reading back as NULL', async () => {
		const db = bed.database();

		const result = await rejection(
			db.run(new Statement('SELECT 1e999 AS v')),
		);

		expect(result).toBeInstanceOf(Error);
	});
});

describe('statements at their edges', () => {
	const orm = OrmBed.use();

	test('a model insert breaking a deferred foreign key outside a transaction fails with foreign_key', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE parents (id INTEGER PRIMARY KEY);' +
					' CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER' +
					' REFERENCES parents (id) DEFERRABLE INITIALLY DEFERRED)',
			),
		);

		const error = await rejection(Child.create({ parent_id: 5 }));

		expect(error.code).toBe('foreign_key');
	});

	test('a statement followed by a semicolon and a comment answers its rows', async () => {
		const db = await orm.open();

		const { rows } = await db.run(new Statement('SELECT 1 AS x; -- one'));

		expect(rows).toEqual([{ x: 1 }]);
	});

	test('a database loaded with the default config spelled out attaches to the one already open', async () => {
		const first = await orm.open();
		await first.run(new Statement('SELECT 1'));
		const second = orm.bed.database({ readers: 4, writerWaitMs: 10000 });

		const result = await rejection(
			second.run(new Statement('SELECT 1 AS one')),
		);

		expect(result).not.toBeInstanceOf(Error);
	});
});

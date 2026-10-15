import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { QueryError } from '../../src/errors';
import { Model } from '../../src/model/model';
import { BooleanCodec } from '../../src/schema/codec';
import { Column } from '../../src/schema/column';
import { InsertBuilder } from '../../src/sql/insert';
import { SelectBuilder } from '../../src/sql/select';
import { UpdateManyBuilder } from '../../src/sql/update-many';
import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';

const SEED = [
	"INSERT INTO users (name, age) VALUES ('Ann', 30), ('Bob', 40), ('Cy', 50)",
	`INSERT INTO posts (user_id, title, published) VALUES
		(1, 'First', 1), (1, 'Second', 0), (2, 'Third', 1)`,
	"INSERT INTO comments (post_id, body, sort) VALUES (1, 'a', 1), (3, 'b', 1)",
];

class Stamp extends Model<typeof Stamp.schema> {
	static readonly schema = this.define({
		table: 'stamps',
		columns: {
			id: Column.integer().primary().generated(),
			at: Column.date('datetime'),
		},
	});
}

describe('query regressions', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await orm.seed(db, SEED);
		return db;
	};

	test('select() names this table whether the join comes before it or after', async () => {
		await open();

		const posts = await Post.query()
			.select('id', 'title')
			.join('comments', 'comments.post_id', '=', 'posts.id')
			.orderBy('posts.id')
			.get();

		expect(posts.pluck('title')).toEqual(['First', 'Third']);
	});

	test('pluck(), value() and exists() keep the selection an ORDER BY or HAVING names', async () => {
		await open();
		const ordered = User.query()
			.select('id', 'name')
			.selectRaw('age * 2 AS double_age')
			.orderByRaw('double_age DESC');
		const grouped = Post.query()
			.select('user_id')
			.selectRaw('COUNT(*) AS n')
			.groupBy('user_id')
			.havingRaw('n > ?', [1]);

		expect(await ordered.value('name')).toBe('Cy');
		expect(await ordered.pluck('name')).toEqual(['Cy', 'Bob', 'Ann']);
		expect(await grouped.pluck('user_id')).toEqual([1]);
		expect(await grouped.exists()).toBe(true);
	});

	test('a datetime column matches what CURRENT_TIMESTAMP wrote', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE stamps (id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)',
			),
		);
		await db.run(new Statement('INSERT INTO stamps DEFAULT VALUES'));
		const stamp = (await Stamp.find(1))!;

		expect(await Stamp.query().where('at', stamp.at).count()).toBe(1);
		expect(
			await Stamp.query().whereAttributes({ at: stamp.at }).count(),
		).toBe(1);
	});

	test('a builder keeps its own copy of the rows it was given', () => {
		const row: Record<string, number> = { a: 1 };
		const insert = InsertBuilder.into('t').values(row);
		const key = [1];
		const set = { a: 'x' };
		const update = UpdateManyBuilder.table('t', ['id']).rows([
			{ key, set },
		]);

		row.a = 2;
		row.b = 3;
		key[0] = 9;
		set.a = 'y';

		expect(insert.toStatement().params).toEqual([1]);
		expect(update.toStatement().params).toEqual([1, 'x', 1]);
	});

	test('an aggregate is one of the five, since its name is written into the SQL', () => {
		expect(() =>
			SelectBuilder.from('users').selectAggregate(
				'count(1) FROM users; --' as never,
				'*',
				'n',
			),
		).toThrow(QueryError);
	});

	test('a boolean column reads any number but 0 as true, as SQLite does', () => {
		const codec = new BooleanCodec();

		expect([2, -1, 1, 0].map(value => codec.decode(value))).toEqual([
			true,
			true,
			true,
			false,
		]);
	});
});

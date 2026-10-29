/** One statement, the SQL it writes, and the params it binds. Nothing executes. */

import { describe, expect, test } from 'bun:test';

import type { StatementSource, Value } from '../../src/database/statement';
import { QueryError } from '../../src/errors';
import { Chunks } from '../../src/sql/chunks';
import { Conditions } from '../../src/sql/conditions';
import { DeleteBuilder } from '../../src/sql/delete';
import { InsertBuilder } from '../../src/sql/insert';
import { SelectBuilder } from '../../src/sql/select';
import { UpdateBuilder } from '../../src/sql/update';
import { UpdateManyBuilder } from '../../src/sql/update-many';

interface Case {
	name: string;
	statement: () => StatementSource;
	sql?: string;
	params?: Value[];
	refused?: true;
}

const cases: Case[] = [
	{
		name: 'select every column',
		statement: () => SelectBuilder.from('users'),
		sql: 'SELECT * FROM `users`',
	},
	{
		name: 'columns, an alias and a raw selection',
		statement: () =>
			SelectBuilder.from('users')
				.select('id')
				.selectAs('users.name', 'n')
				.selectRaw('COUNT(*) AS total'),
		sql: 'SELECT `id`, `users`.`name` AS `n`, COUNT(*) AS total FROM `users`',
	},
	{
		name: 'a star stays bare, qualified or not',
		statement: () => SelectBuilder.from('users').select('users.*', '*'),
		sql: 'SELECT `users`.*, * FROM `users`',
	},
	{
		name: 'an aggregate selection',
		statement: () =>
			SelectBuilder.from('orders')
				.selectAggregate('count', '*', 'aggregate')
				.selectAggregate('sum', 'orders.amount', 'total'),
		sql: 'SELECT COUNT(*) AS `aggregate`, SUM(`orders`.`amount`) AS `total` FROM `orders`',
	},
	{
		name: 'equality and null',
		statement: () =>
			SelectBuilder.from('users')
				.where('name', 'ann')
				.where('deleted_at', null),
		sql: 'SELECT * FROM `users` WHERE `name` = ? AND `deleted_at` IS NULL',
		params: ['ann'],
	},
	{
		name: 'operators and or',
		statement: () =>
			SelectBuilder.from('users')
				.where('age', '>=', 18)
				.orWhere('role', '!=', 'guest')
				.where('deleted_at', '!=', null),
		sql: 'SELECT * FROM `users` WHERE `age` >= ? OR `role` != ? AND `deleted_at` IS NOT NULL',
		params: [18, 'guest'],
	},
	{
		name: 'an operator is normalised',
		statement: () =>
			SelectBuilder.from('users').where('name', ' like ' as never, 'a%'),
		sql: 'SELECT * FROM `users` WHERE `name` LIKE ?',
		params: ['a%'],
	},
	{
		name: 'a negated group',
		statement: () =>
			SelectBuilder.from('users')
				.where('a', 1)
				.whereNot(group => group.where('b', 2).orWhere('c', 3)),
		sql: 'SELECT * FROM `users` WHERE `a` = ? AND NOT (`b` = ? OR `c` = ?)',
		params: [1, 2, 3],
	},
	{
		name: 'a negated comparison',
		statement: () => SelectBuilder.from('users').whereNot('a', 1),
		sql: 'SELECT * FROM `users` WHERE NOT (`a` = ?)',
		params: [1],
	},
	{
		name: 'an empty group is dropped',
		statement: () =>
			SelectBuilder.from('users')
				.where(group => group)
				.where('a', 1),
		sql: 'SELECT * FROM `users` WHERE `a` = ?',
		params: [1],
	},
	{
		name: 'a negated empty group matches nothing',
		statement: () => SelectBuilder.from('users').whereNot(group => group),
		sql: 'SELECT * FROM `users` WHERE 1 = 0',
	},
	{
		name: 'in, and an empty not-in',
		statement: () =>
			SelectBuilder.from('users')
				.whereIn('id', [1, 2])
				.whereNotIn('id', []),
		sql: 'SELECT * FROM `users` WHERE `id` IN (?, ?) AND 1 = 1',
		params: [1, 2],
	},
	{
		name: 'an empty in matches nothing',
		statement: () => SelectBuilder.from('users').whereIn('id', []),
		sql: 'SELECT * FROM `users` WHERE 1 = 0',
	},
	{
		name: 'a null in the list is tested for, which IN never matches',
		statement: () =>
			SelectBuilder.from('users').whereIn('email', ['a', null]),
		sql: 'SELECT * FROM `users` WHERE (`email` IN (?) OR `email` IS NULL)',
		params: ['a'],
	},
	{
		name: 'a not-in list holding a null would otherwise match nothing',
		statement: () =>
			SelectBuilder.from('users').whereNotIn('email', ['a', null]),
		sql: 'SELECT * FROM `users` WHERE (`email` NOT IN (?) AND `email` IS NOT NULL)',
		params: ['a'],
	},
	{
		name: 'a list of only nulls',
		statement: () => SelectBuilder.from('users').whereIn('email', [null]),
		sql: 'SELECT * FROM `users` WHERE `email` IS NULL',
	},
	{
		name: 'several columns matched together, as row values',
		statement: () =>
			SelectBuilder.from('items').whereTuplesIn(
				['items.order_id', 'items.line'],
				[
					[1, 'a'],
					[2, 'b'],
				],
			),
		sql: 'SELECT * FROM `items` WHERE (`items`.`order_id`, `items`.`line`) IN (VALUES (?, ?), (?, ?))',
		params: [1, 'a', 2, 'b'],
	},
	{
		name: 'no tuples match nothing',
		statement: () =>
			SelectBuilder.from('items').whereTuplesIn(['a', 'b'], []),
		sql: 'SELECT * FROM `items` WHERE 1 = 0',
	},
	{
		name: 'a raw condition is parenthesised and binds in place',
		statement: () =>
			SelectBuilder.from('users')
				.where('a', 1)
				.whereRaw('name LIKE ? OR note = ?', ['a%', 'x'])
				.where('b', 2),
		sql: 'SELECT * FROM `users` WHERE `a` = ? AND (name LIKE ? OR note = ?) AND `b` = ?',
		params: [1, 'a%', 'x', 2],
	},
	{
		name: 'a join',
		statement: () =>
			SelectBuilder.from('posts')
				.join('users', 'users.id', '=', 'posts.user_id')
				.leftJoin('teams', 'teams.id', '=', 'users.team_id')
				.rightJoin('tags', 'tags.post_id', '=', 'posts.id'),
		sql:
			'SELECT * FROM `posts` INNER JOIN `users` ON `users`.`id` = `posts`.`user_id` ' +
			'LEFT JOIN `teams` ON `teams`.`id` = `users`.`team_id` ' +
			'RIGHT JOIN `tags` ON `tags`.`post_id` = `posts`.`id`',
	},
	{
		name: 'order, limit and offset',
		statement: () =>
			SelectBuilder.from('users')
				.orderBy('name')
				.orderBy('id', 'desc')
				.limit(10)
				.offset(20),
		sql: 'SELECT * FROM `users` ORDER BY `name` ASC, `id` DESC LIMIT 10 OFFSET 20',
	},
	{
		name: 'offset alone needs a limit, and -1 is none',
		statement: () => SelectBuilder.from('users').offset(5),
		sql: 'SELECT * FROM `users` LIMIT -1 OFFSET 5',
	},
	{
		name: 'a limit of zero with an offset',
		statement: () => SelectBuilder.from('users').limit(0).offset(3),
		sql: 'SELECT * FROM `users` LIMIT 0 OFFSET 3',
	},
	{
		name: 'distinct, group by and having',
		statement: () =>
			SelectBuilder.from('orders')
				.distinct()
				.select('user_id')
				.groupBy('user_id')
				.having(group => group.whereRaw('COUNT(*) > ?', [1])),
		sql: 'SELECT DISTINCT `user_id` FROM `orders` GROUP BY `user_id` HAVING ((COUNT(*) > ?))',
		params: [1],
	},
	{
		name: 'a having() group is parenthesised, so an OR inside it cannot escape',
		statement: () =>
			SelectBuilder.from('orders')
				.groupBy('user_id')
				.havingRaw('COUNT(*) > ?', [5])
				.having(group => group.whereRaw('user_id = ?', [1]).orWhereRaw('user_id = ?', [2])),
		sql: 'SELECT * FROM `orders` GROUP BY `user_id` HAVING (COUNT(*) > ?) AND ((user_id = ?) OR (user_id = ?))',
		params: [5, 1, 2],
	},
	{
		name: 'params follow the order the SQL is written in: selection, where, having, order',
		statement: () =>
			SelectBuilder.from('orders')
				.orderByRaw('CASE WHEN b = ? THEN 0 ELSE 1 END', [4])
				.havingRaw('SUM(amount) > ?', [3])
				.where('paid', true)
				.selectRaw('SUM(amount) + ? AS total', [1])
				.groupBy('user_id'),
		sql:
			'SELECT SUM(amount) + ? AS total FROM `orders` WHERE `paid` = ? ' +
			'GROUP BY `user_id` HAVING (SUM(amount) > ?) ORDER BY CASE WHEN b = ? THEN 0 ELSE 1 END',
		params: [1, true, 3, 4],
	},
	{
		name: 'a backtick inside an identifier is escaped',
		statement: () => SelectBuilder.from('us`ers').select('na`me'),
		sql: 'SELECT `na``me` FROM `us``ers`',
	},
	{
		name: 'insert one row',
		statement: () =>
			InsertBuilder.into('users').values({ name: 'ann', active: true }),
		sql: 'INSERT INTO `users` (`name`, `active`) VALUES (?, ?)',
		params: ['ann', true],
	},
	{
		name: "insert several rows, ordered by the first row's columns, and return keys",
		statement: () =>
			InsertBuilder.into('users')
				.values([
					{ name: 'a', age: 1 },
					{ age: 2, name: 'b' },
				])
				.returning('id'),
		sql: 'INSERT INTO `users` (`name`, `age`) VALUES (?, ?), (?, ?) RETURNING `id`',
		params: ['a', 1, 'b', 2],
	},
	{
		name: 'insert a row of defaults, returning every column',
		statement: () => InsertBuilder.into('users').values({}).returning('*'),
		sql: 'INSERT INTO `users` DEFAULT VALUES RETURNING *',
	},
	{
		name: 'insert skipping rows that clash with a unique constraint, the clause before RETURNING',
		statement: () =>
			InsertBuilder.into('users')
				.values([{ name: 'a' }, { name: 'b' }])
				.returning('id')
				.onConflictDoNothing(),
		sql: 'INSERT INTO `users` (`name`) VALUES (?), (?) ON CONFLICT DO NOTHING RETURNING `id`',
		params: ['a', 'b'],
	},
	{
		name: 'update; assignments merge, the later value winning',
		statement: () =>
			UpdateBuilder.table('users')
				.set({ name: 'bo', age: 1 })
				.set('age', 2)
				.where('id', 7)
				.returning('users.id'),
		sql: 'UPDATE `users` SET `name` = ?, `age` = ? WHERE `id` = ? RETURNING `users`.`id`',
		params: ['bo', 2, 7],
	},
	{
		name: 'a qualified column is assigned without its qualifier, which SQLite refuses in SET',
		statement: () => UpdateBuilder.table('users').set('users.age', 2),
		sql: 'UPDATE `users` SET `age` = ?',
		params: [2],
	},
	{
		name: 'delete',
		statement: () =>
			DeleteBuilder.from('users').where('id', '<', 5).returning('id'),
		sql: 'DELETE FROM `users` WHERE `id` < ? RETURNING `id`',
		params: [5],
	},
	{
		name: 'a write takes over conditions built elsewhere',
		statement: () =>
			DeleteBuilder.from('users').matching(
				SelectBuilder.from('users').where('a', 1).orWhere('b', 2)
					.conditions,
			),
		sql: 'DELETE FROM `users` WHERE `a` = ? OR `b` = ?',
		params: [1, 2],
	},
	{
		name: 'a bulk update gives each row its own values',
		statement: () =>
			UpdateManyBuilder.table('users', ['id'])
				.rows([
					{ key: [1], set: { name: 'a', age: 10 } },
					{ key: [2], set: { name: 'b' } },
				])
				.shared({ updated_at: 99 }),
		sql:
			'UPDATE `users` SET ' +
			'`name` = CASE WHEN `id` = ? THEN ? WHEN `id` = ? THEN ? ELSE `name` END, ' +
			'`age` = CASE WHEN `id` = ? THEN ? ELSE `age` END, ' +
			'`updated_at` = ? WHERE `id` IN (?, ?)',
		params: [1, 'a', 2, 'b', 1, 10, 99, 1, 2],
	},
	{
		name: 'a bulk update on a composite key',
		statement: () =>
			UpdateManyBuilder.table('items', ['order_id', 'line']).rows([
				{ key: [1, 1], set: { qty: 5 } },
				{ key: [1, 2], set: { qty: 6 } },
			]),
		sql:
			'UPDATE `items` SET `qty` = CASE WHEN `order_id` = ? AND `line` = ? THEN ? ' +
			'WHEN `order_id` = ? AND `line` = ? THEN ? ELSE `qty` END ' +
			'WHERE (`order_id`, `line`) IN (VALUES (?, ?), (?, ?))',
		params: [1, 1, 5, 1, 2, 6, 1, 1, 1, 2],
	},
	{
		name: 'an undefined param is refused',
		statement: () =>
			SelectBuilder.from('users').where('a', undefined as never),
		refused: true,
	},
	{
		name: 'an ordering operator against null is refused',
		statement: () => SelectBuilder.from('users').where('a', '>', null),
		refused: true,
	},
	{
		name: 'an operator that is not one is refused, in a where as in a join',
		statement: () =>
			SelectBuilder.from('a').join(
				'b',
				'a.id',
				'= 1 OR 1 = 1 --' as never,
				'b.a_id',
			),
		refused: true,
	},
	{
		name: 'an order direction that is not one is refused',
		statement: () =>
			SelectBuilder.from('a').orderBy('id', 'asc; DROP TABLE a' as never),
		refused: true,
	},
	{
		name: 'a limit that is not a count is refused',
		statement: () => SelectBuilder.from('a').limit(1.5),
		refused: true,
	},
	{
		name: 'an empty identifier segment is refused',
		statement: () => SelectBuilder.from('a').select('a..b'),
		refused: true,
	},
	{
		name: 'an insert without rows is refused',
		statement: () => InsertBuilder.into('users'),
		refused: true,
	},
	{
		name: 'a row of defaults that skips conflicts is refused: SQLite has no ON CONFLICT after DEFAULT VALUES',
		statement: () =>
			InsertBuilder.into('users').values({}).onConflictDoNothing(),
		refused: true,
	},
	{
		name: 'rows setting different columns are refused',
		statement: () =>
			InsertBuilder.into('users').values([{ a: 1 }, { b: 2 }]),
		refused: true,
	},
	{
		name: 'an update without assignments is refused',
		statement: () => UpdateBuilder.table('users').where('id', 1),
		refused: true,
	},
	{
		name: 'a bulk update cannot locate a row by a NULL key, which its WHERE would match and its CASE would not',
		statement: () =>
			UpdateManyBuilder.table('items', ['code']).rows([
				{ key: [null], set: { qty: 1 } },
			]),
		refused: true,
	},
	{
		name: 'a bulk update whose key has the wrong width is refused',
		statement: () =>
			UpdateManyBuilder.table('items', ['a', 'b']).rows([
				{ key: [1], set: { qty: 1 } },
			]),
		refused: true,
	},
];

describe('builders', () => {
	for (const { name, statement, sql, params, refused } of cases) {
		test(name, () => {
			if (refused) {
				expect(() => statement().toStatement()).toThrow(QueryError);
				return;
			}
			const written = statement().toStatement();
			expect(written.sql).toBe(sql!);
			expect([...written.params]).toEqual(params ?? []);
		});
	}

	test('a builder is immutable: a derived builder leaves its source untouched', () => {
		const base = SelectBuilder.from('users').where('a', 1);
		const derived = base.where('b', 2).orderBy('id').limit(1);

		expect(base.toStatement().sql).toBe(
			'SELECT * FROM `users` WHERE `a` = ?',
		);
		expect(derived.toStatement().sql).toBe(
			'SELECT * FROM `users` WHERE `a` = ? AND `b` = ? ORDER BY `id` ASC LIMIT 1',
		);
	});

	test('a group callback receives an empty list and returns the group', () => {
		let received: Conditions | undefined;
		SelectBuilder.from('users')
			.where('a', 1)
			.where(group => {
				received = group;
				return group.where('b', 2);
			});

		expect(received!.isEmpty).toBe(true);
	});

	test('a list is split so each statement stays under the param limit', () => {
		const ids = Array.from({ length: 70_000 }, (_, index) => index);

		const single = Chunks.of(ids, 1);
		expect(single.map(chunk => chunk.length)).toEqual([32702, 32702, 4596]);

		const pairs = Chunks.of(ids, 2, 1_000);
		expect(pairs[0]!.length).toBe(15883);
		expect(pairs.flat()).toEqual(ids);

		expect(Chunks.of([], 1)).toEqual([]);
	});
});

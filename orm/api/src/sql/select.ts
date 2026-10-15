import type { Statement, StatementSource, Value } from '../database/statement';
import { QueryError } from '../errors';
import {
	Conditions,
	type CompareOperator,
	type ConditionGroup,
} from './conditions';
import { Filtered } from './filtered';
import { SqlWriter } from './sql-writer';

export type AggregateFunction = 'count' | 'sum' | 'avg' | 'min' | 'max';

const AGGREGATES: ReadonlySet<string> = new Set<AggregateFunction>([
	'count',
	'sum',
	'avg',
	'min',
	'max',
]);

type Selection =
	| { kind: 'column'; name: string; alias: string | null }
	| { kind: 'raw'; sql: string; params: readonly Value[] }
	| {
			kind: 'aggregate';
			fn: AggregateFunction;
			column: string;
			alias: string;
	  };

interface Join {
	type: 'inner' | 'left' | 'right';
	table: string;
	left: string;
	operator: CompareOperator;
	right: string;
}

type Order =
	| { kind: 'column'; column: string; direction: 'asc' | 'desc' }
	| { kind: 'raw'; sql: string; params: readonly Value[] };

interface SelectParts {
	table: string;
	distinct: boolean;
	/** Empty selects every column. */
	columns: readonly Selection[];
	joins: readonly Join[];
	where: Conditions;
	groupBy: readonly string[];
	having: Conditions;
	orderBy: readonly Order[];
	limit: number | null;
	offset: number | null;
}

export type Direction = 'asc' | 'desc' | 'ASC' | 'DESC';

export class SelectBuilder extends Filtered implements StatementSource {
	private constructor(private readonly parts: SelectParts) {
		super();
	}

	static from(table: string): SelectBuilder {
		return new SelectBuilder({
			table,
			distinct: false,
			columns: [],
			joins: [],
			where: Conditions.none,
			groupBy: [],
			having: Conditions.none,
			orderBy: [],
			limit: null,
			offset: null,
		});
	}

	/** Adds columns to select; none selected means every column. */
	select(...columns: string[]): this {
		return this.addColumns(
			columns.map(name => ({ kind: 'column', name, alias: null })),
		);
	}

	selectAs(column: string, alias: string): this {
		return this.addColumns([{ kind: 'column', name: column, alias }]);
	}

	selectRaw(sql: string, params: readonly Value[] = []): this {
		return this.addColumns([{ kind: 'raw', sql, params: [...params] }]);
	}

	selectAggregate(
		fn: AggregateFunction,
		column: string,
		alias: string,
	): this {
		if (!AGGREGATES.has(fn)) {
			throw new QueryError(
				`[orm] Unknown aggregate ${JSON.stringify(fn)}: use one of ${[...AGGREGATES].join(', ')}.`,
			);
		}
		return this.addColumns([{ kind: 'aggregate', fn, column, alias }]);
	}

	selectNothing(): this {
		return this.with({ columns: [] });
	}

	distinct(distinct = true): this {
		return this.with({ distinct });
	}

	join(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.addJoin('inner', table, left, operator, right);
	}

	leftJoin(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.addJoin('left', table, left, operator, right);
	}

	rightJoin(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.addJoin('right', table, left, operator, right);
	}

	groupBy(...columns: string[]): this {
		return this.with({ groupBy: [...this.parts.groupBy, ...columns] });
	}

	/** Adds a group, in parentheses, to the HAVING conditions already there. */
	having(group: ConditionGroup): this {
		return this.with({ having: this.parts.having.where(group) });
	}

	havingRaw(sql: string, params: readonly Value[] = []): this {
		return this.with({ having: this.parts.having.whereRaw(sql, params) });
	}

	orderBy(column: string, direction: Direction = 'asc'): this {
		const normalized = String(direction).toLowerCase();
		if (normalized !== 'asc' && normalized !== 'desc') {
			throw new QueryError(
				`[orm] Order direction must be 'asc' or 'desc', got ${JSON.stringify(direction)}.`,
			);
		}
		return this.with({
			orderBy: [
				...this.parts.orderBy,
				{ kind: 'column', column, direction: normalized },
			],
		});
	}

	orderByRaw(sql: string, params: readonly Value[] = []): this {
		return this.with({
			orderBy: [
				...this.parts.orderBy,
				{ kind: 'raw', sql, params: [...params] },
			],
		});
	}

	unordered(): this {
		return this.with({ orderBy: [] });
	}

	limit(limit: number | null): this {
		return this.with({ limit: SelectBuilder.count(limit, 'limit') });
	}

	/** Keeps a lower limit already set. */
	atMost(count: number): this {
		const { limit } = this.parts;
		return this.limit(limit === null ? count : Math.min(limit, count));
	}

	offset(offset: number | null): this {
		return this.with({ offset: SelectBuilder.count(offset, 'offset') });
	}

	get hasSelection(): boolean {
		return this.parts.columns.length > 0;
	}

	/** Exact name only; raw selections are not looked into. */
	selects(column: string): boolean {
		return this.parts.columns.some(
			selection =>
				selection.kind === 'column' && selection.name === column,
		);
	}

	get isDistinct(): boolean {
		return this.parts.distinct;
	}

	get isGrouped(): boolean {
		return this.parts.groupBy.length > 0;
	}

	get hasJoins(): boolean {
		return this.parts.joins.length > 0;
	}

	get hasLimitOrOffset(): boolean {
		return this.parts.limit !== null || this.parts.offset !== null;
	}

	/** @internal Columns whose change can change which rows match or their order; null when a join, group or raw SQL hides them. */
	decidingColumns(): string[] | null {
		const where = this.filterColumns();
		if (where === null) return null;

		const order: string[] = [];
		for (const entry of this.parts.orderBy) {
			if (entry.kind === 'raw') return null;
			order.push(entry.column);
		}
		return [...where, ...order];
	}

	filterColumns(): string[] | null {
		const { parts } = this;
		if (parts.joins.length > 0 || parts.groupBy.length > 0 || !parts.having.isEmpty) {
			return null;
		}
		return parts.where.columns();
	}

	toStatement(): Statement {
		const writer = new SqlWriter();
		return writer.statement([this.write(writer)]);
	}

	write(writer: SqlWriter): string {
		const { parts } = this;

		// Each part binds as it is written, so they are written in the order they appear.
		return [
			'SELECT',
			parts.distinct ? 'DISTINCT' : '',
			SelectBuilder.writeSelection(parts.columns, writer),
			`FROM ${writer.identifier(parts.table)}`,
			...parts.joins.map(join => SelectBuilder.writeJoin(join, writer)),
			SelectBuilder.clause('WHERE', parts.where.write(writer)),
			parts.groupBy.length > 0
				? `GROUP BY ${writer.identifiers(parts.groupBy)}`
				: '',
			SelectBuilder.clause('HAVING', parts.having.write(writer)),
			SelectBuilder.writeOrderBy(parts.orderBy, writer),
			SelectBuilder.writeLimit(parts),
		]
			.filter(part => part !== '')
			.join(' ');
	}

	/** @internal */
	get conditions(): Conditions {
		return this.parts.where;
	}

	protected withConditions(conditions: Conditions): this {
		return this.with({ where: conditions });
	}

	private addColumns(columns: Selection[]): this {
		return this.with({ columns: [...this.parts.columns, ...columns] });
	}

	private addJoin(
		type: Join['type'],
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.with({
			joins: [
				...this.parts.joins,
				{
					type,
					table,
					left,
					operator: Conditions.operator(operator),
					right,
				},
			],
		});
	}

	private with(patch: Partial<SelectParts>): this {
		return new SelectBuilder({ ...this.parts, ...patch }) as this;
	}

	private static clause(keyword: string, conditions: string): string {
		return conditions === '' ? '' : `${keyword} ${conditions}`;
	}

	private static writeSelection(
		columns: readonly Selection[],
		writer: SqlWriter,
	): string {
		if (columns.length === 0) return '*';
		return columns
			.map(selection => {
				if (selection.kind === 'raw') {
					return writer.raw(selection.sql, selection.params);
				}
				if (selection.kind === 'aggregate') {
					return (
						`${selection.fn.toUpperCase()}(${writer.identifier(selection.column)}) ` +
						`AS ${writer.identifier(selection.alias)}`
					);
				}
				const column = writer.identifier(selection.name);
				return selection.alias === null
					? column
					: `${column} AS ${writer.identifier(selection.alias)}`;
			})
			.join(', ');
	}

	private static writeJoin(join: Join, writer: SqlWriter): string {
		return (
			`${join.type.toUpperCase()} JOIN ${writer.identifier(join.table)} ` +
			`ON ${writer.identifier(join.left)} ${join.operator} ${writer.identifier(join.right)}`
		);
	}

	private static writeOrderBy(
		orders: readonly Order[],
		writer: SqlWriter,
	): string {
		if (orders.length === 0) return '';
		const list = orders.map(order =>
			order.kind === 'raw'
				? writer.raw(order.sql, order.params)
				: `${writer.identifier(order.column)} ${order.direction.toUpperCase()}`,
		);
		return `ORDER BY ${list.join(', ')}`;
	}

	/** An OFFSET needs a LIMIT; -1 is SQLite's "no limit". */
	private static writeLimit({ limit, offset }: SelectParts): string {
		if (limit === null && offset === null) return '';
		const clause = `LIMIT ${limit ?? -1}`;
		return offset === null ? clause : `${clause} OFFSET ${offset}`;
	}

	/** Written into the SQL, not bound, so only a count passes. */
	private static count(value: number | null, what: string): number | null {
		if (value === null) return null;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new QueryError(
				`[orm] A ${what} must be a non-negative integer, got ${value}.`,
			);
		}
		return value;
	}
}

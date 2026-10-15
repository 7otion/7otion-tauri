import type { Value } from '../database/statement';
import { QueryError } from '../errors';
import type { SqlWriter } from './sql-writer';

export type CompareOperator =
	'=' | '!=' | '<>' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'NOT LIKE';

const OPERATORS: ReadonlySet<string> = new Set<CompareOperator>([
	'=',
	'!=',
	'<>',
	'>',
	'>=',
	'<',
	'<=',
	'LIKE',
	'NOT LIKE',
]);

type Condition =
	| {
			kind: 'compare';
			column: string;
			operator: CompareOperator;
			value: Value;
	  }
	| { kind: 'in'; column: string; values: readonly Value[]; negated: boolean }
	| {
			kind: 'tuples';
			columns: readonly string[];
			tuples: readonly (readonly Value[])[];
	  }
	| { kind: 'null'; column: string; negated: boolean }
	| { kind: 'raw'; sql: string; params: readonly Value[] }
	| {
			kind: 'exists';
			subquery: Subquery;
			columns: readonly string[];
			others: readonly object[];
	  }
	| { kind: 'group'; conditions: Conditions };

export interface Subquery {
	write(writer: SqlWriter): string;
}

/** The first clause's connector is ignored. */
interface Clause {
	connector: 'and' | 'or';
	negated: boolean;
	condition: Condition;
}

export type ConditionGroup = (conditions: Conditions) => Conditions;

/** `(group)`, `(column, value)` where null means IS NULL, or `(column, operator, value)`. */
export type WhereArgs =
	| [group: ConditionGroup]
	| [column: string, value: Value]
	| [column: string, operator: CompareOperator, value: Value];

/** Immutable: every method returns a new list. */
export class Conditions {
	static readonly none = new Conditions([]);

	private constructor(private readonly clauses: readonly Clause[]) {}

	get isEmpty(): boolean {
		return this.clauses.length === 0;
	}

	/** @internal Every column these conditions compare; null when raw SQL hides some. */
	columns(): string[] | null {
		const columns: string[] = [];
		for (const { condition } of this.clauses) {
			switch (condition.kind) {
				case 'compare':
				case 'in':
				case 'null':
					columns.push(condition.column);
					break;
				case 'tuples':
				case 'exists':
					columns.push(...condition.columns);
					break;
				case 'group': {
					const inner = condition.conditions.columns();
					if (inner === null) return null;
					columns.push(...inner);
					break;
				}
				case 'raw':
					return null;
			}
		}
		return columns;
	}

	others(): object[] {
		return this.clauses.flatMap(({ condition }) => {
			if (condition.kind === 'exists') return [...condition.others];
			return condition.kind === 'group' ? condition.conditions.others() : [];
		});
	}

	exists(
		connector: 'and' | 'or',
		negated: boolean,
		subquery: Subquery,
		columns: readonly string[],
		others: readonly object[],
	): Conditions {
		return this.add(connector, negated, {
			kind: 'exists',
			subquery,
			columns: [...columns],
			others: [...others],
		});
	}

	where(...args: WhereArgs): Conditions {
		return this.add('and', false, Conditions.condition(args));
	}

	orWhere(...args: WhereArgs): Conditions {
		return this.add('or', false, Conditions.condition(args));
	}

	whereNot(...args: WhereArgs): Conditions {
		return this.add('and', true, Conditions.condition(args));
	}

	orWhereNot(...args: WhereArgs): Conditions {
		return this.add('or', true, Conditions.condition(args));
	}

	whereIn(column: string, values: readonly Value[]): Conditions {
		return this.in('and', column, values, false);
	}

	orWhereIn(column: string, values: readonly Value[]): Conditions {
		return this.in('or', column, values, false);
	}

	whereNotIn(column: string, values: readonly Value[]): Conditions {
		return this.in('and', column, values, true);
	}

	orWhereNotIn(column: string, values: readonly Value[]): Conditions {
		return this.in('or', column, values, true);
	}

	/** A tuple holding a null matches nothing. */
	whereTuplesIn(
		columns: readonly string[],
		tuples: readonly (readonly Value[])[],
	): Conditions {
		for (const tuple of tuples) {
			if (tuple.length !== columns.length) {
				throw new QueryError(
					`[orm] A tuple has ${tuple.length} values for ${columns.length} columns.`,
				);
			}
		}
		return this.add('and', false, {
			kind: 'tuples',
			columns: [...columns],
			tuples: tuples.map(tuple => [...tuple]),
		});
	}

	whereNull(column: string): Conditions {
		return this.add('and', false, { kind: 'null', column, negated: false });
	}

	orWhereNull(column: string): Conditions {
		return this.add('or', false, { kind: 'null', column, negated: false });
	}

	whereNotNull(column: string): Conditions {
		return this.add('and', false, { kind: 'null', column, negated: true });
	}

	orWhereNotNull(column: string): Conditions {
		return this.add('or', false, { kind: 'null', column, negated: true });
	}

	whereRaw(sql: string, params: readonly Value[] = []): Conditions {
		return this.add('and', false, {
			kind: 'raw',
			sql,
			params: [...params],
		});
	}

	orWhereRaw(sql: string, params: readonly Value[] = []): Conditions {
		return this.add('or', false, { kind: 'raw', sql, params: [...params] });
	}

	/** '' when nothing restricts, as with only empty groups. */
	write(writer: SqlWriter): string {
		let sql = '';
		const alternatives = this.clauses.some(
			(clause, index) => index > 0 && clause.connector === 'or',
		);

		for (const clause of this.clauses) {
			const written = Conditions.writeCondition(clause.condition, writer);

			// A group holding nothing restricts nothing, so it is dropped, but not
			// beside an OR, where it is what makes the whole true. Negated, it restricts everything.
			let text: string;
			if (written === null) {
				if (!clause.negated && !alternatives) continue;
				text = clause.negated ? '1 = 0' : '1 = 1';
			} else {
				text = clause.negated
					? written.atomic
						? `NOT ${written.sql}`
						: `NOT (${written.sql})`
					: written.sql;
			}

			sql +=
				sql === ''
					? text
					: ` ${clause.connector.toUpperCase()} ${text}`;
		}

		return sql;
	}

	private in(
		connector: 'and' | 'or',
		column: string,
		values: readonly Value[],
		negated: boolean,
	): Conditions {
		return this.add(connector, false, {
			kind: 'in',
			column,
			values: [...values],
			negated,
		});
	}

	private add(
		connector: 'and' | 'or',
		negated: boolean,
		condition: Condition,
	): Conditions {
		return new Conditions([
			...this.clauses,
			{ connector, negated, condition },
		]);
	}

	/** `atomic` is set when the SQL is already parenthesised. Null for an empty group. */
	private static writeCondition(
		condition: Condition,
		writer: SqlWriter,
	): { sql: string; atomic: boolean } | null {
		switch (condition.kind) {
			case 'compare':
				return {
					sql: `${writer.identifier(condition.column)} ${condition.operator} ${writer.bind(condition.value)}`,
					atomic: false,
				};

			case 'in': {
				const column = writer.identifier(condition.column);
				const values = condition.values.filter(value => value !== null);
				const nulls = values.length !== condition.values.length;
				const isNull = `${column} IS ${condition.negated ? 'NOT ' : ''}NULL`;

				if (values.length === 0) {
					return {
						sql: nulls
							? isNull
							: condition.negated
								? '1 = 1'
								: '1 = 0',
						atomic: false,
					};
				}

				const list = values.map(value => writer.bind(value)).join(', ');
				const test = `${column} ${condition.negated ? 'NOT IN' : 'IN'} (${list})`;
				if (!nulls) return { sql: test, atomic: false };

				// NULL is in no list, and NOT IN a list holding one is never true.
				return {
					sql: condition.negated
						? `(${test} AND ${isNull})`
						: `(${test} OR ${isNull})`,
					atomic: true,
				};
			}

			case 'tuples': {
				if (condition.tuples.length === 0) {
					return { sql: '1 = 0', atomic: false };
				}
				const columns = writer.identifiers(condition.columns);
				const rows = condition.tuples
					.map(
						tuple =>
							`(${tuple.map(value => writer.bind(value)).join(', ')})`,
					)
					.join(', ');
				return {
					sql: `(${columns}) IN (VALUES ${rows})`,
					atomic: false,
				};
			}

			case 'null':
				return {
					sql: `${writer.identifier(condition.column)} IS ${condition.negated ? 'NOT ' : ''}NULL`,
					atomic: false,
				};

			case 'raw':
				return {
					sql: `(${writer.raw(condition.sql, condition.params)})`,
					atomic: true,
				};

			case 'exists':
				return {
					sql: `EXISTS (${condition.subquery.write(writer)})`,
					atomic: true,
				};

			case 'group': {
				const inner = condition.conditions.write(writer);
				return inner === ''
					? null
					: { sql: `(${inner})`, atomic: true };
			}
		}
	}

	private static condition(args: WhereArgs): Condition {
		if (args.length === 1) {
			return { kind: 'group', conditions: args[0](Conditions.none) };
		}

		if (args.length === 2) {
			const [column, value] = args;
			return value === null
				? { kind: 'null', column, negated: false }
				: { kind: 'compare', column, operator: '=', value };
		}

		const [column, given, value] = args;
		const operator = Conditions.operator(given);

		if (value === null) {
			if (operator === '=') {
				return { kind: 'null', column, negated: false };
			}
			if (operator === '!=' || operator === '<>') {
				return { kind: 'null', column, negated: true };
			}
			throw new QueryError(
				`[orm] ${operator} cannot compare ${column} with null; only = and != can.`,
			);
		}

		return { kind: 'compare', column, operator, value };
	}

	/** An operator is written into the SQL, not bound, so only a known one passes. */
	static operator(given: string): CompareOperator {
		const operator = String(given).trim().toUpperCase();
		if (!OPERATORS.has(operator)) {
			throw new QueryError(
				`[orm] Unknown operator ${JSON.stringify(given)}. Expected one of ` +
					`${[...OPERATORS].join(', ')}; use whereRaw() for anything else.`,
			);
		}
		return operator as CompareOperator;
	}
}

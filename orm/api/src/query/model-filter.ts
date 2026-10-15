import type { Value } from '../database/statement';
import { QueryError } from '../errors';
import type { Model } from '../model/model';
import type {
	ColumnRef,
	ColumnsOf,
	PrimaryKeyOf,
	ValueOf,
} from '../model/types';
import type { Table } from '../schema/table';
import type { CompareOperator, Conditions, WhereArgs } from '../sql/conditions';

/** Operators that compare with null, as IS and IS NOT. */
type Equality = '=' | '!=' | '<>';

type Ordering =
	| Exclude<CompareOperator, Equality | Matching>
	| Lowercase<Exclude<CompareOperator, Equality | Matching>>;

type Matching = 'LIKE' | 'NOT LIKE';

type Pattern = Matching | Lowercase<Matching>;

export type ModelGroup<M extends Model> = (
	conditions: ModelConditions<M>,
) => ModelConditions<M>;

/** Each value is compared as its column stores it. Immutable: every method returns a new object. */
export abstract class ModelFilter<M extends Model> {
	protected abstract readonly table: Table;
	protected abstract get conditions(): Conditions;
	protected abstract withConditions(conditions: Conditions): this;

	where(group: ModelGroup<M>): this;
	where<K extends ColumnRef<M>>(column: K, value: ValueOf<M, K>): this;
	where<K extends ColumnRef<M>>(
		column: K,
		operator: Equality,
		value: ValueOf<M, K>,
	): this;
	where<K extends ColumnRef<M>>(
		column: K,
		operator: Ordering,
		value: NonNullable<ValueOf<M, K>>,
	): this;
	where<K extends ColumnRef<M>>(
		column: K,
		operator: Pattern,
		value: string,
	): this;
	where(...args: unknown[]): this {
		return this.withConditions(this.conditions.where(...this.stored(args)));
	}

	orWhere(group: ModelGroup<M>): this;
	orWhere<K extends ColumnRef<M>>(column: K, value: ValueOf<M, K>): this;
	orWhere<K extends ColumnRef<M>>(
		column: K,
		operator: Equality,
		value: ValueOf<M, K>,
	): this;
	orWhere<K extends ColumnRef<M>>(
		column: K,
		operator: Ordering,
		value: NonNullable<ValueOf<M, K>>,
	): this;
	orWhere<K extends ColumnRef<M>>(
		column: K,
		operator: Pattern,
		value: string,
	): this;
	orWhere(...args: unknown[]): this {
		return this.withConditions(
			this.conditions.orWhere(...this.stored(args)),
		);
	}

	whereNot(group: ModelGroup<M>): this;
	whereNot<K extends ColumnRef<M>>(column: K, value: ValueOf<M, K>): this;
	whereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Equality,
		value: ValueOf<M, K>,
	): this;
	whereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Ordering,
		value: NonNullable<ValueOf<M, K>>,
	): this;
	whereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Pattern,
		value: string,
	): this;
	whereNot(...args: unknown[]): this {
		return this.withConditions(
			this.conditions.whereNot(...this.stored(args)),
		);
	}

	orWhereNot(group: ModelGroup<M>): this;
	orWhereNot<K extends ColumnRef<M>>(column: K, value: ValueOf<M, K>): this;
	orWhereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Equality,
		value: ValueOf<M, K>,
	): this;
	orWhereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Ordering,
		value: NonNullable<ValueOf<M, K>>,
	): this;
	orWhereNot<K extends ColumnRef<M>>(
		column: K,
		operator: Pattern,
		value: string,
	): this;
	orWhereNot(...args: unknown[]): this {
		return this.withConditions(
			this.conditions.orWhereNot(...this.stored(args)),
		);
	}

	whereIn<K extends ColumnRef<M>>(
		column: K,
		values: readonly ValueOf<M, K>[],
	): this {
		return this.withConditions(this.inList('and', column, values, false));
	}

	orWhereIn<K extends ColumnRef<M>>(
		column: K,
		values: readonly ValueOf<M, K>[],
	): this {
		return this.withConditions(this.inList('or', column, values, false));
	}

	whereNotIn<K extends ColumnRef<M>>(
		column: K,
		values: readonly ValueOf<M, K>[],
	): this {
		return this.withConditions(this.inList('and', column, values, true));
	}

	orWhereNotIn<K extends ColumnRef<M>>(
		column: K,
		values: readonly ValueOf<M, K>[],
	): this {
		return this.withConditions(this.inList('or', column, values, true));
	}

	whereNull(column: ColumnRef<M>): this {
		return this.withConditions(this.conditions.whereNull(column));
	}

	orWhereNull(column: ColumnRef<M>): this {
		return this.withConditions(this.conditions.orWhereNull(column));
	}

	whereNotNull(column: ColumnRef<M>): this {
		return this.withConditions(this.conditions.whereNotNull(column));
	}

	orWhereNotNull(column: ColumnRef<M>): this {
		return this.withConditions(this.conditions.orWhereNotNull(column));
	}

	whereRaw(sql: string, params: readonly Value[] = []): this {
		return this.withConditions(this.conditions.whereRaw(sql, params));
	}

	orWhereRaw(sql: string, params: readonly Value[] = []): this {
		return this.withConditions(this.conditions.orWhereRaw(sql, params));
	}

	/** A composite key takes its values in declaration order. */
	whereKey(primaryKey: PrimaryKeyOf<M>): this {
		const columns = this.table.primaryKey.columns;
		const values = Array.isArray(primaryKey) ? primaryKey : [primaryKey];

		if (values.length !== columns.length) {
			throw new QueryError(
				`[orm] ${this.table.name} is keyed on ${columns.join(', ')}, ` +
					`but ${values.length} value(s) were given.`,
			);
		}
		return this.withConditions(
			this.matchColumns(this.conditions, columns, values),
		);
	}

	/** A null matches with IS NULL. */
	whereAttributes(attributes: Partial<ColumnsOf<M>>): this {
		const entries = Object.entries(attributes);
		return this.withConditions(
			this.matchColumns(
				this.conditions,
				entries.map(([column]) => column),
				entries.map(([, value]) => value),
			),
		);
	}

	/** @internal */
	whereAnyOf(
		columns: readonly string[],
		tuples: readonly (readonly unknown[])[],
	): this {
		const qualified = columns.map(column => this.table.qualified(column));

		if (columns.length === 1) {
			const column = columns[0]!;
			return this.withConditions(
				this.conditions.whereIn(
					qualified[0]!,
					tuples.map(tuple => this.storedValue(column, tuple[0])),
				),
			);
		}

		return this.withConditions(
			this.conditions.whereTuplesIn(
				qualified,
				tuples.map(tuple =>
					columns.map((column, index) =>
						this.storedValue(column, tuple[index]),
					),
				),
			),
		);
	}

	/** A null in the list is tested for apart; IN alone never matches one. */
	private inList(
		connector: 'and' | 'or',
		column: string,
		values: readonly unknown[],
		negated: boolean,
	): Conditions {
		const method = negated
			? connector === 'and'
				? 'whereNotIn'
				: 'orWhereNotIn'
			: connector === 'and'
				? 'whereIn'
				: 'orWhereIn';

		return this.conditions[method](
			column,
			values.map(value => this.storedValue(column, value)),
		);
	}

	private matchColumns(
		conditions: Conditions,
		columns: readonly string[],
		values: readonly unknown[],
	): Conditions {
		return columns.reduce(
			(matched, column, index) =>
				matched.where(
					this.table.qualified(column),
					this.storedValue(column, values[index]),
				),
			conditions,
		);
	}

	private stored(args: unknown[]): WhereArgs {
		if (args.length === 1) {
			const group = args[0] as ModelGroup<M>;
			return [
				conditions =>
					group(new ModelConditions<M>(this.table, conditions))
						.untyped,
			];
		}

		const column = args[0] as string;
		if (args.length === 2) {
			return [column, this.storedValue(column, args[1])];
		}

		const operator = args[1] as CompareOperator;
		// A pattern is text to match against the stored text, whatever the column's logical type.
		const pattern =
			/^\s*(not\s+)?like\s*$/i.test(operator) &&
			typeof args[2] === 'string';
		return [
			column,
			operator,
			pattern ? (args[2] as string) : this.storedValue(column, args[2]),
		];
	}

	private storedValue(column: string, value: unknown): Value {
		const prefix = `${this.table.name}.`;
		const name = column.startsWith(prefix)
			? column.slice(prefix.length)
			: column;
		// Undefined is no value; read as NULL it would hide the bug that produced it.
		if (value === undefined) {
			throw new QueryError(
				`[orm] ${this.table.name}.${name} was compared with undefined. ` +
					'Compare with null to match a missing value.',
			);
		}
		return this.table.column(name).encode(value);
	}
}

export class ModelConditions<M extends Model> extends ModelFilter<M> {
	constructor(
		protected readonly table: Table,
		readonly untyped: Conditions,
	) {
		super();
	}

	protected get conditions(): Conditions {
		return this.untyped;
	}

	protected withConditions(conditions: Conditions): this {
		return new ModelConditions<M>(this.table, conditions) as this;
	}
}

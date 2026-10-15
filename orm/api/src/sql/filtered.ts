import type { Value } from '../database/statement';
import type { Conditions, WhereArgs } from './conditions';

/** Immutable: each method returns a new builder. */
export abstract class Filtered {
	/** @internal */
	abstract get conditions(): Conditions;
	protected abstract withConditions(conditions: Conditions): this;

	/** Takes over conditions built elsewhere, in place of its own. */
	matching(conditions: Conditions): this {
		return this.withConditions(conditions);
	}

	where(...args: WhereArgs): this {
		return this.withConditions(this.conditions.where(...args));
	}

	orWhere(...args: WhereArgs): this {
		return this.withConditions(this.conditions.orWhere(...args));
	}

	whereNot(...args: WhereArgs): this {
		return this.withConditions(this.conditions.whereNot(...args));
	}

	orWhereNot(...args: WhereArgs): this {
		return this.withConditions(this.conditions.orWhereNot(...args));
	}

	whereIn(column: string, values: readonly Value[]): this {
		return this.withConditions(this.conditions.whereIn(column, values));
	}

	orWhereIn(column: string, values: readonly Value[]): this {
		return this.withConditions(this.conditions.orWhereIn(column, values));
	}

	whereNotIn(column: string, values: readonly Value[]): this {
		return this.withConditions(this.conditions.whereNotIn(column, values));
	}

	orWhereNotIn(column: string, values: readonly Value[]): this {
		return this.withConditions(
			this.conditions.orWhereNotIn(column, values),
		);
	}

	whereTuplesIn(
		columns: readonly string[],
		tuples: readonly (readonly Value[])[],
	): this {
		return this.withConditions(
			this.conditions.whereTuplesIn(columns, tuples),
		);
	}

	whereNull(column: string): this {
		return this.withConditions(this.conditions.whereNull(column));
	}

	orWhereNull(column: string): this {
		return this.withConditions(this.conditions.orWhereNull(column));
	}

	whereNotNull(column: string): this {
		return this.withConditions(this.conditions.whereNotNull(column));
	}

	orWhereNotNull(column: string): this {
		return this.withConditions(this.conditions.orWhereNotNull(column));
	}

	/** SQL passed through untouched. Never build it from user input. */
	whereRaw(sql: string, params: readonly Value[] = []): this {
		return this.withConditions(this.conditions.whereRaw(sql, params));
	}

	orWhereRaw(sql: string, params: readonly Value[] = []): this {
		return this.withConditions(this.conditions.orWhereRaw(sql, params));
	}
}

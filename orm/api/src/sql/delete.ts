import type { Statement, StatementSource } from '../database/statement';
import { Conditions } from './conditions';
import { Filtered } from './filtered';
import { SqlWriter } from './sql-writer';

export class DeleteBuilder extends Filtered implements StatementSource {
	private constructor(
		private readonly table: string,
		private readonly filter: Conditions,
		private readonly returned: readonly string[],
	) {
		super();
	}

	static from(table: string): DeleteBuilder {
		return new DeleteBuilder(table, Conditions.none, []);
	}

	returning(...columns: string[]): this {
		return new DeleteBuilder(this.table, this.filter, [
			...this.returned,
			...columns,
		]) as this;
	}

	toStatement(): Statement {
		const writer = new SqlWriter();
		const where = this.filter.write(writer);

		return writer.statement([
			`DELETE FROM ${writer.identifier(this.table)}`,
			where === '' ? '' : `WHERE ${where}`,
			this.returned.length === 0
				? ''
				: `RETURNING ${writer.identifiers(this.returned)}`,
		]);
	}

	/** @internal */
	get conditions(): Conditions {
		return this.filter;
	}

	protected withConditions(conditions: Conditions): this {
		return new DeleteBuilder(this.table, conditions, this.returned) as this;
	}
}

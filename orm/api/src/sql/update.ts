import type { Statement, StatementSource, Value } from '../database/statement';
import { QueryError } from '../errors';
import { Conditions } from './conditions';
import { Filtered } from './filtered';
import type { Values } from './insert';
import { SqlWriter } from './sql-writer';

export class UpdateBuilder extends Filtered implements StatementSource {
	private constructor(
		private readonly table: string,
		private readonly assignments: Values,
		private readonly filter: Conditions,
		private readonly returned: readonly string[],
	) {
		super();
	}

	static table(table: string): UpdateBuilder {
		return new UpdateBuilder(table, {}, Conditions.none, []);
	}

	/** Assignments merge, a later value for a column replacing an earlier one. */
	set(values: Values): this;
	set(column: string, value: Value): this;
	set(values: Values | string, value?: Value): this {
		const added =
			typeof values === 'string' ? { [values]: value as Value } : values;
		return new UpdateBuilder(
			this.table,
			{ ...this.assignments, ...added },
			this.filter,
			this.returned,
		) as this;
	}

	returning(...columns: string[]): this {
		return new UpdateBuilder(this.table, this.assignments, this.filter, [
			...this.returned,
			...columns,
		]) as this;
	}

	toStatement(): Statement {
		const assignments = Object.entries(this.assignments);
		if (assignments.length === 0) {
			throw new QueryError(
				'[orm] An update needs at least one assignment.',
			);
		}

		const writer = new SqlWriter();
		const set = assignments
			.map(
				([column, value]) =>
					`${UpdateBuilder.target(column, writer)} = ${writer.bind(value)}`,
			)
			.join(', ');
		const where = this.filter.write(writer);

		return writer.statement([
			`UPDATE ${writer.identifier(this.table)}`,
			`SET ${set}`,
			where === '' ? '' : `WHERE ${where}`,
			this.returned.length === 0
				? ''
				: `RETURNING ${writer.identifiers(this.returned)}`,
		]);
	}

	/** @internal A SET column is always the updated table's; SQLite refuses a qualifier there. */
	static target(column: string, writer: SqlWriter): string {
		return writer.identifier(column.split('.').at(-1)!);
	}

	/** @internal */
	get conditions(): Conditions {
		return this.filter;
	}

	protected withConditions(conditions: Conditions): this {
		return new UpdateBuilder(
			this.table,
			this.assignments,
			conditions,
			this.returned,
		) as this;
	}
}

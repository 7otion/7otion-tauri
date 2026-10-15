import type { Statement, StatementSource, Value } from '../database/statement';
import { QueryError } from '../errors';
import { SqlWriter } from './sql-writer';

export type Values = Readonly<Record<string, Value>>;

export class InsertBuilder implements StatementSource {
	private constructor(
		private readonly table: string,
		private readonly rows: readonly Values[],
		private readonly returned: readonly string[],
	) {}

	static into(table: string): InsertBuilder {
		return new InsertBuilder(table, [], []);
	}

	/** Every row must set the same columns. */
	values(rows: Values | readonly Values[]): this {
		const added = (Array.isArray(rows) ? rows : [rows as Values]).map(
			row => ({ ...row }),
		);
		return new InsertBuilder(
			this.table,
			[...this.rows, ...added],
			this.returned,
		) as this;
	}

	returning(...columns: string[]): this {
		return new InsertBuilder(this.table, this.rows, [
			...this.returned,
			...columns,
		]) as this;
	}

	toStatement(): Statement {
		if (this.rows.length === 0) {
			throw new QueryError('[orm] An insert needs at least one row.');
		}

		const writer = new SqlWriter();
		const into = `INSERT INTO ${writer.identifier(this.table)}`;
		const columns = Object.keys(this.rows[0]!);

		if (columns.length === 0) {
			if (this.rows.length > 1) {
				throw new QueryError(
					'[orm] Only one row of defaults can be inserted per statement.',
				);
			}
			return writer.statement([
				into,
				'DEFAULT VALUES',
				this.writeReturning(writer),
			]);
		}

		const rows = this.rows.map(row => {
			const keys = Object.keys(row);
			if (
				keys.length !== columns.length ||
				!columns.every(column => column in row)
			) {
				throw new QueryError(
					`[orm] Every inserted row must set the same columns. Expected ` +
						`${columns.join(', ')} but a row has ${keys.join(', ')}.`,
				);
			}
			return `(${columns.map(column => writer.bind(row[column]!)).join(', ')})`;
		});

		return writer.statement([
			into,
			`(${writer.identifiers(columns)})`,
			`VALUES ${rows.join(', ')}`,
			this.writeReturning(writer),
		]);
	}

	private writeReturning(writer: SqlWriter): string {
		return this.returned.length === 0
			? ''
			: `RETURNING ${writer.identifiers(this.returned)}`;
	}
}

import type { Statement, StatementSource, Value } from '../database/statement';
import { QueryError } from '../errors';
import { Conditions } from './conditions';
import type { Values } from './insert';
import { SqlWriter } from './sql-writer';
import { UpdateBuilder } from './update';

export interface KeyedValues {
	/** Values in the key columns' order. */
	key: readonly Value[];
	set: Values;
}

export class UpdateManyBuilder implements StatementSource {
	private constructor(
		private readonly table: string,
		private readonly keyColumns: readonly string[],
		private readonly keyed: readonly KeyedValues[],
		private readonly everyRow: Values,
	) {}

	static table(
		table: string,
		keyColumns: readonly string[],
	): UpdateManyBuilder {
		return new UpdateManyBuilder(table, keyColumns, [], {});
	}

	rows(rows: readonly KeyedValues[]): this {
		return new UpdateManyBuilder(
			this.table,
			this.keyColumns,
			[
				...this.keyed,
				...rows.map(({ key, set }) => ({
					key: [...key],
					set: { ...set },
				})),
			],
			this.everyRow,
		) as this;
	}

	/** Assignments every row receives. */
	shared(values: Values): this {
		return new UpdateManyBuilder(this.table, this.keyColumns, this.keyed, {
			...this.everyRow,
			...values,
		}) as this;
	}

	/** Each column takes its row's value through a CASE on the key; rows not setting it keep theirs. */
	toStatement(): Statement {
		if (this.keyed.length === 0) {
			throw new QueryError('[orm] A bulk update needs at least one row.');
		}
		if (this.keyColumns.length === 0) {
			throw new QueryError(
				'[orm] A bulk update needs a key to match rows on.',
			);
		}
		for (const row of this.keyed) {
			if (row.key.length !== this.keyColumns.length) {
				throw new QueryError(
					`[orm] A row's key has ${row.key.length} values for ${this.keyColumns.length} key columns.`,
				);
			}
			// `key = NULL` is never true, so its CASE would not fire, while the WHERE would match every NULL key.
			if (row.key.some(value => value === null)) {
				throw new QueryError(
					'[orm] A bulk update cannot locate a row by a NULL key.',
				);
			}
		}

		const writer = new SqlWriter();
		const columns = [
			...new Set(this.keyed.flatMap(row => Object.keys(row.set))),
		];

		const assignments = columns.map(column => {
			const quoted = UpdateBuilder.target(column, writer);
			const branches = this.keyed
				.filter(row => column in row.set)
				.map(
					row =>
						`WHEN ${this.writeKeyMatch(row.key, writer)} THEN ${writer.bind(row.set[column]!)}`,
				);
			return `${quoted} = CASE ${branches.join(' ')} ELSE ${quoted} END`;
		});

		for (const [column, value] of Object.entries(this.everyRow)) {
			assignments.push(
				`${UpdateBuilder.target(column, writer)} = ${writer.bind(value)}`,
			);
		}

		if (assignments.length === 0) {
			throw new QueryError(
				'[orm] A bulk update needs at least one assignment.',
			);
		}

		const keys = this.keyed.map(row => row.key);
		const where =
			this.keyColumns.length === 1
				? Conditions.none.whereIn(
						this.keyColumns[0]!,
						keys.map(key => key[0]!),
					)
				: Conditions.none.whereTuplesIn(this.keyColumns, keys);

		return writer.statement([
			`UPDATE ${writer.identifier(this.table)}`,
			`SET ${assignments.join(', ')}`,
			`WHERE ${where.write(writer)}`,
		]);
	}

	private writeKeyMatch(key: readonly Value[], writer: SqlWriter): string {
		return this.keyColumns
			.map(
				(column, index) =>
					`${writer.identifier(column)} = ${writer.bind(key[index]!)}`,
			)
			.join(' AND ');
	}
}

import { Statement, type Value } from '../database/statement';
import { QueryError } from '../errors';

export class SqlWriter {
	private readonly params: Value[] = [];

	bind(value: Value): string {
		if (value === undefined) {
			throw new QueryError(
				'[orm] undefined cannot be bound. Bind null to store or match NULL.',
			);
		}
		this.params.push(value);
		return '?';
	}

	raw(sql: string, params: readonly Value[]): string {
		for (const value of params) this.bind(value);
		return sql;
	}

	/** A dotted name with each segment quoted; `*` stays bare. */
	identifier(name: string): string {
		return name
			.split('.')
			.map(segment => {
				if (segment === '*') return '*';
				if (segment === '') {
					throw new QueryError(
						`[orm] Empty identifier in ${JSON.stringify(name)}.`,
					);
				}
				return SqlWriter.quote(segment);
			})
			.join('.');
	}

	identifiers(names: readonly string[]): string {
		return names.map(name => this.identifier(name)).join(', ');
	}

	/** Parts are joined in the order given, which must be the order they bound in. */
	statement(parts: readonly string[]): Statement {
		return new Statement(
			parts.filter(part => part !== '').join(' '),
			this.params,
		);
	}

	/** Backticks: SQLite reads a double-quoted name it cannot resolve as a string literal, and matches it. */
	private static quote(segment: string): string {
		return `\`${segment.replaceAll('`', '``')}\``;
	}
}

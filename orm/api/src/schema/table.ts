import type { Row, Value } from '../database/statement';
import { OrmError } from '../errors';
import type { Values } from '../sql/insert';
import { DateCodec } from './codec';
import { Column } from './column';
import { PrimaryKey } from './primary-key';
import { Timestamps } from './timestamps';

export interface TableDefinition<
	C extends Record<string, Column<any, boolean>>,
> {
	table: string;
	columns: C;
	/** `true` uses `created_at` and `updated_at`. Either way both must be declared as date columns. */
	timestamps?:
		boolean | { createdAt: keyof C & string; updatedAt: keyof C & string };
	/** Columns `fill()` may set; when present, every other column is ignored. */
	fillable?: readonly (keyof C & string)[];
	/** Columns `fill()` may never set. Ignored when `fillable` is present. */
	guarded?: readonly (keyof C & string)[];
}

export class Table {
	readonly name: string;
	readonly columns: ReadonlyMap<string, Column>;
	readonly primaryKey: PrimaryKey;
	readonly timestamps: Timestamps;

	private readonly fillableColumns: ReadonlySet<string> | null;
	private readonly guardedColumns: ReadonlySet<string>;

	constructor(definition: TableDefinition<any>) {
		this.name = definition.table;
		this.columns = new Map(
			Object.entries(definition.columns as Record<string, Column>).map(
				([name, column]) => [name, column.named(name)],
			),
		);
		this.primaryKey = this.resolvePrimaryKey();
		this.timestamps = this.resolveTimestamps(definition.timestamps);
		this.fillableColumns = definition.fillable
			? new Set(definition.fillable)
			: null;
		this.guardedColumns = new Set(definition.guarded ?? []);
	}

	has(column: string): boolean {
		return this.columns.has(column);
	}

	/** @internal */
	column(name: string): Column {
		return this.columns.get(name) ?? Column.undeclared;
	}

	qualified(column: string): string {
		return this.columns.has(column) ? `${this.name}.${column}` : column;
	}

	fillable(column: string): boolean {
		if (!this.columns.has(column)) return false;
		if (this.timestamps.owns(column)) return false;
		return this.fillableColumns
			? this.fillableColumns.has(column)
			: !this.guardedColumns.has(column);
	}

	/** Undefined values are left out; an undeclared column, as a joined or computed one is, passes through. */
	encode(values: Readonly<Record<string, unknown>>): Values {
		const row: Record<string, Value> = {};
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) continue;
			row[name] = this.column(name).encode(value);
		}
		return row;
	}

	decode(row: Row): Record<string, unknown> {
		const values: Record<string, unknown> = { ...row };
		for (const [name, column] of this.columns) {
			if (name in row) values[name] = column.decode(row[name]);
		}
		return values;
	}

	readBackAll(
		values: Readonly<Record<string, unknown>>,
	): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries(values).map(([name, value]) => [
				name,
				this.column(name).readBack(value),
			]),
		);
	}

	/** Null while any value is missing or NULL. */
	signature(
		columns: readonly string[],
		values: readonly unknown[],
	): string | null {
		return this.storedSignature(
			columns,
			columns.map((name, index) => this.column(name).encode(values[index])),
		);
	}

	/** As `signature`, for values already in their stored form. Equal where SQLite's `=` on these columns is. */
	storedSignature(
		columns: readonly string[],
		stored: readonly unknown[],
	): string | null {
		return PrimaryKey.signature(
			columns.map((name, index) => this.column(name).comparable(stored[index])),
		);
	}

	keySignature(values: Readonly<Record<string, unknown>>): string | null {
		const { columns } = this.primaryKey;
		return this.signature(
			columns,
			columns.map(column => values[column]),
		);
	}

	private resolvePrimaryKey(): PrimaryKey {
		const columns = [...this.columns]
			.filter(([, column]) => column.isPrimary)
			.map(([name]) => name);

		if (columns.length === 0) {
			throw new OrmError(
				`[orm] Table ${this.name} declares no primary key. Mark a column with primary().`,
			);
		}

		const generated = [...this.columns]
			.filter(([, column]) => column.isGenerated)
			.map(([name]) => name);

		if (generated.length === 0) return new PrimaryKey(columns, null);

		if (
			generated.length > 1 ||
			columns.length > 1 ||
			generated[0] !== columns[0]
		) {
			throw new OrmError(
				`[orm] Table ${this.name}: generated() is for a single-column primary key.`,
			);
		}
		return new PrimaryKey(columns, generated[0]!);
	}

	private resolveTimestamps(
		declared: TableDefinition<any>['timestamps'],
	): Timestamps {
		if (!declared) return new Timestamps(null);

		const columns =
			declared === true
				? { createdAt: 'created_at', updatedAt: 'updated_at' }
				: declared;

		for (const column of [columns.createdAt, columns.updatedAt]) {
			const declaredColumn = this.columns.get(column);
			if (!declaredColumn) {
				throw new OrmError(
					`[orm] Table ${this.name} has timestamps on, so it must declare ` +
						`${column} as a date column.`,
				);
			}
			if (!(declaredColumn.codec instanceof DateCodec)) {
				throw new OrmError(
					`[orm] Table ${this.name} declares ${column} as a timestamp, so it must be ` +
						"a date column: Column.date('unix'), or another storage.",
				);
			}
		}
		return new Timestamps(columns);
	}
}

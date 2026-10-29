import type { StoredValue, Value } from '../database/statement';
import { OrmError } from '../errors';

/** Never handed null. */
export interface Codec<Logical = any, Stored extends Value = Value> {
	decode(value: StoredValue, column: string): Logical;
	encode(value: Logical, column: string): Stored;
	/** Defaults to decoding what `encode` gives. */
	clone?(value: Logical): Logical;
	/** Defaults to `===`, and for objects to comparing what `encode` gives. */
	equals?(a: Logical, b: Logical): boolean;
	accept?(value: unknown, column: string): Logical;
}

export class BooleanCodec implements Codec<boolean, number> {
	/** Any number but 0 is true, as SQLite reads it. */
	decode(value: StoredValue): boolean {
		return typeof value === 'number'
			? value !== 0
			: value === '1' || value === 'true';
	}

	encode(value: boolean): number {
		return value ? 1 : 0;
	}
}

export class JsonCodec implements Codec<unknown, string> {
	decode(value: StoredValue, column: string): unknown {
		if (typeof value !== 'string') return value;
		try {
			return JSON.parse(value);
		} catch (cause) {
			throw new OrmError(
				`[orm] Column ${JSON.stringify(column)} is declared as json but does not ` +
					`hold valid JSON: ${JSON.stringify(value.slice(0, 80))}.`,
				{ cause },
			);
		}
	}

	/** Strings are serialised too: stored raw they would fail to parse back. */
	encode(value: unknown): string {
		return JSON.stringify(value);
	}
}

/**
 * How a date is stored: `iso` is ISO 8601 text, `datetime` is `YYYY-MM-DD HH:MM:SS.mmm`
 * in UTC as SQLite's own date functions write it, `unix` is whole seconds, `unix_ms` is milliseconds.
 */
export type DateStorage = 'iso' | 'datetime' | 'unix' | 'unix_ms';

export class DateCodec implements Codec<Date, string | number> {
	constructor(private readonly storage: DateStorage) {}

	decode(value: StoredValue, column: string): Date {
		const date = new Date(this.milliseconds(value));
		if (Number.isNaN(date.getTime())) {
			throw new OrmError(
				`[orm] Column ${JSON.stringify(column)} is declared as a date but holds ` +
					`${JSON.stringify(String(value))}.`,
			);
		}
		return date;
	}

	encode(value: Date): string | number {
		if (Number.isNaN(value.getTime())) {
			throw new OrmError('[orm] An invalid Date cannot be stored.');
		}
		switch (this.storage) {
			case 'iso':
				return value.toISOString();
			// Whole seconds as CURRENT_TIMESTAMP writes them, so the two compare equal as text.
			case 'datetime':
				return value
					.toISOString()
					.replace('T', ' ')
					.replace(/(\.000)?Z$/, '');
			case 'unix':
				return Math.floor(value.getTime() / 1000);
			case 'unix_ms':
				return value.getTime();
		}
	}

	accept(value: unknown, column: string): Date {
		if (typeof value !== 'number') return value as Date;
		const date = new Date(
			this.storage === 'unix_ms' ? value : value * 1000,
		);
		if (Number.isNaN(date.getTime())) {
			throw new OrmError(
				`[orm] Column ${JSON.stringify(column)} is a date, and ${value} is not a date.`,
			);
		}
		return date;
	}

	clone(value: Date): Date {
		return new Date(value.getTime());
	}

	equals(a: Date, b: Date): boolean {
		return a.getTime() === b.getTime();
	}

	/** NaN for anything that is not a date in this column's storage. */
	private milliseconds(value: StoredValue): number {
		if (this.storage === 'unix' || this.storage === 'unix_ms') {
			const numeric =
				typeof value === 'number'
					? value
					: typeof value === 'string' && value.trim() !== ''
						? Number(value)
						: Number.NaN;
			return this.storage === 'unix' ? numeric * 1000 : numeric;
		}

		if (typeof value !== 'string') return Number.NaN;
		const text = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T');

		// A date with no time is UTC midnight, which is what parsing it alone gives.
		if (/^\d{4}(-\d{2}){0,2}$/.test(text)) return Date.parse(text);

		// Text without a zone is UTC, which is how `encode` and SQLite write it.
		const zoned = /([zZ]|[+-]\d{2}:\d{2})$/.test(text);
		return Date.parse(zoned ? text : `${text}Z`);
	}
}

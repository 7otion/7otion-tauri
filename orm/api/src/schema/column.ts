import type { StoredValue, Value } from '../database/statement';
import {
	BooleanCodec,
	DateCodec,
	JsonCodec,
	type Codec,
	type DateStorage,
} from './codec';

/** A committed date: still a `Date` to every library, but one that cannot be moved in place. */
export class FrozenDate extends Date {
	private static refuse(): never {
		throw new TypeError(
			'[orm] A committed date cannot be changed in place. Assign a new Date on the draft.',
		);
	}

	override setTime = FrozenDate.refuse;
	override setMilliseconds = FrozenDate.refuse;
	override setUTCMilliseconds = FrozenDate.refuse;
	override setSeconds = FrozenDate.refuse;
	override setUTCSeconds = FrozenDate.refuse;
	override setMinutes = FrozenDate.refuse;
	override setUTCMinutes = FrozenDate.refuse;
	override setHours = FrozenDate.refuse;
	override setUTCHours = FrozenDate.refuse;
	override setDate = FrozenDate.refuse;
	override setUTCDate = FrozenDate.refuse;
	override setMonth = FrozenDate.refuse;
	override setUTCMonth = FrozenDate.refuse;
	override setFullYear = FrozenDate.refuse;
	override setUTCFullYear = FrozenDate.refuse;
}

interface ColumnFlags {
	readonly primary: boolean;
	readonly generated: boolean;
	readonly emptyToNull: boolean;
	readonly nocase: boolean;
}

const NO_FLAGS: ColumnFlags = {
	primary: false,
	generated: false,
	emptyToNull: false,
	nocase: false,
};

/** Immutable. `P` marks a key column for the types. */
export class Column<T = unknown, P extends boolean = boolean, W = T> {
	/** Carries the logical type; never assigned. */
	declare readonly $type: T;
	/** Carries whether it is part of the primary key; never assigned. */
	declare readonly $primary: P;
	declare readonly $write: W;

	private constructor(
		/** Null when the stored value is already the logical one. */
		readonly codec: Codec | null,
		private readonly flags: ColumnFlags,
		/** Set by the table that declares it; codec errors name it. */
		readonly name = '',
	) {}

	/** @internal What a table hands out for a name it does not declare, as a joined or computed column. */
	static readonly undeclared = new Column(null, NO_FLAGS);

	static integer(): Column<number, false> {
		return new Column(null, NO_FLAGS);
	}

	static real(): Column<number, false> {
		return new Column(null, NO_FLAGS);
	}

	static text<T extends string = string>(): Column<NoInfer<T>, false> {
		return new Column(null, NO_FLAGS);
	}

	static blob(): Column<Uint8Array, false> {
		return new Column(null, NO_FLAGS);
	}

	/** Stored as 1 or 0. */
	static boolean(): Column<boolean, false> {
		return new Column(new BooleanCodec(), NO_FLAGS);
	}

	static json<T = unknown>(): Column<T, false> {
		return new Column(new JsonCodec(), NO_FLAGS);
	}

	static date(storage: DateStorage = 'iso'): Column<Date, false, Date | number> {
		return new Column(new DateCodec(storage), NO_FLAGS);
	}

	static custom<T>(codec: Codec<T>): Column<T, false> {
		return new Column(codec, NO_FLAGS);
	}

	/** Type-level only: the database enforces it. */
	nullable(): Column<T | null, P, W | null> {
		return new Column(this.codec, this.flags);
	}

	primary(): Column<T, true, W> {
		return new Column(this.codec, { ...this.flags, primary: true });
	}

	generated(): Column<T, P, W> {
		return new Column(this.codec, { ...this.flags, generated: true });
	}

	emptyToNull(): Column<T | null, P, W | null> {
		return new Column(this.codec, { ...this.flags, emptyToNull: true });
	}

	/** Tells the ORM the column is `COLLATE NOCASE`; the database's own collation is not read. */
	nocase(): Column<T, P, W> {
		return new Column(this.codec, { ...this.flags, nocase: true });
	}

	get isPrimary(): boolean {
		return this.flags.primary;
	}

	get isGenerated(): boolean {
		return this.flags.generated;
	}

	/** @internal */
	named(name: string): Column<T, P, W> {
		return new Column(this.codec, this.flags, name);
	}

	accept(value: unknown): unknown {
		if (value === null || value === undefined || !this.codec?.accept) return value;
		return this.codec.accept(value, this.name);
	}

	/** @internal A logical value as a statement binds it; `''` is null where the column stores it so. */
	encode(value: unknown): Value {
		if (value === null || value === undefined) return null;
		if (this.flags.emptyToNull && value === '') return null;
		return this.codec ? this.codec.encode(value, this.name) : (value as Value);
	}

	/** @internal */
	decode(value: StoredValue | undefined): unknown {
		if (value === null || value === undefined || !this.codec) return value;
		return this.codec.decode(value, this.name);
	}

	/** @internal A stored value as SQLite's `=` compares it on this column: NOCASE folds A-Z only, so 'É' and 'é' stay apart. */
	comparable(stored: unknown): unknown {
		return typeof stored === 'string' && this.flags.nocase
			? stored.replace(/[A-Z]/g, letter => letter.toLowerCase())
			: stored;
	}

	/** @internal Whether the column holds JSON, whose objects a draft hands out wrapped so an edit inside them is seen. */
	get isJson(): boolean {
		return this.codec instanceof JsonCodec;
	}

	/** @internal Whether a draft hands out its own copy of an object value to edit in place: JSON, and a custom codec's. */
	get copiedByDraft(): boolean {
		return (
			this.codec !== null &&
			!(this.codec instanceof DateCodec) &&
			!(this.codec instanceof BooleanCodec)
		);
	}

	/**
	 * @internal A committed value as the model hands it out: JSON frozen through, a custom
	 * codec's object frozen, a date that refuses to be set.
	 */
	frozen(value: unknown): unknown {
		if (value instanceof Date) return new FrozenDate(value.getTime());
		if (this.isJson) return Column.freezeDeep(value);
		if (this.copiedByDraft && value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
			return Object.freeze(value);
		}
		return value;
	}

	private static freezeDeep(value: unknown): unknown {
		if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
		for (const inner of Object.values(value)) Column.freezeDeep(inner);
		return Object.freeze(value);
	}

	/** @internal Detached: the codec's `clone`, or the value as it reads back, which keeps a class instance's class. */
	copy(value: unknown): unknown {
		if (value === null || typeof value !== 'object') return value;
		if (value instanceof Uint8Array) return value.slice();
		if (!this.codec) return structuredClone(value);
		return this.codec.clone
			? this.codec.clone(value)
			: this.readBack(value);
	}

	/** @internal The value as it reads back once stored: a date cut to the second, an empty string become null. */
	readBack(value: unknown): unknown {
		if (value === null || value === undefined) return value;
		if (this.flags.emptyToNull && value === '') return null;
		if (this.codec) return this.decode(Column.asStored(this.encode(value)));
		// Detached, as a decoded value is: bytes edited in place later are not what was stored.
		return value instanceof Uint8Array ? value.slice() : value;
	}

	/** @internal Compared by content, so an edit made in place is seen: the codec's `equals`, or the stored forms. */
	same(a: unknown, b: unknown): boolean {
		if (a === b) return true;
		if (a === null || b === null || a === undefined || b === undefined) {
			return false;
		}
		if (this.codec?.equals) return this.codec.equals(a, b);
		if (typeof a !== 'object' || typeof b !== 'object') return false;

		return Column.sameStored(this.encode(a), this.encode(b));
	}

	/**
	 * @internal Whether `value` would be stored as `stored` is: `''` where the column stores
	 * null, or a time within the second a `unix` column keeps, is no change.
	 */
	storesAs(value: unknown, stored: unknown): boolean {
		let form: unknown;
		try {
			form = this.readBack(value);
		} catch {
			// A value the codec refuses is a change; saving it reports the refusal.
			return false;
		}
		return this.same(form, stored);
	}

	/** @internal A bound value as SQLite hands it back: a boolean comes back as 1 or 0. */
	static asStored(value: Value): StoredValue {
		return typeof value === 'boolean' ? Number(value) : value;
	}

	private static sameStored(a: unknown, b: unknown): boolean {
		if (a instanceof Uint8Array && b instanceof Uint8Array) {
			return a.length === b.length && a.every((byte, i) => byte === b[i]);
		}
		return typeof a === 'object' || typeof b === 'object'
			? JSON.stringify(a) === JSON.stringify(b)
			: a === b;
	}
}

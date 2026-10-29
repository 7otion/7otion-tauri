import { Signal } from '../reactivity/signal.svelte';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import { LiveRegistry, type Entry, type Live } from './live';

/** A read-only list of rows. `rows` is replaced whole on every change and never edited. */
export class Collection<T> implements Iterable<T> {
	private held: readonly T[];
	private readonly signal = new Signal();

	/** @internal */
	constructor(rows: readonly T[]) {
		this.held = rows;
	}

	/** Every read goes through here, so one dependency covers them all. */
	get rows(): readonly T[] {
		this.signal.read();
		return this.held;
	}

	[Symbol.iterator](): Iterator<T> {
		return this.rows[Symbol.iterator]();
	}

	get length(): number {
		return this.rows.length;
	}

	at(index: number): T | undefined {
		return this.rows.at(index);
	}

	get first(): T | undefined {
		return this.rows[0];
	}

	get last(): T | undefined {
		return this.rows.at(-1);
	}

	find(predicate: (row: T, index: number) => boolean): T | undefined {
		return this.rows.find(predicate);
	}

	some(predicate: (row: T, index: number) => boolean): boolean {
		return this.rows.some(predicate);
	}

	every(predicate: (row: T, index: number) => boolean): boolean {
		return this.rows.every(predicate);
	}

	includes(row: T): boolean {
		return this.rows.includes(row);
	}

	reduce<A>(reducer: (total: A, row: T, index: number) => A, start: A): A {
		return this.rows.reduce(reducer, start);
	}

	forEach(callback: (row: T, index: number) => void): void {
		this.rows.forEach(callback);
	}

	/** What `fn` makes of each row, as a plain array of this moment. */
	map<U>(fn: (row: T, index: number) => U): U[] {
		return this.rows.map(fn);
	}

	/** The rows `predicate` keeps, as a plain array of this moment. */
	filter(predicate: (row: T, index: number) => boolean): T[] {
		return this.rows.filter(predicate);
	}

	/** Sorted by a column, or by what `by` gives for each row, nulls first ascending as SQLite orders them; a plain array. */
	sortBy(
		by: keyof T | ((row: T) => unknown),
		direction: 'asc' | 'desc' = 'asc',
	): T[] {
		const value = typeof by === 'function' ? by : (row: T) => row[by];
		const sign = direction === 'desc' ? -1 : 1;
		return [...this.rows].sort((a, b) => {
			const [x, y] = [value(a), value(b)] as [any, any];
			if (x === y || (x == null && y == null)) return 0;
			if (x == null) return -sign;
			if (y == null) return sign;
			return x < y ? -sign : x > y ? sign : 0;
		});
	}

	pluck<K extends keyof T>(key: K): T[K][] {
		return this.rows.map(row => row[key]);
	}

	keyBy<K extends keyof T>(key: K): Map<T[K], T> {
		return new Map(this.rows.map(row => [row[key], row]));
	}

	groupBy<K extends keyof T>(key: K): Map<T[K], T[]> {
		const groups = new Map<T[K], T[]>();
		for (const row of this.rows) {
			const group = groups.get(row[key]);
			if (group) group.push(row);
			else groups.set(row[key], [row]);
		}
		return groups;
	}

	/** A plain copy, which no longer follows the database. */
	toArray(): T[] {
		return [...this.rows];
	}

	toJSON(): readonly T[] {
		return this.rows;
	}

	/** Stops keeping this list correct. The rows stay as they are. A plain list follows nothing to stop. */
	release(): void {}

	/** @internal */
	replace(rows: readonly T[]): void {
		this.held = rows;
		this.signal.bump();
	}

	/** @internal The models a loaded relation's value holds: a collection's rows, or the one model. */
	static modelsIn(value: unknown): Model[] {
		const list = value instanceof Collection ? value.rows : [value];
		return list.filter(
			(related): related is Model =>
				related !== null && related !== undefined,
		);
	}

	/** @internal Same rows in the same order. */
	static same(a: readonly unknown[], b: readonly unknown[]): boolean {
		return (
			a.length === b.length && a.every((row, index) => row === b[index])
		);
	}
}

export interface Decider {
	modelClass: ModelClass<any>;
	columns: readonly string[] | null;
}

export interface Decided {
	modelClass: ModelClass<any>;
	decidingColumns: readonly string[] | null;
	also?: readonly Decider[];
}

/** How a live value asks for its rows again, and which columns of them decide it. */
export interface Source<M extends Model> extends Decided {
	modelClass: ModelClass<M>;
	fetch(): Promise<readonly M[]>;
	/** Columns of the model's table; null when any change may matter. */
	decidingColumns: readonly string[] | null;
	/** Under a limit or offset: a row that leaves may let another in. */
	bounded: boolean;
	/** At most one row can match, found by its primary key. */
	unique?: boolean;
	/** Whether `row` is one this source would fetch, when that is known without a query. */
	matches?(row: M): boolean;
	/** Loads beneath rows that joined what the value was loaded with beneath it. */
	complete?(rows: readonly M[]): Promise<void>;
	/** `LiveRegistry.version` of the model when the rows were read; left out when read in a turn. */
	seen?: number;
	follow?(live: Live, seen: number | undefined): () => void;
}

/** Whether a change to `column` may change what `source` fetches. */
export function decidedBy(
	source: Pick<Source<any>, 'modelClass' | 'decidingColumns'>,
	column: string,
): boolean {
	const columns = source.decidingColumns;
	return (
		columns === null ||
		columns.includes(column) ||
		columns.includes(`${source.modelClass.table.name}.${column}`)
	);
}

export function decidedElsewhere(source: Decided, entry: Entry): boolean {
	return (source.also ?? []).some(
		({ modelClass, columns }) =>
			entry.model.constructor === modelClass &&
			(entry.kind !== 'updated' ||
				Object.keys(entry.changes).some(column =>
					decidedBy({ modelClass, decidingColumns: columns }, column),
				)),
	);
}

export function follows(source: Decided): object[] {
	return [
		...new Set(
			(source.also ?? [])
				.map(({ modelClass }) => modelClass)
				.filter(modelClass => modelClass !== source.modelClass),
		),
	];
}

/**
 * A collection that stays correct: a row that starts to match its query joins, one that stops
 * matching leaves, and its order follows the query. Put right after each commit.
 */
export class LiveCollection<M extends Model>
	extends Collection<M>
	implements Live
{
	private released = false;
	private readonly leave: (() => void) | undefined;

	constructor(
		private readonly source: Source<M>,
		rows: readonly M[],
	) {
		super(rows);
		if (source.follow) {
			this.leave = source.follow(this, source.seen);
			return;
		}
		const registry = LiveRegistry.of(source.modelClass.database);
		registry.follow(
			this,
			source.seen ?? registry.version(source.modelClass),
		);
		for (const modelClass of follows(source))
			registry.add(this, modelClass);
	}

	get modelClass(): ModelClass<M> {
		return this.source.modelClass;
	}

	override release(): void {
		this.released = true;
		this.leave?.();
	}

	/**
	 * @internal A deleted row leaves at once. A created row, a deciding column changed, or under a
	 * limit any delete, asks again; another change to a member leaves the list as it is.
	 */
	async reconcile(entries: readonly Entry[]): Promise<void> {
		if (this.released) return;

		let ask = false;
		let rows = this.rows;
		const deleted = new Set<Model>();
		for (const entry of entries) {
			if (decidedElsewhere(this.source, entry)) ask = true;
			if (entry.model.constructor !== this.source.modelClass) continue;
			if (entry.kind === 'deleted') {
				deleted.add(entry.model);
				if (this.source.bounded) ask = true;
				continue;
			}
			if (
				entry.kind === 'created' ||
				Object.keys(entry.changes).some(column =>
					decidedBy(this.source, column),
				)
			) {
				ask = true;
			}
		}
		if (deleted.size) {
			const kept = rows.filter(row => !deleted.has(row));
			if (kept.length !== rows.length) rows = kept;
		}

		if (ask) {
			const fetched = await this.source.fetch();
			await this.source.complete?.(fetched);
			if (this.released) return;
			rows = Collection.same(fetched, this.rows) ? this.rows : fetched;
		}
		if (rows !== this.rows) this.replace(rows);
	}

	/** @internal */
	async refetch(): Promise<void> {
		if (this.released) return;
		const fetched = await this.source.fetch();
		await this.source.complete?.(fetched);
		if (this.released || Collection.same(fetched, this.rows)) return;
		this.replace(fetched);
	}
}

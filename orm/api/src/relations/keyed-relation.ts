import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { ModelClass, ModelRef } from '../model/types';
import type { Decider, Source } from '../query/collection.svelte';
import type { Entry } from '../query/live';
import { ModelQuery } from '../query/model-query';
import { Column } from '../schema/column';
import type { SelectBuilder } from '../sql/select';
import { SqlWriter } from '../sql/sql-writer';
import { KeyIndex } from './key-index';
import { LiveRelation, type Reach } from './live-relation';
import type { AnyRelation, Deliver, EagerConstraint, Existence } from './relation';

export type KeyColumns = string | readonly string[];

/** A thunk defers the lookup, so two model files may name each other. */
export type Related<RC> = RC | (() => RC);

export interface Matching {
	/** Paired with `relatedColumns` by index. */
	parentColumns: readonly string[];
	relatedColumns: readonly string[];
	many: boolean;
}

export abstract class KeyedRelation<
	R extends Model,
	RC = unknown,
> implements AnyRelation {
	/** Carries the related class type for `with()` paths to walk into; never assigned. */
	declare readonly $related?: RC;

	private resolved: ModelClass<R> | undefined;

	constructor(
		protected readonly parentClass: ModelRef<any>,
		private readonly related: Related<ModelRef<R>>,
	) {}

	protected abstract get matching(): Matching;

	abstract ownerColumns(): readonly string[];

	/** Narrows the query beyond the key; `accepts` is the same test on a row in hand. */
	protected scope(query: ModelQuery<R>): ModelQuery<R> {
		return query;
	}

	protected accepts(_row: R): boolean {
		return true;
	}

	/** The related columns that decide which rows `parent` gets under `constraint`; null when any may. */
	decidingColumns(
		name: string,
		constraint: EagerConstraint | undefined,
	): readonly string[] | null {
		const { relatedColumns } = this.matching;
		const deciding = this.shaped(name, constraint).builder.decidingColumns();
		return deciding === null ? null : [...relatedColumns, ...deciding];
	}

	bounded(name: string, constraint: EagerConstraint | undefined): boolean {
		return this.shaped(name, constraint).builder.hasLimitOrOffset;
	}

	protected shaped(name: string, constraint: EagerConstraint | undefined): ModelQuery<R> {
		return this.scope(
			ModelQuery.forLoad(
				this.relatedClass(),
				this.matching.relatedColumns,
				constraint,
				name,
			),
		);
	}

	classes(): readonly ModelClass<any>[] {
		return [this.relatedClass()];
	}

	others(name: string, constraint: EagerConstraint | undefined): readonly Decider[] {
		return this.shaped(name, constraint).builder.conditions.others() as Decider[];
	}

	version(name: string, constraint?: EagerConstraint): number {
		return LiveRelation.of(this, name, constraint).version();
	}

	existence(name: string, constraint?: EagerConstraint): Existence {
		const { parentColumns, relatedColumns } = this.matching;
		const parent = this.parentClass.table.name;
		const related = this.relatedClass().table.name;
		if (parent === related) {
			throw new OrmError(
				`[orm] '${name}' relates ${this.parentClass.name} to itself, which whereHas ` +
					'cannot ask about: both sides would be read as the same row.',
			);
		}

		const shaped = this.shaped(name, constraint).builder;
		const filter = shaped.filterColumns();
		return {
			subquery: KeyedRelation.correlated(
				shaped,
				related,
				relatedColumns,
				parent,
				parentColumns,
			),
			columns: parentColumns,
			others: [
				{
					modelClass: this.relatedClass(),
					columns: filter === null ? null : [...relatedColumns, ...filter],
				},
				...(shaped.conditions.others() as Decider[]),
			],
		};
	}

	protected static correlated(
		builder: SelectBuilder,
		inner: string,
		innerColumns: readonly string[],
		outer: string,
		outerColumns: readonly string[],
	): SelectBuilder {
		const writer = new SqlWriter();
		const pairs = innerColumns.map(
			(column, index) =>
				`${writer.identifier(`${inner}.${column}`)} = ` +
				writer.identifier(`${outer}.${outerColumns[index]}`),
		);
		return builder
			.selectNothing()
			.distinct(false)
			.selectRaw('1')
			.unordered()
			.limit(null)
			.offset(null)
			.whereRaw(pairs.join(' AND '));
	}

	memberKey(parent: Model): string | null {
		return this.keyOf(parent)?.signature ?? null;
	}

	reach(entry: Entry): Reach {
		const { relatedColumns } = this.matching;
		const { table } = this.relatedClass();
		const changes = entry.changes as Record<string, { from: unknown } | undefined>;
		const now = KeyedRelation.valuesOf(entry.model, relatedColumns);
		const keys = [table.signature(relatedColumns, now)];
		if (entry.kind === 'updated' && relatedColumns.some(column => changes[column])) {
			keys.push(
				table.signature(
					relatedColumns,
					relatedColumns.map((column, index) =>
						changes[column] ? changes[column].from : now[index],
					),
				),
			);
		}
		return {
			keys: [...new Set(keys.filter((key): key is string => key !== null))],
			asks: false,
		};
	}

	/** How `parent`'s value asks for its rows again, loading this one parent as it was loaded. */
	sourceFor(parent: Model, name: string, constraint?: EagerConstraint): Source<R> {
		const { many } = this.matching;
		return LiveRelation.of(this, name, constraint).sourceFor(parent, {
			unique: !many && this.keyedByPrimary,
			matches: constraint || many
				? undefined
				: row => this.accepts(row) && this.sameKey(parent, row),
		});
	}

	/** The related rows are found by their primary key: at most one row can match. */
	private get keyedByPrimary(): boolean {
		const { relatedColumns } = this.matching;
		const primary = this.relatedClass().table.primaryKey.columns;
		return (
			relatedColumns.length === primary.length &&
			relatedColumns.every((column, index) => column === primary[index])
		);
	}

	/** The row in the identity map `parent` points at; undefined when the map cannot say. */
	fromMap(parent: Model, constraint?: EagerConstraint): R | null | undefined {
		const related = this.relatedClass();
		if (constraint || this.matching.many || !this.keyedByPrimary) return undefined;

		const wanted = this.keyOf(parent);
		if (wanted === null) return null;
		const held = IdentityMap.of(related.database).get(related, wanted.signature);
		return held && this.accepts(held) ? held : undefined;
	}

	private sameKey(parent: Model, row: R): boolean {
		const wanted = this.keyOf(parent);
		if (wanted === null) return false;
		const { relatedColumns } = this.matching;
		const signature = this.relatedClass().table.signature(
			relatedColumns,
			KeyedRelation.valuesOf(row, relatedColumns),
		);
		return signature === wanted.signature;
	}

	/** `parent`'s key as the related side stores and signs it; null when unset. */
	private keyOf(parent: Model): { signature: string; translated: unknown[] } | null {
		const { parentColumns, relatedColumns } = this.matching;
		const values = KeyedRelation.valuesOf(parent, parentColumns);
		if (this.parentClass.table.signature(parentColumns, values) === null) return null;

		// Signed as the related side stores it, which is how the rows found are signed.
		const translated = this.translate(parentColumns, relatedColumns, values);
		const signature = this.relatedClass().table.signature(relatedColumns, translated);
		return signature === null ? null : { signature, translated };
	}

	/** Resolved at first use, once every model module has loaded. */
	relatedClass(): ModelClass<R> {
		this.resolved ??= KeyedRelation.resolve(this.related) as ModelClass<R>;
		return this.resolved;
	}

	static resolve<M extends Model>(
		related: Related<ModelRef<M>>,
	): ModelRef<M> {
		return 'table' in related ? related : related();
	}

	protected static columns(columns: KeyColumns): readonly string[] {
		return typeof columns === 'string' ? [columns] : columns;
	}

	protected assertPaired(
		first: readonly string[],
		second: readonly string[],
	): void {
		if (first.length !== second.length) {
			throw new OrmError(
				`[orm] A relation of ${this.parentClass.name} pairs ${first.join(', ')} ` +
					`with ${second.join(', ')}; both sides need the same number of columns.`,
			);
		}
	}

	protected static valuesOf(
		model: Model,
		columns: readonly string[],
	): unknown[] {
		return columns.map(column => model.$attributes.get(column));
	}

	/** Keys are compared as each side stores them. */
	async eagerLoad(
		parents: readonly Model[],
		name: string,
		deliver: Deliver,
		constraint?: EagerConstraint,
		tx?: Transaction,
	): Promise<void> {
		const { relatedColumns, many } = this.matching;
		const related = this.relatedClass();

		// Taken once: a key assigned while the load runs must not change who gets the rows.
		const signatures = new Map<Model, string | null>();
		const wanted = new Map<string, unknown[]>();
		for (const parent of parents) {
			const key = this.keyOf(parent);
			signatures.set(parent, key?.signature ?? null);
			if (key) wanted.set(key.signature, key.translated);
		}

		const rows = await this.scope(
			ModelQuery.forLoad(related, relatedColumns, constraint, name),
		).getForKeys(relatedColumns, [...wanted.values()], tx);

		const found = new KeyIndex<R>();
		for (const row of rows) {
			const signature = related.table.signature(
				relatedColumns,
				KeyedRelation.valuesOf(row, relatedColumns),
			);
			if (signature !== null) found.add(signature, row);
		}

		for (const parent of parents) {
			const rows = found.get(signatures.get(parent) ?? null);
			// Copied: two parents on one key would otherwise share the list.
			deliver(parent, many ? [...(rows ?? [])] : (rows?.[0] ?? null));
		}
	}

	/**
	 * @internal Through the stored form, since the two sides may declare different codecs;
	 * a form the related codec cannot read, as an ISO date cannot read unix seconds, goes as it is.
	 */
	translate(
		parentColumns: readonly string[],
		relatedColumns: readonly string[],
		values: readonly unknown[],
	): unknown[] {
		const parentTable = this.parentClass.table;
		const related = this.relatedClass().table;

		return parentColumns.map((name, index) => {
			const stored = Column.asStored(
				parentTable.column(name).encode(values[index]),
			);
			try {
				return related.column(relatedColumns[index]!).decode(stored);
			} catch {
				return values[index];
			}
		});
	}
}

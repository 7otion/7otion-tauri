import type { Row, Value } from '../database/statement';
import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Model } from '../model/model';
import type { ModelClass, ModelRef } from '../model/types';
import type { Decider } from '../query/collection.svelte';
import type { Entry } from '../query/live';
import { ModelQuery } from '../query/model-query';
import { Chunks } from '../sql/chunks';
import { SelectBuilder } from '../sql/select';
import { KeyIndex } from './key-index';
import { KeyedRelation, type Matching, type Related } from './keyed-relation';
import type { Reach } from './live-relation';
import type { Deliver, EagerConstraint, Existence } from './relation';

export interface BelongsToManyKeys {
	pivot: string | Related<ModelRef<any>>;
	/** Pivot column holding this model's key. */
	foreignPivotKey: string;
	/** Pivot column holding the related model's key. */
	relatedPivotKey: string;
	/** On this model. Defaults to its primary key. */
	parentKey?: string;
	/** On the related model. Defaults to its primary key. */
	relatedKey?: string;
}

/** Each side is matched on one column. */
export class BelongsToMany<R extends Model, RC = unknown> extends KeyedRelation<
	R,
	RC
> {
	constructor(
		parentClass: ModelRef<any>,
		related: Related<ModelRef<R>>,
		private readonly keys: BelongsToManyKeys,
	) {
		super(parentClass, related);
	}

	ownerColumns(): readonly string[] {
		return [this.parentKey];
	}

	protected get matching(): Matching {
		return {
			parentColumns: [this.parentKey],
			relatedColumns: [this.relatedKey],
			many: true,
		};
	}

	private pivotClass(): ModelClass<any> | null {
		const { pivot } = this.keys;
		return typeof pivot === 'string'
			? null
			: (KeyedRelation.resolve(pivot) as ModelClass<any>);
	}

	private get pivotTable(): string {
		const { pivot } = this.keys;
		return typeof pivot === 'string' ? pivot : this.pivotClass()!.table.name;
	}

	override classes(): readonly ModelClass<any>[] {
		const pivot = this.pivotClass();
		return pivot ? [this.relatedClass(), pivot] : [this.relatedClass()];
	}

	override existence(name: string, constraint?: EagerConstraint): Existence {
		const { foreignPivotKey, relatedPivotKey } = this.keys;
		const related = this.relatedClass();
		const pivot = this.pivotTable;
		const pivotClass = this.pivotClass();
		const shaped = this.shaped(name, constraint).builder;
		const filter = shaped.filterColumns();
		const others: Decider[] = [
			{
				modelClass: related,
				columns: filter === null ? null : [this.relatedKey, ...filter],
			},
			...(shaped.conditions.others() as Decider[]),
		];
		if (pivotClass) {
			others.push({
				modelClass: pivotClass,
				columns: [foreignPivotKey, relatedPivotKey],
			});
		}

		const linked = KeyedRelation.correlated(
			shaped,
			related.table.name,
			[this.relatedKey],
			pivot,
			[relatedPivotKey],
		);
		const links = KeyedRelation.correlated(
			SelectBuilder.from(pivot),
			pivot,
			[foreignPivotKey],
			this.parentClass.table.name,
			[this.parentKey],
		);
		return {
			subquery: links.matching(
				links.conditions.exists('and', false, linked, [relatedPivotKey], []),
			),
			columns: [this.parentKey],
			others,
		};
	}

	override memberKey(parent: Model): string | null {
		const table = this.parentClass.table;
		return table.storedSignature(
			[this.parentKey],
			[table.column(this.parentKey).encode(parent.$attributes.get(this.parentKey))],
		);
	}

	override reach(entry: Entry): Reach {
		const pivot = this.pivotClass();
		if (!pivot || entry.model.constructor !== pivot) {
			return { keys: entry.kind === 'created' ? [] : null, asks: false };
		}

		const { foreignPivotKey, relatedPivotKey } = this.keys;
		const changes = entry.changes as Record<string, { from: unknown } | undefined>;
		if (
			entry.kind === 'updated' &&
			!changes[foreignPivotKey] &&
			!changes[relatedPivotKey]
		) {
			return { keys: [], asks: true };
		}

		const linked = [entry.model.$attributes.get(foreignPivotKey)];
		if (entry.kind === 'updated' && changes[foreignPivotKey]) {
			linked.push(changes[foreignPivotKey].from);
		}
		const keys = linked.map(value =>
			this.parentClass.table.storedSignature(
				[this.parentKey],
				[pivot.table.column(foreignPivotKey).encode(value)],
			),
		);
		return {
			keys: [...new Set(keys.filter((key): key is string => key !== null))],
			asks: true,
		};
	}

	/** The pivot holds both keys as stored, so that is the form they are compared in. */
	override async eagerLoad(
		parents: readonly Model[],
		name: string,
		deliver: Deliver,
		constraint?: EagerConstraint,
		tx?: Transaction,
	): Promise<void> {
		const { foreignPivotKey, relatedPivotKey } = this.keys;
		const parentTable = this.parentClass.table;
		const relatedTable = this.relatedClass().table;

		// Taken once: a key assigned while the load runs must not change who gets the rows.
		const stored = new Map(
			parents.map(parent => [
				parent,
				parentTable
					.column(this.parentKey)
					.encode(parent.$attributes.get(this.parentKey)),
			]),
		);

		const links = await this.links(
			[...stored.values()].filter(value => value !== null),
			tx,
		);

		const parentsOf = new KeyIndex<string>();
		for (const link of links) {
			// The pivot has no model; its keys compare as the columns they point at.
			const relatedKey = relatedTable.storedSignature(
				[this.relatedKey],
				[link[relatedPivotKey]],
			);
			const parentKey = parentTable.storedSignature(
				[this.parentKey],
				[link[foreignPivotKey]],
			);
			if (relatedKey !== null && parentKey !== null) {
				parentsOf.add(relatedKey, parentKey);
			}
		}

		// Filled in the order the related query returns, so its ORDER BY is kept.
		const byParent = new KeyIndex<R>();
		for (const row of await this.relatedRows(links, constraint, name, tx)) {
			const relatedKey = relatedTable.signature(
				[this.relatedKey],
				[row.$attributes.get(this.relatedKey)],
			);
			// Each once, even where the pivot links a pair twice.
			for (const parentKey of new Set(parentsOf.get(relatedKey))) {
				byParent.add(parentKey, row);
			}
		}

		for (const parent of parents) {
			deliver(parent, [
				...(byParent.get(
					parentTable.storedSignature(
						[this.parentKey],
						[stored.get(parent)],
					),
				) ?? []),
			]);
		}
	}

	private async links(
		parentKeys: readonly Value[],
		tx: Transaction | undefined,
	): Promise<Row[]> {
		const { foreignPivotKey, relatedPivotKey } = this.keys;
		const pivot = this.pivotTable;
		const links: Row[] = [];

		for (const chunk of Chunks.of([...new Set(parentKeys)], 1)) {
			links.push(
				...(
					await this.parentClass.database.run(
						SelectBuilder.from(pivot)
							.select(foreignPivotKey, relatedPivotKey)
							.whereIn(foreignPivotKey, chunk),
						tx,
					)
				).rows,
			);
		}
		return links;
	}

	private async relatedRows(
		links: readonly Row[],
		constraint: EagerConstraint | undefined,
		name: string,
		tx: Transaction | undefined,
	): Promise<R[]> {
		const related = this.relatedClass();
		const { relatedPivotKey } = this.keys;

		const keys = [
			...new Set(
				links
					.map(link => link[relatedPivotKey] ?? null)
					.filter(value => value !== null),
			),
		].map(stored => [related.table.column(this.relatedKey).decode(stored)]);

		return ModelQuery.forLoad(
			related,
			[this.relatedKey],
			constraint,
			name,
		).getForKeys([this.relatedKey], keys, tx);
	}

	private get parentKey(): string {
		return (
			this.keys.parentKey ??
			BelongsToMany.singleKey(this.parentClass, 'parentKey')
		);
	}

	private get relatedKey(): string {
		return (
			this.keys.relatedKey ??
			BelongsToMany.singleKey(this.relatedClass(), 'relatedKey')
		);
	}

	private static singleKey(
		modelClass: ModelRef<any>,
		option: string,
	): string {
		const { primaryKey } = modelClass.table;
		if (primaryKey.isComposite) {
			throw new OrmError(
				`[orm] ${modelClass.name} has a composite key, and a pivot matches one ` +
					`column per side. Name it with ${option}.`,
			);
		}
		return primaryKey.columns[0]!;
	}
}

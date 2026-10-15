import type {
	Row,
	Statement,
	StatementSource,
	StoredValue,
	Value,
} from '../database/statement';
import type { Transaction } from '../database/transaction';
import { ModelNotFoundError, OrmError, QueryError } from '../errors';
import { Attributes } from '../model/attributes';
import type { Model } from '../model/model';
import type {
	ColumnKey,
	ColumnRef,
	ColumnsOf,
	ModelClass,
	NumericKey,
	UpdatePatch,
} from '../model/types';
import type {
	ModelAtPath,
	RelationPath,
	RelationsAtPath,
} from '../relations/paths';
import type { EagerConstraint } from '../relations/relation';
import type { Table } from '../schema/table';
import { Chunks } from '../sql/chunks';
import { Conditions, type CompareOperator } from '../sql/conditions';
import {
	SelectBuilder,
	type AggregateFunction,
	type Direction,
} from '../sql/select';
import { QueryWriter } from '../write/query-writer';
import { Collection, LiveCollection, type Decider } from './collection.svelte';
import { EagerLoader, type EagerPaths } from './eager-loader';
import { Hydrator } from './hydrator';
import { LiveRegistry } from './live';
import { LiveValue } from './live-value';
import { ModelConditions, ModelFilter, type ModelGroup } from './model-filter';

export type EagerConstraints<R> = {
	[K in RelationPath<R>]?: (
		query: ModelQuery<ModelAtPath<R, K> & Model, RelationsAtPath<R, K>>,
	) => ModelQuery<any, any>;
};

export type HasConstraint<R, K extends string> = (
	query: ModelQuery<ModelAtPath<R, K> & Model, RelationsAtPath<R, K>>,
) => ModelQuery<any, any>;

/** Immutable: every method returns a new query, so a base query can branch. */
export class ModelQuery<M extends Model, R = any>
	extends ModelFilter<M>
	implements StatementSource
{
	/** @internal A query starts from `Model.query()`. */
	constructor(
		/** @internal */
		readonly modelClass: ModelClass<M>,
		/** @internal */
		readonly builder: SelectBuilder,
		private readonly eager: EagerPaths,
		/** @internal Inherited by every query derived from this one, never read afresh. */
		readonly generation: number,
	) {
		super();
	}

	/** @internal The constraint is grouped, so an OR in it cannot escape the keys. */
	static forLoad<M extends Model>(
		modelClass: ModelClass<M>,
		keyColumns: readonly string[],
		constraint: EagerConstraint | undefined,
		relation: string,
	): ModelQuery<M> {
		const base = modelClass.query();
		const shaped: unknown = constraint ? constraint(base) : base;
		if (!(shaped instanceof ModelQuery)) {
			throw new OrmError(
				`[orm] The constraint on '${relation}' returned ${shaped === undefined ? 'nothing' : 'something other than a query'}. ` +
					'A query is immutable, so the callback returns the one it built: query => query.where(…).',
			);
		}
		return (shaped as ModelQuery<M>).grouped().including(keyColumns);
	}

	/** @internal */
	async getForKeys(
		columns: readonly string[],
		keys: readonly (readonly unknown[])[],
		tx?: Transaction,
	): Promise<M[]> {
		const carried = this.toStatement().params.length;
		const models: M[] = [];
		for (const chunk of Chunks.of(keys, columns.length, carried)) {
			models.push(...(await this.whereAnyOf(columns, chunk).getArray(tx)));
		}
		return models;
	}

	toStatement(): Statement {
		return this.builder.toStatement();
	}

	// shape

	/** Adds to what is already selected. */
	select(...columns: ColumnRef<M>[]): this {
		return this.withBuilder(
			this.builder.select(
				...columns.map(column => this.ofThisTable(column)),
			),
		);
	}

	selectRaw(sql: string, params: readonly Value[] = []): this {
		return this.withBuilder(this.builder.selectRaw(sql, params));
	}

	distinct(): this {
		return this.withBuilder(this.builder.distinct());
	}

	join(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.withBuilder(
			this.builder.join(table, left, operator, right),
		);
	}

	leftJoin(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.withBuilder(
			this.builder.leftJoin(table, left, operator, right),
		);
	}

	rightJoin(
		table: string,
		left: string,
		operator: CompareOperator,
		right: string,
	): this {
		return this.withBuilder(
			this.builder.rightJoin(table, left, operator, right),
		);
	}

	groupBy(...columns: ColumnRef<M>[]): this {
		return this.withBuilder(this.builder.groupBy(...columns));
	}

	having(group: ModelGroup<M>): this {
		return this.withBuilder(
			this.builder.having(
				conditions =>
					group(new ModelConditions<M>(this.table, conditions))
						.untyped,
			),
		);
	}

	havingRaw(sql: string, params: readonly Value[] = []): this {
		return this.withBuilder(this.builder.havingRaw(sql, params));
	}

	orderBy(column: ColumnRef<M>, direction: Direction = 'asc'): this {
		return this.withBuilder(this.builder.orderBy(column, direction));
	}

	orderByRaw(sql: string, params: readonly Value[] = []): this {
		return this.withBuilder(this.builder.orderByRaw(sql, params));
	}

	limit(limit: number | null): this {
		return this.withBuilder(this.builder.limit(limit));
	}

	offset(offset: number | null): this {
		return this.withBuilder(this.builder.offset(offset));
	}

	with(
		// An object, so a stray name is not taken for an empty set of constraints.
		...relations: (RelationPath<R> | (EagerConstraints<R> & object))[]
	): this {
		const eager = new Map(this.eager);

		for (const relation of relations) {
			if (Array.isArray(relation)) {
				throw new QueryError(
					'[orm] with() takes relation names, not an array of them: spread it, as in with(...names).',
				);
			}
			if (typeof relation === 'string') {
				// A bare path keeps a constraint given for it earlier.
				eager.set(relation, eager.get(relation));
				continue;
			}
			for (const [path, constraint] of Object.entries(relation) as [
				string,
				EagerConstraint | undefined,
			][]) {
				eager.set(path, constraint ?? eager.get(path));
			}
		}

		return new ModelQuery<M, R>(
			this.modelClass,
			this.builder,
			eager,
			this.generation,
		) as this;
	}

	whereHas<K extends RelationPath<R>>(relation: K, constraint?: HasConstraint<R, K>): this {
		return this.has('and', false, relation, constraint);
	}

	orWhereHas<K extends RelationPath<R>>(relation: K, constraint?: HasConstraint<R, K>): this {
		return this.has('or', false, relation, constraint);
	}

	whereDoesntHave<K extends RelationPath<R>>(
		relation: K,
		constraint?: HasConstraint<R, K>,
	): this {
		return this.has('and', true, relation, constraint);
	}

	orWhereDoesntHave<K extends RelationPath<R>>(
		relation: K,
		constraint?: HasConstraint<R, K>,
	): this {
		return this.has('or', true, relation, constraint);
	}

	private has(
		connector: 'and' | 'or',
		negated: boolean,
		path: string,
		constraint: EagerConstraint | undefined,
	): this {
		const [name, ...rest] = path.split('.') as [string, ...string[]];
		const relation = this.modelClass.$relation(name);
		if (!relation.existence) {
			throw new OrmError(
				`[orm] '${name}' is polymorphic, so ${this.modelClass.name} cannot be asked ` +
					'whether it has one: there is no single related table to look in.',
			);
		}

		const beneath = rest.join('.');
		const inner: EagerConstraint | undefined =
			rest.length === 0 ? constraint : query => query.whereHas(beneath, constraint);
		const { subquery, columns, others } = relation.existence(name, inner);
		return this.withConditions(
			this.conditions.exists(connector, negated, subquery, columns, others),
		);
	}

	// reads

	/**
	 * The matching rows as a collection that stays correct after every commit. Read under a
	 * transaction, the collection is a plain snapshot: what it holds may never be committed.
	 */
	async get(tx?: Transaction): Promise<Collection<M>> {
		if (tx) return new Collection(await this.getArray(tx));

		// Read and registered between two commits, so none lands unseen in between.
		return LiveRegistry.of(this.modelClass.database).turn(
			async () =>
				new LiveCollection<M>(
					{
						modelClass: this.modelClass,
						fetch: () => this.getArray(undefined, true),
						decidingColumns: this.builder.decidingColumns(),
						also: this.also(),
						bounded: this.builder.hasLimitOrOffset,
					},
					await this.getArray(),
				),
		);
	}

	async liveCount(): Promise<LiveValue<number>> {
		return LiveRegistry.of(this.modelClass.database).turn(
			async () =>
				new LiveValue<number>(
					{
						modelClass: this.modelClass,
						fetch: () => this.count(),
						decidingColumns: this.builder.filterColumns(),
						also: this.also(),
					},
					await this.count(),
				),
		);
	}

	private also(): Decider[] {
		return this.builder.conditions.others() as Decider[];
	}

	/** @internal The matching rows as a plain array that does not follow the database, for the ORM's own reads. */
	async getArray(tx?: Transaction, keepLoaded = false): Promise<M[]> {
		this.assertUngrouped('get');

		const began = Attributes.now();
		const rows = await this.run(this.rowsOfModel(), tx);
		const hydrator = new Hydrator(this.modelClass, this.generation, tx, began);
		const models = rows.map(row => hydrator.hydrate(row));

		await new EagerLoader(this.eager, tx, keepLoaded).load(models, this.modelClass);
		return models;
	}

	async toArray(tx?: Transaction): Promise<M[]> {
		return this.getArray(tx);
	}

	async first(tx?: Transaction): Promise<M | null> {
		const [first] = await this.atMostOne().getArray(tx);
		return first ?? null;
	}

	async firstOrFail(tx?: Transaction): Promise<M> {
		const found = await this.first(tx);
		if (found === null) {
			throw new ModelNotFoundError(
				this.modelClass.name,
				'matches the query',
			);
		}
		return found;
	}

	/** A row is keyed by column name, so of two columns sharing one the last is kept. */
	async rows<T = Row>(tx?: Transaction): Promise<T[]> {
		return (await this.run(this.builder, tx)) as unknown as T[];
	}

	async exists(tx?: Transaction): Promise<boolean> {
		// The selection stays: a HAVING may name one of its aliases.
		const selected = this.builder.hasSelection
			? this.builder
			: this.builder.selectRaw('1');
		const rows = await this.run(selected.unordered().atMost(1), tx);
		return rows.length > 0;
	}

	async count(tx?: Transaction): Promise<number> {
		return Number((await this.aggregate('count', '*', tx)) ?? 0);
	}

	/** Zero when nothing matches, as an empty sum is. */
	async sum(column: NumericKey<M>, tx?: Transaction): Promise<number> {
		return Number((await this.aggregate('sum', column, tx)) ?? 0);
	}

	async avg(column: NumericKey<M>, tx?: Transaction): Promise<number | null> {
		const value = await this.aggregate('avg', column, tx);
		return value === null ? null : Number(value);
	}

	/** Read as the column reads, so a date column returns a Date. */
	async min<K extends ColumnKey<M>>(
		column: K,
		tx?: Transaction,
	): Promise<ColumnsOf<M>[K] | null> {
		return this.table
			.column(column)
			.decode(await this.aggregate('min', column, tx)) as
			ColumnsOf<M>[K] | null;
	}

	async max<K extends ColumnKey<M>>(
		column: K,
		tx?: Transaction,
	): Promise<ColumnsOf<M>[K] | null> {
		return this.table
			.column(column)
			.decode(await this.aggregate('max', column, tx)) as
			ColumnsOf<M>[K] | null;
	}

	async pluck<K extends ColumnKey<M>>(
		column: K,
		tx?: Transaction,
	): Promise<ColumnsOf<M>[K][]> {
		// Added to the selection, which an ORDER BY or HAVING may name, rather than replacing it.
		const rows = await this.run(
			this.builder.hasSelection
				? this.including([column]).builder
				: this.builder.select(this.ofThisTable(column)),
			tx,
		);
		return rows.map(
			row => this.table.decode(row)[column] as ColumnsOf<M>[K],
		);
	}

	async value<K extends ColumnKey<M>>(
		column: K,
		tx?: Transaction,
	): Promise<ColumnsOf<M>[K] | null> {
		const [first] = await this.atMostOne().pluck(column, tx);
		return first ?? null;
	}

	/** Pages count from 1. The page is a live collection: a row that moves onto it appears. */
	async paginate(
		page = 1,
		perPage = 20,
		tx?: Transaction,
	): Promise<{ data: Collection<M>; total: number }> {
		for (const [name, value] of [
			['page', page],
			['perPage', perPage],
		] as const) {
			if (!Number.isInteger(value) || value < 1) {
				throw new QueryError(
					`[orm] paginate() takes a ${name} of 1 or more, got ${JSON.stringify(value)}.`,
				);
			}
		}
		if (this.builder.isDistinct) {
			throw new OrmError(
				'[orm] paginate() cannot count the rows of a distinct query. Page it with ' +
					'limit() and offset(), and count the distinct rows another way.',
			);
		}
		const total = await this.count(tx);
		const data = await this.limit(perPage)
			.offset((page - 1) * perPage)
			.get(tx);
		return { data, total };
	}

	// writes

	async update(patch: UpdatePatch<M>, tx?: Transaction): Promise<number> {
		this.assertCurrent();
		return new QueryWriter(this).update(patch, tx);
	}

	async delete(tx?: Transaction): Promise<number> {
		this.assertCurrent();
		return new QueryWriter(this).delete(tx);
	}

	// internals

	protected get table(): Table {
		return this.modelClass.table;
	}

	protected get conditions(): Conditions {
		return this.builder.conditions;
	}

	protected withConditions(conditions: Conditions): this {
		return this.withBuilder(this.builder.matching(conditions));
	}

	private withBuilder(builder: SelectBuilder): this {
		return new ModelQuery<M, R>(
			this.modelClass,
			builder,
			this.eager,
			this.generation,
		) as this;
	}

	/** @internal */
	grouped(): this {
		const { conditions } = this.builder;
		if (conditions.isEmpty) return this;
		return this.withConditions(Conditions.none.where(() => conditions));
	}

	/** @internal Adds nothing when no selection was made, since every column is read. */
	including(columns: readonly string[]): this {
		if (!this.builder.hasSelection) return this;

		const missing = columns
			.map(column => this.ofThisTable(column))
			.filter(column => !this.builder.selects(column));
		return missing.length === 0
			? this
			: this.withBuilder(this.builder.select(...missing));
	}

	/** @internal Also drops distinct and the relations to load. */
	withoutSelection(): this {
		return new ModelQuery<M, R>(
			this.modelClass,
			this.builder.selectNothing().distinct(false),
			new Map(),
			this.generation,
		) as this;
	}

	/** @internal */
	assertUngrouped(method: string): void {
		if (this.builder.isGrouped) {
			throw new OrmError(
				`[orm] ${method}() is unavailable on a grouped query, whose rows are not ` +
					`${this.modelClass.name} rows. Read them with rows().`,
			);
		}
	}

	private atMostOne(): this {
		return this.withBuilder(this.builder.atMost(1));
	}

	private async run(
		statement: StatementSource,
		tx?: Transaction,
	): Promise<Row[]> {
		this.assertCurrent();
		return (await this.modelClass.database.run(statement, tx)).rows;
	}

	private assertCurrent(): void {
		if (this.generation === this.modelClass.$generation) return;
		throw new OrmError(
			`[orm] This ${this.modelClass.name} query was built against a database that is ` +
				'no longer connected, so running it now would reach the one that is. ' +
				'Build it again from the database in use.',
		);
	}

	/** Written with the table's name, so a join, added before or after, cannot make it ambiguous. */
	private ofThisTable(column: string): string {
		return this.table.qualified(column);
	}

	/** With a join and no chosen columns, only this table's columns make a model. */
	private rowsOfModel(): SelectBuilder {
		return this.builder.hasSelection || !this.builder.hasJoins
			? this.builder
			: this.builder.select(`${this.table.name}.*`);
	}

	/** Order, limit and offset do not apply to an aggregate. */
	private async aggregate(
		fn: AggregateFunction,
		column: string,
		tx?: Transaction,
	): Promise<StoredValue> {
		this.assertUngrouped(fn);
		if (this.builder.isDistinct) {
			throw new OrmError(
				`[orm] ${fn}() is unavailable on a distinct query: it would aggregate every ` +
					'row, not the distinct ones. Read them with rows() and aggregate those.',
			);
		}

		const rows = await this.run(
			this.builder
				.selectNothing()
				.selectAggregate(fn, this.ofThisTable(column), 'aggregate')
				.unordered()
				.limit(null)
				.offset(null),
			tx,
		);
		return rows[0]?.aggregate ?? null;
	}
}

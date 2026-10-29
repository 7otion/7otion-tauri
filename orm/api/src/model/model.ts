import type { Database } from '../database/database';
import { Transaction } from '../database/transaction';
import { ModelNotFoundError, OrmError } from '../errors';
import { ModelSignals } from './signals';
import {
	EventRegistry,
	IN_WRITE,
	INSERT_VERBS,
	type EventHandler,
	type ModelEvent,
	type ModelEvents,
} from '../events/events';
import type { Collection } from '../query/collection.svelte';
import { ModelQuery } from '../query/model-query';
import { BelongsTo, type BelongsToKeys } from '../relations/belongs-to';
import {
	BelongsToMany,
	type BelongsToManyKeys,
} from '../relations/belongs-to-many';
import {
	HasMany,
	HasOne,
	MorphMany,
	type HasKeys,
	type MorphManyKeys,
} from '../relations/has';
import type { Related } from '../relations/keyed-relation';
import { MorphTo, type MorphToKeys } from '../relations/morph-to';
import type { AnyRelations } from '../relations/paths';
import type { AnyRelation } from '../relations/relation';
import type { Column } from '../schema/column';
import { Table, type TableDefinition } from '../schema/table';
import { SelectBuilder } from '../sql/select';
import { ModelDelete } from '../write/model-delete';
import {
	ModelInsert,
	type InsertOrIgnoreOptions,
} from '../write/model-insert';
import { ModelUpdate } from '../write/model-update';
import {
	RelationWriter,
	type RelationMember,
	type SyncOptions,
	type SyncResult,
} from '../write/relation-writer';
import { RowFinder } from '../write/row-finder';
import { WriteLifecycle } from '../write/write-lifecycle';
import { Accessors } from './accessors';
import { Attributes, type Checkpoint } from './attributes';
import { Drafts } from './draft';
import { IdentityMap } from './identity-map';
import { LoadedRelations } from '../relations/loaded-relations';
import type {
	Changes,
	ColumnKey,
	Draft,
	HeadOf,
	PrimaryKeyOf,
	LoadPath,
	ModelClass,
	ModelRef,
	ModelSchema,
	Mutators,
	Patch,
	RelatedOf,
	SchemaInstance,
	TimestampsOption,
	ToManyKey,
} from './types';

abstract class BaseModel {
	/** @internal */
	static $default: Database | null = null;

	/** @internal Counts `Model.connect` calls; an instance or query made under an earlier count is stale. */
	static $generation = 0;

	/**
	 * Gives every model `database`. Models and queries made before are refused from now on, and
	 * what lived with the database connected before ends.
	 */
	static connect(database: Database): void {
		this.assertEveryModel('connect(database)');
		BaseModel.switchTo(database);
	}

	/** Closes the database the models are connected to, and leaves them with none. */
	static async disconnect(): Promise<void> {
		this.assertEveryModel('disconnect()');
		const database = BaseModel.$default;
		BaseModel.switchTo(null);
		await database?.close();
	}

	private static assertEveryModel(call: string): void {
		if (this === BaseModel) return;
		throw new OrmError(
			`[orm] ${this.name}.${call} would act on every model: all of them share one ` +
				`database. Call Model.${call}.`,
		);
	}

	private static switchTo(database: Database | null): void {
		const previous = BaseModel.$default;
		if (previous === database) return;
		BaseModel.$default = database;
		BaseModel.$generation++;
		previous?.left();
	}

	declare static readonly schema?: ModelSchema;

	static relations: {} = {};

	private static readonly eventRegistries = new WeakMap<object, EventRegistry>();
	declare static readonly events?: ModelEvents<any>;

	declare static readonly mutators?: Mutators<any>;

	/** New models whose INSERT `save()` is running, and a promise that settles when it is done. */
	private static readonly inserting = new WeakMap<Model, Promise<void>>();

	// declaring

	static define<
		const C extends Record<string, Column<any, boolean>>,
		const T extends TimestampsOption = false,
	>(definition: TableDefinition<C> & { timestamps?: T }): ModelSchema<C, T> {
		for (const column of Object.keys(definition.columns)) {
			Accessors.assertFree(
				column,
				BaseModel.prototype,
				`Table ${definition.table}`,
			);
		}
		const table = new Table(definition);

		if (this === BaseModel) {
			throw new OrmError(
				`[orm] Table ${definition.table} is defined on Model itself. Define it inside ` +
					'its model class: static readonly schema = this.define({ … }).',
			);
		}
		Accessors.columns(this as unknown as ModelRef, table);
		Object.defineProperty(this, 'table', { value: table });
		return definition;
	}

	/** Mutators typed by this class's columns: `static readonly mutators = this.mutate({ … })`. */
	static mutate<M extends Model>(
		this: abstract new () => M,
		mutators: Mutators<M>,
	): Mutators<M> {
		return mutators;
	}

	/** Set on the class by `define`; a subclass of a model shares its parent's. */
	static get table(): Table {
		throw new OrmError(
			`[orm] ${this.name} has no schema. Declare static readonly schema = ` +
				'this.define({ table, columns }), before its other statics.',
		);
	}

	static get database(): Database {
		const database = BaseModel.$default;
		if (!database) {
			throw new OrmError(
				`[orm] ${this.name} has no database. Call Model.connect(database) first.`,
			);
		}
		return database;
	}

	/** @internal */
	static get $events(): EventRegistry {
		let events = BaseModel.eventRegistries.get(this);
		if (!events) {
			events = new EventRegistry(this);
			BaseModel.eventRegistries.set(this, events);
		}
		return events;
	}

	/** @internal The relation this class declares as `name`. Own keys only, so `toString` is not a relation. */
	static $relation(name: string): AnyRelation {
		const relations = this.relations as Readonly<Record<string, AnyRelation>>;
		if (!Object.hasOwn(relations, name)) {
			throw new OrmError(`[orm] ${this.name} declares no relation named '${name}'.`);
		}
		return relations[name]!;
	}

	// reading

	static query<M extends Model, R = AnyRelations>(
		this: ModelClass<M> & { readonly relations: R },
	): ModelQuery<M, R> {
		return new ModelQuery<M, R>(
			this,
			SelectBuilder.from(this.table.name),
			new Map(),
			this.$generation,
		);
	}

	/** A composite key takes its values as an array, in declaration order. */
	static async find<M extends Model>(
		this: ModelClass<M>,
		primaryKey: PrimaryKeyOf<M>,
		tx?: Transaction,
	): Promise<M | null> {
		return this.query().whereKey(primaryKey).first(tx);
	}

	static async findOrFail<M extends Model>(
		this: ModelClass<M>,
		primaryKey: PrimaryKeyOf<M>,
		tx?: Transaction,
	): Promise<M> {
		const found = await this.query().whereKey(primaryKey).first(tx);
		if (found !== null) return found;

		const values = Array.isArray(primaryKey) ? primaryKey : [primaryKey];
		const detail = this.table.primaryKey.columns
			.map((column, i) => `${column} = ${JSON.stringify(values[i])}`)
			.join(', ');
		throw new ModelNotFoundError(this.name, `with ${detail}`);
	}

	static all<M extends Model>(
		this: ModelClass<M>,
		tx?: Transaction,
	): Promise<Collection<M>> {
		return this.query().get(tx);
	}

	// writing

	static async create<M extends Model>(
		this: ModelClass<M>,
		data: NoInfer<Patch<M>>,
		tx?: Transaction,
	): Promise<M> {
		const model = new this();
		model.fill(data);
		await model.save(tx);
		return model;
	}

	/** Each returned model carries its key, in the order given. */
	static createMany<M extends Model>(
		this: ModelClass<M>,
		rows: readonly NoInfer<Patch<M>>[],
		tx?: Transaction,
	): Promise<M[]> {
		return new ModelInsert(this).write(
			rows.map(row => new this().fill(row)),
			tx,
		);
	}

	static createManyOrIgnore<M extends Model>(
		this: ModelClass<M>,
		rows: readonly NoInfer<Patch<M>>[],
		options: InsertOrIgnoreOptions<ColumnKey<M>> = {},
		tx?: Transaction,
	): Promise<M[]> {
		return new ModelInsert(this, options).write(
			rows.map(row => new this().fill(row)),
			tx,
		);
	}

	static updateMany<M extends Model>(
		this: ModelClass<M>,
		models: readonly M[],
		tx?: Transaction,
	): Promise<M[]> {
		// Every model given, the ones with nothing to write included.
		return new ModelUpdate(this).write(models, tx, () => [...models]);
	}

	static deleteMany<M extends Model>(
		this: ModelClass<M>,
		models: readonly M[],
		tx?: Transaction,
	): Promise<number> {
		return new ModelDelete(this).write(
			models,
			tx,
			removed => removed.length,
		);
	}

	static firstOrCreate<M extends Model>(
		this: ModelClass<M>,
		attributes: NoInfer<Patch<M>>,
		values: NoInfer<Patch<M>> = {} as Patch<M>,
		tx?: Transaction,
	): Promise<M> {
		return new RowFinder(this, attributes).firstOrCreate(values, tx);
	}

	static updateOrCreate<M extends Model>(
		this: ModelClass<M>,
		attributes: NoInfer<Patch<M>>,
		values: NoInfer<Patch<M>>,
		tx?: Transaction,
	): Promise<M> {
		return new RowFinder(this, attributes).updateOrCreate(values, tx);
	}

	/** Every instance with unsaved edits, of any model; what to ask before closing the database. */
	static unsaved(): Model[] {
		return IdentityMap.of(this.database).unsaved();
	}

	// events

	/**
	 * Replaces this class's handler for `event`; null removes it, and the one `events`
	 * declares applies again. On `Model` it runs for every model, before the model's own.
	 */
	static registerEvent<M extends Model, E extends ModelEvent>(
		this: abstract new () => M,
		event: E,
		handler: EventHandler<M, E> | null,
	): void {
		(this as unknown as typeof BaseModel).$events.register(
			event,
			handler as never,
		);
	}

	// relations

	static hasOne<RC extends ModelRef<any>>(
		related: Related<RC>,
		keys: HasKeys,
	): HasOne<InstanceType<RC>, RC> {
		return new HasOne(this as unknown as ModelRef, related, keys);
	}

	static hasMany<RC extends ModelRef<any>>(
		related: Related<RC>,
		keys: HasKeys,
	): HasMany<InstanceType<RC>, RC> {
		return new HasMany(this as unknown as ModelRef, related, keys);
	}

	static belongsTo<RC extends ModelRef<any>>(
		related: Related<RC>,
		keys: BelongsToKeys,
	): BelongsTo<InstanceType<RC>, RC> {
		return new BelongsTo(this as unknown as ModelRef, related, keys);
	}

	static belongsToMany<RC extends ModelRef<any>>(
		related: Related<RC>,
		keys: BelongsToManyKeys,
	): BelongsToMany<InstanceType<RC>, RC> {
		return new BelongsToMany(this as unknown as ModelRef, related, keys);
	}

	static morphMany<RC extends ModelRef<any>>(
		related: Related<RC>,
		keys: MorphManyKeys,
	): MorphMany<InstanceType<RC>, RC> {
		return new MorphMany(this as unknown as ModelRef, related, keys);
	}

	static morphTo<R extends Model = Model>(keys: MorphToKeys): MorphTo<R> {
		return new MorphTo<R>(this as unknown as ModelRef, keys);
	}

	// instances

	/** @internal */
	declare readonly $attributes: Attributes;

	/** @internal */
	declare readonly $relations: LoadedRelations;

	/** @internal */
	declare $exists: boolean;

	/** @internal The `Model.connect()` count this instance belongs to; a read sets its query's. */
	declare $generation: number;

	/** @internal The transaction this instance was read in, whose uncommitted rows it may show; null for a shared instance. */
	declare $scope: Transaction | null;

	/** @internal The draft, once asked for. */
	declare $draft: Model | null;

	/** @internal What a read of the row depends on. */
	declare readonly $signals: ModelSignals;

	constructor() {
		const modelClass = new.target as unknown as ModelClass;

		// Not enumerable, so an instance shows no own keys.
		Object.defineProperties(this, {
			$attributes: {
				value: new Attributes(modelClass.table, modelClass.name),
			},
			$relations: { value: new LoadedRelations(this) },
			$exists: { value: false, writable: true },
			$generation: { value: BaseModel.$generation, writable: true },
			$scope: { value: null, writable: true },
			$draft: { value: null, writable: true },
			$signals: {
				value: new ModelSignals(
					modelClass,
					modelClass.table.columns.keys(),
					Object.keys(modelClass.relations),
				),
			},
		});

		Accessors.prepare(modelClass, BaseModel.prototype);
	}

	get exists(): boolean {
		this.$signals.readExists();
		return this.$exists;
	}

	/** Whether the draft holds edits not yet saved. Depends on the edits and the row both: a save takes an edit without changing what the draft shows. */
	get isDirty(): boolean {
		this.$signals.readEdits();
		this.$signals.readRow();
		return this.$attributes.dirty().length > 0;
	}

	/**
	 * The row's one draft, shared by everyone editing it: reads show the pending values over
	 * the committed ones, and assignments record pending values. `save()` commits them.
	 */
	draft(): Draft<this> {
		return Drafts.of(this, BaseModel.prototype) as Draft<this>;
	}

	/** Drops pending edits: those columns, or every one. */
	discard(...columns: ColumnKey<this>[]): this {
		const before = this.$attributes.shownSnapshot();
		this.$attributes.discard(columns.length > 0 ? columns : undefined);
		this.$edited(this.$attributes.shownChangedSince(before));
		return this;
	}

	/** @internal Pins while dirty, and tells the columns the draft now shows differently. */
	$edited(columns: readonly string[]): void {
		this.$repin();
		if (columns.length > 0) this.$signals.edited(columns);
	}

	/** @internal A read found the row with other values than the model showed: `columns`, and the row itself when it was taken for gone. */
	$refreshed(values: Readonly<Record<string, unknown>>, tx?: Transaction, began?: number): void {
		const columns = this.$attributes.refreshed(values, tx, began);
		const found = !this.$exists;
		this.$exists = true;
		if (found) this.$signals.created();
		if (columns.length > 0) this.$signals.committed(columns);
	}

	/** @internal */
	$assertCurrent(): void {
		if (this.$generation === BaseModel.$generation) return;

		const { name } = this.constructor as unknown as ModelClass;
		throw new OrmError(
			`[orm] This ${name} was read from a database that is no longer connected, so it ` +
				'cannot be used with the one that is: its key names a row of the database it ' +
				'came from. Read it again from the database in use.',
		);
	}

	/** @internal Held by the map while it has unsaved edits, so a half-edited row is never collected. */
	$repin(): void {
		const database = BaseModel.$default;
		if (this.$scope || !database || this.$generation !== BaseModel.$generation) return;
		IdentityMap.of(database).pin(this, this.$attributes.dirty().length > 0);
	}

	/**
	 * @internal The model as it is now, to put back if a write fails or rolls back: its values
	 * and pending edits, whether it exists, and the key the identity map holds it under.
	 */
	$checkpoint(): Checkpoint {
		const values = this.$attributes.checkpoint();
		const existed = this.$exists;
		return {
			sending: () => values.sending(),
			restore: () => {
				const signature = this.$attributes.persistedKeySignature();
				const before = this.$attributes.shownSnapshot();
				values.restore();
				this.$exists = existed;
				IdentityMap.holding(this).moved(this, signature);
				this.$edited(this.$attributes.shownChangedSince(before));
				// The committed values a handle showed at once are back, with no commit to say so.
				const { table } = this.constructor as unknown as ModelClass;
				this.$signals.gone(table.columns.keys());
			},
		};
	}

	/** @internal A transaction's instance lives only inside it. */
	$assertReadable(): void {
		if (!this.$scope || this.$scope.isOpen) return;

		const { name } = this.constructor as unknown as ModelClass;
		throw new OrmError(
			`[orm] This ${name} was read inside a transaction that has ended, so it shows ` +
				'nothing now. Fetch it again, or hold the instance read outside the transaction.',
		);
	}

	/**
	 * @internal Refuses a model read before the last `Model.connect()`, one read in a
	 * transaction other than `tx`, and one whose class declares a field with a column's name.
	 */
	$assertWritable(tx?: Transaction): void {
		this.$assertCurrent();
		if (this.$scope && this.$scope !== tx) {
			const { name } = this.constructor as unknown as ModelClass;
			throw new OrmError(
				this.$scope.isOpen
					? `[orm] This ${name} was read inside a transaction, so it is written with that ` +
						"transaction's handle: save(tx), update(…, tx), delete(tx)."
					: `[orm] This ${name} was read inside a transaction that has ended, so it cannot ` +
						'be written. Read it again from the database.',
			);
		}
		Accessors.assertUnshadowed(this);
	}

	/** @internal Refuses a model that is not in the database, or was read without its key, which `action` needs to find its row. */
	$assertStored(action: 'update' | 'delete'): void {
		const { name, table } = this.constructor as unknown as ModelClass;
		if (!this.$exists) {
			throw new OrmError(
				`[orm] Cannot ${action} a ${name} that is not in the database.`,
			);
		}
		if (this.$attributes.persistedKeySignature() === null) {
			throw new OrmError(
				`[orm] Cannot ${action} a ${name} without its primary key; ` +
					`it was selected without ${table.primaryKey.columns.join(', ')}.`,
			);
		}
	}

	getDirty(): string[] {
		this.$signals.readEdits();
		this.$signals.readRow();
		return this.$attributes.dirty();
	}

	/** The draft's unsaved edits, each column from its committed value to its pending one. */
	getPending(): Changes<this> {
		this.$signals.readEdits();
		this.$signals.readRow();
		return this.$attributes.pendingChanges() as Changes<this>;
	}

	/** Stages `data` on the draft through the mutators; columns `fillable`/`guarded` refuse and timestamps are skipped. */
	fill(data: Patch<this>): this {
		const { table } = this.constructor as unknown as ModelClass;
		for (const [column, value] of Object.entries(data)) {
			if (value === undefined || !table.fillable(column)) continue;
			Accessors.assign(this, column, value);
		}
		return this;
	}

	/**
	 * Writes `patch` now through the mutators, past the draft, whose edits stay pending. On a
	 * row never saved, `patch` is filled in and the row inserted.
	 */
	async update(patch: Patch<this>, tx?: Transaction): Promise<this> {
		const modelClass = this.constructor as unknown as ModelClass<this>;
		if (!this.$exists) {
			for (const [column, value] of Object.entries(patch)) {
				if (value !== undefined) Accessors.assign(this, column, value);
			}
			return this.save(tx);
		}

		const staged = Drafts.staged(this, patch);
		const values = Object.fromEntries(
			Object.entries(staged).filter(
				([column, value]) =>
					!modelClass.table.column(column).storesAs(value, this.$attributes.get(column)),
			),
		);
		if (Object.keys(values).length > 0) {
			await new ModelUpdate(modelClass, { values: () => values }).write([this], tx);
		}
		return this;
	}

	/**
	 * Inserts the model when it is new, updates it otherwise. With `columns`, only those pending
	 * edits are saved and the rest stay pending.
	 */
	save(...columns: ColumnKey<this>[]): Promise<this>;
	save(tx: Transaction | undefined, ...columns: ColumnKey<this>[]): Promise<this>;
	async save(...args: (Transaction | ColumnKey<this> | undefined)[]): Promise<this> {
		const tx = args[0] instanceof Transaction ? args[0] : undefined;
		const columns = args.filter(
			(arg): arg is ColumnKey<this> => typeof arg === 'string',
		);

		this.$assertWritable(tx);
		const modelClass = this.constructor as unknown as ModelClass<this>;
		const only = columns.length > 0 ? columns : undefined;
		const update = (on?: Transaction) =>
			new ModelUpdate(modelClass, { only }).write([this], on, () => this);

		// A second save of a new model waits for the first's INSERT, then updates. Not with
		// `:before`/`:after` handlers, which may be where it was called from: it checks below instead.
		const running = BaseModel.inserting.get(this);
		if (running && !modelClass.$events.has(INSERT_VERBS, IN_WRITE)) {
			await running;
			return this.save(tx, ...columns);
		}
		if (this.$exists) return update(tx);

		let settle!: () => void;
		const inserting = new Promise<void>(resolve => (settle = resolve));
		BaseModel.inserting.set(this, inserting);

		// Releases a save waiting on this INSERT, before the `:committed` handlers, which may save it.
		const inserted = () => {
			if (BaseModel.inserting.get(this) === inserting) {
				BaseModel.inserting.delete(this);
			}
			settle();
		};

		return WriteLifecycle.around(
			modelClass,
			'created',
			{ tx, oneStatement: true },
			async lifecycle => {
				try {
					// A save that did not wait is inserted by the first one by now.
					if (this.$exists) return await update(lifecycle.tx);
					await new ModelInsert(modelClass).within(lifecycle, [this]);
					return this;
				} finally {
					inserted();
				}
			},
		).finally(inserted); // also when the write failed before its work began
	}

	/**
	 * False when nothing was deleted: the row was already missing, or a delete that has not
	 * finished yet is already removing it (an event handler deleting back what deleted it).
	 */
	delete(tx?: Transaction): Promise<boolean> {
		return new ModelDelete(this.constructor as unknown as ModelClass<this>).write(
			[this],
			tx,
			removed => removed.length > 0,
		);
	}

	load<P extends LoadPath<this>>(
		path: P,
		tx?: Transaction,
	): Promise<this[HeadOf<P> & keyof this]> {
		try {
			this.$assertCurrent();
		} catch (error) {
			return Promise.reject(error);
		}
		return this.$relations.load(path, tx) as Promise<
			this[HeadOf<P> & keyof this]
		>;
	}

	/** Also reloads the loaded relations, or only `paths`, under the constraints they were loaded with. */
	async refresh(
		paths?: readonly LoadPath<this>[],
		tx?: Transaction,
	): Promise<void> {
		this.$assertCurrent();
		const modelClass = this.constructor as unknown as ModelClass<this>;
		const key = this.$attributes.persistedKey();

		if (this.$attributes.persistedKeySignature() === null) {
			throw new OrmError(
				`[orm] Cannot refresh a ${modelClass.name} without its primary key.`,
			);
		}

		const fresh = await modelClass
			.query()
			.whereKey(key as PrimaryKeyOf<this>)
			.first(tx);
		if (!fresh) {
			throw new OrmError(
				`[orm] The ${modelClass.name} with ` +
					`${modelClass.table.primaryKey.columns.join('/')} = ${key.join('/')} no longer exists.`,
			);
		}

		// Read as itself, the shared instance already holds the fresh values.
		if (fresh !== this) {
			const checkpoint = this.$checkpoint();
			this.$refreshed(fresh.$attributes.all(), tx);
			// What was read inside a transaction that rolls back was never committed.
			tx?.onRollback(() => checkpoint.restore());
		}
		await this.$relations.replay(this.$relations.recorded(paths), tx);
	}

	async sync<
		K extends ToManyKey<this>,
		const C extends ColumnKey<RelatedOf<this, K> & Model> = never,
	>(
		name: K,
		members: readonly RelationMember<RelatedOf<this, K> & Model, C>[],
		options: SyncOptions<C> = {},
		tx?: Transaction,
	): Promise<SyncResult> {
		return new RelationWriter<RelatedOf<this, K> & Model>(this, name).sync(
			members,
			options,
			tx,
		);
	}

	/** Copies of the column values; relations are left out. */
	toObject(): Record<string, unknown> {
		const { table } = this.constructor as unknown as ModelClass;
		this.$signals.readRow();
		return Object.fromEntries(
			Object.entries(this.$attributes.all()).map(([column, value]) => [
				column,
				table.column(column).copy(value),
			]),
		);
	}

	toJSON(): Record<string, unknown> {
		return this.toObject();
	}
}

/**
 * A model class names its own schema: `class Post extends Model<typeof Post.schema>`.
 * The type argument exists for the types only; at runtime every model extends the same class.
 */
type ModelConstructor = Omit<typeof BaseModel, 'prototype'> & {
	readonly prototype: BaseModel;
} & (abstract new <S = {}>() => BaseModel & SchemaInstance<S>);

export type Model = BaseModel;
export const Model = BaseModel as unknown as ModelConstructor;

import type { Database } from '../database/database';
import type { Value } from '../database/statement';
import type { EventRegistry, ModelEvents } from '../events/events';
import type { ModelQuery } from '../query/model-query';
import type { AnyRelation } from '../relations/relation';
import type { Column } from '../schema/column';
import type { Table, TableDefinition } from '../schema/table';
import type { Model } from './model';

export type InferColumns<C> = {
	-readonly [K in keyof C]: C[K] extends Column<infer T, boolean, any>
		? T
		: never;
};

export type InferWrites<C> = {
	-readonly [K in keyof C]: C[K] extends Column<any, boolean, infer W>
		? W
		: never;
};

export type KeyColumns<C> = {
	[K in keyof C]: C[K] extends Column<any, true, any> ? K : never;
}[keyof C] &
	string;

export type IsUnion<U, W = U> = U extends unknown
	? [W] extends [U]
		? false
		: true
	: never;

/** One value, or an array of them for a composite key. */
export type PrimaryKeyFromColumns<C> = [KeyColumns<C>] extends [never]
	? unknown
	: true extends IsUnion<KeyColumns<C>>
		? readonly NonNullable<InferColumns<C>[KeyColumns<C>]>[]
		: NonNullable<InferColumns<C>[KeyColumns<C>]>;

export type PrimaryKeyOf<M> = 0 extends 1 & M
	? unknown
	: M extends { readonly $key: infer K }
		? K
		: unknown;

/** Without the key columns, which `query().update()` cannot reassign. */
export type UpdatePatch<M> = 0 extends 1 & M
	? Record<string, any>
	: M extends { readonly $keyColumns: infer N }
		? Omit<Patch<M>, N & string>
		: Patch<M>;

/** A model of unknown class, as an eager constraint's is, accepts any name. */
export type ColumnsOf<M> = 0 extends 1 & M
	? Record<string, any>
	: M extends { readonly $columns: infer C }
		? C
		: Record<string, unknown>;

export type ColumnKey<M> = keyof ColumnsOf<M> & string;

/** Columns of one row, each with the value before and after. */
export type Changes<M> = {
	readonly [K in ColumnKey<M>]?: {
		readonly from: ColumnsOf<M>[K];
		readonly to: ColumnsOf<M>[K];
	};
};

/** What a write did, one pair per row: the model, and the columns it carried. A delete carries none. */
export type Written<M> = readonly (readonly [model: M, changes: Changes<M>])[];

export type TimestampsOption =
	boolean | { readonly createdAt: string; readonly updatedAt: string };

export type OwnedColumns<T> = T extends true
	? 'created_at' | 'updated_at'
	: T extends { readonly createdAt: infer A; readonly updatedAt: infer B }
		? (A | B) & string
		: never;

/** What `this.define` returns, and what a model names in `extends Model<typeof Post.schema>`. */
export type ModelSchema<
	C extends Record<string, Column<any, boolean>> = Record<
		string,
		Column<any, boolean>
	>,
	T extends TimestampsOption = TimestampsOption,
> = Omit<TableDefinition<C>, 'timestamps'> & { readonly timestamps?: T };

declare const draftBrand: unique symbol;

/**
 * A model's draft: its columns writable, and `model()` giving the model back. Passes wherever
 * the model is read; a model does not pass where a draft is asked for.
 */
export type Draft<M> = M &
	(M extends { readonly $patch: infer P }
		? { -readonly [K in keyof P]: P[K] }
		: {}) & {
		model(): M;
		readonly [draftBrand]: true;
	};

/** The columns and the typing members an instance gets from its schema. A model shows the database, so its columns are read-only. */
export type SchemaInstance<S> = S extends {
	readonly columns: infer C;
	readonly timestamps?: infer T;
}
	? Readonly<InferColumns<C>> & {
			/** Carries the column types for the query builder; never assigned. */
			readonly $columns: InferColumns<C>;
			/** Carries the columns a caller may set; never assigned. */
			readonly $patch: Omit<InferColumns<C>, OwnedColumns<T>>;
			readonly $input: Omit<InferWrites<C>, OwnedColumns<T>>;
			/** Carries the primary key's type and columns; never assigned. */
			readonly $key: PrimaryKeyFromColumns<C>;
			readonly $keyColumns: KeyColumns<C>;
			/** The same `fill`, typed by these columns: a model's own methods cannot resolve `this`. */
			fill<X>(
				this: X,
				data: Partial<Omit<InferWrites<C>, OwnedColumns<T>>>,
			): X;
		}
	: {};

/** Per column, what an assigned value becomes. It receives the draft; a column assigned on it inside is set as given, past its own mutator. */
export type Mutators<M> = {
	readonly [K in keyof Assigned<M> & string]?: (
		value: Exclude<Assigned<M>[K], undefined>,
		draft: Draft<M>,
	) => Exclude<Assigned<M>[K], undefined>;
};

type Assigned<M> = 0 extends 1 & M
	? Record<string, any>
	: M extends { readonly $patch: infer P }
		? Partial<P>
		: Partial<ColumnsOf<M>>;

export type Patch<M> = 0 extends 1 & M
	? Record<string, any>
	: M extends { readonly $input: infer I }
		? Partial<I>
		: Partial<ColumnsOf<M>>;

/** A `table.column` reference, checked only at runtime. */
export type QualifiedColumn = `${string}.${string}`;

export type ColumnRef<M> = ColumnKey<M> | QualifiedColumn;

/** A qualified name is not resolved, so it takes any bindable value or any of the model's own types. */
export type ValueOf<M, K> =
	K extends ColumnKey<M>
		? ColumnsOf<M>[K]
		: Value | ColumnsOf<M>[ColumnKey<M>];

/** Leaving out Model's own members also keeps a self-referencing model from typing itself in a loop. */
type DeclaredKey<M> = Exclude<
	keyof M,
	keyof Model | '$columns' | '$patch' | '$input' | '$key' | '$keyColumns'
>;

/** Recognised by one member: comparing a self-referencing model with Model whole would type it through itself. */
type ModelLike = Pick<Model, 'getDirty'>;

/** A collection, told by its rows: a class's generic methods would not compare across row types. */
type CollectionLike<T> = { readonly rows: readonly T[] };

export type RelationKey<M> = {
	[K in DeclaredKey<M>]-?: [NonNullable<M[K]>] extends [
		ModelLike | CollectionLike<ModelLike>,
	]
		? K
		: never;
}[DeclaredKey<M>] &
	string;

type RelatedModel<V> =
	NonNullable<V> extends CollectionLike<infer R> ? R : NonNullable<V>;

/** Recursion budget, since model graphs are cyclic; D permits D + 1 segments. */
type Decrement = [never, 0, 1, 2, 3];

export type LoadPath<M, D extends number = 3> = [D] extends [never]
	? never
	: {
			[K in RelationKey<M>]:
				| K
				| `${K}.${LoadPath<RelatedModel<M[K & keyof M]>, Decrement[D]>}`;
		}[RelationKey<M>];

export type HeadOf<P extends string> = P extends `${infer Head}.${string}`
	? Head
	: P;

export type ToManyKey<M> = {
	[K in DeclaredKey<M>]-?: [NonNullable<M[K]>] extends [
		CollectionLike<ModelLike>,
	]
		? K
		: never;
}[DeclaredKey<M>] &
	string;

export type NumericKey<M> = {
	[K in ColumnKey<M>]-?: [NonNullable<ColumnsOf<M>[K]>] extends [number]
		? K
		: never;
}[ColumnKey<M>];

export type RelatedOf<M, K extends keyof M> =
	NonNullable<M[K]> extends CollectionLike<infer R> ? R : never;

/** Without `relations`, so a relation declared against it does not make its class's type depend on itself. */
export interface ModelRef<M extends Model = Model> {
	/** The only member naming `M`: a second one would give inference two answers and collapse it. */
	new (): M;
	readonly name: string;
	readonly table: Table;
	readonly database: Database;
	readonly mutators?: Mutators<any>;
	/** @internal */
	readonly $generation: number;
	/** @internal */
	readonly $events: EventRegistry;
	readonly events?: ModelEvents<any>;
}

export interface ModelClass<M extends Model = Model> extends ModelRef<M> {
	readonly relations: Readonly<Record<string, AnyRelation>>;
	/** `NoInfer`, since `new (): M` must stay the only member `M` is inferred from. */
	query(): ModelQuery<NoInfer<M>>;
	/** @internal */
	$relation(name: string): AnyRelation;
}

/**
 * @author Burak Kartal
 * @license MIT
 */

export { Database, type DatabaseOptions } from './database/database';
export {
	Statement,
	type Row,
	type StatementResult,
	type StatementSource,
	type Value,
} from './database/statement';
export { Transaction } from './database/transaction';

export {
	AfterCommitError,
	DatabaseError,
	ModelNotFoundError,
	OrmError,
	QueryError,
	TransactionError,
	type ErrorCode,
} from './errors';

export { Model } from './model/model';
export type {
	Changes,
	ColumnKey,
	ColumnRef,
	ColumnsOf,
	Draft,
	LoadPath,
	ModelClass,
	Patch,
	PrimaryKeyOf,
	UpdatePatch,
	Written,
} from './model/types';

export { Column } from './schema/column';
export type { Codec } from './schema/codec';

export type { EagerConstraints, ModelQuery } from './query/model-query';
export type { ModelConditions, ModelGroup } from './query/model-filter';

export { Conditions, type CompareOperator } from './sql/conditions';
export { SelectBuilder } from './sql/select';

export type { RelationPath } from './relations/paths';
export { Collection } from './query/collection.svelte';

export type { EventHandler, ModelEvent, ModelEvents } from './events/events';

export type { RelationMember } from './write/relation-writer';
export { StoreError } from './errors';
export { Query } from './store/query.svelte';
export { Count } from './store/count.svelte';
export { ConnectionStore } from './store/connection-store';
export { TabScope } from './store/tab-scope';
export { TabStore } from './store/tab-store';
export { Store, type StoreClass } from './store/store.svelte';
export { Stored, type StoredOptions } from './store/stored.svelte';

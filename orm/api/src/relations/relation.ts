import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import type { Decider, Source } from '../query/collection.svelte';
import type { ModelQuery } from '../query/model-query';
import type { Subquery } from '../sql/conditions';
import type { Transaction } from '../database/transaction';

export type EagerConstraint = (
	query: ModelQuery<any, any>,
) => ModelQuery<any, any>;

export interface Existence {
	subquery: Subquery;
	columns: readonly string[];
	others: readonly Decider[];
}

/** The parent drops the value if the relation changed meanwhile. */
export type Deliver = (parent: Model, value: unknown) => void;

export interface AnyRelation {
	eagerLoad(
		parents: readonly Model[],
		name: string,
		deliver: Deliver,
		constraint?: EagerConstraint,
		tx?: Transaction,
	): Promise<void>;

	/** A change to one of these makes a loaded value stale. */
	ownerColumns(): readonly string[];

	/** Absent on a polymorphic relation, which has no single related class to walk into. */
	relatedClass?(): ModelClass<any>;

	/** How `parent`'s loaded value asks for its rows again after a commit. Absent when it cannot. */
	sourceFor?(
		parent: Model,
		name: string,
		constraint?: EagerConstraint,
	): Source<any>;

	version?(name: string, constraint?: EagerConstraint): number;

	existence?(name: string, constraint?: EagerConstraint): Existence;

	/** The row in the identity map `parent` points at; undefined when the map cannot say. */
	fromMap?(
		parent: Model,
		constraint?: EagerConstraint,
	): Model | null | undefined;
}

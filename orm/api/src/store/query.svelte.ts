import type { Model } from '../model/model';
import { Collection } from '../query/collection.svelte';
import type { ModelQuery } from '../query/model-query';
import { Followed } from './followed.svelte';

/**
 * A live collection whose query is built again whenever the state `build` read changes. Loads
 * itself; empty until the first result lands, and `loaded` says when. Made where an effect can
 * be, a store's field or a component's script, and ended with what made it.
 */
export class Query<M extends Model>
	extends Followed<Collection<M>>
	implements Iterable<M>
{
	constructor(build: () => ModelQuery<M, any>) {
		super(build, new Collection<M>([]));
	}

	protected fetch(query: ModelQuery<M, any>): Promise<Collection<M>> {
		return query.get();
	}

	/** The rows as a collection, with its helpers. */
	get collection(): Collection<M> {
		return this.held;
	}

	get rows(): readonly M[] {
		return this.held.rows;
	}

	/** The first row, or null: for a query that holds one. */
	get first(): M | null {
		return this.held.first ?? null;
	}

	[Symbol.iterator](): Iterator<M> {
		return this.rows[Symbol.iterator]();
	}

	/** Resolves with the collection once the query built last has loaded. */
	settled(): Promise<Collection<M>> {
		return this.whenSettled();
	}
}

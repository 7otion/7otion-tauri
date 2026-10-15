import type { Model } from '../model/model';
import type { ModelQuery } from '../query/model-query';
import { StoreError } from '../errors';
import { Count } from './count.svelte';
import { Query } from './query.svelte';
import { Stored, type StoredOptions } from './stored.svelte';

/** A store class that can be made: a concrete one. */
export interface StoreClass<S extends Store> {
	new (): S;
	readonly name: string;
}

/** A store, and the way to end the effects made as it was constructed. */
export interface Held {
	store: Store;
	end(): void;
}

/**
 * Owns interface state, derived values and live queries; its actions are its methods. State is
 * `$state`, a derived value `$derived`, and an `$effect` made in the constructor lives as long as
 * the store. One instance per class, made on first `get()`, for the app's whole run.
 */
export abstract class Store {
	private static readonly ofApp = new Map<StoreClass<Store>, Held>();
	private static constructing = false;

	constructor() {
		if (!Store.constructing) {
			throw new StoreError(
				`[store] ${new.target.name} is made by ${new.target.name}.get(), not with new.`,
			);
		}
	}

	/** The instance of this class, made on first ask. */
	static get<S extends Store>(this: StoreClass<S>): S {
		return Store.held(Store.ofApp, this);
	}

	/** @internal The instance `stores` holds for `Class`, made and kept when there is none. */
	protected static held<S extends Store>(
		stores: Map<StoreClass<Store>, Held>,
		Class: StoreClass<S>,
	): S {
		const held = stores.get(Class as StoreClass<Store>);
		if (held) return held.store as S;

		const previous = Store.constructing;
		Store.constructing = true;
		let store!: S;
		let end: () => void;
		try {
			// A root of its own: the store's effects end with it, and its state is not owned by whoever asked first.
			end = $effect.root(() => {
				store = new Class();
			});
		} finally {
			Store.constructing = previous;
		}
		stores.set(Class as StoreClass<Store>, { store, end });
		return store;
	}

	/** @internal Ends every store held, the last made first; one that fails stops none of it, and the first failure is thrown after. */
	static endAll(stores: Map<StoreClass<Store>, Held>): void {
		let failed = false;
		let first: unknown;
		for (const { end } of [...stores.values()].reverse()) {
			try {
				end();
			} catch (error) {
				if (!failed) first = error;
				failed = true;
			}
		}
		stores.clear();
		if (failed) throw first;
	}

	/** What every key this store keeps in `localStorage` begins with. */
	protected get prefix(): string {
		return '';
	}

	/** Whether the store still lives; one that ended makes no more queries and stored values. */
	protected get lives(): boolean {
		return true;
	}

	/** Why a store of this kind ends, for the error of one used after. */
	protected get endsWhen(): string {
		return 'its database is no longer connected';
	}

	/** A live collection whose query follows the state `build` reads. */
	protected query<M extends Model>(build: () => ModelQuery<M, any>): Query<M> {
		this.assertLives();
		return new Query(build);
	}

	protected counted(build: () => ModelQuery<any, any>): Count {
		this.assertLives();
		return new Count(build);
	}

	/** A value kept in `localStorage`. */
	protected stored<T>(key: string, initial: T, options?: StoredOptions): Stored<T> {
		this.assertLives();
		return new Stored(this.prefix + key, initial, options);
	}

	private assertLives(): void {
		if (!this.lives) {
			throw new StoreError(`[store] ${this.constructor.name} has ended: ${this.endsWhen}.`);
		}
	}
}

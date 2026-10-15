import type { Database } from '../database/database';
import { StoreError } from '../errors';
import { Store, type StoreClass } from './store.svelte';
import { TabScope } from './tab-scope';

/**
 * A store that lives while one tab is open: one instance per class per `TabScope`, made on
 * first `get()`, ended when the scope ends.
 */
export abstract class TabStore extends Store {
	private static constructingIn: TabScope | null = null;

	/** The tab this store lives in. */
	readonly scope: TabScope;
	/** The database this store lives with. */
	readonly database: Database;

	constructor() {
		super();
		this.scope = TabStore.constructingIn!;
		this.database = this.scope.database;
	}

	/**
	 * The instance of this class for `scope`, made on first ask. Without `scope`: the one of the
	 * tab store being constructed, else the scope provided above the asking component.
	 */
	static override get<S extends Store>(this: StoreClass<S>, scope?: TabScope): S {
		const within = scope ?? TabStore.constructingIn ?? TabScope.current(this.name);
		if (!within.isOpen) {
			throw new StoreError(`[store] ${this.name} lives while its tab is open; the tab has closed.`);
		}
		const previous = TabStore.constructingIn;
		TabStore.constructingIn = within;
		try {
			return Store.held(within.stores, this);
		} finally {
			TabStore.constructingIn = previous;
		}
	}

	protected override get prefix(): string {
		const { namespace } = this.scope;
		return `${this.database.namespace}.${namespace ? `${namespace}.` : ''}`;
	}

	protected override get lives(): boolean {
		return this.scope.isOpen;
	}

	protected override get endsWhen(): string {
		return 'its tab has closed';
	}
}

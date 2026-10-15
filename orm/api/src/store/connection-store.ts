import type { Database } from '../database/database';
import { Model } from '../model/model';
import { StoreError } from '../errors';
import { Store, type Held, type StoreClass } from './store.svelte';

/**
 * A store that lives while the models are connected to one database: one instance per class,
 * made on first `get()`, ended when the models connect elsewhere or the database closes.
 */
export abstract class ConnectionStore extends Store {
	private static readonly ofDatabase = new WeakMap<Database, Map<StoreClass<Store>, Held>>();

	/** The database this store lives with. */
	readonly database: Database;

	constructor() {
		super();
		this.database = ConnectionStore.connected(new.target.name);
	}

	/** The instance of this class for the connected database, made on first ask. */
	static override get<S extends Store>(this: StoreClass<S>): S {
		const database = ConnectionStore.connected(this.name);
		let stores = ConnectionStore.ofDatabase.get(database);
		if (!stores) {
			const made = new Map<StoreClass<Store>, Held>();
			ConnectionStore.ofDatabase.set(database, (stores = made));
			database.onLeave(() => Store.endAll(made));
		}
		return Store.held(stores, this);
	}

	protected override get prefix(): string {
		return `${this.database.namespace}.`;
	}

	protected override get lives(): boolean {
		return this.database.isOpen && Model.$default === this.database;
	}

	/** The database the models are connected to, while it is open. */
	private static connected(asking: string): Database {
		const database = Model.$default;
		if (!database?.isOpen) {
			throw new StoreError(`[store] ${asking} lives while a database is connected; none is.`);
		}
		return database;
	}

}

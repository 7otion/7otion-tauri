import { getContext, setContext } from 'svelte';

import type { Database } from '../database/database';
import { Model } from '../model/model';
import { StoreError } from '../errors';
import { Store, type Held, type StoreClass } from './store.svelte';

const CONTEXT = Symbol('@7otion-tauri/orm tab scope');

/**
 * One tab's lifetime: the tab stores made in it, ended when the tab closes or when its database
 * leaves, whichever is first. The shell makes one per tab and provides it to the tab's components.
 */
export class TabScope {
	/** The database connected as the scope was made. */
	readonly database: Database;
	/** @internal */
	readonly stores = new Map<StoreClass<Store>, Held>();
	private ended = false;
	private readonly forget: () => void;

	/** `namespace` begins the key of every stored value kept by this scope's stores, after the database's. */
	constructor(readonly namespace = '') {
		const database = Model.$default;
		if (!database?.isOpen) {
			throw new StoreError(
				'[store] A tab scope lives while a database is connected; none is.',
			);
		}
		this.database = database;
		this.forget = database.onLeave(() => this.end());
	}

	get isOpen(): boolean {
		return !this.ended;
	}

	/** Makes this the scope of the component whose script calls it, and of every component beneath. */
	provide(): this {
		setContext(CONTEXT, this);
		return this;
	}

	/** The scope provided above the component whose script asks; `asking` names the store for the error. */
	static current(asking: string): TabScope {
		let scope: TabScope | undefined;
		try {
			scope = getContext<TabScope | undefined>(CONTEXT);
		} catch {
			throw new StoreError(
				`[store] ${asking} lives in a tab: asked for outside a component's script, it needs ` +
					`its TabScope passed, as ${asking}.get(scope).`,
			);
		}
		if (!scope) {
			throw new StoreError(
				`[store] ${asking} lives in a tab; no TabScope is provided above this component.`,
			);
		}
		return scope;
	}

	/** Ends every store of this scope, the last made first; the first failure is thrown after all of it ran. Ending twice does nothing more. */
	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.forget();
		Store.endAll(this.stores);
	}
}

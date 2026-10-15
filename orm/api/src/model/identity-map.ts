import type { Database } from '../database/database';
import type { Transaction } from '../database/transaction';
import type { Model } from './model';
import type { ModelClass } from './types';

interface Slot {
	modelClass: object;
	signature: string;
}

/**
 * One instance per row, per database: two reads of one row give the same object. Held
 * weakly, so a row nobody references is collected and read afresh next time. An instance
 * with unsaved edits is pinned, so a half-edited row is never lost to collection.
 */
export class IdentityMap {
	private static readonly ofOwner = new WeakMap<Database | Transaction, IdentityMap>();

	/** Per class, not per table: two classes over one table are two shared instances. */
	private readonly held = new Map<object, Map<string, WeakRef<Model>>>();
	private readonly pinned = new Set<Model>();

	/** Drops a slot once its instance was collected, so a stale key is never handed out. */
	private readonly collected = new FinalizationRegistry<Slot>(slot => {
		const rows = this.held.get(slot.modelClass);
		if (rows?.get(slot.signature)?.deref() === undefined) {
			rows?.delete(slot.signature);
		}
	});

	/** The database's shared instances, or a transaction's own: one per row within it too. */
	static of(owner: Database | Transaction): IdentityMap {
		let map = IdentityMap.ofOwner.get(owner);
		if (!map) {
			map = new IdentityMap();
			IdentityMap.ofOwner.set(owner, map);
		}
		return map;
	}

	/** The map `model` belongs to: its transaction's when it was read in one, else its database's. */
	static holding(model: Model): IdentityMap {
		return IdentityMap.of(model.$scope ?? (model.constructor as ModelClass).database);
	}

	/** `model` was held under `before`, and is now held under its key if its row exists. */
	moved(model: Model, before: string | null): void {
		this.forget(model, before);
		if (model.$exists) this.register(model);
	}

	/** The shared instance for `modelClass`'s row `signature`, while one is held. */
	get<M extends Model>(modelClass: ModelClass<M>, signature: string): M | undefined {
		return this.held.get(modelClass)?.get(signature)?.deref() as M | undefined;
	}

	/** `model` becomes the shared instance for its row, replacing any other held for it. */
	register(model: Model): void {
		const signature = model.$attributes.persistedKeySignature();
		if (signature === null) return;
		const modelClass = model.constructor;

		let rows = this.held.get(modelClass);
		if (!rows) {
			rows = new Map();
			this.held.set(modelClass, rows);
		}
		const before = rows.get(signature)?.deref();
		if (before === model) return;
		if (before) this.collected.unregister(before);

		rows.set(signature, new WeakRef(model));
		this.collected.register(model, { modelClass, signature }, model);
	}

	/** `model` is no longer the shared instance for `signature`: its row was deleted or rekeyed. */
	forget(model: Model, signature: string | null): void {
		if (signature === null) return;
		const rows = this.held.get(model.constructor);
		if (rows?.get(signature)?.deref() !== model) return;

		rows.delete(signature);
		this.collected.unregister(model);
	}

	/** Kept alive while it has unsaved edits; released once it is clean again. */
	pin(model: Model, dirty: boolean): void {
		if (dirty) this.pinned.add(model);
		else this.pinned.delete(model);
	}

	/** Every instance with unsaved edits. */
	unsaved(): Model[] {
		return [...this.pinned];
	}
}

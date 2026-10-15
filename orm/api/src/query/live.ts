import type { Database } from '../database/database';
import type { Changes } from '../model/types';
import type { Model } from '../model/model';

export type WriteKind = 'created' | 'updated' | 'deleted';

/** One row a commit changed, and how. */
export interface Entry {
	model: Model;
	kind: WriteKind;
	changes: Changes<any>;
}

/** A held value put right after each commit that touched rows of `modelClass`. */
export interface Live {
	readonly modelClass: object;
	/** @internal */
	reconcile(entries: readonly Entry[]): Promise<void>;
	/** @internal Asks the database again, for a value read before a commit it was not yet registered to see. */
	refetch(): Promise<void>;
}

/** The live values of one database, by the class whose rows decide them, held weakly. */
export class LiveRegistry {
	private static readonly ofDatabase = new WeakMap<Database, LiveRegistry>();
	private readonly held = new Map<object, Set<WeakRef<Live>>>();
	private readonly collected = new FinalizationRegistry<{
		refs: Set<WeakRef<Live>>;
		ref: WeakRef<Live>;
	}>(({ refs, ref }) => void refs.delete(ref));
	/** The last turn taken, which the next waits for. */
	private last: Promise<unknown> = Promise.resolve();
	/** Per class, how many commits touching its rows have been put right. */
	private readonly commits = new Map<object, number>();

	/** How many commits touching `modelClass`'s rows have been put right: a value read before that number moved may have missed one. */
	version(modelClass: object): number {
		return this.commits.get(modelClass) ?? 0;
	}

	/** Registers `live`, read when `version(live.modelClass)` was `seen`, asking again if a commit was put right meanwhile. */
	follow(live: Live, seen: number): void {
		this.add(live);
		if (this.version(live.modelClass) !== seen) void this.turn(() => live.refetch());
	}

	/**
	 * Runs `work` after every turn taken before it: commits are put right one at a time, and a
	 * new live value is read and registered between two. `work` runs no code of the app's.
	 */
	turn<T>(work: () => Promise<T>): Promise<T> {
		const mine = this.last.then(work);
		this.last = mine.then(
			() => {},
			() => {},
		);
		return mine;
	}

	static of(database: Database): LiveRegistry {
		let registry = LiveRegistry.ofDatabase.get(database);
		if (!registry) {
			registry = new LiveRegistry();
			LiveRegistry.ofDatabase.set(database, registry);
		}
		return registry;
	}

	add(live: Live, modelClass: object = live.modelClass): void {
		let refs = this.held.get(modelClass);
		if (!refs) {
			refs = new Set();
			this.held.set(modelClass, refs);
		}
		const ref = new WeakRef(live);
		refs.add(ref);
		this.collected.register(live, { refs, ref });
	}

	/** Puts every value the classes of `entries` decide right; one that fails keeps none of the others from it. Returns the failures. */
	async reconcile(entries: readonly Entry[]): Promise<unknown[]> {
		const failures: unknown[] = [];
		const byClass = new Map<object, Entry[]>();
		for (const entry of entries) {
			const modelClass = entry.model.constructor;
			const mine = byClass.get(modelClass);
			if (mine) mine.push(entry);
			else byClass.set(modelClass, [entry]);
		}

		for (const [modelClass, mine] of byClass) {
			this.commits.set(modelClass, this.version(modelClass) + 1);
			const refs = this.held.get(modelClass);
			if (!refs) continue;
			for (const ref of refs) {
				const live = ref.deref();
				if (!live) {
					refs.delete(ref);
					continue;
				}
				try {
					await live.reconcile(mine);
				} catch (error) {
					failures.push(error);
				}
			}
		}
		return failures;
	}
}

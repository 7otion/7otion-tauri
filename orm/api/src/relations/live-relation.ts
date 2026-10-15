import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import {
	decidedBy,
	decidedElsewhere,
	type Decider,
	type Source,
} from '../query/collection.svelte';
import { LiveRegistry, type Entry, type Live } from '../query/live';
import type { KeyedRelation } from './keyed-relation';
import type { EagerConstraint } from './relation';

export interface Reach {
	keys: readonly string[] | null;
	asks: boolean;
}

interface Place {
	key: string;
	ref: WeakRef<Live>;
}

interface Waiting<R> {
	resolve(rows: readonly R[]): void;
	reject(error: unknown): void;
}

interface Held {
	plain?: LiveRelation<any>;
	shaped: WeakMap<EagerConstraint, LiveRelation<any>>;
}

export class LiveRelation<R extends Model> implements Live {
	private static readonly held = new WeakMap<
		LiveRegistry,
		WeakMap<KeyedRelation<any>, Held>
	>();

	private readonly members = new Map<string, Set<WeakRef<Live>>>();
	private readonly places = new WeakMap<Live, Place>();
	private readonly collected = new FinalizationRegistry<Place>(place =>
		this.drop(place),
	);
	readonly decidingColumns: readonly string[] | null;
	readonly also: readonly Decider[];
	private readonly classes: readonly object[];
	private readonly bounded: boolean;
	private asking: Map<Model, Waiting<R>[]> | null = null;

	private constructor(
		private readonly relation: KeyedRelation<R>,
		private readonly name: string,
		private readonly constraint: EagerConstraint | undefined,
		private readonly registry: LiveRegistry,
	) {
		this.decidingColumns = relation.decidingColumns(name, constraint);
		this.also = relation.others(name, constraint);
		this.bounded = relation.bounded(name, constraint);
		this.classes = [
			...new Set<object>([
				...relation.classes(),
				...this.also.map(({ modelClass }) => modelClass),
			]),
		];
		for (const modelClass of this.classes) registry.add(this, modelClass);
	}

	version(): number {
		return this.classes.reduce<number>(
			(sum, modelClass) => sum + this.registry.version(modelClass),
			0,
		);
	}

	static of<R extends Model>(
		relation: KeyedRelation<R>,
		name: string,
		constraint: EagerConstraint | undefined,
	): LiveRelation<R> {
		const registry = LiveRegistry.of(relation.relatedClass().database);
		let relations = LiveRelation.held.get(registry);
		if (!relations) {
			relations = new WeakMap();
			LiveRelation.held.set(registry, relations);
		}
		let held = relations.get(relation);
		if (!held) {
			held = { shaped: new WeakMap() };
			relations.set(relation, held);
		}

		let live = constraint ? held.shaped.get(constraint) : held.plain;
		if (!live) {
			live = new LiveRelation(relation, name, constraint, registry);
			if (constraint) held.shaped.set(constraint, live);
			else held.plain = live;
		}
		return live as LiveRelation<R>;
	}

	get modelClass(): ModelClass<R> {
		return this.relation.relatedClass();
	}

	sourceFor(
		parent: Model,
		own: Pick<Source<R>, 'unique' | 'matches'>,
	): Source<R> {
		const key = this.relation.memberKey(parent);
		return {
			...own,
			modelClass: this.modelClass,
			decidingColumns: this.decidingColumns,
			bounded: this.bounded,
			fetch: () => this.ask(parent),
			follow: (live, seen) => this.join(live, key, seen),
		};
	}

	async reconcile(entries: readonly Entry[]): Promise<void> {
		const reached = new Map<Live, Entry[]>();
		const asked = new Set<Live>();

		for (const entry of entries) {
			if (decidedElsewhere(this, entry)) {
				for (const live of this.everyone()) asked.add(live);
			}
			if (!this.relation.classes().some(owned => owned === entry.model.constructor)) {
				continue;
			}
			const related = entry.model.constructor === this.modelClass;
			if (related && this.unmoved(entry)) continue;

			const { keys, asks } = this.relation.reach(entry);
			const lives =
				keys === null || (related && this.decidingColumns === null)
					? this.everyone()
					: keys.flatMap(key => this.under(key));
			for (const live of lives) {
				if (asks) {
					asked.add(live);
					continue;
				}
				const mine = reached.get(live);
				if (mine) mine.push(entry);
				else reached.set(live, [entry]);
			}
		}

		const work = [...asked].map(live => live.refetch());
		for (const [live, mine] of reached) {
			if (!asked.has(live)) work.push(live.reconcile(mine));
		}
		LiveRelation.raise(await Promise.allSettled(work));
	}

	async refetch(): Promise<void> {
		LiveRelation.raise(
			await Promise.allSettled(this.everyone().map(live => live.refetch())),
		);
	}

	private static raise(settled: readonly PromiseSettledResult<unknown>[]): void {
		const reasons = settled
			.filter(result => result.status === 'rejected')
			.map(result => result.reason as unknown);
		if (reasons.length === 1) throw reasons[0];
		if (reasons.length > 1) throw new AggregateError(reasons);
	}

	private unmoved(entry: Entry): boolean {
		return (
			entry.kind === 'updated' &&
			!Object.keys(entry.changes).some(column => decidedBy(this, column))
		);
	}

	private join(live: Live, key: string | null, seen: number | undefined): () => void {
		if (key !== null) {
			const place = { key, ref: new WeakRef(live) };
			let refs = this.members.get(key);
			if (!refs) {
				refs = new Set();
				this.members.set(key, refs);
			}
			refs.add(place.ref);
			this.places.set(live, place);
			this.collected.register(live, place, live);
		}
		if (seen !== undefined && this.version() !== seen) {
			void this.registry.turn(() => live.refetch());
		}
		return () => {
			const place = this.places.get(live);
			if (!place) return;
			this.places.delete(live);
			this.collected.unregister(live);
			this.drop(place);
		};
	}

	private drop({ key, ref }: Place): void {
		const refs = this.members.get(key);
		if (!refs) return;
		refs.delete(ref);
		if (refs.size === 0) this.members.delete(key);
	}

	private under(key: string): Live[] {
		return LiveRelation.alive(this.members.get(key));
	}

	private everyone(): Live[] {
		return [...this.members.values()].flatMap(refs => LiveRelation.alive(refs));
	}

	private static alive(refs: ReadonlySet<WeakRef<Live>> | undefined): Live[] {
		const lives: Live[] = [];
		for (const ref of refs ?? []) {
			const live = ref.deref();
			if (live) lives.push(live);
		}
		return lives;
	}

	private ask(parent: Model): Promise<readonly R[]> {
		if (this.bounded) {
			return this.load([parent]).then(found => found.get(parent) ?? []);
		}
		return new Promise((resolve, reject) => {
			if (!this.asking) {
				this.asking = new Map();
				queueMicrotask(() => void this.answer());
			}
			const waiting = this.asking.get(parent);
			if (waiting) waiting.push({ resolve, reject });
			else this.asking.set(parent, [{ resolve, reject }]);
		});
	}

	private async answer(): Promise<void> {
		const asking = this.asking!;
		this.asking = null;
		try {
			const found = await this.load([...asking.keys()]);
			for (const [parent, waiting] of asking) {
				for (const { resolve } of waiting) resolve(found.get(parent) ?? []);
			}
		} catch (error) {
			for (const waiting of asking.values()) {
				for (const { reject } of waiting) reject(error);
			}
		}
	}

	private static rowsOf<R>(value: unknown): readonly R[] {
		if (Array.isArray(value)) return value as readonly R[];
		return value === null ? [] : [value as R];
	}

	private async load(parents: readonly Model[]): Promise<Map<Model, readonly R[]>> {
		const found = new Map<Model, readonly R[]>();
		await this.relation.eagerLoad(
			parents,
			this.name,
			(parent, value) => {
				found.set(parent, LiveRelation.rowsOf<R>(value));
			},
			this.constraint,
		);
		return found;
	}
}

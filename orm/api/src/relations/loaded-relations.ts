import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { Collection, LiveCollection, type Source } from '../query/collection.svelte';
import { EagerLoader, type EagerPaths } from '../query/eager-loader';
import { LiveRegistry } from '../query/live';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import { LiveLookup } from './live-lookup';
import type { EagerConstraint } from './relation';

/** What a relation held, and the lookup keeping it right. */
interface Held {
	had: boolean;
	value: unknown;
	lookup: LiveLookup<any> | undefined;
}

export class LoadedRelations {
	private readonly related = new Map<string, unknown>();
	/** The to-one values kept right after each commit, by relation. */
	private readonly lookups = new Map<string, LiveLookup<any>>();

	/** The loads on their way, by path: a second call for one joins it. */
	private readonly promises = new Map<string, Promise<unknown>>();

	private lastIssued = 0;
	/** For each relation, the token of the one load whose result is still wanted. */
	private readonly awaited = new Map<string, number>();

	/** The load begun last per relation. A dropped load waits for it: two retrying at once drop each other's without end. */
	private readonly running = new Map<string, Promise<unknown>>();

	readonly paths = new Map<string, EagerConstraint | undefined>();

	constructor(private readonly model: Model) {}

	has(name: string): boolean {
		return this.related.has(name);
	}

	held(name: string): unknown {
		return this.related.get(name);
	}

	/** @internal */
	startLoad(name: string): number {
		const token = ++this.lastIssued;
		this.awaited.set(name, token);
		return token;
	}

	/**
	 * @internal Dropped unless that load is still awaited; followed through `source` unless read
	 * in a developer transaction. Under `tx`, what it replaces is kept for a rollback to put back.
	 */
	deliver(
		name: string,
		value: unknown,
		token: number,
		tx?: Transaction,
		source?: Source<any>,
	): void {
		if (this.awaited.get(name) !== token) return;

		const live = source !== undefined && !tx?.ownsReads;
		const followed: Source<any> | undefined = live
			? { ...source, complete: rows => this.loadBeneath(name, rows) }
			: undefined;
		const held = Array.isArray(value)
			? followed
				? new LiveCollection(followed, value)
				: new Collection(value)
			: value;
		const lookup =
			followed && !Array.isArray(value)
				? new LiveLookup(followed, value as Model | null, next => this.follow(name, next))
				: undefined;

		const before: Held = {
			had: this.related.has(name),
			value: this.related.get(name),
			lookup: this.lookups.get(name),
		};
		this.related.set(name, held);
		if (lookup) this.lookups.set(name, lookup);
		else this.lookups.delete(name);
		if (before.had && before.value !== held) {
			if (tx?.isOpen) tx.notify(() => this.model.$signals.pointed(name));
			else this.model.$signals.pointed(name);
		}

		if (!tx) {
			LoadedRelations.release(before);
			return;
		}
		// Put back only while this is still what is held: a newer value is not undone.
		tx.onRollback(() => {
			if (this.related.get(name) !== held) return;
			LoadedRelations.release({ had: true, value: held, lookup });
			if (before.had) {
				this.related.set(name, before.value);
				if (before.lookup) this.lookups.set(name, before.lookup);
				else this.lookups.delete(name);
				this.supersede(name);
				this.model.$signals.pointed(name);
			} else {
				this.clear(name);
			}
		});
		tx.onCommit(`${this.modelClass().name}.${name}`, async () => {
			if (this.related.get(name) !== before.value) LoadedRelations.release(before);
			if (!live && this.related.get(name) === held) await this.pointAgain([name]);
		});
	}

	/** A load already on its way is from before, so its result is dropped. */
	clear(name: string): boolean {
		this.supersede(name);
		LoadedRelations.release({
			had: this.related.has(name),
			value: this.related.get(name),
			lookup: this.lookups.get(name),
		});
		this.lookups.delete(name);
		const had = this.related.delete(name);
		if (had) this.model.$signals.pointed(name);
		return had;
	}

	/** A value no longer held stops following the database. */
	private static release({ value, lookup }: Held): void {
		if (value instanceof Collection) value.release();
		lookup?.release();
	}

	/** Holds what a commit put right; a load on its way is newer, and still lands. */
	private follow(name: string, value: unknown): void {
		this.related.set(name, value);
		this.model.$signals.pointed(name);
	}

	/** Loads beneath `rows` what `name` was loaded with beneath it: `posts.comments` loads `comments` on posts that joined `posts`. */
	private async loadBeneath(name: string, rows: readonly Model[]): Promise<void> {
		const beneath = new Map<string, EagerConstraint | undefined>();
		for (const [path, constraint] of this.paths) {
			if (path.startsWith(`${name}.`)) beneath.set(path.slice(name.length + 1), constraint);
		}
		const relatedClass = this.modelClass().$relation(name).relatedClass?.();
		if (beneath.size === 0 || rows.length === 0 || !relatedClass) return;
		await new EagerLoader(beneath, undefined, true).load(rows, relatedClass);
	}

	/** A to-one whose row was deleted reads as null. */
	read(name: string): unknown {
		if (this.related.has(name)) {
			const held = this.related.get(name);
			if (held === null || held instanceof Collection) return held;
			(held as Model).$signals.readExists();
			return (held as Model).$exists ? held : null;
		}

		throw new OrmError(
			`[orm] ${this.modelClass().name}.${name} is not loaded. Load it with ` +
				`with('${name}') on the query, or await load('${name}') on the instance.`,
		);
	}

	load(path: string, tx?: Transaction): Promise<unknown> {
		// Not shared across the transaction's edge: rows it reads may never be committed.
		if (tx) return this.loadUntilHeld(path, tx);

		const handed = this.promises.get(path);
		if (handed) return handed;

		const loading: Promise<unknown> = this.loadUntilHeld(path).finally(() => {
			if (this.promises.get(path) === loading) this.promises.delete(path);
		});
		this.promises.set(path, loading);
		return loading;
	}

	/** A to-one holding a row since deleted holds nothing. */
	holds(path: string): boolean {
		let models: Model[] = [this.model];
		for (const name of path.split('.')) {
			const next: Model[] = [];
			for (const model of models) {
				if (!model.$relations.has(name)) return false;
				const held = model.$relations.held(name);
				if (!(held instanceof Collection) && (held as Model | null)?.$exists === false) {
					return false;
				}
				next.push(...Collection.modelsIn(held));
			}
			models = next;
		}
		return true;
	}

	/** A value is swapped only once its replacement has arrived. */
	async refreshAffected(
		columns: readonly string[],
		tx?: Transaction,
	): Promise<void> {
		const relations = this.modelClass().relations;

		// A load still on its way counts: it reads by the old key, and its answer is dropped for this one.
		const affected = Object.keys(relations).filter(
			name =>
				(this.related.has(name) || this.running.has(name)) &&
				relations[name]!.ownerColumns().some(column =>
					columns.includes(column),
				),
		);

		await Promise.all(
			affected.map(name => this.replay(this.recordedUnder(name), tx)),
		);
	}

	/** After a commit that changed `columns`, the loaded relations keyed off them point again. Returns the relations changed. */
	followKeys(columns: readonly string[]): Promise<{ model: Model; name: string }[]> {
		const relations = this.modelClass().relations;
		return this.pointAgain(
			Object.keys(relations).filter(
				name =>
					this.related.has(name) &&
					relations[name]!.ownerColumns().some(column => columns.includes(column)),
			),
		);
	}

	/**
	 * `names` read again as shared where they hold a transaction's value or the wrong row: a
	 * to-one from the identity map where it can be. Returns the relations now holding another value.
	 */
	private async pointAgain(names: readonly string[]): Promise<{ model: Model; name: string }[]> {
		const relations = this.modelClass().relations;
		const changed: { model: Model; name: string }[] = [];
		const query: string[] = [];

		for (const name of names) {
			const relation = relations[name]!;
			const held = this.related.get(name);
			if (held instanceof Collection) {
				query.push(name);
				continue;
			}
			const constraint = this.paths.get(name);
			const source = relation.sourceFor?.(this.model, name, constraint);
			const found = relation.fromMap?.(this.model, constraint);
			const right =
				held === null
					? found === null
					: !(held as Model).$scope &&
						(held as Model).$exists &&
						source?.matches?.(held as Model) === true;
			if (right) continue;

			if (found === undefined) {
				query.push(name);
				continue;
			}
			if (found !== held) {
				this.deliver(name, found, this.startLoad(name), undefined, source);
				if (found) await this.loadBeneath(name, [found]);
				changed.push({ model: this.model, name });
			}
		}

		if (query.length > 0) {
			const before = new Map(query.map(name => [name, this.related.get(name)]));
			await Promise.all(query.map(name => this.replay(this.recordedUnder(name))));
			for (const name of query) {
				if (this.related.get(name) !== before.get(name)) changed.push({ model: this.model, name });
			}
		}
		return changed;
	}

	/** Loads even what is loaded already; a call made after it began joins no load begun before. */
	async replay(paths: EagerPaths, tx?: Transaction): Promise<void> {
		const loader = new EagerLoader(paths, tx);
		loader.begin([this.model]);
		const loading = loader.load([this.model], this.modelClass());

		// Registered like any load, so a load it supersedes waits for it rather than loading again.
		const heads = new Set([...paths.keys()].map(path => path.split('.')[0]!));
		for (const head of heads) this.running.set(head, loading);
		try {
			await loading;
		} finally {
			for (const head of heads) {
				if (this.running.get(head) === loading) this.running.delete(head);
			}
		}

		for (const head of heads) this.forget(head);
	}

	/** Includes every path leading to each one, so a parent segment reloads as it was loaded. */
	recorded(paths?: readonly string[]): EagerPaths {
		if (!paths) return new Map(this.paths);

		const replay = new Map<string, EagerConstraint | undefined>();
		for (const path of paths) {
			const segments = path.split('.');
			segments.forEach((_, index) => {
				const prefix = segments.slice(0, index + 1).join('.');
				replay.set(prefix, this.paths.get(prefix));
			});
		}
		return replay;
	}

	/** Again if the relation was cleared while it loaded: the caller asked for it as it now is. */
	private async loadUntilHeld(
		path: string,
		tx?: Transaction,
	): Promise<unknown> {
		const head = path.split('.')[0]!;

		do {
			// The head by its own load: shared with anyone else loading it, and under the constraint it was loaded with.
			if (path !== head) await this.load(head, tx);

			// Each prefix under its recorded constraint, should a segment cleared meanwhile load again.
			const mine = new EagerLoader(this.recorded([path]), tx, true).load(
				[this.model],
				this.modelClass(),
			);
			this.running.set(head, mine);
			try {
				await mine;
			} finally {
				if (this.running.get(head) === mine) this.running.delete(head);
			}

			// Dropped for a later load's, which is waited for rather than raced.
			let later: Promise<unknown> | undefined;
			while (
				!this.related.has(head) &&
				(later = this.running.get(head)) !== undefined
			) {
				await later.catch(() => {});
			}
		} while (!this.holds(path));

		// A value read before a commit it did not see asks again in a turn; it has answered after this one.
		if (!tx) await LiveRegistry.of(this.modelClass().database).turn(async () => {});
		return this.read(head);
	}

	private recordedUnder(name: string): EagerPaths {
		const replay = new Map<string, EagerConstraint | undefined>([
			[name, this.paths.get(name)],
		]);
		for (const [path, constraint] of this.paths) {
			if (path.startsWith(`${name}.`)) replay.set(path, constraint);
		}
		return replay;
	}

	/** @internal A load still in flight for `name` read rows from before now: its answer is dropped. */
	supersede(name: string): void {
		this.awaited.delete(name);
		this.forget(name);
	}

	/** The loads on their way for `name` and beneath it are joined by no later call. */
	private forget(name: string): void {
		for (const path of [...this.promises.keys()]) {
			if (path === name || path.startsWith(`${name}.`)) this.promises.delete(path);
		}
	}

	private modelClass(): ModelClass {
		return this.model.constructor as unknown as ModelClass;
	}
}

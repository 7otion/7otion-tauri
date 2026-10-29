import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import { decidedBy, type Source } from '../query/collection.svelte';
import { LiveRegistry, type Entry, type Live } from '../query/live';

/** A loaded to-one relation, registered with its database so each commit can put it right. */
export class LiveLookup<M extends Model> implements Live {
	private released = false;
	private readonly leave: (() => void) | undefined;

	constructor(
		private readonly source: Source<M>,
		private held: M | null,
		private readonly follow: (value: M | null) => void,
	) {
		if (source.follow) {
			this.leave = source.follow(this, source.seen);
			return;
		}
		const registry = LiveRegistry.of(source.modelClass.database);
		registry.follow(
			this,
			source.seen ?? registry.version(source.modelClass),
		);
	}

	get modelClass(): ModelClass<M> {
		return this.source.modelClass;
	}

	release(): void {
		this.released = true;
		this.leave?.();
	}

	/**
	 * @internal A row that matches by key alone is taken; the database is asked when that cannot
	 * tell. Where only one row can match, a deleted held row leaves null without a query.
	 */
	async reconcile(entries: readonly Entry[]): Promise<void> {
		if (this.released) return;
		const unique = this.source.unique === true;
		const held = this.held;

		let heldGone = false;
		let ask = false;
		const candidates: M[] = [];
		for (const entry of entries) {
			const row = entry.model as M;
			if (entry.kind === 'deleted') {
				if (row === held) heldGone = true;
				continue;
			}
			if (
				entry.kind !== 'created' &&
				!Object.keys(entry.changes).some(column =>
					decidedBy(this.source, column),
				)
			) {
				continue;
			}
			const matches = this.source.matches?.(row);
			if (matches === undefined) ask = true;
			else if (matches && row !== held && !candidates.includes(row))
				candidates.push(row);
			else if (!matches && row === held) ask = true;
		}
		// A row created and deleted in the same commit is no candidate.
		const standing = candidates.filter(row => row.$exists);
		if (
			(heldGone && !unique) ||
			(held && !heldGone && standing.length > 0 && !unique)
		)
			ask = true;

		let next: M | null;
		if (ask) next = (await this.source.fetch())[0] ?? null;
		else if (heldGone) next = standing[0] ?? null;
		else if (!held && standing.length > 0) next = standing[0]!;
		else return;

		await this.take(next);
	}

	/** @internal */
	async refetch(): Promise<void> {
		if (this.released) return;
		await this.take((await this.source.fetch())[0] ?? null);
	}

	/** Holds `next`, loaded beneath as the relation was; whether it held another row before. */
	private async take(next: M | null): Promise<boolean> {
		if (next) await this.source.complete?.([next]);
		if (this.released || next === this.held) return false;
		this.held = next;
		this.follow(next);
		return true;
	}
}

import type { ModelClass } from '../model/types';
import { Signal } from '../reactivity/signal.svelte';
import {
	decidedBy,
	decidedElsewhere,
	follows,
	type Decided,
} from './collection.svelte';
import { LiveRegistry, type Entry, type Live } from './live';

export interface ValueSource<T> extends Decided {
	fetch(): Promise<T>;
}

export class LiveValue<T> implements Live {
	private readonly signal = new Signal();
	private released = false;

	constructor(
		private readonly source: ValueSource<T>,
		private held: T,
	) {
		const registry = LiveRegistry.of(source.modelClass.database);
		registry.follow(this, registry.version(source.modelClass));
		for (const modelClass of follows(source))
			registry.add(this, modelClass);
	}

	get modelClass(): ModelClass<any> {
		return this.source.modelClass;
	}

	get current(): T {
		this.signal.read();
		return this.held;
	}

	release(): void {
		this.released = true;
	}

	async reconcile(entries: readonly Entry[]): Promise<void> {
		const asks = entries.some(
			entry =>
				decidedElsewhere(this.source, entry) ||
				(entry.model.constructor === this.source.modelClass &&
					(entry.kind !== 'updated' ||
						Object.keys(entry.changes).some(column =>
							decidedBy(this.source, column),
						))),
		);
		if (asks) await this.refetch();
	}

	async refetch(): Promise<void> {
		if (this.released) return;
		const next = await this.source.fetch();
		if (this.released || Object.is(next, this.held)) return;
		this.held = next;
		this.signal.bump();
	}
}

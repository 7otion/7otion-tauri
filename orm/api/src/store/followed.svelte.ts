import { tick, untrack } from 'svelte';

import type { ModelQuery } from '../query/model-query';

export interface Releasable {
	release(): void;
}

export abstract class Followed<H extends Releasable> {
	#held = $state.raw<H>(undefined as unknown as H);
	#loaded = $state(false);
	#error = $state.raw<unknown>(null);
	#sequence = 0;
	#settling: Promise<H>;
	#loading: Promise<unknown> = Promise.resolve();

	constructor(build: () => ModelQuery<any, any>, initial: H) {
		this.#held = initial;
		this.#settling = Promise.resolve(initial);
		$effect(() => {
			const query = build();
			untrack(() => {
				this.#settling = this.load(query);
			});
		});
		$effect(() => () => {
			this.#sequence++;
			untrack(() => this.#held).release();
		});
	}

	protected abstract fetch(query: ModelQuery<any, any>): Promise<H>;

	protected get held(): H {
		return this.#held;
	}

	get loaded(): boolean {
		return this.#loaded;
	}

	/** What the last load rejected with; null otherwise. */
	get error(): unknown {
		return this.#error;
	}

	protected async whenSettled(): Promise<H> {
		let settling: Promise<H>;
		do {
			await tick();
			settling = this.#settling;
			await settling;
		} while (settling !== this.#settling);
		return untrack(() => this.#held);
	}

	/** A result from a load begun earlier than the latest is dropped; the latest wins whatever order they land in. */
	private load(query: ModelQuery<any, any>): Promise<H> {
		const sequence = ++this.#sequence;
		const loading = this.#loading.then(() =>
			sequence === this.#sequence
				? this.take(query, sequence)
				: this.#held,
		);
		this.#loading = loading;
		return loading;
	}

	private async take(
		query: ModelQuery<any, any>,
		sequence: number,
	): Promise<H> {
		let held: H;
		try {
			held = await this.fetch(query);
		} catch (error) {
			if (sequence === this.#sequence) this.#error = error;
			return this.#held;
		}
		if (sequence !== this.#sequence) {
			held.release();
			return this.#held;
		}
		const previous = this.#held;
		this.#held = held;
		this.#error = null;
		this.#loaded = true;
		previous.release();
		return held;
	}
}

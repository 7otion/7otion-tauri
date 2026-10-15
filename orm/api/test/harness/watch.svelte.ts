import { flushSync } from 'svelte';

/** What an expression in a component's markup would show: every value `read` gave, one per run. */
export class Watch<T> {
	readonly stop: () => void;
	private readonly values: T[] = [];

	constructor(read: () => T) {
		this.stop = $effect.root(() => {
			$effect(() => {
				this.values.push(read());
			});
		});
		flushSync();
	}

	get seen(): readonly T[] {
		flushSync();
		return this.values;
	}

	/** How many times it ran again after the first. */
	get reruns(): number {
		return this.seen.length - 1;
	}

	get last(): T {
		return this.seen.at(-1) as T;
	}
}

/** A piece of state, as a component or a store declares one. */
export class State<T> {
	value: T;

	constructor(initial: T) {
		this.value = $state.raw(initial);
	}
}

/** Runs `make` where a component's script would run: what it makes may hold effects, ended by `unmount`. */
export function mounted<T>(make: () => T): { made: T; unmount(): void } {
	let made!: T;
	const unmount = $effect.root(() => {
		made = make();
	});
	flushSync();
	return { made, unmount };
}

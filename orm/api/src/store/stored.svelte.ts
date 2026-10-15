import { untrack } from 'svelte';

export interface StoredOptions {
	/** Rejects a stored value; a rejected one falls back to the initial value. */
	validate?: (value: unknown) => boolean;
}

/** A value kept in `localStorage` under its key: read once when made, written as JSON on every assignment. */
export class Stored<T> {
	#value: T;

	constructor(
		readonly key: string,
		initial: T,
		options?: StoredOptions,
	) {
		this.#value = $state.raw(Stored.load(key, initial, options));
	}

	get current(): T {
		return this.#value;
	}

	/** Replaced whole: a change made inside the value held is neither seen nor saved. */
	set current(value: T) {
		// Read untracked: an effect that assigns must not depend on what it assigns.
		if (Object.is(value, untrack(() => this.#value))) return;
		this.#value = value;
		this.save(value);
	}

	/** Drops every stored value whose key begins with `prefix`, for a namespace that will not open again. */
	static erase(prefix: string): void {
		try {
			for (const key of Object.keys(localStorage)) {
				if (key.startsWith(prefix)) localStorage.removeItem(key);
			}
		} catch {
			// No storage, nothing to erase.
		}
	}

	private save(value: T): void {
		try {
			const raw = JSON.stringify(value);
			if (raw === undefined) localStorage.removeItem(this.key);
			else localStorage.setItem(this.key, raw);
		} catch {
			// A full or blocked storage must not break the write.
		}
	}

	private static load<T>(key: string, initial: T, options?: StoredOptions): T {
		try {
			const raw = localStorage.getItem(key);
			if (raw === null) return initial;
			const stored: unknown = JSON.parse(raw);
			return options?.validate && !options.validate(stored) ? initial : (stored as T);
		} catch {
			return initial;
		}
	}
}

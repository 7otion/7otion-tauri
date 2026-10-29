/** A `localStorage` for tests run without a DOM, as a Tauri webview always has one. */
class MemoryStorage implements Storage {
	private readonly items = new Map<string, string>();

	get length(): number {
		return this.items.size;
	}

	key(index: number): string | null {
		return [...this.items.keys()][index] ?? null;
	}

	getItem(key: string): string | null {
		return this.items.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.items.set(key, String(value));
		Object.defineProperty(this, key, {
			value: String(value),
			configurable: true,
			enumerable: true,
		});
	}

	removeItem(key: string): void {
		this.items.delete(key);
		delete (this as unknown as Record<string, unknown>)[key];
	}

	clear(): void {
		for (const key of [...this.items.keys()]) this.removeItem(key);
	}
}

if (!('localStorage' in globalThis)) {
	Object.defineProperty(globalThis, 'localStorage', {
		value: new MemoryStorage(),
		configurable: true,
	});
}

export const storage: Storage = globalThis.localStorage;

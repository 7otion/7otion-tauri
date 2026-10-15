/** Keyed by signature, which `Table.storedSignature` makes follow a `nocase()` column. */
export class KeyIndex<V> {
	private readonly entries = new Map<string, V[]>();

	add(signature: string, value: V): void {
		const group = this.entries.get(signature);
		if (group) group.push(value);
		else this.entries.set(signature, [value]);
	}

	get(signature: string | null): readonly V[] | undefined {
		return signature === null ? undefined : this.entries.get(signature);
	}
}

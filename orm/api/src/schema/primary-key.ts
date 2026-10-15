const SEPARATOR = String.fromCharCode(0);

export class PrimaryKey {
	constructor(
		readonly columns: readonly string[],
		readonly generated: string | null,
	) {}

	get isComposite(): boolean {
		return this.columns.length > 1;
	}

	/** The generated column, when `values` leaves it for the database to fill. */
	generatedIn(values: Readonly<Record<string, unknown>>): string | null {
		if (this.generated === null) return null;
		const value = values[this.generated];
		return value === undefined || value === null ? this.generated : null;
	}

	/** Null while any value is missing or NULL; `0` and `''` are real keys. */
	static signature(stored: readonly unknown[]): string | null {
		if (stored.some(value => value === undefined || value === null)) {
			return null;
		}
		return stored.map(PrimaryKey.part).join(SEPARATOR);
	}

	/** As text, so `1` and `'1'` agree as SQLite's affinity makes them; a separator inside a value is escaped. */
	private static part(value: unknown): string {
		return String(value)
			.replaceAll('\\', '\\\\')
			.replaceAll(SEPARATOR, '\\0');
	}
}

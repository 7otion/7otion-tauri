/** The ORM writes these columns; the caller cannot. */
export class Timestamps {
	private readonly owned: ReadonlySet<string>;

	constructor(
		readonly columns: {
			readonly createdAt: string;
			readonly updatedAt: string;
		} | null,
	) {
		this.owned = new Set(
			columns ? [columns.createdAt, columns.updatedAt] : [],
		);
	}

	owns(column: string): boolean {
		return this.owned.has(column);
	}

	without(columns: readonly string[]): string[] {
		return columns.filter(column => !this.owned.has(column));
	}

	insertStamp(now: Date): Record<string, Date> {
		if (!this.columns) return {};
		return {
			[this.columns.createdAt]: now,
			[this.columns.updatedAt]: now,
		};
	}

	updateStamp(now: Date): Record<string, Date> {
		if (!this.columns) return {};
		return { [this.columns.updatedAt]: now };
	}
}

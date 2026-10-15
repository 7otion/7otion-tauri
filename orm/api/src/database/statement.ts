export type Value = null | boolean | number | string | Uint8Array;

export type StoredValue = null | number | string | Uint8Array;

export type Row = Record<string, StoredValue>;

export class Statement {
	/** SQLITE_MAX_VARIABLE_NUMBER since SQLite 3.32, which the Rust crate's bundled build is past. */
	static readonly MAX_PARAMS = 32766;

	constructor(
		readonly sql: string,
		readonly params: readonly Value[] = [],
	) {}
}

export interface StatementSource {
	toStatement(): Statement;
}

export interface StatementResult {
	rows: Row[];
	affected: number;
	transactionEnded: boolean;
	timing: Timing;
}

/** Measured by the crate, so none includes the trip through IPC nor a busy page. */
export interface Timing {
	/** Waiting for a connection: a reader from the pool, or the writer. */
	waitedMs: number;
	/** In SQLite, running the statement and reading its rows. */
	ranMs: number;
	/** Inside the plugin's command, from entry to answer; the two above included. */
	pluginMs: number;
}

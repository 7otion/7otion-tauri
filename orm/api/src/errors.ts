import type { Statement } from './database/statement';

export class OrmError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** A statement the builders cannot write as SQL. */
export class QueryError extends OrmError {}

export type ErrorCode =
	| 'unique'
	| 'foreign_key'
	| 'not_null'
	| 'check'
	| 'busy'
	| 'read_only'
	| 'value'
	| 'protocol'
	| 'misuse'
	| 'unknown';

export class DatabaseError extends OrmError {
	constructor(
		message: string,
		readonly code: ErrorCode,
		cause: unknown,
		/** Its params stay out of the message: they may be personal data. */
		readonly statement: Statement | null = null,
		/** SQLite ended the statement's transaction by itself. */
		readonly transactionEnded = false,
	) {
		super(message, { cause });
	}
}

export class TransactionError extends OrmError {}

export class ModelNotFoundError extends OrmError {
	constructor(
		readonly model: string,
		detail: string,
	) {
		super(`[orm] No ${model} ${detail}.`);
	}
}

export interface AfterCommitFailure {
	/** What failed, such as `save:committed on User`. */
	source: string;
	error: unknown;
}

export class AfterCommitError extends OrmError {
	readonly committed = true as const;

	constructor(
		/** What the write returned, so a committed `create()` still hands back its model. */
		readonly result: unknown,
		readonly failures: readonly AfterCommitFailure[],
	) {
		super(
			`[orm] The write committed, but ${failures.length} step(s) after it failed: ` +
				failures
					.map(
						({ source, error }) =>
							`${source}: ${error instanceof Error ? error.message : String(error)}`,
					)
					.join('; '),
		);
	}
}

/** A misuse of the store layer: a store made with `new`, one asked for with no database open, one used after its database closed. */
export class StoreError extends OrmError {}

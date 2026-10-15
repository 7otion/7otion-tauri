import {
	AfterCommitError,
	DatabaseError,
	OrmError,
	QueryError,
} from '../errors';
import { Bridge, type BridgeOptions } from './bridge';
import {
	Statement,
	type StatementResult,
	type StatementSource,
} from './statement';
import { StatementLogger } from './statement-logger';
import { Transaction } from './transaction';

export interface DatabaseOptions extends BridgeOptions {
	/** Relative to the app's data directory unless absolute. */
	path: string;
	loggerEnabled?: boolean;
	/** What the stores living with this database begin their `localStorage` keys with. Defaults to the path. */
	namespace?: string;
}

const FORGOTTEN_HANDLE =
	'A transaction of this database was open meanwhile. If this statement was made inside its ' +
	'callback, or inside a :before or :after event, it is missing the tx handle: it waited for the transaction, ' +
	'which waited for it. Pass the handle, as in save(tx), create(data, tx), delete(tx), ' +
	'transaction(fn, tx). Otherwise the other transaction simply held the writer too long.';

/** One SQLite file, opened through the Rust crate at first use. */
export class Database {
	private readonly options: BridgeOptions;
	readonly path: string;
	readonly namespace: string;
	private readonly logger = new StatementLogger();
	private readonly leaving: (() => void)[] = [];

	private connection: Promise<Bridge> | null = null;
	private closed = false;
	private openTransactions = 0;

	constructor(options: DatabaseOptions) {
		const { path, loggerEnabled, namespace, ...bridge } = options;
		this.path = path;
		this.namespace = namespace ?? path;
		this.options = bridge;
		this.logger.enabled = loggerEnabled ?? false;
	}

	get isOpen(): boolean {
		return !this.closed;
	}

	/** @internal Runs once, when the models connect to another database or this one closes, whichever is first; returns what takes it back. */
	onLeave(work: () => void): () => void {
		this.leaving.push(work);
		return () => {
			const index = this.leaving.indexOf(work);
			if (index !== -1) this.leaving.splice(index, 1);
		};
	}

	/** @internal What lived with this database ends, the last made first; the first failure is thrown after all of it ran. */
	left(): void {
		let failed = false;
		let first: unknown;
		for (const work of this.leaving.splice(0).reverse()) {
			try {
				work();
			} catch (error) {
				if (!failed) first = error;
				failed = true;
			}
		}
		if (failed) throw first;
	}

	get loggerEnabled(): boolean {
		return this.logger.enabled;
	}

	set loggerEnabled(enabled: boolean) {
		this.logger.enabled = enabled;
	}

	async run(
		statement: Statement | StatementSource,
		tx?: Transaction,
	): Promise<StatementResult> {
		const prepared =
			statement instanceof Statement ? statement : statement.toStatement();

		const { length } = prepared.params;
		if (length > Statement.MAX_PARAMS) {
			throw new QueryError(
				`[orm] The statement binds ${length} values, and SQLite takes at most ` +
					`${Statement.MAX_PARAMS} in one statement. Split the list, as a whereIn over ` +
					`that many values, into several queries.\n  while running: ${prepared.sql.slice(0, 200)}`,
			);
		}

		const bridge = await this.bridge();
		if (!tx) {
			return this.attempt(prepared, null, () => bridge.send(prepared, null));
		}

		tx.assertBelongsTo(this);
		return tx.send(async () => {
			try {
				const result = await this.attempt(prepared, tx.id, () =>
					bridge.send(prepared, tx.id),
				);
				if (result.transactionEnded) tx.endedByDatabase();
				return result;
			} catch (error) {
				if (error instanceof DatabaseError && error.transactionEnded) {
					tx.endedByDatabase();
				}
				throw error;
			}
		});
	}

	async transaction<T>(
		work: (tx: Transaction) => Promise<T>,
		inside?: Transaction,
	): Promise<T> {
		if (inside) {
			inside.assertBelongsTo(this);
			return inside.savepoint(() => work(inside));
		}

		const bridge = await this.bridge();

		const id = await this.attempt(
			new Statement('BEGIN IMMEDIATE'),
			null,
			() => bridge.begin(),
		);
		const tx = new Transaction(this, id);

		let result: T;
		let committing = false;
		this.openTransactions++;
		try {
			try {
				result = await work(tx);
			} finally {
				await tx.close();
			}
			tx.assertIntact();

			committing = true;
			await this.attempt(new Statement('COMMIT'), id, () =>
				bridge.commit(id),
			);
		} catch (error) {
			// A failed COMMIT, and a transaction SQLite ended, are already rolled back.
			if (!committing && !tx.wasEndedByDatabase) {
				await this.rollback(bridge, tx);
			}
			tx.undo();
			throw error;
		} finally {
			this.openTransactions--;
		}

		const failures = await tx.runAfterCommit();
		if (failures.length > 0) throw new AfterCommitError(result, failures);

		return result;
	}

	/**
	 * Refuses further use. Ends what lived with it, then rolls back whatever it left open and
	 * closes the file. One failure stops none of it; the first is thrown after.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;

		let failed = false;
		let first: unknown;
		try {
			this.left();
		} catch (error) {
			first = error;
			failed = true;
		}

		const connection = this.connection;
		this.connection = null;
		try {
			// A load still in flight is waited for, so the file it opens is not left open behind this.
			const bridge = connection ? await connection.catch(() => null) : null;
			await bridge?.close();
		} catch (error) {
			if (!failed) first = error;
			failed = true;
		}
		if (failed) throw first;
	}

	private async attempt<T>(
		statement: Statement,
		tx: number | null,
		call: () => Promise<T>,
	): Promise<T> {
		const started = performance.now();
		try {
			const result = await call();
			this.logger.succeeded(statement, tx, result, started);
			return result;
		} catch (error) {
			const failure = this.failureFrom(error, statement, tx);
			this.logger.failed(statement, tx, failure, started);
			throw failure;
		}
	}

	private failureFrom(
		error: unknown,
		statement: Statement,
		tx: number | null,
	): OrmError {
		if (error instanceof OrmError && !(error instanceof DatabaseError)) {
			return error;
		}

		const reported = error instanceof DatabaseError ? error : null;
		const code = reported?.code ?? 'unknown';
		const reason =
			reported?.message ??
			(error instanceof Error ? error.message : String(error));
		const forgotHandle =
			code === 'busy' && tx === null && this.openTransactions > 0;

		return new DatabaseError(
			`${reason}\n  while running: ${statement.sql}` +
				(forgotHandle ? `\n  ${FORGOTTEN_HANDLE}` : ''),
			code,
			reported?.cause ?? error,
			statement,
			reported?.transactionEnded ?? false,
		);
	}

	/** A failed rollback is reported, not thrown, so the error that caused it survives. */
	private async rollback(bridge: Bridge, tx: Transaction): Promise<void> {
		try {
			await this.attempt(new Statement('ROLLBACK'), tx.id, () =>
				bridge.rollback(tx.id),
			);
		} catch (error) {
			console.error('[orm] ROLLBACK failed.', error);
		}
	}

	private bridge(): Promise<Bridge> {
		if (this.closed) {
			return Promise.reject(
				new OrmError(
					`[orm] The database ${this.path} is closed. Make a new Database to open it again.`,
				),
			);
		}

		if (!this.connection) {
			const connection = Bridge.load(this.path, this.options).catch(
				error => {
					if (this.connection === connection) this.connection = null;
					throw error;
				},
			);
			this.connection = connection;
		}
		return this.connection;
	}
}

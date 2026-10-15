import { tick } from 'svelte';

import { TransactionError, type AfterCommitFailure } from '../errors';
import { Notices } from '../reactivity/notices';
import type { Database } from './database';
import { Statement } from './statement';

/** Savepoints nested deeper than this are a write triggering itself forever. */
const MAX_SAVEPOINT_DEPTH = 32;

/**
 * @internal Work that waits for a commit; `source` names it in an `AfterCommitError`. What `run`
 * does is told to Svelte with every other task's, at once; a function it returns runs after that.
 */
export interface AfterCommitTask {
	source: string;
	run: () => unknown;
}

/** What the transaction did that a reader is told of only once it commits. */
const NOTICES = { journal: 'notices' };

/** Kept as a journal, so a savepoint that rolls back drops the tasks queued inside it. */
const AFTER_COMMIT = { journal: 'after commit' };

export class Transaction {
	private open = true;
	private savepointsOpened = 0;
	private readonly stack: string[] = [];
	private broken: TransactionError | null = null;
	private ended = false;

	/** @internal Opened by the ORM for one of its own writes: rows read inside it are the shared instances. */
	openedByOrm = false;

	/** @internal Rows read in it are its own instances, not the shared ones: the app opened it. */
	get ownsReads(): boolean {
		return !this.openedByOrm;
	}
	/** What the connection was last given; the next call waits for it to settle. */
	private queue: Promise<void> = Promise.resolve();

	private readonly journals = new Map<object, unknown[]>();
	private readonly restorers: (() => void)[] = [];

	/** @internal Created by `Database.transaction()` only. */
	constructor(
		private readonly database: Database,
		readonly id: number,
	) {}

	get isOpen(): boolean {
		return this.open;
	}

	/** @internal How many savepoints have been set; one set while a write without its own ran may hold that write. */
	get savepointCount(): number {
		return this.savepointsOpened;
	}

	/** @internal */
	get wasEndedByDatabase(): boolean {
		return this.ended;
	}

	async savepoint<T>(work: () => Promise<T>): Promise<T> {
		this.assertOpen('set a savepoint');

		if (this.stack.length >= MAX_SAVEPOINT_DEPTH) {
			throw new TransactionError(
				`[orm] Savepoints are nested ${MAX_SAVEPOINT_DEPTH} deep. An event handler is ` +
					`writing a model whose handlers write it back; it must stop once nothing changes.`,
			);
		}

		const name = `sp_${++this.savepointsOpened}`;
		this.stack.push(name);
		const marks = this.mark();
		const restoreFrom = this.restorers.length;
		try {
			await this.database.run(new Statement(`SAVEPOINT ${name}`), this);
		} catch (error) {
			this.stack.splice(this.stack.lastIndexOf(name), 1);
			throw error;
		}

		let result: T;
		try {
			result = await work();
		} catch (error) {
			// Left alone when interleaved: rolling back to this savepoint would
			// undo the other work's statements with it.
			const interleaved = this.unstack(name);
			if (!interleaved) await this.discard(name, restoreFrom, marks);
			throw error;
		}

		const interleaved = this.unstack(name);
		if (interleaved) throw interleaved;
		try {
			await this.database.run(new Statement(`RELEASE SAVEPOINT ${name}`), this);
		} catch (error) {
			await this.discard(name, restoreFrom, marks);
			throw error;
		}
		return result;
	}

	/** @internal */
	assertBelongsTo(database: Database): void {
		if (this.database !== database) {
			throw new TransactionError(
				'[orm] This transaction belongs to another Database, so it cannot carry this statement.',
			);
		}
	}

	/** @internal */
	assertIntact(): void {
		if (this.broken) throw this.broken;
	}

	/** @internal Runs if what is written from here on is rolled back, by the transaction or an enclosing savepoint. */
	onRollback(restore: () => void): void {
		this.restorers.push(restore);
	}

	/** @internal Runs the `onRollback` work, newest first; `from` keeps what a savepoint found already there. */
	undo(from = 0): void {
		for (const restore of this.restorers.splice(from).reverse()) {
			try {
				restore();
			} catch (error) {
				console.error('[orm] Undoing a write after a rollback failed.', error);
			}
		}
	}

	/**
	 * @internal A list kept for `owner` that follows the transaction's writes:
	 * entries added inside a savepoint that rolls back are dropped with it.
	 */
	journal<T>(owner: object): T[] {
		let entries = this.journals.get(owner);
		if (!entries) {
			entries = [];
			this.journals.set(owner, entries);
		}
		return entries as T[];
	}

	/** @internal Runs after the outermost COMMIT, in the order queued, and never after a rollback. */
	onCommit(source: string, run: () => unknown): AfterCommitTask {
		const task = { source, run };
		this.journal<AfterCommitTask>(AFTER_COMMIT).push(task);
		return task;
	}

	/** @internal Whether `task` is still queued: a savepoint that rolled back drops what was queued inside it. */
	queued(task: AfterCommitTask): boolean {
		return this.journal<AfterCommitTask>(AFTER_COMMIT).includes(task);
	}

	/** @internal Tells a reader once the transaction commits, with everything else it did; never after a rollback. */
	notify(notice: () => void): void {
		this.journal<() => void>(NOTICES).push(notice);
	}

	/**
	 * @internal Each task runs whatever the others do; a throw is its failure, and a list it
	 * returns is failures of its own. Svelte is told of all of them at once, then what they
	 * returned to run afterwards runs.
	 */
	async runAfterCommit(): Promise<AfterCommitFailure[]> {
		const failures: AfterCommitFailure[] = [];
		const afterwards: AfterCommitTask[] = [];
		const taken = (source: string, result: unknown): void => {
			if (Array.isArray(result)) failures.push(...(result as AfterCommitFailure[]));
			else if (typeof result === 'function') afterwards.push({ source, run: result as () => unknown });
		};

		Notices.hold();
		try {
			for (const { source, run } of this.journal<AfterCommitTask>(AFTER_COMMIT).splice(0)) {
				try {
					taken(source, await run());
				} catch (error) {
					failures.push({ source, error });
				}
			}
			for (const notice of this.journal<() => void>(NOTICES).splice(0)) notice();
		} finally {
			Notices.release();
		}
		// What reads the models has run again before a handler does.
		await tick();

		for (const { source, run } of afterwards) {
			try {
				taken(source, await run());
			} catch (error) {
				failures.push({ source, error });
			}
		}
		return failures;
	}

	/** @internal Settles once the call already on the connection has, so COMMIT or ROLLBACK follows it. */
	close(): Promise<void> {
		this.open = false;
		return this.queue;
	}

	/**
	 * @internal One call at a time on the connection, in the order made. A call still
	 * waiting when the callback returns is refused, and the transaction rolls back.
	 */
	send<T>(call: () => Promise<T>): Promise<T> {
		this.assertOpen('run a statement');

		// Accepted while the handle was open; closed since means its turn never came in time.
		const next = () => {
			if (!this.open) throw this.refusal();
			this.assertIntact();
			return call();
		};
		const turn = this.queue.then(next, next);
		this.queue = turn.then(
			() => {},
			() => {},
		);
		return turn;
	}

	private mark(): Map<object, number> {
		const marks = new Map<object, number>();
		for (const [owner, entries] of this.journals) {
			marks.set(owner, entries.length);
		}
		return marks;
	}

	private unstack(name: string): TransactionError | null {
		const at = this.stack.lastIndexOf(name);
		const innermost = at !== -1 && at === this.stack.length - 1;
		if (at !== -1) this.stack.splice(at, 1);

		return innermost && !this.broken ? null : this.overlapped();
	}

	private async discard(
		name: string,
		restoreFrom: number,
		marks: Map<object, number>,
	): Promise<void> {
		if (!this.ended) {
			try {
				await this.database.run(
					new Statement(`ROLLBACK TO SAVEPOINT ${name}`),
					this,
				);
				await this.database.run(
					new Statement(`RELEASE SAVEPOINT ${name}`),
					this,
				);
			} catch (error) {
				console.error(`[orm] ROLLBACK TO ${name} failed.`, error);
			}
		}

		this.undo(restoreFrom);
		for (const [owner, entries] of this.journals) {
			entries.length = marks.get(owner) ?? 0;
		}
	}

	private assertOpen(action: string): void {
		this.assertIntact();
		if (!this.open) {
			throw new TransactionError(
				`[orm] This transaction has ended, so it cannot ${action}. ` +
					`A handle is valid only inside the callback that received it.`,
			);
		}
	}

	private refusal(): TransactionError {
		this.broken ??= new TransactionError(
			'[orm] A statement was still waiting its turn on this transaction when the callback ' +
				'returned, so it never ran and the transaction is rolled back. Await every ' +
				'statement inside the callback, including those an event handler or a relation writes.',
		);
		return this.broken;
	}

	/** @internal */
	overlapped(): TransactionError {
		this.broken ??= new TransactionError(
			'[orm] Two pieces of work ran at once on one transaction handle, so their statements ' +
				'interleaved on its one connection and the transaction is rolled back. ' +
				'Await each, or give each its own transaction.',
		);
		return this.broken;
	}

	/** @internal */
	endedByDatabase(): void {
		this.ended = true;
		this.broken ??= new TransactionError(
			'[orm] The transaction ended on the database before its callback returned: a statement ' +
				'failed in a way that made SQLite roll all of it back, or raw SQL ended it. ' +
				'The handle takes no more work.',
		);
	}
}

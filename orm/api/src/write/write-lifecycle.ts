import type { Database } from '../database/database';
import type { Transaction } from '../database/transaction';
import { AfterCommitError } from '../errors';
import {
	DELETE_VERBS,
	IN_WRITE,
	INSERT_VERBS,
	UPDATE_VERBS,
	type CommitHandler,
	type EventVerb,
} from '../events/events';
import type { Checkpoint } from '../model/attributes';
import type { Model } from '../model/model';
import type { Changes, ModelClass, Written } from '../model/types';
import type { Entry, WriteKind } from '../query/live';
import { Notices } from '../reactivity/notices';
import { Settlement } from './settlement';

/**
 * A model a write landed, and the change each column it wrote was. `finish` reloads the
 * model's loaded relations that depend on those columns: writing `post.author_id` reloads
 * `post.author`.
 */
export interface Landed<M> {
	model: M;
	changes: Changes<M>;
}

/**
 * One write while it runs, and everything around its SQL: the transaction it runs in, if
 * any, its events, and what it hands to the settlement after the commit. `ModelInsert`,
 * `ModelUpdate` and `ModelDelete` each begin with `start` and, when rows landed, end with `finish`.
 */
export class WriteLifecycle<M extends Model> {
	/** The events each kind of write fires, `:before` in this order and `:after` in reverse. */
	private static readonly VERBS: Readonly<
		Record<WriteKind, readonly EventVerb[]>
	> = {
		created: INSERT_VERBS,
		updated: UPDATE_VERBS,
		deleted: DELETE_VERBS,
	};

	private readonly queued: ReturnType<Settlement['queue']>[] = [];
	private readonly recorded: Entry[] = [];
	private readonly tracked = new Map<M, Checkpoint>();
	private readonly verbs: readonly EventVerb[];

	private constructor(
		private readonly modelClass: ModelClass<M>,
		private readonly kind: WriteKind,
		readonly tx: Transaction | undefined,
		private readonly settlement: Settlement,
	) {
		this.verbs = WriteLifecycle.VERBS[kind];
	}

	/**
	 * Runs `work`, one write: in a transaction of its own (a savepoint inside `tx`) when a
	 * `:before`/`:after` handler exists or it takes more than one statement; else in `tx`, or none.
	 */
	static async around<M extends Model, T>(
		modelClass: ModelClass<M>,
		kind: WriteKind,
		/** `oneStatement` as a function is asked only when no handler has already decided on a transaction. */
		options: { tx?: Transaction; oneStatement: boolean | (() => boolean) },
		work: (lifecycle: WriteLifecycle<M>) => Promise<T>,
	): Promise<T> {
		const { tx, oneStatement } = options;
		const { database } = modelClass;

		if (
			modelClass.$events.has(WriteLifecycle.VERBS[kind], IN_WRITE) ||
			!(typeof oneStatement === 'function'
				? oneStatement()
				: oneStatement)
		) {
			return WriteLifecycle.transaction(database, tx, inner =>
				work(
					new WriteLifecycle(
						modelClass,
						kind,
						inner,
						Settlement.of(database, inner),
					),
				),
			);
		}

		if (tx) {
			const lifecycle = new WriteLifecycle(
				modelClass,
				kind,
				tx,
				Settlement.of(database, tx),
			);
			const savepoints = tx.savepointCount;
			try {
				return await work(lifecycle);
			} catch (error) {
				// No savepoint of its own to roll back.
				lifecycle.settlement.withdraw(
					lifecycle.queued,
					lifecycle.recorded,
				);
				lifecycle.restoreUnwritten();
				throw error;
			} finally {
				// A savepoint opened meanwhile may hold this write's statements: two writes ran unawaited.
				if (tx.savepointCount !== savepoints) tx.overlapped();
			}
		}

		const lifecycle = new WriteLifecycle(
			modelClass,
			kind,
			undefined,
			Settlement.immediate(database),
		);
		// Held from here: what the write tells as it lands goes out with what its settlement tells.
		Notices.hold();
		let result: T;
		try {
			result = await work(lifecycle);
		} catch (error) {
			lifecycle.restoreUnwritten();
			Notices.release();
			throw error;
		}

		// No transaction to settle after: the write's own statement was its commit.
		const failures = await lifecycle.settlement.run();
		if (failures.length > 0) throw new AfterCommitError(result, failures);
		return result;
	}

	/**
	 * A transaction for one of the ORM's own writes: `tx` when the caller gave one, otherwise
	 * one opened here and marked the ORM's, so rows read inside it are the shared instances.
	 */
	static transaction<T>(
		database: Database,
		tx: Transaction | undefined,
		work: (inner: Transaction) => Promise<T>,
	): Promise<T> {
		return database.transaction(inner => {
			if (!tx) inner.openedByOrm = true;
			return work(inner);
		}, tx);
	}

	/**
	 * Every write begins here: takes each model's checkpoint, queues its `:committed` handlers,
	 * then fires `:before` with `announced`, which a delete narrows to the rows it removes.
	 */
	async start(models: readonly M[], announced: Written<M>): Promise<void> {
		this.track(models);
		// Queued before any `:before` handler runs: a write a handler makes queues its own
		// `:committed` handlers after this write's, in the order the writes began.
		for (const verb of [...this.verbs].reverse()) {
			for (const handler of this.modelClass.$events.handlersFor(
				`${verb}:committed`,
			)) {
				this.queued.push(
					this.settlement.queue(
						`${verb}:committed on ${this.modelClass.name}`,
						handler as CommitHandler<M>,
					),
				);
			}
		}
		for (const verb of this.verbs)
			await this.fire(verb, 'before', announced);
	}

	/** Right before the statements go out: the values each model is about to send are noted, so a failure keeps what the app assigned since. */
	sending(models: readonly M[]): void {
		for (const model of models) this.tracked.get(model)?.sending();
	}

	/**
	 * Every write whose rows landed ends here: records what changed for the settlement, fires
	 * `:after`, then reloads the loaded relations keyed off the columns written.
	 */
	async finish(landed: readonly Landed<M>[]): Promise<void> {
		if (landed.length === 0) return;
		const written: Written<M> = landed.map(
			({ model, changes }) => [model, changes] as const,
		);
		const { kind } = this;
		const entries: Entry[] = landed.map(({ model, changes }) => ({
			model,
			kind,
			changes,
		}));
		this.recorded.push(...entries);
		this.settlement.record(entries);
		for (const queued of this.queued) queued.entries.push(...entries);

		for (const verb of [...this.verbs].reverse())
			await this.fire(verb, 'after', written);

		for (const { model, changes } of landed) {
			await model.$relations.refreshAffected(
				Object.keys(changes),
				this.tx,
			);
		}
	}

	/** Runs the `:before` or `:after` handlers, inside the write's transaction. */
	private async fire(
		verb: EventVerb,
		moment: 'before' | 'after',
		written: Written<M>,
	): Promise<void> {
		const handlers = this.modelClass.$events.handlersFor(
			`${verb}:${moment}`,
		);
		// A write that started with no `:before`/`:after` handler has no transaction to give one.
		// A handler registered while it was running applies from the next write.
		if (written.length === 0 || handlers.length === 0 || !this.tx) return;

		for (const handler of handlers) {
			await handler(written, this.tx);
		}
	}

	/** If the write fails or its transaction rolls back, each model goes back to what it was when it began. */
	private track(models: readonly M[]): void {
		for (const model of models) {
			const checkpoint = model.$checkpoint();
			this.tracked.set(model, checkpoint);
			this.tx?.onRollback(() => checkpoint.restore());
		}
	}

	/** For a failed write no rollback covers, which is one statement that did not land: its models go back. */
	private restoreUnwritten(): void {
		for (const checkpoint of this.tracked.values()) checkpoint.restore();
	}
}

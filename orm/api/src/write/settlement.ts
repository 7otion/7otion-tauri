import { tick } from 'svelte';

import type { Database } from '../database/database';
import type { AfterCommitTask, Transaction } from '../database/transaction';
import type { AfterCommitFailure } from '../errors';
import type { CommitHandler } from '../events/events';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import { LiveRegistry, type Entry } from '../query/live';
import { Notices } from '../reactivity/notices';

/** A `:committed` handler, queued when its write began; `entries` are filled in once the write landed. */
export interface QueuedHandler {
	source: string;
	handler: CommitHandler<any>;
	entries: Entry[];
}

const ENTRIES = { journal: 'settlement entries' };
const HANDLERS = { journal: 'settlement handlers' };

/**
 * After a commit: the models are made true, in a turn, while the notices are held; then the
 * `:committed` handlers run. Journaled on the transaction, so a savepoint rollback drops its part.
 */
export class Settlement {
	private static readonly ofTransaction = new WeakMap<
		Transaction,
		Settlement
	>();

	private task: AfterCommitTask | null = null;
	/** Deleted rows a read made while their delete ran left a second instance for. */
	private readonly strays: Entry[] = [];

	private constructor(
		private readonly database: Database,
		private readonly entries: Entry[],
		private readonly handlers: QueuedHandler[],
	) {}

	/** The transaction's settlement, run after its COMMIT. */
	static of(database: Database, tx: Transaction): Settlement {
		let settlement = Settlement.ofTransaction.get(tx);
		if (!settlement) {
			settlement = new Settlement(
				database,
				tx.journal<Entry>(ENTRIES),
				tx.journal<QueuedHandler>(HANDLERS),
			);
			Settlement.ofTransaction.set(tx, settlement);
		}
		// Queued again when a savepoint that rolled back took it with the writes made inside it.
		if (!settlement.task || !tx.queued(settlement.task)) {
			const queued = settlement;
			settlement.task = tx.onCommit('settle', () => queued.settle());
		}
		return settlement;
	}

	/** For a write with no transaction: `run` right after its statement. */
	static immediate(database: Database): Settlement {
		return new Settlement(database, [], []);
	}

	record(entries: readonly Entry[]): void {
		this.entries.push(...entries);
	}

	queue(source: string, handler: CommitHandler<any>): QueuedHandler {
		const queued = { source, handler, entries: [] };
		this.handlers.push(queued);
		return queued;
	}

	/** Takes back what a write that failed had queued, when no savepoint rollback will. */
	withdraw(
		handlers: readonly QueuedHandler[],
		entries: readonly Entry[],
	): void {
		for (const list of [this.handlers, this.entries] as unknown[][]) {
			for (const item of list === this.handlers ? handlers : entries) {
				const index = list.indexOf(item);
				if (index !== -1) list.splice(index, 1);
			}
		}
	}

	/** Settles a write with no transaction, whose lifecycle held the notices when it began. */
	async run(): Promise<AfterCommitFailure[]> {
		let handle: () => Promise<AfterCommitFailure[]>;
		try {
			handle = await this.settle();
		} finally {
			Notices.release();
		}
		// What reads the models has run again before a handler does.
		await tick();
		return handle();
	}

	/** Makes the models true, with the notices held by the caller; what it returns runs the `:committed` handlers. */
	async settle(): Promise<() => Promise<AfterCommitFailure[]>> {
		const failures: AfterCommitFailure[] = [];
		const handlers = this.handlers.splice(0);
		const { shared } = await this.madeTrue(failures);

		return async () => {
			for (const { source, handler, entries: told } of handlers) {
				if (told.length === 0) continue;
				try {
					await handler(
						told.map(
							entry =>
								[shared(entry).model, entry.changes] as const,
						),
					);
				} catch (error) {
					failures.push({ source, error });
				}
			}
			return failures;
		};
	}

	/** Makes the shared instances, loaded relations and collections show this commit, after every earlier commit of the database. */
	private madeTrue(
		failures: AfterCommitFailure[],
	): Promise<{ shared: (entry: Entry) => Entry }> {
		const registry = LiveRegistry.of(this.database);
		return registry.turn(async () => {
			const resolved = new Map<Entry, Entry>();
			const shared = (entry: Entry): Entry => {
				let found = resolved.get(entry);
				if (!found) {
					found = this.adoptShared(entry);
					resolved.set(entry, found);
				}
				return found;
			};
			const written = this.entries.splice(0);
			const entries = written.map(shared);
			entries.push(...this.strays.splice(0));

			for (const entry of entries) {
				const signals = entry.model.$signals;
				const { table } = entry.model.constructor as ModelClass;
				if (entry.kind === 'deleted')
					signals.gone(table.columns.keys());
				else if (entry.kind === 'created') signals.created();
				else signals.committed(Object.keys(entry.changes));
			}

			// A write loaded its model's relations again as it landed. The shared instance a
			// transaction's own one stands for saw no write, so its relations follow here.
			for (const [index, entry] of entries.entries()) {
				if (
					entry.kind === 'deleted' ||
					entry.model === written[index]!.model
				)
					continue;
				try {
					await entry.model.$relations.followKeys(
						Object.keys(entry.changes),
					);
				} catch (error) {
					failures.push({ source: 'loaded relations', error });
				}
			}
			for (const error of await registry.reconcile(entries)) {
				failures.push({ source: 'collections', error });
			}
			return { shared };
		});
	}

	/**
	 * The shared instance standing for a transaction's own, found by the key the row had before,
	 * made when nobody holds one; a deleted row nobody held is told by a detached copy.
	 */
	private adoptShared(entry: Entry): Entry {
		const { model } = entry;
		const modelClass = model.constructor as ModelClass;
		const map = IdentityMap.of(this.database);
		const signature = model.$attributes.persistedKeySignature();

		if (!model.$scope) {
			// A read made outside the transaction while it ran may have left another instance for the row.
			const other =
				entry.kind === 'deleted' && signature !== null
					? map.get(modelClass, signature)
					: undefined;
			if (other && other !== model) {
				Settlement.retire(other, signature);
				this.strays.push({ ...entry, model: other });
			}
			return entry;
		}

		const before = Settlement.signatureBefore(entry);
		let shared =
			(before === null ? undefined : map.get(modelClass, before)) ??
			(signature === null ? undefined : map.get(modelClass, signature));

		if (entry.kind === 'deleted') {
			if (shared) {
				Settlement.retire(shared, before ?? signature);
				return { ...entry, model: shared };
			}
			const copy = new modelClass();
			copy.$attributes.accept(model.$attributes.all());
			return { ...entry, model: copy };
		}

		if (!shared) {
			shared = new modelClass();
			shared.$attributes.accept(model.$attributes.all());
			shared.$exists = true;
			map.register(shared);
		} else {
			const held = shared.$attributes.persistedKeySignature();
			shared.$attributes.refreshed(model.$attributes.all());
			shared.$exists = true;
			map.moved(shared, held);
		}
		return { ...entry, model: shared };
	}

	/** The key signature the row had before the write `entry` stands for. */
	private static signatureBefore(entry: Entry): string | null {
		const { table } = entry.model.constructor as ModelClass;
		const columns = table.primaryKey.columns;
		const changes = entry.changes as Record<
			string,
			{ from: unknown } | undefined
		>;
		return table.signature(
			columns,
			columns.map(column =>
				changes[column] && entry.kind !== 'created'
					? changes[column]!.from
					: entry.model.$attributes.get(column),
			),
		);
	}

	/** A shared instance whose row is gone: it says so, keeps no edits, and leaves the map. */
	private static retire(model: Model, signature: string | null): void {
		model.$exists = false;
		model.$signals.gone([]);
		const before = model.$attributes.shownSnapshot();
		model.$attributes.discard();
		IdentityMap.of((model.constructor as ModelClass).database).forget(
			model,
			signature,
		);
		model.$edited(model.$attributes.shownChangedSince(before));
	}
}

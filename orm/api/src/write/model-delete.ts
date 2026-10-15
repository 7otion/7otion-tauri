import type { Transaction } from '../database/transaction';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import { Drafts } from '../model/draft';
import { Chunks } from '../sql/chunks';
import { DeleteBuilder } from '../sql/delete';
import { WriteLifecycle } from './write-lifecycle';

const CLAIMS = { journal: 'claimed deletes' };

/**
 * Deletes a list of models by their keys, never by the query that found them: a
 * `delete:before` handler may make other rows match it. One model is a list of one.
 */
export class ModelDelete<M extends Model> {
	constructor(private readonly modelClass: ModelClass<M>) {}

	/** The models whose rows were removed, or what `answer` makes of them; an `AfterCommitError` carries the same. */
	write(given: readonly M[], tx?: Transaction): Promise<M[]>;
	write<R>(
		given: readonly M[],
		tx: Transaction | undefined,
		answer: (removed: M[]) => R,
	): Promise<R>;
	async write<R>(
		given: readonly M[],
		tx?: Transaction,
		answer?: (removed: M[]) => R,
	): Promise<R | M[]> {
		const result = answer ?? ((removed: M[]) => removed);
		const models = Drafts.models(given);
		for (const model of models) {
			model.$assertWritable(tx);
			model.$assertStored('delete');
		}
		if (models.length === 0) return result([]);

		return WriteLifecycle.around(
			this.modelClass,
			'deleted',
			{ tx, oneStatement: () => this.keyChunks(models).length === 1 },
			async lifecycle => result(await this.within(lifecycle, models)),
		);
	}

	/**
	 * Rows another delete in this transaction is already removing (see `claim`) are left to
	 * that delete: this one fires no events for them, but marks their models deleted.
	 */
	private async within(
		lifecycle: WriteLifecycle<M>,
		models: readonly M[],
	): Promise<M[]> {
		const { mine, claims } = this.claim(lifecycle.tx, models);
		await lifecycle.start(
			models,
			mine.map(model => [model, {}] as const),
		);
		for (const model of models) {
			if (!mine.includes(model)) model.$exists = false;
		}

		try {
			lifecycle.sending(mine);
			const removed = await this.send(mine, lifecycle.tx);
			// A row that was already missing counts as deleted: the caller wanted it gone, and it is.
			// Its pending edits go with it: nothing is left to save them on.
			for (const model of mine) {
				model.$exists = false;
				const before = model.$attributes.shownSnapshot();
				model.$attributes.discard();
				IdentityMap.holding(model).forget(model, model.$attributes.persistedKeySignature());
				model.$edited(model.$attributes.shownChangedSince(before));
			}
			// A row found already gone is in no commit to tell of it.
			for (const model of mine) {
				if (!removed.includes(model)) model.$signals.gone(this.modelClass.table.columns.keys());
			}
			if (removed.length === 0) return [];

			await lifecycle.finish(
				removed.map(model => ({ model, changes: {} })),
			);
			return removed;
		} finally {
			this.release(lifecycle.tx, claims);
		}
	}

	/**
	 * The models this delete removes and announces: one per row, and none another delete in
	 * this transaction already claimed, as a handler deleting back the row that started it does.
	 */
	private claim(
		tx: Transaction | undefined,
		models: readonly M[],
	): { mine: M[]; claims: string[] } {
		// Kept on the transaction; a savepoint that rolls back drops what was added inside it.
		const ledger = tx ? tx.journal<string>(CLAIMS) : [];
		const claimed = new Set(ledger);
		const claims: string[] = [];

		const mine = models.filter(model => {
			const claim = this.claimOf(model);
			if (claimed.has(claim)) return false;

			claimed.add(claim);
			claims.push(claim);
			ledger.push(claim);
			return true;
		});
		return { mine, claims };
	}

	/** Drops this delete's claims, as made: a handler may have changed a model's key since. */
	private release(tx: Transaction | undefined, claims: readonly string[]): void {
		if (!tx) return;

		const ledger = tx.journal<string>(CLAIMS);
		for (const claim of claims) {
			const index = ledger.indexOf(claim);
			if (index !== -1) ledger.splice(index, 1);
		}
	}

	private claimOf(model: M): string {
		return `${this.modelClass.table.name}/${model.$attributes.persistedKeySignature()}`;
	}

	/** Sends `DELETE … WHERE key IN (…) RETURNING key`, and returns the models whose rows it removed. */
	private async send(
		models: readonly M[],
		tx: Transaction | undefined,
	): Promise<M[]> {
		const { table, database } = this.modelClass;
		const keyColumns = table.primaryKey.columns;
		const removed = new Set<string | null>();

		for (const chunk of this.keyChunks(models)) {
			const result = await database.run(
				DeleteBuilder.from(table.name)
					.matching(
						this.modelClass.query().whereAnyOf(keyColumns, chunk).builder
							.conditions,
					)
					.returning(...keyColumns),
				tx,
			);
			for (const row of result.rows) {
				removed.add(table.keySignature(table.decode(row)));
			}
		}

		return models.filter(model =>
			removed.has(model.$attributes.persistedKeySignature()),
		);
	}

	/** The models' keys, split so no statement binds more values than SQLite allows. */
	private keyChunks(models: readonly M[]): unknown[][][] {
		return Chunks.of(
			models.map(model => model.$attributes.persistedKey()),
			this.modelClass.table.primaryKey.columns.length,
		);
	}
}

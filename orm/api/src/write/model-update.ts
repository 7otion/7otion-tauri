import type { Value } from '../database/statement';
import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { Drafts } from '../model/draft';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { Changes, ModelClass } from '../model/types';
import { Chunks } from '../sql/chunks';
import type { Conditions } from '../sql/conditions';
import type { Values } from '../sql/insert';
import { UpdateBuilder } from '../sql/update';
import { UpdateManyBuilder } from '../sql/update-many';
import { WriteLifecycle, type Landed } from './write-lifecycle';

/** One model's row, ready to send. */
interface PlannedRow<M> {
	model: M;
	/** The key the row has in the database now, encoded. Finds the row even when this update changes the key. */
	key: Value[];
	/** The columns to write, encoded. */
	set: Values;
	/** The same values as the model will hold them once stored, taken before sending. */
	sent: Record<string, unknown>;
	/** This update changes the row's primary key. */
	rekeyed: boolean;
	/** A `:before` handler edited the model, so its values are not `values` alone. */
	edited: boolean;
}

/**
 * Updates a list of models; one model is a list of one. If any row turns out to be
 * missing, the whole write fails and nothing of it stays.
 */
export class ModelUpdate<M extends Model> {
	/**
	 * A shared UPDATE picks each row's value with `CASE WHEN id = 1 THEN … WHEN id = 2 THEN …`.
	 * SQLite reads that list from the top for every row, so n rows cost n²; 500 keeps it fast.
	 */
	private static readonly ROWS_PER_STATEMENT = 500;

	/**
	 * `only`: just those pending edits. `values`: these, past the draft, even if unchanged.
	 * `matching`: selects exactly the models' rows, for one UPDATE. `:before` edits always go too.
	 */
	constructor(
		private readonly modelClass: ModelClass<M>,
		private readonly options: {
			only?: readonly string[];
			values?: (model: M) => Readonly<Record<string, unknown>>;
			matching?: Conditions;
		} = {},
	) {}

	/** The updated models, or what `answer` makes of them; an `AfterCommitError` carries the same. */
	write(given: readonly M[], tx?: Transaction): Promise<M[]>;
	write<R>(
		given: readonly M[],
		tx: Transaction | undefined,
		answer: (written: M[]) => R,
	): Promise<R>;
	async write<R>(
		given: readonly M[],
		tx?: Transaction,
		answer?: (written: M[]) => R,
	): Promise<R | M[]> {
		const result = answer ?? ((written: M[]) => written);
		const models = Drafts.models(given);
		for (const model of models) {
			model.$assertWritable(tx);
			model.$assertStored('update');
		}

		const changed = this.withChanges(models);
		if (changed.length === 0) return result([]);

		return WriteLifecycle.around(
			this.modelClass,
			'updated',
			// One row, not one statement: an UPDATE of two rows may write one and find the other
			// missing, and the written one must then be rolled back, which needs a transaction.
			{ tx, oneStatement: changed.length === 1 },
			async lifecycle => result(await this.within(lifecycle, changed)),
		);
	}

	private async within(
		lifecycle: WriteLifecycle<M>,
		models: readonly M[],
	): Promise<M[]> {
		const { table } = this.modelClass;
		const limited = this.options.only !== undefined || this.options.values !== undefined;
		const before = limited ? models.map(model => model.$attributes.pendingSnapshot()) : [];
		await lifecycle.start(
			models,
			models.map(model => [model, this.changesOf(model)] as const),
		);

		// Planned only now: a `:before` handler may have changed the models, and its edits are
		// written too. One that deleted a model fails the write, as a row found missing does.
		for (const model of models) model.$assertStored('update');
		const rows = this.plan(
			models,
			models.map((model, index) =>
				limited ? ModelUpdate.editedBy(model, before[index]!) : [],
			),
		);
		if (rows.length === 0) return [];

		const stamp = table.readBackAll(table.timestamps.updateStamp(new Date()));
		lifecycle.sending(rows.map(({ model }) => model));

		const missing = await this.send(rows, stamp, lifecycle.tx);
		if (missing.length > 0) throw this.missingError(missing, rows.length);

		const landed: Landed<M>[] = rows.map(({ model, sent, rekeyed }) => {
			const before = model.$attributes.persistedKeySignature();
			const changes = ModelUpdate.changesBetween(model, { ...sent, ...stamp });
			const shown = model.$attributes.shownSnapshot();
			// Marks as saved what the statement carried. A column the app assigned while it
			// was running was not carried, so it stays unsaved.
			model.$attributes.written(sent, stamp, lifecycle.tx);
			if (rekeyed) IdentityMap.holding(model).moved(model, before);
			model.$edited(model.$attributes.shownChangedSince(shown));
			return { model, changes };
		});

		await lifecycle.finish(landed);
		return landed.map(({ model }) => model);
	}

	/** The columns this write carries for `model` as they stand, each from its committed value to the one it writes. */
	private changesOf(model: M): Changes<M> {
		return ModelUpdate.changesBetween(
			model,
			Object.fromEntries(
				this.columnsOf(model).map(column => [column, this.valueOf(model, column)]),
			),
		);
	}

	private valueOf(model: M, column: string): unknown {
		const values = this.options.values?.(model);
		return values && column in values
			? values[column]
			: model.$attributes.draftValue(column);
	}

	/** The edits a `:before` handler made on `model`'s draft since `before` was taken. */
	private static editedBy<M extends Model>(
		model: M,
		before: Readonly<Record<string, unknown>>,
	): string[] {
		const dirty = model.$attributes.dirty();
		return model.$attributes
			.pendingChangedSince(before)
			.filter(column => dirty.includes(column));
	}

	private static changesBetween<M extends Model>(
		model: M,
		values: Readonly<Record<string, unknown>>,
	): Changes<M> {
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		for (const [column, to] of Object.entries(values)) {
			changes[column] = { from: model.$attributes.get(column), to };
		}
		return changes as Changes<M>;
	}

	/**
	 * The models with something to write. Two changed instances of one row, a transaction's
	 * own and the shared one, are refused: a shared UPDATE has one `WHEN` per row.
	 */
	private withChanges(models: readonly M[]): M[] {
		const changed = models.filter(model => this.columnsOf(model).length > 0);

		const rows = new Set<string | null>();
		for (const model of changed) {
			const key = model.$attributes.persistedKeySignature();
			if (rows.has(key)) {
				throw new OrmError(
					`[orm] Two ${this.modelClass.name} instances of the row ` +
						`${model.$attributes.persistedKey().join('/')} were given, each with changes: one read ` +
						'inside a transaction, one outside it. Save them one after the other.',
				);
			}
			rows.add(key);
		}
		return changed;
	}

	/** The columns this write carries for `model`: `values`' columns, or its pending edits within `only` when given. */
	private columnsOf(model: M): string[] {
		const { only, values } = this.options;
		if (values) return Object.keys(values(model));
		const dirty = this.modelClass.table.timestamps.without(
			model.$attributes.dirty(),
		);
		return only ? dirty.filter(column => only.includes(column)) : dirty;
	}

	/** `edited[i]` are the columns a `:before` handler edited on `models[i]`, written from the draft. */
	private plan(models: readonly M[], edited: readonly (readonly string[])[]): PlannedRow<M>[] {
		const { table } = this.modelClass;
		const keyColumns = table.primaryKey.columns;
		const rows: PlannedRow<M>[] = [];

		for (const [index, model] of models.entries()) {
			const columns = [...new Set([...this.columnsOf(model), ...edited[index]!])];
			if (columns.length === 0) continue;

			const values = Object.fromEntries(
				columns.map(column => [
					column,
					edited[index]!.includes(column)
						? model.$attributes.draftValue(column)
						: this.valueOf(model, column),
				]),
			);
			rows.push({
				model,
				key: keyColumns.map(column =>
					table.column(column).encode(model.$attributes.persisted(column)),
				),
				set: table.encode(values),
				sent: table.readBackAll(values),
				rekeyed: columns.some(column => keyColumns.includes(column)),
				edited: edited[index]!.length > 0,
			});
		}
		return rows;
	}

	/**
	 * Groups the rows into UPDATEs. A row whose primary key changes gets an UPDATE of its own:
	 * in a shared one, rows moving onto each other's keys would collide. The rest share
	 * UPDATEs, as many rows per statement as SQLite's limit on bound values allows.
	 */
	private statements(rows: readonly PlannedRow<M>[]): PlannedRow<M>[][] {
		const rekeyed = rows.filter(row => row.rekeyed).map(row => [row]);
		const shared = rows.filter(row => !row.rekeyed);
		if (shared.length === 0) return rekeyed;

		const keys = this.modelClass.table.primaryKey.columns.length;
		const columns = new Set(shared.flatMap(({ set }) => Object.keys(set))).size;
		// Bound values per row: for each column, the key and the value in its CASE; then the key once more in the WHERE.
		const byParams = Chunks.sizeFor(columns * (keys + 1) + keys);
		return [
			...rekeyed,
			...Chunks.sized(
				shared,
				Math.min(byParams, ModelUpdate.ROWS_PER_STATEMENT),
			),
		];
	}

	/** Sends the UPDATEs, and returns the models whose rows turned out to be missing. */
	private async send(
		rows: readonly PlannedRow<M>[],
		stamp: Record<string, unknown>,
		tx: Transaction | undefined,
	): Promise<M[]> {
		const { table, database } = this.modelClass;
		const stamped = table.encode(stamp);
		const missing: M[] = [];

		const { matching } = this.options;
		if (matching && rows.every(({ rekeyed, edited }) => !rekeyed && !edited)) {
			const { affected } = await database.run(
				UpdateBuilder.table(table.name)
					.set({ ...rows[0]!.set, ...stamped })
					.matching(matching),
				tx,
			);
			return affected < rows.length ? this.findMissing(rows, tx) : [];
		}

		for (const statement of this.statements(rows)) {
			if (statement.length === 1) {
				const [row] = statement as [PlannedRow<M>];
				const { affected } = await database.run(
					this.whereKey(
						UpdateBuilder.table(table.name).set({ ...row.set, ...stamped }),
						row.key,
					),
					tx,
				);
				if (affected === 0) missing.push(row.model);
				continue;
			}

			const { affected } = await database.run(
				UpdateManyBuilder.table(table.name, table.primaryKey.columns)
					.rows(statement.map(({ key, set }) => ({ key, set })))
					.shared(stamped),
				tx,
			);
			// SQLite counts every row the WHERE found, even one whose values did not change,
			// so fewer than sent means some rows are missing. A SELECT finds which.
			if (affected < statement.length) {
				missing.push(...(await this.findMissing(statement, tx)));
			}
		}
		return missing;
	}

	private whereKey(builder: UpdateBuilder, key: readonly Value[]): UpdateBuilder {
		return this.modelClass.table.primaryKey.columns.reduce(
			(located, column, index) => located.where(column, key[index]!),
			builder,
		);
	}

	/** The models among `rows` whose row is not in the table. */
	private async findMissing(
		rows: readonly PlannedRow<M>[],
		tx: Transaction | undefined,
	): Promise<M[]> {
		const { table } = this.modelClass;
		const keyColumns = table.primaryKey.columns;
		const present = new Set<string | null>();

		for (const chunk of Chunks.of(
			rows.map(({ model }) => model.$attributes.persistedKey()),
			keyColumns.length,
		)) {
			const found = await this.modelClass
				.query()
				.select(...(keyColumns as never[]))
				.whereAnyOf(keyColumns, chunk)
				.rows(tx);
			for (const row of found) {
				present.add(table.keySignature(table.decode(row)));
			}
		}

		return rows
			.map(({ model }) => model)
			.filter(model => !present.has(model.$attributes.persistedKeySignature()));
	}

	private missingError(missing: readonly M[], of: number): OrmError {
		const keys = missing
			.map(model => model.$attributes.persistedKey().join('/'))
			.join(', ');
		return new OrmError(
			`[orm] ${missing.length} of ${of} ${this.modelClass.table.name} rows no longer exist, ` +
				`so nothing was written: ${keys}.`,
		);
	}
}

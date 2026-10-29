import type { Row, Value } from '../database/statement';
import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { INSERT_VERBS } from '../events/events';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { Changes, ModelClass } from '../model/types';
import { Drafts } from '../model/draft';
import { Chunks } from '../sql/chunks';
import { InsertBuilder, type Values } from '../sql/insert';
import { WriteLifecycle, type Landed } from './write-lifecycle';

/** The models one INSERT carries, with their rows in the same order. */
interface InsertChunk<M> {
	models: M[];
	/** Each model's values, encoded. */
	rows: Values[];
	/** The same values as the model will hold them once stored, taken before sending. */
	sent: Record<string, unknown>[];
}

export interface InsertOrIgnoreOptions<C extends string = string> {
	uniqueBy?: readonly C[];
}

/** Inserts a list of models; one model is a list of one. */
export class ModelInsert<M extends Model> {
	constructor(
		private readonly modelClass: ModelClass<M>,
		private readonly ignoring: InsertOrIgnoreOptions | null = null,
	) {}

	/** The inserted models, or what `answer` makes of them; an `AfterCommitError` carries the same. */
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
		if (this.ignoring) this.assertNoBeforeHandlers();
		for (const model of models) {
			model.$assertWritable(tx);
			if (model.$exists) {
				throw new OrmError(
					`[orm] Cannot insert a ${this.modelClass.name} that is already in the database. save() it instead.`,
				);
			}
		}
		const sent = this.ignoring ? this.firstOfEach(models) : models;
		if (sent.length === 0) return result([]);

		return WriteLifecycle.around(
			this.modelClass,
			'created',
			{ tx, oneStatement: () => this.statements(sent) === 1 },
			async lifecycle => result(await this.within(lifecycle, sent)),
		);
	}

	/** The insert itself, for a caller that started the lifecycle: `Model.save()`. */
	async within(
		lifecycle: WriteLifecycle<M>,
		models: readonly M[],
	): Promise<M[]> {
		const { table } = this.modelClass;
		await lifecycle.start(
			models,
			models.map(
				model => [model, ModelInsert.changesTo(model.$attributes.draftValues())] as const,
			),
		);

		const stamp = table.timestamps.insertStamp(new Date());
		lifecycle.sending(models);

		// Grouped only now: a `:before` handler may have filled a column, which changes the
		// columns a model's row carries, and so the INSERT it can share.
		const byModel = new Map<M, Landed<M>>();
		for (const chunk of this.chunks(models, stamp)) {
			for (const landed of await this.insertChunk(chunk, lifecycle.tx)) {
				byModel.set(landed.model, landed);
			}
		}

		// Handlers get the models in the order given, not grouped by INSERT.
		const inserted = models.filter(model => byModel.has(model));
		await lifecycle.finish(inserted.map(model => byModel.get(model)!));
		return inserted;
	}

	/** A new row's changes: every value from nothing. */
	private static changesTo<M extends Model>(
		values: Readonly<Record<string, unknown>>,
	): Changes<M> {
		return Object.fromEntries(
			Object.entries(values).map(([column, to]) => [column, { from: undefined, to }]),
		) as Changes<M>;
	}

	/** How many INSERTs the models need: more than one needs a transaction. */
	private statements(models: readonly M[]): number {
		return this.chunks(models, this.modelClass.table.timestamps.insertStamp(new Date()))
			.length;
	}

	/**
	 * Sends one INSERT, then updates each model from it: what it sent is marked saved, and the
	 * values the database filled in (a generated id, column defaults) are put on the model.
	 */
	private async insertChunk(
		{ models, rows, sent }: InsertChunk<M>,
		tx: Transaction | undefined,
	): Promise<Landed<M>[]> {
		const { table } = this.modelClass;
		const keyColumns = table.primaryKey.columns;
		const unsent = [...table.columns.keys()].filter(
			column => !(column in rows[0]!),
		);

		// The database fills the columns the rows leave out. RETURNING asks for them, and for
		// the key, to tell which returned row belongs to which model.
		const matching = this.matchingColumns(rows[0]!);
		const asked = this.ignoring
			? [...new Set([...keyColumns, ...(matching ?? []), ...unsent])]
			: unsent.length === 0
				? []
				: [...new Set([...keyColumns, ...unsent])];
		const insert = InsertBuilder.into(table.name).values(rows);
		const result = await this.modelClass.database.run(
			(this.ignoring ? insert.onConflictDoNothing() : insert).returning(
				...asked,
			),
			tx,
		);

		if (
			!this.ignoring &&
			asked.length > 0 &&
			result.rows.length !== models.length
		) {
			throw new OrmError(
				`[orm] Inserting ${models.length} ${table.name} rows returned ${result.rows.length}.`,
			);
		}

		const returned = this.ignoring
			? this.insertedIn(models, result.rows, matching)
			: this.inModelOrder(models, result.rows, unsent);
		return models.flatMap((model, index) => {
			if (this.ignoring && !returned[index]) return [];
			const supplied = this.supplied(unsent, returned[index]);
			const before = model.$attributes.shownSnapshot();
			model.$attributes.written(sent[index]!, supplied, tx);
			model.$exists = true;
			// Inserted, the model is its row's instance.
			IdentityMap.holding(model).register(model);
			model.$edited(model.$attributes.shownChangedSince(before));
			// What the database filled in, a generated id above all, is written too.
			return {
				model,
				changes: ModelInsert.changesTo<M>({ ...sent[index]!, ...supplied }),
			};
		});
	}

	/** The values the database filled in for the columns the INSERT left out. */
	private supplied(
		unsent: readonly string[],
		returned: Row | undefined,
	): Record<string, unknown> {
		const { table } = this.modelClass;
		if (unsent.length === 0) return {};
		if (!returned) {
			throw new OrmError(
				`[orm] Inserting into ${table.name} returned no row for ${unsent.join(', ')}.`,
			);
		}
		const decoded = table.decode(returned);
		return Object.fromEntries(
			unsent.map(column => [column, decoded[column]]),
		);
	}

	/**
	 * Puts the returned rows in the models' order: SQLite does not promise RETURNING rows in
	 * insert order. Generated ids rise in insert order within one INSERT, so those rows are
	 * sorted by id; rows whose key the app gave are matched by key.
	 */
	private inModelOrder(
		models: readonly M[],
		rows: readonly Row[],
		unsent: readonly string[],
	): (Row | undefined)[] {
		if (rows.length === 0) return [];
		if (models.length === 1) return [rows[0]];
		const { table } = this.modelClass;
		const generated = table.primaryKey.generated;

		if (generated !== null && unsent.includes(generated)) {
			return [...rows].sort(
				(a, b) => Number(a[generated]) - Number(b[generated]),
			);
		}

		const byKey = new Map(
			rows.map(row => [table.keySignature(table.decode(row)), row]),
		);
		return models.map(model =>
			byKey.get(table.keySignature(model.$attributes.draftValues())),
		);
	}

	/**
	 * Groups the models into INSERTs. One INSERT names one list of columns, and a column a row
	 * leaves out must get its database default, so only rows setting the same columns share one.
	 * `stamp` is the timestamps every row carries.
	 */
	private chunks(
		models: readonly M[],
		stamp: Readonly<Record<string, unknown>>,
	): InsertChunk<M>[] {
		const { table } = this.modelClass;
		const shapes = new Map<string, InsertChunk<M>>();

		for (const model of models) {
			const values = { ...model.$attributes.draftValues(), ...stamp };
			// A model without an id leaves it out, for the database to generate.
			const generated = table.primaryKey.generatedIn(values);
			if (generated) delete values[generated];

			// Taken now: a value the app assigns or edits while the INSERT runs belongs to the
			// next save, not this one.
			const row = table.encode(values);
			const sent = table.readBackAll(values);

			const shape = Object.keys(row).sort().join('/');
			const chunk = shapes.get(shape);
			if (chunk) {
				chunk.models.push(model);
				chunk.rows.push(row);
				chunk.sent.push(sent);
			} else {
				shapes.set(shape, { models: [model], rows: [row], sent: [sent] });
			}
		}

		const chunks: InsertChunk<M>[] = [];
		for (const shape of shapes.values()) {
			const columns = Object.keys(shape.rows[0]!).length;
			const indexes = shape.rows.map((_, index) => index);

			// One INSERT per row for a row with no values (`DEFAULT VALUES` takes one row) and for
			// a key filled by a default other than the rowid (no telling which returned row is whose).
			const parts =
				columns === 0 || this.keyFilledByDefault(shape.rows[0]!)
					? indexes.map(index => [index])
					: this.parts(shape.models, columns);

			for (const part of parts) {
				chunks.push({
					models: part.map(index => shape.models[index]!),
					rows: part.map(index => shape.rows[index]!),
					sent: part.map(index => shape.sent[index]!),
				});
			}
		}
		return chunks;
	}

	private keyFilledByDefault(row: Readonly<Record<string, Value>>): boolean {
		const { primaryKey } = this.modelClass.table;
		return primaryKey.columns.some(
			column => !(column in row) && column !== primaryKey.generated,
		);
	}

	private parts(models: readonly M[], columns: number): number[][] {
		const indexes = models.map((_, index) => index);
		if (!this.ignoring) return Chunks.of(indexes, columns);
		const parts: number[][] = [];
		let run: number[] = [];
		for (const index of indexes) {
			if (this.matchSignature(models[index]!) !== null) {
				run.push(index);
				continue;
			}
			parts.push(...Chunks.of(run, columns), [index]);
			run = [];
		}
		parts.push(...Chunks.of(run, columns));
		return parts;
	}

	private insertedIn(
		models: readonly M[],
		rows: readonly Row[],
		matching: readonly string[] | null,
	): (Row | undefined)[] {
		if (models.length === 1) return [rows[0]];
		const { table } = this.modelClass;
		const byMatch = new Map(
			rows.map(row => [this.signatureOf(matching!, table.decode(row)), row]),
		);
		return models.map(model =>
			byMatch.get(
				this.signatureOf(matching!, model.$attributes.draftValues()),
			),
		);
	}

	private firstOfEach(models: readonly M[]): M[] {
		const seen = new Set<string>();
		return models.filter(model => {
			const signature = this.matchSignature(model);
			if (signature === null) return true;
			if (seen.has(signature)) return false;
			seen.add(signature);
			return true;
		});
	}

	private matchSignature(model: M): string | null {
		const values = model.$attributes.draftValues();
		const columns = this.matchingColumns(values);
		return columns === null ? null : this.signatureOf(columns, values);
	}

	private matchingColumns(
		values: Readonly<Record<string, unknown>>,
	): readonly string[] | null {
		if (this.ignoring?.uniqueBy) return this.ignoring.uniqueBy;
		const { primaryKey } = this.modelClass.table;
		return primaryKey.generatedIn(values) === null ? primaryKey.columns : null;
	}

	private signatureOf(
		columns: readonly string[],
		values: Readonly<Record<string, unknown>>,
	): string | null {
		return this.modelClass.table.signature(
			columns,
			columns.map(column => values[column]),
		);
	}

	private assertNoBeforeHandlers(): void {
		if (!this.modelClass.$events.has(INSERT_VERBS, ['before'])) return;
		throw new OrmError(
			`[orm] ${this.modelClass.name} has a create:before or save:before handler, which ` +
				'createManyOrIgnore cannot run: which rows go in is known only after the insert.',
		);
	}
}

import { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { Accessors } from '../model/accessors';
import type { Model } from '../model/model';
import type { ColumnsOf, ModelClass, Patch } from '../model/types';
import { WriteLifecycle } from './write-lifecycle';

/**
 * `firstOrCreate` and `updateOrCreate`. The lookup and the write share one transaction, which
 * holds the only writer, so two calls racing for one row cannot both miss it and both create it.
 */
export class RowFinder<M extends Model> {
	private readonly attributes: Record<string, unknown>;

	constructor(
		private readonly modelClass: ModelClass<M>,
		attributes: Patch<M>,
	) {
		this.attributes = { ...attributes };

		const columns = Object.keys(this.attributes);
		const unset = columns.filter(
			column => this.attributes[column] === undefined,
		);
		if (columns.length === 0 || unset.length > 0) {
			throw new OrmError(
				`[orm] ${modelClass.name} cannot be looked up by ` +
					`${columns.length === 0 ? 'no columns' : `an undefined ${unset.join(', ')}`}: ` +
					'that would match any row.',
			);
		}
	}

	/** The row found, as it is; otherwise one created with `values`. */
	firstOrCreate(
		values: Patch<M> | Transaction,
		tx: Transaction | undefined,
	): Promise<M> {
		return this.lookUp(values, tx, found => found);
	}

	/** The row found, with `values` written onto it as `fill()` takes them; otherwise one created with them. Other edits pending on the row found stay pending. */
	updateOrCreate(
		values: Patch<M> | Transaction,
		tx: Transaction | undefined,
	): Promise<M> {
		const { table } = this.modelClass;
		return this.lookUp(values, tx, (found, patch, inner) =>
			found.update(
				Object.fromEntries(
					Object.entries(patch).filter(([column]) =>
						table.fillable(column),
					),
				) as Patch<M>,
				inner,
			),
		);
	}

	/**
	 * Looks up by the lookup columns as their mutators store them; a row created has them set
	 * even when not fillable, so the same lookup finds it next time.
	 */
	private lookUp(
		values: Patch<M> | Transaction,
		tx: Transaction | undefined,
		whenFound: (
			found: M,
			patch: Patch<M>,
			tx: Transaction,
		) => M | Promise<M>,
	): Promise<M> {
		// `firstOrCreate(attributes, tx)` puts the transaction where the values go. TypeScript
		// cannot tell the two apart (both have an `id`), so it is checked here.
		const handle = values instanceof Transaction ? values : tx;
		const patch = (values instanceof Transaction ? {} : values) as Patch<M>;

		const created = new this.modelClass();
		for (const [column, value] of Object.entries(this.attributes)) {
			Accessors.assign(created, column, value);
		}
		const staged = created.$attributes.draftValues();
		const lookup = Object.fromEntries(
			Object.keys(this.attributes).map(column => [
				column,
				staged[column],
			]),
		);

		return WriteLifecycle.transaction(
			this.modelClass.database,
			handle,
			async inner => {
				const found = await this.modelClass
					.query()
					.whereAttributes(lookup as Partial<ColumnsOf<M>>)
					.first(inner);
				if (found) return whenFound(found, patch, inner);

				created.fill(patch);
				await created.save(inner);
				return created;
			},
		);
	}
}

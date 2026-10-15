import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Model } from '../model/model';
import type { ModelClass, UpdatePatch } from '../model/types';
import type { ModelQuery } from '../query/model-query';
import type { Conditions } from '../sql/conditions';
import { ModelDelete } from './model-delete';
import { ModelUpdate } from './model-update';
import { WriteLifecycle } from './write-lifecycle';

/** `query().update()` and `query().delete()`. */
export class QueryWriter<M extends Model> {
	private readonly modelClass: ModelClass<M>;

	constructor(private readonly query: ModelQuery<M, any>) {
		this.modelClass = query.modelClass;
	}

	/**
	 * Reads the matched rows first, then writes them in one UPDATE … WHERE, past the mutators and
	 * each draft, even a row holding those values already. Returns how many matched.
	 */
	async update(patch: UpdatePatch<M>, tx?: Transaction): Promise<number> {
		const values = this.writable(patch);
		if (Object.keys(values).length === 0) return 0;

		const matching = this.matched('update');
		return WriteLifecycle.transaction(this.modelClass.database, tx, async inner => {
			const models = await this.query.withoutSelection().getArray(inner);
			return new ModelUpdate(this.modelClass, { values: () => values, matching }).write(
				models,
				inner,
				() => models.length,
			);
		});
	}

	/** The matched rows are read first, in the write's transaction, so every instance and collection shows they are gone. */
	async delete(tx?: Transaction): Promise<number> {
		this.matched('delete');

		return WriteLifecycle.transaction(this.modelClass.database, tx, async inner => {
			const models = await this.query.withoutSelection().getArray(inner);
			return new ModelDelete(this.modelClass).write(
				models,
				inner,
				removed => removed.length,
			);
		});
	}

	private writable(patch: UpdatePatch<M>): Record<string, unknown> {
		const { table } = this.modelClass;
		const values: Record<string, unknown> = {};

		for (const [column, value] of Object.entries(patch)) {
			if (value === undefined || table.timestamps.owns(column)) continue;

			if (!table.has(column)) {
				throw new OrmError(
					`[orm] ${this.modelClass.name} declares no column named '${column}'.`,
				);
			}
			if (table.primaryKey.columns.includes(column)) {
				throw new OrmError(
					`[orm] ${this.modelClass.name}.${column} is a key column, which a query ` +
						'update cannot reassign. save() the model on its own.',
				);
			}
			values[column] = table.column(column).accept(value);
		}
		return values;
	}

	private matched(verb: string): Conditions {
		this.query.assertUngrouped(verb);

		const { builder } = this.query;
		if (builder.hasJoins) {
			throw new OrmError(
				`[orm] A query with a join cannot ${verb}; filter on this table's columns.`,
			);
		}
		if (builder.hasLimitOrOffset) {
			throw new OrmError(
				`[orm] A query with a limit or offset cannot ${verb}: SQLite's ${verb.toUpperCase()} takes neither.`,
			);
		}
		return builder.conditions;
	}
}

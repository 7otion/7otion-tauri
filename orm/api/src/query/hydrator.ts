import type { Row } from '../database/statement';
import type { Transaction } from '../database/transaction';
import { Accessors } from '../model/accessors';
import { IdentityMap } from '../model/identity-map';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';

/** Turns a row into its model: the instance already held for that row, or a fresh one the map takes. */
export class Hydrator<M extends Model> {
	private readonly map: IdentityMap;

	/** The transaction whose own instances the rows become, since they may show what never commits. */
	private readonly scope: Transaction | null;

	/**
	 * `generation` is the query's: rows answered after `Model.connect()` switched files belong to
	 * the old one. `began` is `Attributes.now()` from before the query was sent.
	 */
	constructor(
		private readonly modelClass: ModelClass<M>,
		private readonly generation: number,
		private readonly tx: Transaction | undefined,
		private readonly began: number,
	) {
		this.scope = tx?.ownsReads ? tx : null;
		this.map = IdentityMap.of(this.scope ?? modelClass.database);
	}

	hydrate(row: Row): M {
		const values = this.modelClass.table.decode(row);
		const signature = this.modelClass.table.keySignature(values);

		if (signature !== null) {
			const held = this.map.get(this.modelClass, signature);
			// One from before the last `Model.connect()` is stale, and gives way to this read.
			if (held && held.$generation === this.generation) {
				held.$refreshed(values, this.tx, this.began);
				return held;
			}
		}

		const model = new this.modelClass();
		Accessors.assertUnshadowed(model);
		model.$attributes.accept(values);
		model.$exists = true;
		model.$generation = this.generation;
		model.$scope = this.scope;
		this.map.register(model);
		return model;
	}
}

import type { Model } from '../model/model';
import type { ModelRef } from '../model/types';
import {
	KeyedRelation,
	type KeyColumns,
	type Matching,
	type Related,
} from './keyed-relation';

export interface BelongsToKeys {
	/** On this model, pointing at the related row. */
	foreignKey: KeyColumns;
	/** On the related model. Defaults to its primary key. */
	ownerKey?: KeyColumns;
}

export class BelongsTo<R extends Model, RC = unknown> extends KeyedRelation<
	R,
	RC
> {
	readonly foreignKey: readonly string[];
	private readonly declaredOwnerKey: readonly string[] | null;

	constructor(
		parentClass: ModelRef<any>,
		related: Related<ModelRef<R>>,
		keys: BelongsToKeys,
	) {
		super(parentClass, related);
		this.foreignKey = KeyedRelation.columns(keys.foreignKey);
		this.declaredOwnerKey = keys.ownerKey
			? KeyedRelation.columns(keys.ownerKey)
			: null;
	}

	/** Read from the related class at first use, which a thunk may not have resolved before. */
	get ownerKey(): readonly string[] {
		const ownerKey =
			this.declaredOwnerKey ??
			this.relatedClass().table.primaryKey.columns;
		this.assertPaired(this.foreignKey, ownerKey);
		return ownerKey;
	}

	ownerColumns(): readonly string[] {
		return this.foreignKey;
	}

	protected get matching(): Matching {
		return {
			parentColumns: this.foreignKey,
			relatedColumns: this.ownerKey,
			many: false,
		};
	}
}

import type { Model } from '../model/model';
import type { ModelRef } from '../model/types';
import type { ModelQuery } from '../query/model-query';
import {
	KeyedRelation,
	type KeyColumns,
	type Matching,
	type Related,
} from './keyed-relation';

export interface HasKeys {
	/** On the related table, pointing back at the parent. */
	foreignKey: KeyColumns;
	/** On the parent. Defaults to its primary key. */
	localKey?: KeyColumns;
}

abstract class Has<R extends Model, RC = unknown> extends KeyedRelation<R, RC> {
	readonly foreignKey: readonly string[];
	readonly localKey: readonly string[];

	constructor(
		parentClass: ModelRef<any>,
		related: Related<ModelRef<R>>,
		keys: HasKeys,
	) {
		super(parentClass, related);
		this.foreignKey = KeyedRelation.columns(keys.foreignKey);
		this.localKey = keys.localKey
			? KeyedRelation.columns(keys.localKey)
			: parentClass.table.primaryKey.columns;
		this.assertPaired(this.foreignKey, this.localKey);
	}

	ownerColumns(): readonly string[] {
		return this.localKey;
	}

	protected abstract get many(): boolean;

	protected get matching(): Matching {
		return {
			parentColumns: this.localKey,
			relatedColumns: this.foreignKey,
			many: this.many,
		};
	}
}

export class HasOne<R extends Model, RC = unknown> extends Has<R, RC> {
	protected get many(): boolean {
		return false;
	}
}

export class HasMany<R extends Model, RC = unknown> extends Has<R, RC> {
	protected get many(): boolean {
		return true;
	}
}

export interface MorphManyKeys extends HasKeys {
	/** Column on the related table naming the owner's type. */
	typeColumn: string;
	typeValue: string;
}

export class MorphMany<R extends Model, RC = unknown> extends HasMany<R, RC> {
	readonly typeColumn: string;
	readonly typeValue: string;

	constructor(
		parentClass: ModelRef<any>,
		related: Related<ModelRef<R>>,
		keys: MorphManyKeys,
	) {
		super(parentClass, related, keys);
		this.typeColumn = keys.typeColumn;
		this.typeValue = keys.typeValue;
	}

	protected override scope(query: ModelQuery<R>): ModelQuery<R> {
		return query.whereAnyOf([this.typeColumn], [[this.typeValue]]);
	}

	protected override accepts(row: R): boolean {
		return row.$attributes.get(this.typeColumn) === this.typeValue;
	}
}

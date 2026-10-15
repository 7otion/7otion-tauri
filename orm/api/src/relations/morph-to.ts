import type { Value } from '../database/statement';
import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Model } from '../model/model';
import type { ModelClass, ModelRef } from '../model/types';
import { ModelQuery } from '../query/model-query';
import { Column } from '../schema/column';
import { KeyIndex } from './key-index';
import { KeyedRelation, type Related } from './keyed-relation';
import type { AnyRelation, Deliver, EagerConstraint } from './relation';

export interface MorphToKeys {
	/** Column on this model naming the target's type. */
	typeColumn: string;
	/** Column on this model holding the target's key. */
	keyColumn: string;
	/** Which model each type value names. */
	types: Readonly<Record<string, Related<ModelRef<any>>>>;
}

export class MorphTo<R extends Model = Model> implements AnyRelation {
	private readonly resolved = new Map<string, ModelClass<any>>();

	constructor(
		private readonly parentClass: ModelRef<any>,
		private readonly keys: MorphToKeys,
	) {}

	ownerColumns(): readonly string[] {
		return [this.keys.keyColumn, this.keys.typeColumn];
	}

	/** A type or key that is unset, unmapped, or matches no row gives null. */
	async eagerLoad(
		parents: readonly Model[],
		name: string,
		deliver: Deliver,
		constraint?: EagerConstraint,
		tx?: Transaction,
	): Promise<void> {
		const { keyColumn } = this.keys;
		const parentTable = this.parentClass.table;

		// Taken once: a key assigned while the load runs must not change who gets the row.
		const aimed = new Map<Model, { type: string; stored: Value } | null>();
		const wanted = new Map<string, Map<string, Value>>();
		for (const parent of parents) {
			const type = this.typeOf(parent);
			const key = parent.$attributes.get(keyColumn);
			const signature = parentTable.signature([keyColumn], [key]);
			if (type === null || signature === null) {
				aimed.set(parent, null);
				continue;
			}
			const stored = parentTable.column(keyColumn).encode(key);
			aimed.set(parent, { type, stored });

			const keys = wanted.get(type) ?? new Map<string, Value>();
			keys.set(signature, stored);
			wanted.set(type, keys);
		}

		const found = new Map<string, KeyIndex<R>>();
		for (const [type, keys] of wanted) {
			const target = this.target(type);
			if (!target) {
				console.warn(
					`[orm] No model is mapped for ${this.keys.typeColumn} = ${JSON.stringify(type)}.`,
				);
				continue;
			}
			found.set(
				type,
				await this.rowsOf(
					target,
					[...keys.values()],
					constraint,
					name,
					tx,
				),
			);
		}

		for (const parent of parents) {
			const aim = aimed.get(parent) ?? null;
			const target = aim && this.target(aim.type);
			// Signed as the target's column compares, which is how its rows were signed.
			const signature =
				aim && target
					? target.table.storedSignature(
							[MorphTo.keyColumnOf(target)],
							[aim.stored],
						)
					: null;
			deliver(
				parent,
				aim === null
					? null
					: (found.get(aim.type)?.get(signature)?.[0] ?? null),
			);
		}
	}

	private async rowsOf(
		target: ModelClass<any>,
		stored: readonly Value[],
		constraint: EagerConstraint | undefined,
		name: string,
		tx: Transaction | undefined,
	): Promise<KeyIndex<R>> {
		const column = MorphTo.keyColumnOf(target);
		// In the target's own form: the two sides may declare different codecs.
		const keys = stored.map(value => [
			target.table.column(column).decode(Column.asStored(value)),
		]);

		const found = await ModelQuery.forLoad(
			target,
			[column],
			constraint,
			name,
		).getForKeys([column], keys, tx);

		const rows = new KeyIndex<R>();
		for (const row of found) {
			const signature = target.table.signature(
				[column],
				[row.$attributes.get(column)],
			);
			if (signature !== null) rows.add(signature, row as R);
		}
		return rows;
	}

	private typeOf(parent: Model): string | null {
		const type = parent.$attributes.get(this.keys.typeColumn);
		return type === null || type === undefined || type === ''
			? null
			: String(type);
	}

	private target(stored: string): ModelClass<any> | undefined {
		const type = this.typeNamed(stored);
		if (type === undefined) return undefined;

		let target = this.resolved.get(type);
		if (!target) {
			target = KeyedRelation.resolve(
				this.keys.types[type]!,
			) as ModelClass<any>;
			this.resolved.set(type, target);
		}
		return target;
	}

	/** Folds case where the type column is `nocase()`. */
	private typeNamed(stored: string): string | undefined {
		if (Object.hasOwn(this.keys.types, stored)) return stored;

		const { typeColumn } = this.keys;
		const table = this.parentClass.table;
		const signature = table.storedSignature([typeColumn], [stored]);
		return Object.keys(this.keys.types).find(
			type => table.storedSignature([typeColumn], [type]) === signature,
		);
	}

	private static keyColumnOf(target: ModelClass<any>): string {
		const { primaryKey } = target.table;
		if (primaryKey.isComposite) {
			throw new OrmError(
				`[orm] ${target.name} has a composite key, which one key column cannot point at.`,
			);
		}
		return primaryKey.columns[0]!;
	}
}

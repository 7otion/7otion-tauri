import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import { Accessors } from '../model/accessors';
import { Drafts } from '../model/draft';
import type { Model } from '../model/model';
import type {
	ColumnKey,
	ColumnsOf,
	IsUnion,
	ModelClass,
	Patch,
} from '../model/types';
import { HasMany, MorphMany } from '../relations/has';
import { ModelDelete } from './model-delete';
import { ModelInsert } from './model-insert';
import { ModelUpdate } from './model-update';
import { WriteLifecycle } from './write-lifecycle';

type KeyColumnsOf<R> = R extends { readonly $keyColumns: infer N }
	? N & ColumnKey<R>
	: ColumnKey<R>;

/**
 * A bare member (`sync('tags', ['red'])`) is a value of the one `matchOn` column. Without
 * `matchOn`, of any key column: which of them is the foreign key is known only at runtime.
 */
type BareMember<R, C> = [C] extends [never]
	? NonNullable<ColumnsOf<R>[KeyColumnsOf<R>]>
	: true extends IsUnion<C>
		? never
		: NonNullable<ColumnsOf<R>[C & keyof ColumnsOf<R>]>;

export type RelationMember<
	R extends Model = Model,
	C extends ColumnKey<R> = never,
> = { [K in keyof Patch<R>]?: Patch<R>[K] | null } | R | BareMember<R, C>;

export interface SyncOptions<C extends string = string> {
	/** Defaults to the related model's key columns, less those pointing at the parent: the foreign key, and a morph's type. */
	matchOn?: readonly C[];
}

export interface SyncResult {
	attached: number;
	detached: number;
	updated: number;
	unchanged: number;
}

/** `parent.sync(name, members)`: makes a hasMany or morphMany hold exactly the members given. */
export class RelationWriter<R extends Model> {
	private readonly relation: HasMany<R>;

	constructor(
		private readonly parent: Model,
		private readonly name: string,
	) {
		const relation = (parent.constructor as ModelClass).$relation(name);
		if (!(relation instanceof HasMany)) {
			throw new OrmError(
				`[orm] '${name}' has no set to sync: sync() is for hasMany and morphMany, ` +
					'whose rows each belong to one parent.',
			);
		}
		this.relation = relation as HasMany<R>;
	}

	async sync<const C extends ColumnKey<R> = never>(
		members: readonly RelationMember<R, C>[],
		options: SyncOptions<C> = {},
		tx?: Transaction,
	): Promise<SyncResult> {
		this.parent.$assertCurrent();
		const related = this.relation.relatedClass();
		const match = this.matchColumns(options.matchOn);
		const incoming = this.incomingRows(members, match);

		try {
			// Reading the current rows and writing the changes share one transaction, so no
			// other write can change those rows in between.
			return await WriteLifecycle.transaction(
				related.database,
				tx,
				async inner => {
					const owned = this.ownership();
					const existing = await (related as ModelClass<R>)
						.query()
						.whereAnyOf(Object.keys(owned), [Object.values(owned)])
						.getArray(inner);

					// Several existing rows may match one member (same `matchOn` values). The first is
					// kept as that member; the others are deleted.
					const current = new Map<string, R>();
					const remove: R[] = [];
					for (const model of existing) {
						const identity = this.identityOf(model, match);
						if (identity === null || current.has(identity)) {
							remove.push(model);
						} else {
							current.set(identity, model);
						}
					}

					const create: R[] = [];
					const update = new Map<R, Record<string, unknown>>();
					let unchanged = 0;
					const fixed = new Set([
						...match,
						...Object.keys(owned),
						...related.table.primaryKey.columns,
					]);

					for (const [identity, row] of incoming) {
						const model = current.get(identity);
						current.delete(identity);

						if (!model) {
							create.push(this.build(row, match, owned));
							continue;
						}
						const changed = this.changesFor(model, row, fixed);
						if (Object.keys(changed).length > 0)
							update.set(model, changed);
						else unchanged++;
					}
					remove.push(...current.values());

					await new ModelDelete(related).write(remove, inner);
					await new ModelInsert(related).write(create, inner);
					await new ModelUpdate(related, {
						values: model => update.get(model)!,
					}).write([...update.keys()], inner);

					return {
						attached: create.length,
						detached: remove.length,
						updated: update.size,
						unchanged,
					};
				},
			);
		} finally {
			// A load of the relation still on its way read the rows from before; the loaded value follows the write.
			this.parent.$relations.supersede(this.name);
		}
	}

	private incomingRows(
		members: readonly RelationMember[],
		match: readonly string[],
	): Map<string, Record<string, unknown>> {
		const related = this.relation.relatedClass();
		const rows = new Map<string, Record<string, unknown>>();

		for (const member of members) {
			const row = this.toRow(member, match);

			// Identified by its match values as their mutators store them, as the rows already there are.
			const probe = new related();
			for (const column of match) {
				if (row[column] !== undefined) {
					Accessors.assign(probe, column, row[column]);
				}
			}
			const stored = match.map(column =>
				probe.$attributes.draftValue(column),
			);

			// A member needs a value in every match column. Checked as stored, so '' in a column
			// that stores empty strings as NULL counts as no value too.
			const missing = match.find(
				(column, index) =>
					related.table.signature([column], [stored[index]]) === null,
			);
			if (missing) {
				throw new OrmError(
					`[orm] A '${this.name}' member is missing '${missing}', which identifies it. ` +
						'Pass matchOn to identify members by other columns.',
				);
			}

			const identity = related.table.signature(match, stored)!;

			if (rows.has(identity)) {
				throw new OrmError(
					`[orm] '${this.name}' was given two members identified by ` +
						`${match.map(column => `${column} = ${String(row[column])}`).join(', ')}.`,
				);
			}
			rows.set(identity, row);
		}
		return rows;
	}

	/**
	 * A new related model for a member. The member's values go through `fill()`, so `fillable`
	 * applies. Match columns are set even when not fillable, since they identify the row, still
	 * through their mutators. The foreign key pointing at the parent is set directly.
	 */
	private build(
		row: Record<string, unknown>,
		match: readonly string[],
		owned: Readonly<Record<string, unknown>>,
	): R {
		const model = new (this.relation.relatedClass())();
		// The match columns are left out of `fill`: they are assigned below, fillable or not.
		model.fill(
			Object.fromEntries(
				Object.entries(row).filter(
					([column]) => !match.includes(column),
				),
			) as Patch<R>,
		);

		for (const column of match) {
			if (row[column] !== undefined)
				Accessors.assign(model, column, row[column]);
		}
		for (const [column, value] of Object.entries(owned)) {
			if (value !== undefined) model.$attributes.assign(column, value);
		}
		return model;
	}

	private ownership(): Record<string, unknown> {
		const { foreignKey, localKey } = this.relation;
		const owned: Record<string, unknown> = {};

		// The parent's key, converted to the form the related table stores its foreign key in,
		// the same way loading the relation compares them.
		const values = this.relation.translate(
			localKey,
			foreignKey,
			localKey.map(column => this.parent.$attributes.persisted(column)),
		);
		foreignKey.forEach((column, index) => {
			const value = values[index];
			if (value === undefined || value === null) {
				throw new OrmError(
					`[orm] Cannot write '${this.name}': ${this.parent.constructor.name}.` +
						`${localKey[index]} has no value, so nothing can point at it.`,
				);
			}
			owned[column] = value;
		});

		if (this.relation instanceof MorphMany) {
			owned[this.relation.typeColumn] = this.relation.typeValue;
		}
		return owned;
	}

	private matchColumns(explicit?: readonly string[]): readonly string[] {
		if (explicit && explicit.length > 0) return explicit;

		// The columns the ORM sets itself, pointing at the parent, identify no member.
		const owned = Object.keys(this.ownership());
		const derived = this.relation
			.relatedClass()
			.table.primaryKey.columns.filter(column => !owned.includes(column));

		if (derived.length === 0) {
			throw new OrmError(
				`[orm] Cannot tell members of '${this.name}' apart: its key is the ` +
					'foreign key alone. Pass matchOn with the columns that identify one.',
			);
		}
		return derived;
	}

	private toRow(
		member: RelationMember,
		match: readonly string[],
	): Record<string, unknown> {
		if (typeof member !== 'object' || member === null) {
			if (match.length !== 1) {
				throw new OrmError(
					`[orm] '${this.name}' identifies a member by ${match.join(', ')}, ` +
						'so members must be objects, not bare values.',
				);
			}
			return { [match[0]!]: member };
		}

		if (!('$attributes' in member))
			return member as Record<string, unknown>;

		// A member given as a model loses its generated id: that id is the model's own row,
		// which may belong to another parent. The member is matched by its match columns instead.
		const row = (member as Model).toObject();
		const { generated } = this.relation.relatedClass().table.primaryKey;
		if (generated !== null && !match.includes(generated))
			delete row[generated];
		return row;
	}

	private identityOf(model: R, match: readonly string[]): string | null {
		return this.relation.relatedClass().table.signature(
			match,
			match.map(column => model.$attributes.get(column)),
		);
	}

	/**
	 * The member's columns, as `fill()` takes them and their mutators store them, that differ
	 * from the row's: what the member changes, written past the model's draft.
	 */
	private changesFor(
		model: R,
		row: Record<string, unknown>,
		fixed: ReadonlySet<string>,
	): Record<string, unknown> {
		const { table } = this.relation.relatedClass();
		const staged = Drafts.staged(
			model,
			Object.fromEntries(
				Object.entries(row).filter(
					([column]) => !fixed.has(column) && table.fillable(column),
				),
			),
		);
		return Object.fromEntries(
			Object.entries(staged).filter(
				([column, value]) =>
					!table
						.column(column)
						.storesAs(value, model.$attributes.get(column)),
			),
		);
	}
}

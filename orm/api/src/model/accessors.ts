import { OrmError } from '../errors';
import type { Table } from '../schema/table';
import type { Model } from './model';
import type { ModelClass, ModelRef } from './types';

export class Accessors {
	private static readonly prepared = new WeakSet<object>();
	private static readonly verified = new WeakSet<object>();

	/** Names a draft has of its own, which no column or relation may take. */
	private static readonly reserved = new Set(['draft', 'model']);

	/** Names starting with `$` are the ORM's own. */
	static assertFree(name: string, base: object, owner: string): void {
		if (
			name.startsWith('$') ||
			name in base ||
			Accessors.reserved.has(name)
		) {
			throw new OrmError(
				`[orm] ${owner}: '${name}' cannot name a column or relation, ` +
					'since the model already has a member of that name.',
			);
		}
	}

	/** Refuses a getter, setter or method of the class's own named after a column: a mutator is the one way to change what an assignment stores. */
	static assertColumnsFree(
		prototype: object,
		table: Table,
		owner: string,
	): void {
		for (const column of table.columns.keys()) {
			if (!Object.hasOwn(prototype, column)) continue;
			throw new OrmError(
				`[orm] ${owner} declares its own '${column}', which is a column. ` +
					`To change what an assigned value becomes, give it a mutator: ` +
					`static readonly mutators = this.mutate({ ${column}: value => … }).`,
			);
		}
	}

	/** On the class that declares the schema. A model shows its committed values; edits are made on its draft. */
	static columns(modelClass: ModelRef<any>, table: Table): void {
		const { prototype } = modelClass as unknown as { prototype: object };
		Accessors.assertColumnsFree(prototype, table, modelClass.name);

		for (const column of table.columns.keys()) {
			Object.defineProperty(prototype, column, {
				configurable: true,
				get(this: Model) {
					this.$assertReadable();
					this.$signals.readColumn(column);
					return this.$attributes.committedValue(column);
				},
				set(this: Model) {
					throw new OrmError(
						`[orm] ${modelClass.name}.${column} shows what the database holds, so it cannot ` +
							`be assigned. Edit the draft: model.draft().${column} = …, then save().`,
					);
				},
			});
		}
	}

	/** Once per class, at its first instance, after its relations are declared; also checks a subclass, which calls no `define`. */
	static prepare(modelClass: ModelClass, base: object): void {
		if (Accessors.prepared.has(modelClass)) return;

		for (
			let owner: object = modelClass;
			!Object.hasOwn(owner, 'schema');
			owner = Object.getPrototypeOf(owner)
		) {
			const { prototype, name } = owner as {
				prototype: object;
				name: string;
			};
			Accessors.assertColumnsFree(prototype, modelClass.table, name);
		}

		for (const name of Object.keys(modelClass.relations)) {
			if (modelClass.table.has(name)) {
				throw new OrmError(
					`[orm] ${modelClass.name} declares '${name}' as both a column and a relation.`,
				);
			}
			Accessors.assertFree(name, base, modelClass.name);

			Object.defineProperty(modelClass.prototype, name, {
				configurable: true,
				get(this: Model) {
					this.$signals.readRelation(name);
					return this.$relations.read(name);
				},
				set(this: Model) {
					throw new OrmError(
						`[orm] ${modelClass.name}.${name} is a relation, which cannot be assigned. ` +
							'To point it at another row, set the columns it is keyed on and save.',
					);
				},
			});
		}
		Accessors.prepared.add(modelClass);
	}

	/** Assigns on the draft as `model.draft()[column] = value` does, so the column's mutator runs. */
	static assign(model: Model, column: string, value: unknown): void {
		(model.draft() as unknown as Record<string, unknown>)[column] = value;
	}

	/** A class field named after a column or relation hides the accessor. A class is trusted once an instance has passed. */
	static assertUnshadowed(model: Model): void {
		const modelClass = model.constructor as unknown as ModelClass;
		if (Accessors.verified.has(modelClass)) return;

		for (const name of Object.keys(model)) {
			if (modelClass.table.has(name) || name in modelClass.relations) {
				throw new OrmError(
					`[orm] ${modelClass.name} declares '${name}' as a class field, which hides ` +
						"the ORM's property. Columns need no field; declare a relation as " +
						`\`declare ${name}: …\` so no field is emitted.`,
				);
			}
		}
		Accessors.verified.add(modelClass);
	}
}

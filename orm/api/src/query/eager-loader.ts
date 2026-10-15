import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Model } from '../model/model';
import type { ModelClass } from '../model/types';
import type { AnyRelation, EagerConstraint } from '../relations/relation';
import { Collection } from './collection.svelte';
import type { ModelQuery } from './model-query';

export type EagerPaths = ReadonlyMap<string, EagerConstraint | undefined>;

export class EagerLoader {
	private readonly loaded = new Set<string>();

	/** Taken once per model and relation; what a load delivers is dropped once the relation has moved on. */
	private readonly taken = new WeakMap<Model, Map<string, number>>();

	constructor(
		private readonly paths: EagerPaths,
		private readonly tx?: Transaction,
		private readonly keepLoaded = false,
	) {}

	/** Takes the tokens of every path's first segment now, ahead of the load itself. */
	begin(models: readonly Model[]): void {
		for (const path of this.paths.keys()) {
			for (const model of models) {
				this.tokenOf(model, path.split('.')[0]!);
			}
		}
	}

	async load(
		models: readonly Model[],
		modelClass: ModelClass<any>,
	): Promise<void> {
		if (models.length === 0) return;

		// Walked whole first, so a path that cannot be loaded leaves nothing half loaded or recorded.
		for (const path of this.paths.keys()) {
			EagerLoader.assertPath(modelClass, path);
		}
		for (const path of this.paths.keys()) {
			await this.loadPath(models, modelClass, path, '');
		}
	}

	/** `walked` is the path already loaded, with its trailing dot. */
	private async loadPath(
		models: readonly Model[],
		owner: ModelClass<any>,
		path: string,
		walked: string,
	): Promise<void> {
		const [name, ...rest] = path.split('.') as [string, ...string[]];
		const relation = owner.relations[name]!;

		const here = walked + name;
		if (!this.loaded.has(here)) {
			this.loaded.add(here);
			const parents = this.keepLoaded
				? models.filter(model => !model.$relations.holds(name))
				: models;
			// Parents read before `Model.connect()` switched files would be given rows of the file now open.
			for (const parent of parents) parent.$assertCurrent();
			EagerLoader.assertKeysRead(parents, owner, relation, here);

			const tokens = new Map(
				parents.map(parent => [parent, this.tokenOf(parent, name)]),
			);
			const constraint = this.constraintFor(here, relation);
			// Taken before the read: a commit put right before the rows are delivered is asked again for.
			const seen = relation.version?.(name, constraint);
			await relation.eagerLoad(
				parents,
				name,
				(parent, value) => {
					const source = relation.sourceFor?.(parent, name, constraint);
					parent.$relations.deliver(
						name,
						value,
						tokens.get(parent)!,
						this.tx,
						source && { ...source, seen },
					);
				},
				constraint,
				this.tx,
			);
		}

		// Recorded on each model the path reached, so a reload of any of them replays it, constraint included.
		for (const model of models) {
			model.$relations.paths.set(path, this.paths.get(walked + path));
		}

		if (rest.length === 0) return;

		// One related instance may hang off several parents.
		const related = [
			...new Set(models.flatMap(model => Collection.modelsIn(model.$relations.held(name)))),
		];
		if (related.length === 0) return;

		await this.loadPath(
			related,
			relation.relatedClass!(),
			rest.join('.'),
			`${here}.`,
		);
	}

	/** Also selects the columns the paths beneath `here` are keyed off. */
	private constraintFor(
		here: string,
		relation: AnyRelation,
	): EagerConstraint | undefined {
		const constraint = this.paths.get(here);
		if (!constraint || !relation.relatedClass) return constraint;

		const related = relation.relatedClass();
		const beneath = new Set<string>();
		for (const path of this.paths.keys()) {
			if (!path.startsWith(`${here}.`)) continue;
			const next = path.slice(here.length + 1).split('.')[0]!;
			for (const column of related.relations[next]!.ownerColumns()) {
				beneath.add(column);
			}
		}
		if (beneath.size === 0) return constraint;

		// Anything but a query goes on as it came, for forLoad to refuse.
		return query => {
			const shaped = constraint(query) as
				ModelQuery<any, any> | undefined;
			return typeof shaped?.including === 'function'
				? shaped.including([...beneath])
				: shaped!;
		};
	}

	private tokenOf(model: Model, name: string): number {
		const tokens = this.taken.get(model) ?? new Map<string, number>();
		this.taken.set(model, tokens);

		let token = tokens.get(name);
		if (token === undefined) {
			token = model.$relations.startLoad(name);
			tokens.set(name, token);
		}
		return token;
	}

	private static assertPath(modelClass: ModelClass<any>, path: string): void {
		let owner = modelClass;
		const segments = path.split('.');

		segments.forEach((name, index) => {
			if (!Object.hasOwn(owner.relations, name)) {
				throw new OrmError(
					`[orm] ${owner.name} declares no relation named '${name}'.`,
				);
			}
			if (index === segments.length - 1) return;

			const relation = owner.relations[name]!;
			if (!relation.relatedClass) {
				const here = segments.slice(0, index + 1).join('.');
				throw new OrmError(
					`[orm] '${name}' is polymorphic, so '${here}.${segments.slice(index + 1).join('.')}' cannot be ` +
						`loaded through it. Load '${name}', then load the rest on each target.`,
				);
			}
			owner = relation.relatedClass();
		});
	}

	private static assertKeysRead(
		parents: readonly Model[],
		owner: ModelClass<any>,
		relation: AnyRelation,
		path: string,
	): void {
		for (const parent of parents) {
			if (!parent.$exists) continue;
			const missing = relation
				.ownerColumns()
				.filter(column => parent.$attributes.get(column) === undefined);
			if (missing.length === 0) continue;

			throw new OrmError(
				`[orm] ${owner.name} rows were selected without ${missing.join(', ')}, ` +
					`which '${path}' is keyed on. Select those columns too.`,
			);
		}
	}
}

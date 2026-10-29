import type { Model } from './model';
import type { ModelClass, ModelRef } from './types';

/** Members a draft answers for itself; every other method of `Model` runs on the owner. */
const OWN = new Set([
	'constructor',
	'draft',
	'model',
	'fill',
	'toObject',
	'toJSON',
	'discard',
]);

/**
 * A model's one draft: the same accessors and methods as the model, over the pending
 * values. Built once per class, on a prototype that inherits the model class's.
 */
export class Drafts {
	private static readonly prototypes = new WeakMap<object, object>();

	/** The draft of `model`, made on first use and kept on it. `modelPrototype` is `Model`'s own, whose methods the draft forwards. */
	static of<M extends Model>(model: M, modelPrototype: object): M {
		const held = model.$draft;
		if (held) return held as M;

		const draft = Object.create(
			Drafts.prototypeFor(
				model.constructor as ModelClass,
				modelPrototype,
			),
			{ $owner: { value: model } },
		) as M;
		model.$draft = draft;
		return draft;
	}

	/** The models given to a write, a draft standing for its model, each once. */
	static models<M extends Model>(given: readonly M[]): M[] {
		return [
			...new Set(
				given.map(value => (value as { $owner?: M }).$owner ?? value),
			),
		];
	}

	/**
	 * What `patch` becomes through the mutators, staged off the draft: a mutator reads and sets
	 * columns on a stand-in that shows the draft, and the draft itself is left as it is.
	 */
	static staged(
		model: Model,
		patch: Readonly<Record<string, unknown>>,
	): Record<string, unknown> {
		const draft = model.draft();
		const { table, mutators } = model.constructor as ModelRef<any>;
		const staged: Record<string, unknown> = {};
		const stand = new Proxy(draft, {
			get: (target, key) =>
				typeof key === 'string' && key in staged
					? staged[key]
					: Reflect.get(target, key, target),
			set: (target, key, value) => {
				if (typeof key !== 'string' || !table.has(key))
					return Reflect.set(target, key, value, target);
				staged[key] = model.$attributes.assignable(key, value);
				return true;
			},
		});

		for (const [column, given] of Object.entries(patch)) {
			if (given === undefined) continue;
			const value = table.has(column)
				? table.column(column).accept(given)
				: given;
			const mutator = mutators?.[column] as
				((value: unknown, draft: Model) => unknown) | undefined;
			const mutated = mutator ? mutator(value, stand) : value;
			staged[column] = model.$attributes.assignable(column, mutated);
		}
		return staged;
	}

	private static prototypeFor(
		modelClass: ModelClass,
		modelPrototype: object,
	): object {
		let prototype = Drafts.prototypes.get(modelClass);
		if (!prototype) {
			prototype = Drafts.build(modelClass, modelPrototype);
			Drafts.prototypes.set(modelClass, prototype);
		}
		return prototype;
	}

	private static build(
		modelClass: ModelClass,
		modelPrototype: object,
	): object {
		const prototype = Object.create(modelClass.prototype);

		for (const [column, type] of modelClass.table.columns) {
			Object.defineProperty(prototype, column, {
				configurable: true,
				get(this: DraftWithOwner) {
					const owner = this.$owner;
					owner.$assertReadable();
					owner.$signals.readEdit(column);
					const value = owner.$attributes.draftValue(column);
					if (
						!type.copiedByDraft ||
						value === null ||
						typeof value !== 'object'
					)
						return value;
					const copy = owner.$attributes.pendingCopy(column);
					// A date or a byte array is not a proxy's to wrap; anything else edited in place is announced.
					return copy instanceof Date || ArrayBuffer.isView(copy)
						? copy
						: Drafts.json(owner, copy, column);
				},
				set(this: DraftWithOwner, given: unknown) {
					const owner = this.$owner;
					let value = type.accept(given);
					const mutator = (owner.constructor as ModelRef<any>)
						.mutators?.[column] as
						((value: unknown, model: Model) => unknown) | undefined;

					if (
						mutator &&
						value !== undefined &&
						!Drafts.mutating.has(owner)
					) {
						Drafts.mutating.add(owner);
						try {
							value = mutator(value, this);
						} finally {
							Drafts.mutating.delete(owner);
						}
					}
					// Read after the mutator, whose own assignments announce themselves.
					const before = owner.$attributes.draftValue(column);
					owner.$attributes.assign(column, value);
					const shown = owner.$attributes.draftValue(column);
					owner.$edited(type.storesAs(shown, before) ? [] : [column]);
				},
			});
		}

		// The owner's internals, so a relation accessor or a method inherited from the class finds them.
		for (const name of [
			'$attributes',
			'$relations',
			'$signals',
			'$exists',
			'$generation',
			'$scope',
		]) {
			Object.defineProperty(prototype, name, {
				configurable: true,
				get(this: DraftWithOwner) {
					return (this.$owner as unknown as Record<string, unknown>)[
						name
					];
				},
			});
		}

		Object.defineProperties(prototype, {
			model: {
				value: function (this: DraftWithOwner) {
					return this.$owner;
				},
			},
			draft: {
				value: function (this: DraftWithOwner) {
					return this;
				},
			},
			toObject: {
				value: function (this: DraftWithOwner) {
					this.$owner.$signals.readRow();
					this.$owner.$signals.readEdits();
					return this.$owner.$attributes.draftValues();
				},
			},
		});

		// Everything else `Model` offers runs on the owner: a write must take the model, not its draft.
		for (const name of Object.getOwnPropertyNames(modelPrototype)) {
			if (OWN.has(name)) continue;
			const member = Object.getOwnPropertyDescriptor(
				modelPrototype,
				name,
			)!;
			if (typeof member.value === 'function') {
				Object.defineProperty(prototype, name, {
					configurable: true,
					value: function (this: DraftWithOwner, ...args: unknown[]) {
						return (
							this.$owner as unknown as Record<
								string,
								(...a: unknown[]) => unknown
							>
						)[name]!(...args);
					},
				});
			} else if (member.get) {
				Object.defineProperty(prototype, name, {
					configurable: true,
					get(this: DraftWithOwner) {
						return (
							this.$owner as unknown as Record<string, unknown>
						)[name];
					},
				});
			}
		}
		return prototype;
	}

	/** Owners whose mutator is running: a column assigned on the draft inside it is set as given. */
	private static readonly mutating = new WeakSet<object>();

	/** The draft's pending copy of an object value, so a write however deep (`draft.settings.tags.push('x')`) is seen and announced as the column's. */
	private static json(owner: Model, target: object, column: string): object {
		const noted = (): true => {
			owner.$edited([column]);
			return true;
		};
		return new Proxy(target, {
			get(inner, key, receiver) {
				const value = Reflect.get(inner, key, receiver);
				return value !== null &&
					typeof value === 'object' &&
					!(value instanceof Date)
					? Drafts.json(owner, value, column)
					: value;
			},
			// An array's `push` sets the index and then a `length` it already has: the same value is no edit.
			set: (inner, key, value) => {
				const same =
					key in inner && Object.is(Reflect.get(inner, key), value);
				return Reflect.set(inner, key, value) && (same || noted());
			},
			deleteProperty: (inner, key) =>
				Reflect.deleteProperty(inner, key) && noted(),
			defineProperty: (inner, key, descriptor) =>
				Reflect.defineProperty(inner, key, descriptor) && noted(),
		});
	}
}

interface DraftWithOwner extends Model {
	readonly $owner: Model;
}

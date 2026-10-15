import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Written } from '../model/types';

export type EventVerb = 'create' | 'update' | 'delete' | 'save';

/** `before` and `after` the statement run inside the write; `committed` after the outermost commit. */
export type EventMoment = 'before' | 'after' | 'committed';

export type ModelEvent = `${EventVerb}:${EventMoment}`;

export const INSERT_VERBS: readonly EventVerb[] = ['save', 'create'];
export const UPDATE_VERBS: readonly EventVerb[] = ['save', 'update'];
export const DELETE_VERBS: readonly EventVerb[] = ['delete'];

export const IN_WRITE: readonly EventMoment[] = ['before', 'after'];
export const ANY_MOMENT: readonly EventMoment[] = ['before', 'after', 'committed'];

const EVENTS: ReadonlySet<string> = new Set(
	(['create', 'update', 'delete', 'save'] as const).flatMap(verb =>
		ANY_MOMENT.map(moment => `${verb}:${moment}`),
	),
);

/** Runs inside the write; its own reads and writes must carry `tx`. A throw rolls the write back. */
export type WriteHandler<M> = (written: Written<M>, tx: Transaction) => unknown;

/** Runs after the outermost commit; never on rollback. What it returns is awaited, then ignored. */
export type CommitHandler<M> = (written: Written<M>) => unknown;

export type EventHandler<M, E extends ModelEvent> = E extends `${string}:committed`
	? CommitHandler<M>
	: WriteHandler<M>;

export type ModelEvents<M> = {
	readonly [E in ModelEvent]?: EventHandler<M, E>;
};

type AnyHandler = (written: Written<any>, tx: Transaction) => unknown;

interface EventSource {
	readonly name: string;
	readonly events?: ModelEvents<any>;
	/** Absent above `Model`, where the chain of classes ends. */
	readonly $events?: EventRegistry;
}

export class EventRegistry {
	private readonly registered = new Map<ModelEvent, AnyHandler>();
	private sealed = false;

	constructor(private readonly modelClass: EventSource) {}

	/** Null removes the registered handler, and the declared one applies again. */
	register(event: ModelEvent, handler: AnyHandler | null): void {
		EventRegistry.assertEvent(event, this.modelClass.name);
		this.seal();
		if (handler === null) {
			this.registered.delete(event);
			return;
		}
		if (typeof handler !== 'function') {
			throw new OrmError(
				`[orm] ${this.modelClass.name}.registerEvent('${event}') takes a function or null.`,
			);
		}
		this.registered.set(event, handler);
	}

	/** Ordered from `Model` down to this class. */
	handlersFor(event: ModelEvent): readonly AnyHandler[] {
		const above = (
			Object.getPrototypeOf(this.modelClass) as EventSource | null
		)?.$events;
		const inherited = above ? above.handlersFor(event) : [];
		const own = this.own(event);
		return own ? [...inherited, own] : inherited;
	}

	has(verbs: readonly EventVerb[], moments: readonly EventMoment[]): boolean {
		return verbs.some(verb =>
			moments.some(
				moment => this.handlersFor(`${verb}:${moment}`).length > 0,
			),
		);
	}

	/** Once sealed, `events` is the class's own and fixed, so it is read in place. */
	private own(event: ModelEvent): AnyHandler | undefined {
		this.seal();
		return (
			this.registered.get(event) ??
			(this.modelClass.events?.[event] as AnyHandler | undefined)
		);
	}

	/** Fixes the class's own `events` literal: frozen, and unassignable. */
	private seal(): void {
		if (this.sealed) return;

		const { modelClass } = this;
		const declared = Object.hasOwn(modelClass, 'events')
			? modelClass.events
			: undefined;

		for (const [event, handler] of Object.entries(declared ?? {})) {
			EventRegistry.assertEvent(event, modelClass.name);
			if (typeof handler !== 'function') {
				throw new OrmError(
					`[orm] ${modelClass.name}.events['${event}'] is not a function.`,
				);
			}
		}

		// Its own property even when absent, so a parent's literal is never read as this class's.
		Object.defineProperty(modelClass, 'events', {
			value: declared && Object.freeze({ ...declared }),
			writable: false,
			configurable: false,
		});
		this.sealed = true;
	}

	private static assertEvent(
		event: string,
		modelName: string,
	): asserts event is ModelEvent {
		if (EVENTS.has(event)) return;
		throw new OrmError(
			`[orm] ${modelName} has no event '${event}'. Events are ` +
				'create, update, delete and save, each :before, :after or :committed, as in save:before.',
		);
	}
}

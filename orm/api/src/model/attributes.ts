import type { Transaction } from '../database/transaction';
import { OrmError } from '../errors';
import type { Table } from '../schema/table';

/**
 * A row's values as the database holds them (`committed`), and the edits made on its draft
 * (`pending`). The model reads the first, the draft the second over the first.
 */
export class Attributes {
	private committed: Record<string, unknown> = {};
	private pending: Record<string, unknown> = {};
	/** False until the row was read or inserted: a never-saved row has no committed values to show. */
	private loaded = false;
	/** Pending copies the draft made on a read, which are no edit while they equal what they were copied from. */
	private readonly copiedOnRead = new Set<string>();
	/** Columns written through a transaction: while it is open, a read made outside it does not overwrite them. */
	private readonly writtenIn = new Map<string, Transaction>();
	/** When each column was last written, on `Attributes.clock`. */
	private readonly writtenAt = new Map<string, number>();

	/** Counts the writes that landed, on any model. */
	private static clock = 0;

	/** @internal The moment a read begins: what is written after it is newer than what the read answers. */
	static now(): number {
		return Attributes.clock;
	}

	constructor(
		private readonly table: Table,
		private readonly modelName: string,
	) {}

	/** @internal The committed value, for the ORM's own reads; the model's getter goes through `committedValue`. */
	get(column: string): unknown {
		return this.committed[column];
	}

	/** What the model shows. A never-saved row has nothing to show yet; its draft has. */
	committedValue(column: string): unknown {
		if (!this.loaded) {
			throw new OrmError(
				`[orm] This ${this.modelName} is not saved yet, so it has no ${column} to show. ` +
					`Read what is being set through its draft: model.draft().${column}.`,
			);
		}
		return Attributes.handedOut(this.committed[column]);
	}

	/** What the draft shows: the pending value, or else the committed one. */
	draftValue(column: string): unknown {
		return column in this.pending
			? this.pending[column]
			: Attributes.handedOut(this.committed[column]);
	}

	/** Bytes cannot be frozen, so a committed blob goes out as a copy. */
	private static handedOut(value: unknown): unknown {
		return value instanceof Uint8Array ? value.slice() : value;
	}

	/** Copies of every column the draft shows, pending over committed. */
	draftValues(): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries({ ...this.committed, ...this.pending }).map(([column, value]) => [
				column,
				this.table.column(column).copy(value),
			]),
		);
	}

	/** Records a pending edit. A frozen value, as read from another model, is stored as a copy the draft can edit. */
	assign(column: string, value: unknown): void {
		this.pending[column] = this.assignable(column, value);
		this.copiedOnRead.delete(column);
	}

	/** @internal `value` as a pending edit of `column` stores it; refuses what no edit may set. */
	assignable(column: string, value: unknown): unknown {
		if (!this.table.has(column)) {
			throw new OrmError(
				`[orm] ${this.modelName} declares no column named '${column}'.`,
			);
		}
		if (this.table.timestamps.owns(column)) {
			throw new OrmError(
				`[orm] ${this.modelName}.${column} is a timestamp, which the ORM maintains: ` +
					'it is set on insert and refreshed on every update. It cannot be assigned.',
			);
		}
		if (value === undefined) {
			throw new OrmError(
				`[orm] ${this.modelName}.${column} was assigned undefined, which no column holds. ` +
					'Assign null to clear it.',
			);
		}
		return value !== null && typeof value === 'object' && Object.isFrozen(value)
			? this.table.column(column).copy(value)
			: value;
	}

	/** Drops pending edits: those columns, or every one. */
	discard(columns?: readonly string[]): void {
		for (const column of columns ?? Object.keys(this.pending)) {
			delete this.pending[column];
			this.copiedOnRead.delete(column);
		}
	}

	/** @internal Copies of every pending value, for `pendingChangedSince`. */
	pendingSnapshot(): Record<string, unknown> {
		return Object.fromEntries(
			Object.entries(this.pending).map(([column, value]) => [
				column,
				this.table.column(column).copy(value),
			]),
		);
	}

	/** @internal What the draft shows for every column, pending copied so an edit in place is told apart. */
	shownSnapshot(): Record<string, unknown> {
		const shown: Record<string, unknown> = {};
		for (const [name, column] of this.table.columns) {
			shown[name] = name in this.pending ? column.copy(this.pending[name]) : this.committed[name];
		}
		return shown;
	}

	/** @internal The columns the draft shows differently than when `shownSnapshot()` took `before`. */
	shownChangedSince(before: Readonly<Record<string, unknown>>): string[] {
		return [...this.table.columns.keys()].filter(
			name => !this.table.column(name).storesAs(this.draftValue(name), before[name]),
		);
	}

	/** @internal The pending columns set or edited in place since `pendingSnapshot()` took `before`. */
	pendingChangedSince(before: Readonly<Record<string, unknown>>): string[] {
		return Object.keys(this.pending).filter(
			column =>
				!(column in before) ||
				!this.table.column(column).storesAs(this.pending[column], before[column]),
		);
	}

	all(): Readonly<Record<string, unknown>> {
		return this.committed;
	}

	/** The committed value; for a row never saved, what its draft holds, since that is what its key will be. */
	persisted(column: string): unknown {
		return this.loaded ? this.committed[column] : this.draftValue(column);
	}

	/** Undefined where a row was read without that column, so an assignment cannot stand in for it. */
	persistedKey(): unknown[] {
		return this.table.primaryKey.columns.map(column =>
			this.loaded && !(column in this.committed)
				? undefined
				: this.persisted(column),
		);
	}

	persistedKeySignature(): string | null {
		return this.table.signature(
			this.table.primaryKey.columns,
			this.persistedKey(),
		);
	}

	/** @internal A row as read: those columns are committed, and any pending edit on them is dropped. */
	accept(values: Readonly<Record<string, unknown>>): void {
		for (const [column, value] of Object.entries(values)) {
			this.committed[column] = this.table.column(column).frozen(value);
			delete this.pending[column];
			this.copiedOnRead.delete(column);
		}
		this.loaded = true;
	}

	/**
	 * @internal A fresh read, made in `readIn`. Pending edits stay; a column another open
	 * transaction wrote keeps its value, and so does one written since the read `began`.
	 * Returns the columns that hold another value now.
	 */
	refreshed(
		values: Readonly<Record<string, unknown>>,
		readIn?: Transaction,
		began = Attributes.clock,
	): string[] {
		const changed: string[] = [];
		for (const [name, value] of Object.entries(values)) {
			const writer = this.writtenIn.get(name);
			if (writer?.isOpen && writer !== readIn) continue;
			if ((this.writtenAt.get(name) ?? 0) > began) continue;
			const column = this.table.column(name);
			if (!this.loaded || !(name in this.committed) || !column.storesAs(value, this.committed[name])) {
				changed.push(name);
			}
			this.commit(name, column.frozen(value));
		}
		this.loaded = true;
		return changed;
	}

	/**
	 * @internal The pending value of a column the draft hands out to edit in place: made as a
	 * copy of the committed value when there is none yet, so the frozen truth stays as it is.
	 */
	pendingCopy(column: string): object {
		if (!(column in this.pending)) {
			this.pending[column] = this.table.column(column).copy(this.committed[column]);
			this.copiedOnRead.add(column);
		}
		return this.pending[column] as object;
	}

	/** Sets a committed value. A copy made on a read and never edited follows it rather than stay as an edit of the old value. */
	private commit(column: string, value: unknown): void {
		if (this.copiedOnRead.has(column)) {
			this.copiedOnRead.delete(column);
			if (this.table.column(column).storesAs(this.pending[column], this.committed[column])) {
				delete this.pending[column];
			}
		}
		this.committed[column] = value;
	}

	/**
	 * @internal A write landed in `tx`: `sent` as stored, `supplied` what the ORM or database
	 * filled in. A pending edit equal to what was sent is saved; any other stays.
	 */
	written(
		sent: Readonly<Record<string, unknown>>,
		supplied: Readonly<Record<string, unknown>> = {},
		tx?: Transaction,
	): void {
		for (const values of [sent, supplied]) {
			for (const [name, value] of Object.entries(values)) {
				const column = this.table.column(name);
				if (tx) this.writtenIn.set(name, tx);
				else this.writtenIn.delete(name);
				this.writtenAt.set(name, ++Attributes.clock);
				this.commit(name, column.frozen(column.copy(value)));
				if (name in this.pending && column.storesAs(this.pending[name], value)) {
					delete this.pending[name];
				}
			}
		}
		this.loaded = true;
	}

	dirty(): string[] {
		return Object.keys(this.pending).filter(
			name =>
				!this.table
					.column(name)
					.storesAs(this.pending[name], this.committed[name]),
		);
	}

	/** `from` is a copy, so a caller cannot reach the committed value through it. */
	pendingChanges(): Record<string, { from: unknown; to: unknown }> {
		const changes: Record<string, { from: unknown; to: unknown }> = {};
		for (const column of this.dirty()) {
			changes[column] = {
				from: this.table.column(column).copy(this.committed[column]),
				to: this.pending[column],
			};
		}
		return changes;
	}

	/** @internal The values as they are now, for a write that may fail or roll back. */
	checkpoint(): Checkpoint {
		const committed = { ...this.committed };
		const pending = { ...this.pending };
		const loaded = this.loaded;
		const copiedOnRead = new Set(this.copiedOnRead);
		let sent: Record<string, unknown> = {};

		return {
			sending: () => {
				sent = { ...this.pending };
			},
			restore: () => {
				this.committed = committed;
				this.loaded = loaded;
				for (const column of copiedOnRead) {
					if (!(column in this.pending) || this.pending[column] === pending[column]) {
						this.copiedOnRead.add(column);
					}
				}
				const names = new Set([...Object.keys(pending), ...Object.keys(this.pending)]);
				for (const name of names) {
					// Assigned by the app since the write sent its value: kept.
					const column = this.table.column(name);
					const now = this.pending[name];
					if (
						name in this.pending &&
						!(name in sent && column.storesAs(now, sent[name])) &&
						!(name in pending && column.storesAs(now, pending[name]))
					) {
						continue;
					}
					if (name in pending) this.pending[name] = pending[name];
					else delete this.pending[name];
				}
			},
		};
	}
}

/** @internal Taken on a model when a write begins. */
export interface Checkpoint {
	/** Records the pending values the write is about to send. */
	sending(): void;
	/** Puts the committed values back, and the pending edits the write had cleared, but for edits made since. */
	restore(): void;
}

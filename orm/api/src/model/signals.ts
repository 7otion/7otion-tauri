import { SvelteMap } from 'svelte/reactivity';

import { Notices } from '../reactivity/notices';

const ROW = '$row';
const EXISTS = '$exists';
const EDITS = '$edits';
const edit = (column: string): string => `$edit:${column}`;

/**
 * What a read of one row depends on: a version per column, relation and draft column, one for
 * the row and one for the draft as a whole. Made with the model, since Svelte does not follow a
 * signal made inside the read that first needs it.
 */
export class ModelSignals {
	private static readonly keys = new WeakMap<object, [string, number][]>();
	private static last = 0;

	private readonly versions: SvelteMap<string, number>;

	constructor(modelClass: object, columns: Iterable<string>, relations: readonly string[]) {
		let keys = ModelSignals.keys.get(modelClass);
		if (!keys) {
			keys = [ROW, EXISTS, EDITS, ...relations].map(key => [key, 0]);
			for (const column of columns) keys.push([column, 0], [edit(column), 0]);
			ModelSignals.keys.set(modelClass, keys);
		}
		this.versions = new SvelteMap(keys);
	}

	// what the core reports

	/** A commit changed `columns`, or the committed values were put back. */
	committed(columns: readonly string[]): void {
		this.bump([...columns, ROW]);
	}

	/** The row is gone, or back after a rollback: every column, the row, and whether it exists. */
	gone(columns: Iterable<string>): void {
		this.bump([...columns, ROW, EXISTS]);
	}

	created(): void {
		this.bump([ROW, EXISTS]);
	}

	/** The draft shows `columns` differently. */
	edited(columns: readonly string[]): void {
		this.bump([...columns.map(edit), EDITS]);
	}

	/** The loaded relation holds another value. */
	pointed(name: string): void {
		this.bump([name]);
	}

	// what a read depends on

	/** Any commit to the row, its creation and deletion included. */
	readRow(): void {
		this.versions.get(ROW);
	}

	readExists(): void {
		this.versions.get(EXISTS);
	}

	readColumn(name: string): void {
		this.versions.get(name);
	}

	readRelation(name: string): void {
		this.versions.get(name);
	}

	/** A draft's column: its edit, and the committed column beneath it. */
	readEdit(name: string): void {
		this.versions.get(edit(name));
		this.versions.get(name);
	}

	/** Any edit to the draft. */
	readEdits(): void {
		this.versions.get(EDITS);
	}

	private bump(keys: readonly string[]): void {
		Notices.send(() => {
			for (const key of keys) this.versions.set(key, ++ModelSignals.last);
		});
	}
}

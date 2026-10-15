import { afterEach, beforeEach } from 'bun:test';

import { Database, type DatabaseOptions } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { crate } from './crate';
import type { CrateProcess } from './crate-process';

export const FILE = 'app.sqlite';

/** A clean crate per test, and the databases opened on it closed afterwards. */
export class TestBed {
	crate: CrateProcess;
	private opened: Database[] = [];

	/** Registers the hooks; call at the top of a test file or `describe`. */
	static use(): TestBed {
		const bed = new TestBed();
		beforeEach(() => {
			bed.crate = crate.open();
			crate.current = bed.crate;
		});
		afterEach(async () => {
			for (const database of bed.opened.splice(0)) {
				await database.close().catch(() => {});
			}
			crate.current = null;
		});
		return bed;
	}

	database(options: Partial<DatabaseOptions> = {}): Database {
		const database = new Database({ path: FILE, ...options });
		this.opened.push(database);
		return database;
	}

	/** A database with `schema` already run on it, one statement per entry. */
	async databaseWith(
		schema: readonly string[],
		options: Partial<DatabaseOptions> = {},
	): Promise<Database> {
		const database = this.database(options);
		for (const sql of schema) await database.run(new Statement(sql));
		this.crate.calls.length = 0;
		return database;
	}
}

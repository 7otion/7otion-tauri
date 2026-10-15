import { afterEach } from 'bun:test';

import type { Database, DatabaseOptions } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { TestBed } from './database';
import { resetEvents, SCHEMA } from './models';

/** A test bed whose database carries the fixture schema and has every model bound to it. */
export class OrmBed {
	private constructor(readonly bed: TestBed) {}

	static use(): OrmBed {
		const orm = new OrmBed(TestBed.use());
		afterEach(() => {
			Model.$default = null;
			resetEvents();
		});
		return orm;
	}

	get crate() {
		return this.bed.crate;
	}

	async open(options: Partial<DatabaseOptions> = {}): Promise<Database> {
		const database = await this.bed.databaseWith(SCHEMA, options);
		Model.connect(database);
		resetEvents();
		return database;
	}

	/** Rows written around the ORM, for tests of reading. */
	async seed(database: Database, sql: readonly string[]): Promise<void> {
		for (const statement of sql) {
			await database.run(new Statement(statement));
		}
		this.crate.calls.length = 0;
	}
}

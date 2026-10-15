import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Article } from '../harness/models';
import { OrmBed } from '../harness/orm';

class Stamp extends Model<typeof Stamp.schema> {
	static readonly schema = this.define({
		table: 'stamps',
		columns: {
			id: Column.integer().primary().generated(),
			at: Column.date('unix'),
		},
	});
}

describe('a value that would be stored as the one saved is no change', () => {
	const orm = OrmBed.use();

	test('an empty string, where the column stores it as null, over a null', async () => {
		await orm.open();
		const article = await Article.create({ ref: 'a', summary: null });
		orm.crate.calls.length = 0;

		article.draft().summary = '';

		expect(article.isDirty).toBe(false);
		await article.save();
		expect(orm.crate.statements).toEqual([]);
	});

	test('a time within the second a unix date column already holds', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE stamps (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL)',
			),
		);
		const stamp = await Stamp.create({ at: new Date(1_700_000_000_000) });
		orm.crate.calls.length = 0;

		stamp.draft().at = new Date(1_700_000_000_250);

		expect(stamp.isDirty).toBe(false);
		await stamp.save();
		expect(orm.crate.statements).toEqual([]);
	});
});

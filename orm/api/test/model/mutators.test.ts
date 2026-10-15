import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import { OrmBed } from '../harness/orm';

class Article extends Model<typeof Article.schema> {
	static readonly schema = this.define({
		table: 'drafts',
		columns: {
			id: Column.integer().primary().generated(),
			title: Column.text(),
			slug: Column.text(),
			note: Column.text().nullable(),
		},
	});

	static readonly mutators = this.mutate({
		title: (value, article) => {
			article.slug = `${value.trim().toLowerCase().replace(/\s+/g, '-')}  `;
			return value.trim();
		},
		slug: value => value.trim(),
		note: value => value?.toUpperCase() ?? null,
	});
}

const DRAFTS =
	'CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL, note TEXT)';

describe('mutators', () => {
	const orm = OrmBed.use();

	test('an assignment on the draft runs the column’s mutator', () => {
		const article = new Article().draft();

		article.title = '  Hello World ';

		expect(article.title).toBe('Hello World');
	});

	test('a column assigned inside a mutator is set as given, past its own mutator', () => {
		const article = new Article().draft();

		article.title = 'Hello World';
		expect(article.slug).toBe('hello-world  ');

		article.slug = ' own ';
		expect(article.slug).toBe('own');
	});

	test('null reaches a nullable column’s mutator', () => {
		const article = new Article().draft();

		article.note = 'quiet';
		expect(article.note).toBe('QUIET');
		article.note = null;
		expect(article.note).toBeNull();
	});

	test('query().update() writes its values as given, as a mass update does', async () => {
		const db = await orm.open();
		await db.run(new Statement(DRAFTS));
		await Article.create({ title: 'a', slug: 'a' });

		await Article.query().update({ title: '  as given  ' });

		expect((await Article.query().first())!.title).toBe('  as given  ');
	});

	test('sync stores a created member’s match column as its mutator makes it', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE owners (id INTEGER PRIMARY KEY); ' +
					'CREATE TABLE marks (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, label TEXT NOT NULL); ' +
					'INSERT INTO owners (id) VALUES (1)',
			),
		);
		class Mark extends Model<typeof Mark.schema> {
			static readonly schema = this.define({
				table: 'marks',
				columns: {
					id: Column.integer().primary().generated(),
					owner_id: Column.integer(),
					label: Column.text(),
				},
			});

			static readonly mutators = this.mutate({ label: value => `[${value}]` });
		}
		class Owner extends Model<typeof Owner.schema> {
			static readonly schema = this.define({
				table: 'owners',
				columns: { id: Column.integer().primary() },
			});

			declare marks: Collection<Mark>;
			static readonly relations = {
				marks: this.hasMany(() => Mark, { foreignKey: 'owner_id' }),
			};
		}

		await (await Owner.find(1))!.sync('marks', ['a'], { matchOn: ['label'] });

		expect(await Mark.query().pluck('label')).toEqual(['[a]']);
	});

	test('a subclass of a model cannot declare its own accessor over a column either', () => {
		class Base extends Model<typeof Base.schema> {
			static readonly schema = this.define({
				table: 't',
				columns: { id: Column.integer().primary(), name: Column.text() },
			});
		}
		class Sub extends Base {
			set name(value: string) {
				void value;
			}
		}

		expect(() => new Sub()).toThrow('give it a mutator');
	});

	test('a value read from the database does not pass through the mutator', async () => {
		const db = await orm.open();
		await db.run(new Statement(DRAFTS));
		await db.run(
			new Statement("INSERT INTO drafts (title, slug) VALUES ('  raw  ', 'raw')"),
		);

		expect((await Article.query().first())!.title).toBe('  raw  ');
	});
});

/** Never run: the compiler is the test. */
export function mutatorsAreTyped(): void {
	class Typed extends Model<typeof Typed.schema> {
		static readonly schema = this.define({
			table: 't',
			columns: { id: Column.integer().primary(), name: Column.text() },
		});

		static readonly mutators = this.mutate({
			// @ts-expect-error a text column's mutator returns text
			name: value => value.length,
		});
	}
	void Typed;

	class Misnamed extends Model<typeof Misnamed.schema> {
		static readonly schema = this.define({
			table: 't',
			columns: { id: Column.integer().primary(), name: Column.text() },
		});

		// @ts-expect-error no column named `nmae`
		static readonly mutators = this.mutate({ nmae: (value: string) => value });
	}
	void Misnamed;
}

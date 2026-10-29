import { describe, expect, test } from 'bun:test';

import type { Database } from '../../src/database/database';
import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import { Column } from '../../src/schema/column';
import { OrmBed } from '../harness/orm';

const SCHEMA =
	'CREATE TABLE countries (code TEXT COLLATE NOCASE PRIMARY KEY, name TEXT NOT NULL);' +
	' CREATE TABLE cities (id INTEGER PRIMARY KEY, country TEXT COLLATE NOCASE, name TEXT NOT NULL);' +
	' CREATE TABLE tags (slug TEXT COLLATE NOCASE PRIMARY KEY);' +
	' CREATE TABLE country_tags (country TEXT COLLATE NOCASE, tag TEXT COLLATE NOCASE);' +
	' CREATE TABLE pins (id INTEGER PRIMARY KEY, kind TEXT, ref TEXT);' +
	" INSERT INTO countries VALUES ('FR', 'France'), ('ÉT', 'Étoile');" +
	" INSERT INTO cities (country, name) VALUES ('fr', 'Paris'), ('Fr', 'Lyon'), ('ét', 'Nowhere');" +
	" INSERT INTO tags VALUES ('Wine');" +
	" INSERT INTO country_tags VALUES ('fR', 'WINE');" +
	" INSERT INTO pins (kind, ref) VALUES ('country', 'fr')";

class City extends Model<typeof City.schema> {
	static readonly schema = this.define({
		table: 'cities',
		columns: {
			id: Column.integer().primary().generated(),
			country: Column.text().nullable().nocase(),
			name: Column.text(),
		},
	});

	declare owner: Country | null;

	static readonly relations = {
		owner: this.belongsTo(() => Country, { foreignKey: 'country' }),
	};
}

class Tag extends Model<typeof Tag.schema> {
	static readonly schema = this.define({
		table: 'tags',
		columns: { slug: Column.text().primary().nocase() },
	});
}

class Country extends Model<typeof Country.schema> {
	static readonly schema = this.define({
		table: 'countries',
		columns: {
			code: Column.text().primary().nocase(),
			name: Column.text(),
		},
	});

	declare cities: Collection<City>;
	declare tags: Collection<Tag>;

	static readonly relations = {
		cities: this.hasMany(() => City, {
			foreignKey: 'country',
			localKey: 'code',
		}),
		tags: this.belongsToMany(() => Tag, {
			pivot: 'country_tags',
			foreignPivotKey: 'country',
			relatedPivotKey: 'tag',
			parentKey: 'code',
			relatedKey: 'slug',
		}),
	};
}

class Pin extends Model<typeof Pin.schema> {
	static readonly schema = this.define({
		table: 'pins',
		columns: {
			id: Column.integer().primary().generated(),
			kind: Column.text().nullable(),
			ref: Column.text().nullable(),
		},
	});

	declare target: Country | null;

	static readonly relations = {
		target: this.morphTo<Country>({
			typeColumn: 'kind',
			keyColumn: 'ref',
			types: { country: () => Country },
		}),
	};
}

describe('nocase() columns', () => {
	const orm = OrmBed.use();
	const open = async (): Promise<Database> => {
		const db = await orm.open();
		await db.run(new Statement(SCHEMA));
		return db;
	};

	test('hasMany and belongsTo match a key that differs only in case', async () => {
		await open();

		const france = (await Country.query()
			.with('cities')
			.where('code', 'FR')
			.first())!;
		const cities = await City.query().with('owner').orderBy('id').get();

		expect(france.cities.pluck('name').sort()).toEqual(['Lyon', 'Paris']);
		expect(cities.at(0)!.owner?.name).toBe('France');
		expect(cities.at(1)!.owner?.name).toBe('France');
	});

	test('only A to Z fold, as in SQLite', async () => {
		await open();

		const [nowhere] = await City.query()
			.with('owner')
			.where('name', 'Nowhere')
			.get();
		const etoile = (await Country.query()
			.with('cities')
			.where('name', 'Étoile')
			.first())!;

		expect(nowhere!.owner).toBeNull();
		expect(etoile.cities).toHaveLength(0);
	});

	test('belongsToMany matches the pivot on both sides', async () => {
		await open();

		const france = (await Country.query()
			.with('tags')
			.where('code', 'FR')
			.first())!;

		expect(france.tags.pluck('slug')).toEqual(['Wine']);
	});

	test('morphTo matches as the target column compares', async () => {
		await open();

		const [pin] = await Pin.query().with('target').get();

		expect(pin!.target?.name).toBe('France');
	});

	test('a column without nocase() still matches exactly', async () => {
		const db = await open();
		await db.run(
			new Statement(
				'CREATE TABLE plain_parents (code TEXT PRIMARY KEY); ' +
					'CREATE TABLE plain_children (id INTEGER PRIMARY KEY, code TEXT); ' +
					"INSERT INTO plain_parents VALUES ('A'); " +
					"INSERT INTO plain_children (code) VALUES ('a'), ('A')",
			),
		);
		class PlainChild extends Model<typeof PlainChild.schema> {
			static readonly schema = this.define({
				table: 'plain_children',
				columns: {
					id: Column.integer().primary().generated(),
					code: Column.text(),
				},
			});
		}
		class PlainParent extends Model<typeof PlainParent.schema> {
			static readonly schema = this.define({
				table: 'plain_parents',
				columns: { code: Column.text().primary() },
			});

			declare children: Collection<PlainChild>;
			static readonly relations = {
				children: this.hasMany(() => PlainChild, {
					foreignKey: 'code',
					localKey: 'code',
				}),
			};
		}

		const [parent] = await PlainParent.query().with('children').get();

		expect(parent!.children.pluck('code')).toEqual(['A']);
	});

	test('a folded key is still written as it was given', async () => {
		await open();

		const city = await City.create({ country: 'fR', name: 'Nice' });
		city.draft().country = 'FR';

		expect(city.draft().country).toBe('FR');
		expect(city.getDirty()).toEqual(['country']);
	});
});

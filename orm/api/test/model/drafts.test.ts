import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';

class Article extends Model<typeof Article.schema> {
	static readonly schema = this.define({
		table: 'drafts',
		columns: {
			id: Column.integer().primary().generated(),
			title: Column.text(),
			slug: Column.text(),
		},
	});

	static readonly mutators = this.mutate({
		title: (value, article) => {
			article.slug = value.trim().toLowerCase().replace(/\s+/g, '-');
			return value.trim();
		},
	});
}

const DRAFTS =
	'CREATE TABLE drafts (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT NOT NULL)';

describe('the draft', () => {
	const orm = OrmBed.use();

	test('the model shows the database; the draft shows the edits over it', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });

		user.draft().name = 'Annie';

		expect([user.name, user.draft().name]).toEqual(['Ann', 'Annie']);
		expect([user.age, user.draft().age]).toEqual([30, 30]);
		expect(user.getPending()).toEqual({ name: { from: 'Ann', to: 'Annie' } });
	});

	test('save(column) saves only that edit and leaves the rest pending', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'Annie';
		user.draft().age = 31;

		await user.save('name');

		expect([user.name, user.age]).toEqual(['Annie', 30]);
		expect(user.getDirty()).toEqual(['age']);
		expect(await User.query().pluck('age')).toEqual([30]);
	});

	test('discard drops every edit, or only the columns named', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'Annie';
		user.draft().age = 31;

		user.discard('age');
		expect(user.getDirty()).toEqual(['name']);

		user.discard();
		expect(user.isDirty).toBe(false);
		expect(user.draft().name).toBe('Ann');
	});

	test('update writes its patch now and leaves the draft as it was', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', age: 30 });
		user.draft().name = 'typing…';
		user.draft().age = 99;

		await user.update({ age: 31 });

		expect([user.name, user.age]).toEqual(['Ann', 31]);
		expect(user.getPending()).toEqual({
			name: { from: 'Ann', to: 'typing…' },
			age: { from: 31, to: 99 },
		});
		expect(await User.query().pluck('age')).toEqual([31]);
	});

	test('update runs the mutators, as an instance write does', async () => {
		const db = await orm.open();
		await db.run(new Statement(DRAFTS));
		const article = await Article.create({ title: 'a', slug: 'a' });

		await article.update({ title: '  Hello World ' });

		expect([article.title, article.slug]).toEqual(['Hello World', 'hello-world']);
		expect(article.isDirty).toBe(false);
	});

	test('the draft is shared: two holders of a row edit one draft', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		const again = (await User.find(user.id))!;

		user.draft().name = 'Annie';

		expect(again.draft().name).toBe('Annie');
		expect(again.isDirty).toBe(true);
	});

	test('a nested edit inside a JSON value on the draft is a pending edit of that column', async () => {
		await orm.open();
		const user = await User.create({
			name: 'Ann',
			settings: { theme: 'dark', tags: ['a'] },
		});

		const settings = user.draft().settings!;
		settings.tags.push('b');
		settings.theme = 'light';

		expect(user.getDirty()).toEqual(['settings']);
		expect(user.draft().settings).toEqual({ theme: 'light', tags: ['a', 'b'] });
		expect(user.settings).toEqual({ theme: 'dark', tags: ['a'] });
		expect(Array.isArray(user.draft().settings!.tags)).toBe(true);

		await user.save();
		expect(user.settings).toEqual({ theme: 'light', tags: ['a', 'b'] });
		expect(user.isDirty).toBe(false);
	});

	test('a method of the class works on the draft and sees the pending values', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann', email: 'a@x.io' });

		user.draft().name = 'Annie';

		expect(user.label).toBe('Ann <a@x.io>');
		expect(user.draft().label).toBe('Annie <a@x.io>');
	});
});

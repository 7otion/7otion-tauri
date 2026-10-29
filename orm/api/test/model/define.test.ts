import { expect, test } from 'bun:test';

import { OrmError } from '../../src/errors';
import { Model } from '../../src/model/model';
import type { Draft } from '../../src/model/types';
import { Column } from '../../src/schema/column';
import { User } from '../harness/models';

test('a model needs a primary key', () => {
	expect(() =>
		Model.define({ table: 't', columns: { a: Column.text() } }),
	).toThrow('declares no primary key');
});

test('a column cannot take the name of a model member, nor start with $', () => {
	expect(() =>
		Model.define({
			table: 't',
			columns: { id: Column.integer().primary(), fill: Column.text() },
		}),
	).toThrow("'fill' cannot name a column");
	expect(() =>
		Model.define({
			table: 't',
			columns: { id: Column.integer().primary(), $x: Column.text() },
		}),
	).toThrow("'$x' cannot name a column");
});

test('a table defined on Model itself, outside a model class, is refused', () => {
	expect(() =>
		Model.define({
			table: 't',
			columns: { id: Column.integer().primary() },
		}),
	).toThrow('Define it inside its model class');
});

test('a class that extends Model without a schema is refused', () => {
	class Bare extends Model {}
	expect(() => new Bare()).toThrow('has no schema');
});

test('a class that declares its own accessor over a column is refused as it is declared, and pointed to mutators', () => {
	expect(() => {
		class Accessed extends Model<typeof Accessed.schema> {
			static readonly schema = this.define({
				table: 't',
				columns: {
					id: Column.integer().primary(),
					name: Column.text(),
				},
			});

			get name(): string {
				return 'shown';
			}
		}
		void Accessed;
	}).toThrow('give it a mutator');
});

test('an instance shows no own keys, and serialises to its committed columns; its draft to what it holds', () => {
	const user = new User().fill({ name: 'Ann', active: true });

	expect(Object.keys(user)).toEqual([]);
	expect({ ...user } as object).toEqual({});
	expect(user.toObject()).toEqual({});
	expect(user.draft().toObject()).toEqual({ name: 'Ann', active: true });
	expect(JSON.stringify(user.draft())).toBe('{"name":"Ann","active":true}');
});

test('a getter on the model reads columns, on the draft the pending ones', () => {
	const user = new User().fill({ name: 'Ann' });
	expect(user.draft().label).toBe('Ann <no email>');
});

test('assigning a column the model does not declare is refused', () => {
	const user = new User();
	expect(() => user.$attributes.assign('nickname', 'x')).toThrow(
		"declares no column named 'nickname'",
	);

	user.fill({ name: 'Ann', nickname: 'x' } as never);
	expect(user.draft().toObject()).toEqual({ name: 'Ann' });
});

/** Never run: the compiler is the test. */
export function typesAreChecked(): void {
	const user = new User();
	const draft = user.draft();
	draft.name = 'ann';
	draft.age = null;

	// @ts-expect-error the model shows the database; edits go on the draft
	user.name = 'ann';
	// @ts-expect-error name is text
	draft.name = 1;
	// @ts-expect-error not nullable
	draft.name = null;
	// @ts-expect-error not a column
	draft.nickname = 'x';
	// @ts-expect-error a timestamp is the ORM's to set
	draft.created_at = new Date();

	const read = (model: User): string => model.name;
	read(draft); // a draft passes where a model is read
	const edit = (target: Draft<User>): void => void (target.name = 'x');
	// @ts-expect-error a model does not pass where a draft is asked for
	edit(user);
	const owner: User = draft.model();
	void owner;
	// @ts-expect-error not a column
	user.fill({ nickname: 'x' });
	// @ts-expect-error a timestamp is the ORM's to set
	user.fill({ created_at: new Date() });

	const made: Date = user.created_at;
	void made;
}

test('undefined cannot be assigned; null clears a column', () => {
	const user = new User();
	expect(() => {
		user.draft().email = undefined as never;
	}).toThrow(OrmError);

	user.draft().email = null;
	expect(user.draft().email).toBeNull();
});

test('a column cannot be assigned on the model, and reads nothing on a row never saved', () => {
	const user = new User();

	expect(() => {
		(user as { name: string }).name = 'Ann';
	}).toThrow('model.draft().name');
	expect(() => user.name).toThrow('not saved yet');

	user.draft().name = 'Ann';
	expect(user.draft().name).toBe('Ann');
	expect(user.draft().model()).toBe(user);
	expect(user.draft()).toBe(user.draft());
});

test('a timestamp cannot be assigned, and fill leaves it out', () => {
	const user = new User();
	expect(() => {
		// @ts-expect-error the ORM maintains it
		user.draft().created_at = new Date();
	}).toThrow('is a timestamp');

	user.fill({ name: 'Ann', created_at: new Date() } as never);
	expect(user.draft().toObject()).toEqual({ name: 'Ann' });
});

test('a model without a database says how to get one', () => {
	expect(() => User.database).toThrow('Call Model.connect(database) first');
});

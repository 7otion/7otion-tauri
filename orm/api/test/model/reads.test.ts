import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Comment, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { State, Watch } from '../harness/watch.svelte';

describe('what a read follows', () => {
	const orm = OrmBed.use();

	test('a column follows its own commits, not another column’s or another row’s', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann', age: 30 });
		const bob = await User.create({ name: 'Bob', age: 40 });
		const name = new Watch(() => ann.name);
		const age = new Watch(() => ann.age);
		const other = new Watch(() => bob.name);

		await ann.update({ name: 'Annie' });

		expect([name.reruns, age.reruns, other.reruns]).toEqual([1, 0, 0]);
		expect(name.last).toBe('Annie');
	});

	test('a commit that changes two columns is shown once to a reader of both', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann', age: 30 });
		const summary = new Watch(() => `${ann.name} ${ann.age}`);

		await ann.update({ name: 'Annie', age: 31 });

		expect(summary.seen).toEqual(['Ann 30', 'Annie 31']);
	});

	test('a delete tells the readers of the row, of its columns and of its draft', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		ann.draft().name = 'Annie';
		const exists = new Watch(() => ann.exists);
		const name = new Watch(() => ann.name);
		const edit = new Watch(() => ann.draft().name);
		const dirty = new Watch(() => ann.isDirty);

		await ann.delete();

		expect([exists.last, name.last, edit.last, dirty.last]).toEqual([
			false,
			'Ann',
			'Ann',
			false,
		]);
	});

	test('a draft edit tells the readers of that draft column, never of the committed column', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann', age: 30 });
		const edit = new Watch(() => ann.draft().name);
		const otherEdit = new Watch(() => ann.draft().age);
		const dirty = new Watch(() => ann.isDirty);
		const column = new Watch(() => ann.name);

		ann.draft().name = 'Annie';
		ann.draft().name = 'Annie';

		expect([
			edit.reruns,
			otherEdit.reruns,
			dirty.reruns,
			column.reruns,
		]).toEqual([1, 0, 1, 0]);
	});

	test('a draft column with no edit follows the commits beneath it, and one with an edit keeps showing it', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const preview = new Watch(() => `(${ann.draft().name})`);

		await ann.update({ name: 'Anna' });
		expect(preview.last).toBe('(Anna)');

		ann.draft().name = 'Annie';
		await ann.update({ name: 'Ana' });
		expect(preview.last).toBe('(Annie)');

		ann.discard();
		expect(preview.last).toBe('(Ana)');
	});

	test('a collection follows its rows, not a member’s other columns', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann', active: true });
		const active = await User.query().where('active', true).get();
		const names = new Watch(() => active.rows.length);

		await ann.update({ name: 'Annie' });
		expect(names.reruns).toBe(0);

		await User.create({ name: 'Bob', active: true });
		expect(names.reruns).toBe(1);

		await ann.update({ active: false });
		expect(names.reruns).toBe(2);
		// Held to the end, as a component holds it: the registry keeps a collection weakly.
		expect(active.pluck('name')).toEqual(['Bob']);
	});

	test('every helper of a collection follows its rows', async () => {
		await orm.open();
		await User.create({ name: 'Ann' });
		const users = await User.query().orderBy('name').get();
		const iterated = new Watch(() =>
			[...users].map(user => user.name).join(),
		);
		const plucked = new Watch(() => users.pluck('name').join());
		const first = new Watch(() => users.first?.name);

		await User.create({ name: 'Aaron' });

		expect([iterated.last, plucked.last, first.last]).toEqual([
			'Aaron,Ann',
			'Aaron,Ann',
			'Aaron',
		]);
	});

	test('a relation loaded again by another query moves its readers to the new collection', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const post = await Post.create({ user_id: ann.id, title: 'Hi' });
		await Comment.create({ post_id: post.id, body: 'one', sort: 1 });
		await post.load('comments');
		const bodies = new Watch(() => post.comments.pluck('body').join(','));

		const again = await Post.query().with('comments').get();
		expect(again.first).toBe(post);
		await Comment.create({ post_id: post.id, body: 'two', sort: 2 });

		expect(bodies.last).toBe('one,two');
	});

	test('a rollback that puts back committed values tells what read them meanwhile', async () => {
		const database = await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const step = new State(0);
		const label = new Watch(() => `${step.value}:${ann.name}`);

		await database
			.transaction(async tx => {
				await ann.update({ name: 'T' }, tx);
				step.value = 1;
				throw new Error('rollback');
			})
			.catch(() => {});

		expect(ann.name).toBe('Ann');
		expect(label.last).toBe('1:Ann');
	});

	test('a loaded to-one follows the key it hangs on', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const bob = await User.create({ name: 'Bob' });
		const post = await Post.create({ user_id: ann.id, title: 'Hi' });
		await post.load('author');
		const author = new Watch(() => post.author?.name);

		await post.update({ user_id: bob.id });

		expect(author.last).toBe('Bob');
		expect(post.author).toBe(bob);
	});

	test('a related row’s own column is followed through the relation', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const post = await Post.create({ user_id: ann.id, title: 'Hi' });
		await post.load('author');
		const author = new Watch(() => post.author?.name);

		await ann.update({ name: 'Annie' });

		expect(author.seen).toEqual(['Ann', 'Annie']);
	});

	test('a read that finds a held row changed around the ORM tells what reads the row', async () => {
		const database = await orm.open();
		const ann = await User.create({ name: 'Ann', age: 30 });
		const name = new Watch(() => ann.name);
		const age = new Watch(() => ann.age);
		await database.run(
			new Statement(
				`UPDATE users SET name = 'Annie' WHERE id = ${ann.id}`,
			),
		);

		await ann.refresh();
		expect([name.last, age.reruns]).toEqual(['Annie', 0]);

		await database.run(
			new Statement(
				`UPDATE users SET name = 'Anna' WHERE id = ${ann.id}`,
			),
		);
		expect(await User.find(ann.id)).toBe(ann);
		expect(name.last).toBe('Anna');

		await database.run(
			new Statement(`UPDATE users SET name = 'Ana' WHERE id = ${ann.id}`),
		);
		await database.transaction(async tx => {
			await ann.refresh(undefined, tx);
		});
		expect(name.last).toBe('Ana');
	});

	test('deleting a row that is already gone tells what reads whether it exists', async () => {
		const database = await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const exists = new Watch(() => ann.exists);
		await database.run(
			new Statement(`DELETE FROM users WHERE id = ${ann.id}`),
		);

		expect(await ann.delete()).toBe(false);

		expect(exists.seen).toEqual([true, false]);
	});

	test('a row read from outside while its delete commits is gone once it has', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		let reached!: () => void;
		const inHandler = new Promise<void>(resolve => (reached = resolve));
		User.registerEvent('delete:after', async () => {
			reached();
			await new Promise(resolve => setTimeout(resolve, 80));
		});
		const deleting = ann.delete();
		await inHandler;
		const users = await User.query().get();
		const other = users.first!;
		const shown = new Watch(() => `${users.rows.length}/${other.exists}`);

		await deleting;

		expect(other).not.toBe(ann);
		expect(shown.last).toBe('0/false');
	});

	test('what is read outside any effect follows nothing and costs no subscription', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });

		expect(ann.name).toBe('Ann');
		await ann.update({ name: 'Annie' });
		expect(ann.name).toBe('Annie');
	});

	test('a getter of the class follows what it reads', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann', age: 30 });
		const object = new Watch(() => ann.toObject().name);

		await ann.update({ age: 31 });
		await ann.update({ name: 'Annie' });

		expect(object.last).toBe('Annie');
	});
});

import { describe, expect, test } from 'bun:test';

import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';
import { Watch } from '../harness/watch.svelte';

describe('what a commit tells Svelte', () => {
	const orm = OrmBed.use();

	test('a write without a transaction tells what reads its row once it is done', async () => {
		await orm.open();
		const user = await User.create({ name: 'Ann' });
		const exists = new Watch(() => user.exists);
		const age = new Watch(() => user.age);

		await user.update({ age: 3 });
		expect([exists.reruns, age.reruns]).toEqual([0, 1]);

		await user.delete();
		expect([exists.reruns, age.reruns]).toEqual([1, 2]);
		expect(exists.last).toBe(false);
	});

	test('a transaction shows everything it did at once, after its commit and before its :committed handlers', async () => {
		const db = await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const post = await Post.create({ title: 'Hello' });
		const order: string[] = [];
		User.registerEvent(
			'update:committed',
			() => void order.push('handler'),
		);
		new Watch(() => order.push(`shown ${ann.name} ${post.title}`));
		order.length = 0;

		await db.transaction(async tx => {
			await ann.update({ name: 'Annie' }, tx);
			await post.update({ title: 'Hi' }, tx);
			expect(order).toEqual([]);
		});

		expect(order).toEqual(['shown Annie Hi', 'handler']);
	});

	test('a row and the list it moves in are shown together', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		await User.create({ name: 'Bob' });
		const users = await User.query().orderBy('name').get();
		const shown = new Watch(
			() => `${ann.name}: ${users.pluck('name').join()}`,
		);

		await ann.update({ name: 'Cy' });

		expect(shown.seen).toEqual(['Ann: Ann,Bob', 'Cy: Bob,Cy']);
	});

	test('a rollback tells the values it puts back, and a commit tells once whatever savepoints rolled back inside it', async () => {
		const db = await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const name = new Watch(() => ann.name);

		await rejection(
			db.transaction(async tx => {
				await ann.update({ name: 'Gone' }, tx);
				throw new Error('undo');
			}),
		);
		await db.transaction(async tx => {
			await ann.update({ name: 'Kept' }, tx);
			await rejection(
				tx.savepoint(async () => {
					await ann.update({ name: 'Undone' }, tx);
					throw new Error('undo');
				}),
			);
		});

		// The shared instance showed each write at once; a rollback puts the value back and says so.
		expect(name.seen).toEqual(['Ann', 'Ann', 'Kept', 'Kept']);
	});

	test('a row written through a transaction’s own instance tells what reads its shared instance', async () => {
		const db = await orm.open();
		const shared = await User.create({ name: 'Ann' });
		const age = new Watch(() => shared.age);

		await db.transaction(async tx => {
			const inside = (await User.find(shared.id, tx))!;
			await inside.update({ age: 5 }, tx);
			expect(shared.age).toBeNull();
		});

		expect(age.seen).toEqual([null, 5]);
	});

	test('a :committed handler that takes its time holds back no other commit', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		const posts = await Post.query().get();
		let release!: () => void;
		const uploading = new Promise<void>(resolve => (release = resolve));
		let started!: () => void;
		const handlerStarted = new Promise<void>(
			resolve => (started = resolve),
		);
		Post.registerEvent('create:committed', async () => {
			started();
			await uploading;
		});
		const titles = new Watch(() => posts.pluck('title').join());
		const name = new Watch(() => ann.name);

		const creating = Post.create({ title: 'Hello' });
		await handlerStarted;
		await ann.update({ name: 'Annie' });

		expect([titles.last, name.last]).toEqual(['Hello', 'Annie']);

		release();
		await creating;
	});
});

import { describe, expect, test } from 'bun:test';

import { Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';

describe('writes at once and in odd order', () => {
	const orm = OrmBed.use();

	test('a new model with a handler inside its write saved twice at once inserts one row', async () => {
		await orm.open();
		Post.registerEvent('save:before', () => {});
		const post = new Post().fill({ title: 'x' });
		await Promise.all([post.save(), post.save()]);
		expect(await Post.query().count()).toBe(1);
	});

	test('two deletes of one instance at once announce once', async () => {
		await orm.open();
		const user = await User.create({ name: 'A' });
		let heard = 0;
		User.registerEvent(
			'delete:committed',
			written => void (heard += written.length),
		);
		const results = await Promise.all([user.delete(), user.delete()]);
		expect(results.sort()).toEqual([false, true]);
		expect(heard).toBe(1);
	});

	test('a new model with a handler inside its write saved twice at once, edited between, keeps both edits', async () => {
		await orm.open();
		Post.registerEvent('save:before', () => {});
		const post = new Post().fill({ title: 'x' });
		const first = post.save();
		post.draft().title = 'y';
		const second = post.save();
		await Promise.all([first, second]);
		const row = await Post.query().first();
		expect(row!.title).toBe('y');
		expect(post.isDirty).toBe(false);
	});

	test('a read that began before a save landed does not put the old value back', async () => {
		await orm.open();
		const wrong: string[] = [];

		for (let round = 0; round < 40; round++) {
			const user = await User.create({ name: `Ann${round}` });
			const reading =
				round % 2 === 0
					? User.find(user.id)
					: User.query().where('id', user.id).get();
			await Promise.all([
				reading,
				user.update({ name: `Annie${round}` }),
			]);
			if (user.name !== `Annie${round}`) wrong.push(user.name);
		}

		expect(wrong).toEqual([]);
	});
});

import { describe, expect, test } from 'bun:test';

import { Note, Post, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { Watch } from '../harness/watch.svelte';

describe('a relation is shown with the commit that moved it', () => {
	const orm = OrmBed.use();

	const authored = async () => {
		const ann = await User.create({ name: 'Ann' });
		const bob = await User.create({ name: 'Bob' });
		const post = await Post.create({ user_id: ann.id, title: 'Hi' });
		await post.load('author');
		return { ann, bob, post };
	};

	test('a key change shows the new to-one, the key column and the lists in one step', async () => {
		await orm.open();
		const { bob, post } = await authored();
		await bob.load('posts');
		const shown = new Watch(
			() => `${post.user_id} ${post.author?.name} ${bob.posts.length}`,
		);

		await post.update({ user_id: bob.id });

		expect(shown.seen).toEqual([`1 Ann 0`, `${bob.id} Bob 1`]);
	});

	test('a transaction shows nothing of a key change before its commit, the loaded to-one included', async () => {
		const db = await orm.open();
		const { ann, bob, post } = await authored();
		const shown = new Watch(() => `${post.user_id} ${post.author?.name}`);

		let during: readonly string[] = [];
		await db.transaction(async tx => {
			await post.update({ user_id: bob.id }, tx);
			await new Promise(resolve => setTimeout(resolve, 10));
			during = [...shown.seen];
		});

		expect(during).toEqual([`${ann.id} Ann`]);
		expect(shown.seen).toEqual([`${ann.id} Ann`, `${bob.id} Bob`]);
	});

	test('a relation loaded again inside a transaction that wrote its row is read after the commit', async () => {
		const db = await orm.open();
		const { ann } = await authored();
		await ann.load('posts');
		const shown = new Watch(
			() => `${ann.name}: ${ann.posts.pluck('title').join()}`,
		);

		await db.transaction(async tx => {
			await ann.update({ name: 'Annie' }, tx);
			await ann.refresh(['posts'], tx);
		});

		expect(shown.seen).toEqual(['Ann: Hi', 'Annie: Hi']);
	});

	test('a relation loaded inside a transaction that wrote nothing is shared once it commits', async () => {
		const db = await orm.open();
		const { post } = await authored();
		const shown = new Watch(() => post.author?.name);

		await db.transaction(async tx => {
			await post.refresh(['author'], tx);
		});
		await (await User.findOrFail(post.user_id!)).update({ name: 'Annie' });

		expect(shown.last).toBe('Annie');
	});

	test('a rolled back key change leaves the to-one as it was shown', async () => {
		const db = await orm.open();
		const { bob, post } = await authored();
		const shown = new Watch(() => `${post.user_id} ${post.author?.name}`);

		await db
			.transaction(async tx => {
				await post.update({ user_id: bob.id }, tx);
				throw new Error('undo');
			})
			.catch(() => {});

		expect([...new Set(shown.seen)]).toEqual(['1 Ann']);
	});

	test('a reader of a morphTo alone is told when its target is deleted', async () => {
		await orm.open();
		const ann = await User.create({ name: 'Ann' });
		await Note.create({
			target_kind: 'user',
			target_id: ann.id,
			body: 'n',
		});
		const note = (await Note.query().with('target').first())!;
		const has = new Watch(() => note.target !== null);

		await ann.delete();

		expect(has.seen).toEqual([true, false]);
	});
});

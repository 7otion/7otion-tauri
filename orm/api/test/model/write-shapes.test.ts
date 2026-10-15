import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { Order, User } from '../harness/models';
import { OrmBed } from '../harness/orm';
import { rejection } from '../harness/rejection';

class Token extends Model<typeof Token.schema> {
	static readonly schema = this.define({
		table: 'tokens',
		columns: {
			code: Column.text().primary(),
			label: Column.text(),
		},
	});
}

describe('writes of unusual shapes', () => {
	const orm = OrmBed.use();

	test('a key the database fills by default: create and createMany agree', async () => {
		const db = await orm.open();
		await db.run(
			new Statement(
				'CREATE TABLE tokens (code TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(4)))), label TEXT NOT NULL)',
			),
		);
		const one = await Token.create({ label: 'a' });
		expect(typeof one.code).toBe('string');
		const many = await rejection(
			Token.createMany([{ label: 'b' }, { label: 'c' }]),
		);
		expect(many).not.toBeInstanceOf(Error);
	});

	test('firstOrCreate by a null column finds the row it made', async () => {
		await orm.open();
		const a = await User.firstOrCreate({ email: null }, { name: 'A' });
		const b = await User.firstOrCreate({ email: null }, { name: 'B' });
		expect(b.id).toBe(a.id);
		expect(await User.query().count()).toBe(1);
	});

	test('updateMany of many composite rows', async () => {
		await orm.open();
		const rows = Array.from({ length: 12000 }, (_, i) => ({
			tenant: 't',
			number: i,
			total: 0,
		}));
		const orders = await Order.createMany(rows);
		for (const o of orders) o.draft().total = 5;
		await Order.updateMany(orders);
		expect(await Order.query().where('total', 5).count()).toBe(12000);
	});

	test('updateMany of many single-key rows with two columns', async () => {
		await orm.open();
		const users = await User.createMany(
			Array.from({ length: 12000 }, (_, i) => ({ name: `u${i}` })),
		);
		for (const u of users) {
			u.draft().age = 3;
			u.draft().email = `${u.id}@x`;
		}
		await User.updateMany(users);
		expect(await User.query().where('age', 3).count()).toBe(12000);
	});

	test('query delete with a listener across many composite rows', async () => {
		await orm.open();
		await Order.createMany(
			Array.from({ length: 12000 }, (_, i) => ({
				tenant: 't',
				number: i,
				total: 0,
			})),
		);
		let heard = 0;
		Order.registerEvent(
			'delete:committed',
			written => void (heard += written.length),
		);
		const removed = await Order.query().delete();
		expect(removed).toBe(12000);
		expect(heard).toBe(12000);
	});
});

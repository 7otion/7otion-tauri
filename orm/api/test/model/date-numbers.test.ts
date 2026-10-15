import { describe, expect, test } from 'bun:test';

import { Statement } from '../../src/database/statement';
import { Model } from '../../src/model/model';
import { Column } from '../../src/schema/column';
import { OrmBed } from '../harness/orm';

const received: unknown[] = [];

class Stamp extends Model<typeof Stamp.schema> {
	static readonly schema = this.define({
		table: 'stamps',
		columns: {
			id: Column.integer().primary().generated(),
			seen_at: Column.date('unix'),
			seen_ms: Column.date('unix_ms').nullable(),
			seen_iso: Column.date('iso').nullable(),
			noted_at: Column.date('unix').nullable(),
		},
	});

	static readonly mutators = this.mutate({
		noted_at: value => {
			received.push(value);
			return value;
		},
	});
}

const STAMPS =
	'CREATE TABLE stamps (id INTEGER PRIMARY KEY AUTOINCREMENT, seen_at INTEGER NOT NULL, ' +
	'seen_ms INTEGER, seen_iso TEXT, noted_at INTEGER)';

const SECONDS = 1_727_712_000;
const AT = new Date(SECONDS * 1000);

describe('a date column given a number', () => {
	const orm = OrmBed.use();

	async function table(): Promise<void> {
		const db = await orm.open();
		await db.run(new Statement(STAMPS));
	}

	test('a unix column takes Unix seconds on create and reads a Date', async () => {
		await table();

		const stamp = await Stamp.create({ seen_at: SECONDS });

		expect(stamp.seen_at).toBeInstanceOf(Date);
		expect(stamp.seen_at.getTime()).toBe(AT.getTime());
		expect(await Stamp.query().pluck('seen_at')).toEqual([AT]);
	});

	test('a unix_ms column takes milliseconds', async () => {
		await table();

		const stamp = await Stamp.create({ seen_at: SECONDS, seen_ms: AT.getTime() + 250 });

		expect(stamp.seen_ms!.getTime()).toBe(AT.getTime() + 250);
	});

	test('a date stored as text takes Unix seconds', async () => {
		await table();

		const stamp = await Stamp.create({ seen_at: SECONDS, seen_iso: SECONDS });

		expect(stamp.seen_iso!.getTime()).toBe(AT.getTime());
		expect(
			(await orm.bed.database().run(new Statement('SELECT seen_iso FROM stamps'))).rows[0]!
				.seen_iso,
		).toBe(AT.toISOString());
	});

	test('update() takes a number', async () => {
		await table();
		const stamp = await Stamp.create({ seen_at: 0 });

		await stamp.update({ seen_at: SECONDS });

		expect(stamp.seen_at.getTime()).toBe(AT.getTime());
	});

	test('fill() and an assignment on the draft take a number', async () => {
		await table();
		const stamp = new Stamp().fill({ seen_at: SECONDS });
		(stamp.draft() as unknown as Record<string, unknown>).seen_ms = AT.getTime();

		await stamp.save();

		expect(stamp.seen_at.getTime()).toBe(AT.getTime());
		expect(stamp.seen_ms!.getTime()).toBe(AT.getTime());
		expect(stamp.draft().seen_at).toBeInstanceOf(Date);
	});

	test('query().update() takes a number, and the rows it wrote read a Date', async () => {
		await table();
		const stamp = await Stamp.create({ seen_at: 0 });

		await Stamp.query().update({ seen_at: SECONDS });

		expect(stamp.seen_at).toBeInstanceOf(Date);
		expect(stamp.seen_at.getTime()).toBe(AT.getTime());
	});

	test('a mutator of a date column receives a Date for a number', async () => {
		await table();
		received.length = 0;

		await Stamp.create({ seen_at: 0, noted_at: SECONDS });

		expect(received).toHaveLength(1);
		expect(received[0]).toBeInstanceOf(Date);
		expect((received[0] as Date).getTime()).toBe(AT.getTime());
	});

	test('a number that is no date is refused', async () => {
		await table();

		await expect(Stamp.create({ seen_at: Number.NaN })).rejects.toThrow('not a date');
	});
});

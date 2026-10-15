import { describe, expect, test } from 'bun:test';

import { User } from '../harness/models';
import { OrmBed } from '../harness/orm';

describe('a query update and the values it is given', () => {
	const orm = OrmBed.use();

	test('a query update with a listener leaves the caller patch and each model independent', async () => {
		await orm.open();
		await User.createMany([{ name: 'A' }, { name: 'B' }]);
		let models: User[] = [];
		User.registerEvent(
			'update:committed',
			written => void (models = written.map(([model]) => model)),
		);
		const patch = { settings: { theme: 'dark', tags: [] as string[] } };
		await User.query().update(patch);
		patch.settings.theme = 'caller-edit';
		expect(models[0]!.settings === models[1]!.settings).toBe(false);
		expect(models[0]!.isDirty).toBe(false);
	});
});

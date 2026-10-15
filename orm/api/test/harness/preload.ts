import { plugin } from 'bun';
import { mock } from 'bun:test';
import { compileModule } from 'svelte/compiler';

import { crate } from './crate';

mock.module('@tauri-apps/api/core', () => ({
	invoke(command: string, args?: unknown): Promise<unknown> {
		if (!crate.current) {
			return Promise.reject(new Error('No crate is open for this test.'));
		}
		return crate.current.invoke(command, args);
	},
}));

// Runes are compiled as the app's Vite plugin compiles them. The run needs `--conditions browser`:
// Svelte's server build runs no effect.
const types = new Bun.Transpiler({ loader: 'ts' });
plugin({
	name: 'svelte modules',
	setup(build) {
		build.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path }) => {
			const source = types.transformSync(await Bun.file(path).text());
			const { js } = compileModule(source, { filename: path, generate: 'client' });
			return { contents: js.code, loader: 'js' };
		});
	},
});

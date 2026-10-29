import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '../../src');

function files(dir: string): string[] {
	return readdirSync(dir).flatMap(name => {
		const path = join(dir, name);
		return statSync(path).isDirectory()
			? files(path)
			: path.endsWith('.ts')
				? [path]
				: [];
	});
}

function imports(path: string): string[] {
	return [...readFileSync(path, 'utf8').matchAll(/from '([^']+)'/g)].map(
		match => match[1]!,
	);
}

/** Where a file lives: what Svelte is told through, the core, the store layer, or the package entry above them all. */
function layer(path: string): 'reactivity' | 'core' | 'store' | 'entry' {
	const rel = relative(SRC, path).replaceAll('\\', '/');
	if (rel === 'index.ts') return 'entry';
	if (rel.startsWith('reactivity/')) return 'reactivity';
	return rel.startsWith('store/') ? 'store' : 'core';
}

function resolved(path: string, specifier: string): string {
	return join(path, '..', specifier).replaceAll('\\', '/');
}

describe('the layers', () => {
	test('what Svelte is told through imports nothing of the package outside itself', () => {
		const offenders = files(SRC)
			.filter(path => layer(path) === 'reactivity')
			.flatMap(path =>
				imports(path)
					.filter(spec => spec.startsWith('..'))
					.map(spec => `${relative(SRC, path)} → ${spec}`),
			);
		expect(offenders).toEqual([]);
	});

	test('the core imports nothing from the store layer', () => {
		const offenders = files(SRC)
			.filter(path => layer(path) === 'core')
			.flatMap(path =>
				imports(path)
					.filter(spec => spec.startsWith('.'))
					.filter(spec => /\/store\//.test(resolved(path, spec)))
					.map(spec => `${relative(SRC, path)} → ${spec}`),
			);
		expect(offenders).toEqual([]);
	});

	test('only the bridge imports Tauri', () => {
		const offenders = files(SRC)
			.filter(
				path =>
					!path.replaceAll('\\', '/').endsWith('database/bridge.ts'),
			)
			.flatMap(path =>
				imports(path)
					.filter(spec => spec.startsWith('@tauri-apps/'))
					.map(spec => `${relative(SRC, path)} → ${spec}`),
			);
		expect(offenders).toEqual([]);
	});

	test('a file that holds a rune is one Svelte compiles', () => {
		const offenders = files(SRC)
			.filter(path => !path.endsWith('.svelte.ts'))
			.filter(path =>
				/\$(state|derived|effect)\b/.test(
					readFileSync(path, 'utf8').replace(
						/\/\*[\s\S]*?\*\/|\/\/.*|`[^`]*`/g,
						'',
					),
				),
			)
			.map(path => relative(SRC, path));
		expect(offenders).toEqual([]);
	});
});

import { invoke } from '@tauri-apps/api/core';

import { DatabaseError, OrmError, type ErrorCode } from '../errors';
import type {
	Row,
	Statement,
	StatementResult,
	StoredValue,
	Value,
} from './statement';

const PLUGIN = 'plugin:7otion-sqlite';

/** Bytes per `String.fromCharCode` call, under every engine's argument limit. */
const BASE64_CHUNK = 0x8000;

/** `protocol` is this file's own, for an answer it cannot read. */
const CODES: ReadonlySet<string> = new Set<ErrorCode>([
	'unique',
	'foreign_key',
	'not_null',
	'check',
	'busy',
	'read_only',
	'value',
	'misuse',
	'unknown',
]);

type Command = 'load' | 'run' | 'begin' | 'commit' | 'rollback' | 'close';

export interface BridgeOptions {
	/** The migration set the file runs when it opens, by the name the plugin registered it under. */
	migrations?: string;
	/** SQLCipher key. One passed from JavaScript crosses IPC and stays in webview memory. */
	key?: string;
	/** Run in order after the crate's defaults; one naming a default replaces it. */
	pragmas?: Record<string, string | number | boolean>;
	/** How long a write waits for the writer connection. Defaults to 10000. */
	writerWaitMs?: number;
	/** Read-only connections kept for reads outside a transaction. Defaults to 4. */
	readers?: number;
}

type Wire = null | boolean | number | string | { blob: string };

interface WireAnswer {
	columns: string[];
	rows: Wire[][];
	rowsAffected: number;
	transactionEnded: boolean;
	waitedMs: number;
	ranMs: number;
	pluginMs: number;
}

export class Bridge {
	private constructor(
		private readonly handle: number,
		readonly path: string,
	) {}

	/** Without options it attaches to whatever the file was opened with; options must match that exactly. */
	static async load(path: string, options: BridgeOptions): Promise<Bridge> {
		if (options.key !== undefined) {
			console.warn(
				'[orm] An encryption key passed from JavaScript crosses IPC and stays in webview ' +
					'memory, so it is not safe. Supply it from Rust with app.sqlite().load() instead.',
			);
		}

		const loaded = await Bridge.call<{ handle: number; path: string }>(
			'load',
			{
				path,
				migrations: options.migrations ?? null,
				config: Bridge.config(options),
			},
		);
		return new Bridge(loaded.handle, loaded.path);
	}

	async send(
		statement: Statement,
		tx: number | null,
	): Promise<StatementResult> {
		const answer = await Bridge.call<WireAnswer>('run', {
			handle: this.handle,
			sql: statement.sql,
			params: statement.params.map(Bridge.encode),
			tx,
		});
		return {
			rows: Bridge.rows(answer),
			affected: answer.rowsAffected,
			transactionEnded: answer.transactionEnded,
			timing: {
				waitedMs: answer.waitedMs,
				ranMs: answer.ranMs,
				pluginMs: answer.pluginMs,
			},
		};
	}

	async begin(): Promise<number> {
		const { tx } = await Bridge.call<{ tx: number }>('begin', {
			handle: this.handle,
		});
		return tx;
	}

	async commit(tx: number): Promise<void> {
		await Bridge.call('commit', { handle: this.handle, tx });
	}

	async rollback(tx: number): Promise<void> {
		await Bridge.call('rollback', { handle: this.handle, tx });
	}

	async close(): Promise<void> {
		await Bridge.call('close', { handle: this.handle });
	}

	private static async call<T>(
		command: Command,
		args: Record<string, unknown>,
	): Promise<T> {
		try {
			return await invoke<T>(`${PLUGIN}|${command}`, args);
		} catch (error) {
			throw Bridge.failure(error);
		}
	}

	private static failure(error: unknown): DatabaseError {
		if (typeof error === 'object' && error !== null && 'message' in error) {
			const { code, message, transactionEnded } = error as {
				code?: unknown;
				message: unknown;
				transactionEnded?: unknown;
			};
			return new DatabaseError(
				String(message),
				typeof code === 'string' && CODES.has(code)
					? (code as ErrorCode)
					: 'unknown',
				error,
				null,
				transactionEnded === true,
			);
		}
		return new DatabaseError(String(error), 'unknown', error);
	}

	private static config(options: BridgeOptions): object | null {
		const { key, pragmas, writerWaitMs, readers } = options;
		if (
			key === undefined &&
			pragmas === undefined &&
			writerWaitMs === undefined &&
			readers === undefined
		) {
			return null;
		}

		return {
			key: key ?? null,
			pragmas: Object.entries(pragmas ?? {}).map(([name, value]) => [
				name,
				String(value),
			]),
			writerWaitMs: writerWaitMs ?? null,
			readers: readers ?? null,
		};
	}

	private static encode(value: Value): Wire {
		if (value instanceof Uint8Array) {
			let binary = '';
			for (let at = 0; at < value.length; at += BASE64_CHUNK) {
				binary += String.fromCharCode(
					...value.subarray(at, at + BASE64_CHUNK),
				);
			}
			return { blob: btoa(binary) };
		}

		// JSON writes these as null, which would store NULL without a word.
		if (typeof value === 'number' && !Number.isFinite(value)) {
			throw new OrmError(
				`[orm] ${value} cannot be stored: SQLite holds finite numbers only.`,
			);
		}

		const kind = typeof value;
		if (
			value === null ||
			kind === 'boolean' ||
			kind === 'number' ||
			kind === 'string'
		) {
			return value;
		}
		throw new OrmError(
			`[orm] A ${kind} cannot be sent to the database. A column holding one needs a codec.`,
		);
	}

	private static decode(value: Wire): StoredValue {
		if (typeof value === 'object' && value !== null) {
			const binary = atob(value.blob);
			const bytes = new Uint8Array(binary.length);
			for (let at = 0; at < binary.length; at++) {
				bytes[at] = binary.charCodeAt(at);
			}
			return bytes;
		}
		return typeof value === 'boolean' ? Number(value) : value;
	}

	/** On a column name shared by two result columns, the later one wins. */
	private static rows({ columns, rows }: WireAnswer): Row[] {
		return rows.map(values => {
			if (values.length !== columns.length) {
				throw new DatabaseError(
					`[orm] The crate answered ${values.length} values for ${columns.length} columns.`,
					'protocol',
					{ columns, values },
				);
			}

			const row: Row = {};
			columns.forEach((column, index) => {
				const value = Bridge.decode(values[index]!);
				if (column !== '__proto__') {
					row[column] = value;
					return;
				}
				// Defined, not assigned: assigning `__proto__` would change the row's prototype.
				Object.defineProperty(row, column, {
					value,
					enumerable: true,
					writable: true,
					configurable: true,
				});
			});
			return row;
		});
	}
}

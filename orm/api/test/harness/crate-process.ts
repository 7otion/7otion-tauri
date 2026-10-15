import { Database as Sqlite } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Call, CrateFailure } from './crate';

const PREFIX = 'plugin:7otion-sqlite|';

/** Built by `bun run harness`, from `backend/harness`. */
const BINARY = (() => {
	const named = process.env.ORM_HARNESS;
	if (named) return named;

	const built = resolve(import.meta.dir, '../../../backend/target/debug');
	for (const name of ['harness.exe', 'harness']) {
		const path = join(built, name);
		if (existsSync(path)) return path;
	}
	throw new Error(
		`[test] No harness binary in ${built}. Build it with: cd api && bun run harness`,
	);
})();

interface Answer {
	id: number | null;
	ok?: unknown;
	err?: CrateFailure;
}

/** The Rust crate itself, one process per test, answering the protocol over stdin and stdout. */
export class CrateProcess {
	readonly calls: Call[] = [];

	private readonly root = mkdtempSync(join(tmpdir(), '7otion-tauri-orm-'));
	/** A directory of this test's own, so two tests never name the same file. */
	private directory = this.root;
	private tests = 0;
	private readonly process = Bun.spawn([BINARY, this.root], {
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'inherit',
	});

	private readonly waiting = new Map<
		number,
		{ resolve(value: unknown): void; reject(error: unknown): void }
	>();
	private readonly failures: { command: string; failure: CrateFailure }[] =
		[];
	/** The handle each open transaction belongs to, as the answers report them. */
	private readonly transactions = new Map<number, number>();
	private readonly connections = new Map<string, Sqlite>();
	private next = 1;
	private readonly reading = this.read();

	/** Every statement received, control included, in order. */
	get sql(): string[] {
		return this.calls.flatMap(call =>
			call.sql === null ? [] : [call.sql],
		);
	}

	/** Statements other than transaction control. */
	get statements(): string[] {
		return this.sql.filter(
			sql => !/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql),
		);
	}

	get openTransactions(): number {
		return this.transactions.size;
	}

	/** The next `command` fails with `failure` before it is sent. */
	failNext(command: string, failure: CrateFailure): void {
		this.failures.push({ command, failure });
	}

	/**
	 * Hands the next test a clean slate on the same process: its own directory, so it shares
	 * no database file with any other, and none of what earlier tests recorded or arranged.
	 * Handles an earlier test left open are its own business; they name files nothing else uses.
	 */
	reset(): void {
		for (const connection of this.connections.values()) connection.close();
		this.connections.clear();
		this.calls.length = 0;
		this.failures.length = 0;
		this.transactions.clear();

		this.directory = join(this.root, String(this.tests++));
		mkdirSync(this.directory, { recursive: true });
	}

	/** A connection of this test's own on a file the crate has open, for schemas and for checking what is stored. */
	direct(path: string): Sqlite {
		const file = resolve(this.directory, path);
		let connection = this.connections.get(file);
		if (!connection) {
			connection = new Sqlite(file, { create: true, safeIntegers: true });
			this.connections.set(file, connection);
		}
		return connection;
	}

	async invoke(command: string, args: unknown): Promise<unknown> {
		const name = command.startsWith(PREFIX)
			? command.slice(PREFIX.length)
			: command;
		const input = JSON.parse(JSON.stringify(args ?? {})) as Record<
			string,
			any
		>;

		this.calls.push({
			command: name,
			sql:
				name === 'begin'
					? 'BEGIN IMMEDIATE'
					: name === 'commit'
						? 'COMMIT'
						: name === 'rollback'
							? 'ROLLBACK'
							: (input.sql ?? null),
			params: input.params ?? [],
			tx: input.tx ?? null,
			args: input,
		});

		const planned = this.failures.findIndex(
			failure => failure.command === name,
		);
		if (planned !== -1) {
			throw this.failures.splice(planned, 1)[0]!.failure;
		}

		if (name === 'load') {
			// The mock app's data directory is not this test's, so every file is named in full.
			input.path = resolve(this.directory, input.path);
		}
		try {
			const answer = await this.send(name, input);
			this.follow(name, input, answer);
			return answer;
		} catch (error) {
			// A commit or rollback lets go of the transaction whether or not it worked,
			// and a statement SQLite ended the transaction under says so as it fails.
			const ended =
				name === 'commit' ||
				name === 'rollback' ||
				(error as CrateFailure)?.transactionEnded === true;
			if (ended && input.tx !== null) this.transactions.delete(input.tx);
			throw error;
		}
	}

	/** Everything `dispose` does that an exit handler can do, which cannot await. */
	kill(): void {
		for (const connection of this.connections.values()) connection.close();
		this.connections.clear();
		this.process.stdin.end();
		this.process.kill();
	}

	async dispose(): Promise<void> {
		this.kill();
		await this.process.exited;
		await this.reading;

		try {
			rmSync(this.root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 20,
			});
		} catch {
			// Windows may still hold the WAL files; the system's temp directory is cleared by the system.
		}
	}

	private send(command: string, args: object): Promise<unknown> {
		const id = this.next++;
		const settled = new Promise((resolve, reject) => {
			this.waiting.set(id, { resolve, reject });
		});

		this.process.stdin.write(`${JSON.stringify({ id, command, args })}\n`);
		this.process.stdin.flush();
		return settled;
	}

	/** Keeps track of which transactions are open, which only the answers say. */
	private follow(command: string, args: any, answer: unknown): void {
		if (command === 'begin') {
			this.transactions.set((answer as { tx: number }).tx, args.handle);
		} else if (command === 'commit' || command === 'rollback') {
			this.transactions.delete(args.tx);
		} else if (command === 'close') {
			for (const [tx, handle] of [...this.transactions]) {
				if (handle === args.handle) this.transactions.delete(tx);
			}
		} else if (
			args.tx !== null &&
			(answer as { transactionEnded?: boolean })?.transactionEnded
		) {
			this.transactions.delete(args.tx);
		}
	}

	private async read(): Promise<void> {
		const decoder = new TextDecoder();
		let buffer = '';

		for await (const chunk of this.process.stdout) {
			buffer += decoder.decode(chunk as Uint8Array, { stream: true });

			let end: number;
			while ((end = buffer.indexOf('\n')) !== -1) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				if (line !== '') this.settle(JSON.parse(line) as Answer);
			}
		}

		for (const { reject } of this.waiting.values()) {
			reject(new Error('[test] The harness process ended.'));
		}
		this.waiting.clear();
	}

	private settle({ id, ok, err }: Answer): void {
		if (id === null) throw new Error(`[test] ${err?.message}`);

		const waiting = this.waiting.get(id);
		this.waiting.delete(id);
		if (err) waiting?.reject(err);
		else waiting?.resolve(ok ?? null);
	}
}

import { CrateProcess } from './crate-process';

export type Wire = null | boolean | number | string | { blob: string };

/** What a call rejects with, as the Rust crate reports it. */
export interface CrateFailure {
	code: string;
	message: string;
	transactionEnded: boolean;
}

export interface Call {
	command: string;
	sql: string | null;
	params: Wire[];
	tx: number | null;
	/** Everything the command was given, as it arrived. */
	args: Record<string, any>;
}

let running: CrateProcess | null = null;

export const crate = {
	/** The one `invoke` reaches. */
	current: null as CrateProcess | null,

	/**
	 * One crate for the whole run, reset between tests. Spawning the mock Tauri app costs
	 * about as much as a test does, so a process per test is the suite's whole runtime.
	 */
	open(): CrateProcess {
		if (!running) {
			running = new CrateProcess();
			const started = running;
			process.on('exit', () => started.kill());
		}
		running.reset();
		return running;
	},
};

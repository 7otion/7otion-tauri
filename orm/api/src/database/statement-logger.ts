import type { Row, Statement, StatementResult, Timing } from './statement';

const MAX_ROWS = 50;
const MAX_PARAMS = 50;
const MAX_STRING = 200;

/**
 * One line per statement: the SQL and the time SQLite took. What the line does not say,
 * params, rows, the transaction and the full timing, sits under it; a line with nothing
 * more to say is not a group.
 */
export class StatementLogger {
	enabled = false;

	/** `result` is what the crate answered: a statement's result, a new transaction's id, or nothing. */
	succeeded(
		statement: Statement,
		tx: number | null,
		result: unknown,
		started: number,
	): void {
		if (!this.enabled) return;
		const total = performance.now() - started;

		if (!StatementLogger.isResult(result)) {
			const id = typeof result === 'number' ? result : tx;
			console.log(
				`${StatementLogger.line(statement, id)} — took ${StatementLogger.ms(total)}`,
			);
			return;
		}

		console.groupCollapsed(
			`${StatementLogger.line(statement, null)} — took ${StatementLogger.ms(result.timing.ranMs)}`,
		);
		StatementLogger.params(statement);
		if (result.affected > 0) console.log(`affected ${result.affected}`);
		if (result.rows.length > 0) {
			console.log(StatementLogger.counted(result.rows.length, 'row'));
			console.log(
				result.rows.slice(0, MAX_ROWS).map(StatementLogger.row),
			);
			if (result.rows.length > MAX_ROWS) {
				console.log(`…and ${result.rows.length - MAX_ROWS} more rows`);
			}
		}
		if (tx !== null) console.log(`tx ${tx}`);
		console.log(StatementLogger.breakdown(result.timing, total));
		console.groupEnd();
	}

	/** Four parts that add up to the total: SQLite, the wait for a connection, the plugin around them, and the page: the bridge and any wait for the main thread. */
	private static breakdown(timing: Timing, total: number): string {
		const ms = StatementLogger.ms;
		const plugin = Math.max(
			0,
			timing.pluginMs - timing.ranMs - timing.waitedMs,
		);
		const render = Math.max(0, total - timing.pluginMs);
		return `db ${ms(timing.ranMs)} · wait ${ms(timing.waitedMs)} · plugin ${ms(plugin)} · render ${ms(render)} · total ${ms(total)}`;
	}

	/** Expanded, so an error is never hidden behind a click. */
	failed(
		statement: Statement,
		tx: number | null,
		error: unknown,
		started: number,
	): void {
		if (!this.enabled) return;
		const total = performance.now() - started;

		console.group(
			`${StatementLogger.line(statement, tx)} — FAILED after ${StatementLogger.ms(total)}`,
		);
		StatementLogger.params(statement);
		console.error(error);
		console.groupEnd();
	}

	private static line(statement: Statement, tx: number | null): string {
		const sql = statement.sql.replace(/\s+/g, ' ').trim();
		return tx === null ? `[orm] ${sql}` : `[orm] ${sql} (tx ${tx})`;
	}

	private static ms(value: number): string {
		return `${value.toFixed(1)}ms`;
	}

	private static isResult(result: unknown): result is StatementResult {
		return (
			typeof result === 'object' && result !== null && 'rows' in result
		);
	}

	private static counted(count: number, noun: string): string {
		return `${count} ${noun}${count === 1 ? '' : 's'}`;
	}

	private static params(statement: Statement): void {
		if (statement.params.length === 0) return;
		const more = statement.params.length - MAX_PARAMS;
		console.log(
			`params  ${statement.params
				.slice(0, MAX_PARAMS)
				.map(
					(value, index) =>
						`${index + 1}: ${StatementLogger.param(value)}`,
				)
				.join('   ')}${more > 0 ? `   …and ${more} more` : ''}`,
		);
	}

	private static param(value: unknown): string {
		const shown = StatementLogger.shorten(value);
		if (shown === null) return 'NULL';
		if (typeof value === 'string') {
			return `'${String(shown).replace(/'/g, "''")}'`;
		}
		return String(shown);
	}

	/** A copy with long values shortened, so the console holds no reference to the row. */
	private static row(row: Row): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		for (const [column, value] of Object.entries(row)) {
			out[column] = StatementLogger.shorten(value);
		}
		return out;
	}

	private static shorten(value: unknown): unknown {
		if (typeof value === 'string' && value.length > MAX_STRING) {
			return `${value.slice(0, MAX_STRING)}… (+${value.length - MAX_STRING} chars)`;
		}
		if (value instanceof Uint8Array) return `<${value.byteLength} bytes>`;
		return value;
	}
}

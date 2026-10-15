import { Statement } from '../database/statement';

/** Params left for whatever else a statement carries when its own count is unknown. */
const RESERVED = 64;

export class Chunks {
	/**
	 * `perItem` is how many params one item binds; `carried` is what the rest of
	 * the statement binds, such as an eager constraint's own values.
	 */
	static of<T>(items: readonly T[], perItem: number, carried = 0): T[][] {
		return Chunks.sized(items, Chunks.sizeFor(perItem, carried));
	}

	static sizeFor(perItem: number, carried = 0): number {
		return Math.max(
			1,
			Math.floor(
				(Statement.MAX_PARAMS - Math.max(carried, RESERVED)) /
					Math.max(1, perItem),
			),
		);
	}

	static sized<T>(items: readonly T[], size: number): T[][] {
		const step = Math.max(1, size);
		const chunks: T[][] = [];
		for (let i = 0; i < items.length; i += step) {
			chunks.push(items.slice(i, i + step));
		}
		return chunks;
	}
}

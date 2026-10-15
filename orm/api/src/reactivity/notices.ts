/** What a commit has to tell waits here, and goes out in one synchronous block: Svelte shows the commit at once. */
export class Notices {
	private static depth = 0;
	private static readonly waiting: (() => void)[] = [];

	static hold(): void {
		Notices.depth++;
	}

	static release(): void {
		if (--Notices.depth > 0) return;
		for (const notice of Notices.waiting.splice(0)) notice();
	}

	/** Runs `notice` now, or on release while held. */
	static send(notice: () => void): void {
		if (Notices.depth > 0) Notices.waiting.push(notice);
		else notice();
	}
}

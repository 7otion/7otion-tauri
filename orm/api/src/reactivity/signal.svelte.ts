import { Notices } from './notices';

/** Something a read can depend on that holds no value of its own: bumped where the value changes. */
export class Signal {
	/** Never read to make the next: a bump inside an effect would depend on what it bumps. */
	private static last = 0;

	#version = $state(0);

	read(): void {
		void this.#version;
	}

	bump(): void {
		Notices.send(() => {
			this.#version = ++Signal.last;
		});
	}
}

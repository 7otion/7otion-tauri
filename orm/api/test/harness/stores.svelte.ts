import { ConnectionStore } from '../../src/store/connection-store';
import { Store } from '../../src/store/store.svelte';
import { TabStore } from '../../src/store/tab-store';
import { User } from './models';

export class Library extends ConnectionStore {
	count = $state(0);
	readonly view = this.stored('view', 'grid');

	/** What an action still running after the database closed would do. */
	later(): void {
		this.stored('later', 0);
	}
}

export class Settings extends Store {
	readonly theme = this.stored('theme', 'dark');
}

/** Reads another store, derives from it, and counts in an effect of its own how often the count was shown. */
export class Counter extends ConnectionStore {
	readonly library = Library.get();
	readonly doubled = $derived(this.library.count * 2);
	readonly shown: number[] = [];

	constructor() {
		super();
		$effect(() => {
			this.shown.push(this.library.count);
		});
	}
}

export class Breaks extends ConnectionStore {
	constructor() {
		super();
		$effect(() => () => {
			throw new Error('cleanup bug');
		});
	}
}

export class Throws extends ConnectionStore {
	constructor() {
		super();
		throw new Error('constructor bug');
	}
}

export class Users extends ConnectionStore {
	onlyActive = $state(false);
	readonly all = this.query(() =>
		this.onlyActive ? User.query().where('active', true).orderBy('name') : User.query().orderBy('name'),
	);
	readonly names = $derived(this.all.rows.map(user => user.name).join());
	readonly total = this.counted(() =>
		this.onlyActive ? User.query().where('active', true) : User.query(),
	);
}

export class Search extends TabStore {
	term = $state('');
	readonly view = this.stored('view', 'grid');

	/** What an action still running after the tab closed would do. */
	later(): void {
		this.stored('later', 0);
	}
}

/** Reads its tab's search and its database's library, and counts in an effect of its own how often the term was shown. */
export class Results extends TabStore {
	readonly search = Search.get();
	readonly library = Library.get();
	readonly shown: string[] = [];

	constructor() {
		super();
		$effect(() => {
			this.shown.push(this.search.term);
		});
	}
}

export class TabBreaks extends TabStore {
	constructor() {
		super();
		$effect(() => () => {
			throw new Error('tab cleanup bug');
		});
	}
}

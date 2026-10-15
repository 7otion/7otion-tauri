import type { ModelQuery } from '../query/model-query';
import { Followed, type Releasable } from './followed.svelte';

interface Counted extends Releasable {
	readonly current: number;
}

export class Count extends Followed<Counted> {
	constructor(build: () => ModelQuery<any, any>) {
		super(build, { current: 0, release() {} });
	}

	protected fetch(query: ModelQuery<any, any>): Promise<Counted> {
		return query.liveCount();
	}

	get current(): number {
		return this.held.current;
	}

	async settled(): Promise<number> {
		return (await this.whenSettled()).current;
	}
}

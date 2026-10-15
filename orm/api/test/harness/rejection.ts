/** Stands in for the error when the promise resolved, so no error matcher accepts it. */
class ResolvedInstead {
	constructor(readonly value: unknown) {}
}

/** What a promise rejected with, as a value a test can inspect. */
export function rejection(promise: PromiseLike<unknown>): Promise<any> {
	return Promise.resolve(promise).then(
		value => new ResolvedInstead(value),
		error => error,
	);
}

import type { Model } from '../model/model';

/** Recursion budget, since model graphs are cyclic; D permits D + 1 segments. */
type Decrement = [never, 0, 1, 2, 3, 4, 5];
type Depth = 0 | 1 | 2 | 3 | 4 | 5;

type RelatedClassOf<TRelation> = TRelation extends {
	readonly $related?: infer C;
}
	? C
	: unknown;

type RelationsOf<TClass> = TClass extends { relations: infer R }
	? R
	: Record<never, never>;

/** An index signature degrades to `string`. */
export type RelationPath<
	TRelations,
	D extends Depth = 5,
> = string extends keyof TRelations
	? string
	: [D] extends [never]
		? never
		: {
				[K in keyof TRelations & string]:
					| K
					| `${K}.${RelationPath<
							RelationsOf<RelatedClassOf<TRelations[K]>>,
							Decrement[D] & Depth
					  >}`;
			}[keyof TRelations & string];

export type AnyRelations = Record<string, any>;

/** Any model where the relation does not say, as a morphTo. */
type RelatedModelOf<TRelation> =
	RelatedClassOf<TRelation> extends new () => infer M
		? M extends Model
			? M
			: any
		: any;

export type ModelAtPath<
	TRelations,
	P extends string,
> = P extends `${infer Head}.${infer Rest}`
	? Head extends keyof TRelations
		? ModelAtPath<RelationsOf<RelatedClassOf<TRelations[Head]>>, Rest>
		: any
	: P extends keyof TRelations
		? RelatedModelOf<TRelations[P]>
		: any;

export type RelationsAtPath<
	TRelations,
	P extends string,
> = P extends `${infer Head}.${infer Rest}`
	? Head extends keyof TRelations
		? RelationsAtPath<RelationsOf<RelatedClassOf<TRelations[Head]>>, Rest>
		: AnyRelations
	: P extends keyof TRelations
		? RelationsOf<RelatedClassOf<TRelations[P]>>
		: AnyRelations;

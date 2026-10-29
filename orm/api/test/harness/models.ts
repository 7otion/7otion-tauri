/** Model fixtures, declared the way a consumer declares models. */

import type { ModelEvent } from '../../src/events/events';
import { Model } from '../../src/model/model';
import type { Collection } from '../../src/query/collection.svelte';
import type { Codec } from '../../src/schema/codec';
import { Column } from '../../src/schema/column';

export interface Settings {
	theme: string;
	tags: string[];
}

export class User extends Model<typeof User.schema> {
	static readonly schema = this.define({
		table: 'users',
		columns: {
			id: Column.integer().primary().generated(),
			name: Column.text(),
			email: Column.text().nullable(),
			active: Column.boolean(),
			age: Column.integer().nullable(),
			settings: Column.json<Settings>().nullable(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
	});

	declare profile: Profile | null;
	declare posts: Collection<Post>;
	declare roles: Collection<Role>;
	declare duties: Collection<Role>;
	declare notes: Collection<Note>;

	static readonly relations = {
		profile: this.hasOne(() => Profile, { foreignKey: 'user_id' }),
		posts: this.hasMany(() => Post, { foreignKey: 'user_id' }),
		roles: this.belongsToMany(() => Role, {
			pivot: 'user_roles',
			foreignPivotKey: 'user_id',
			relatedPivotKey: 'role_id',
		}),
		duties: this.belongsToMany(() => Role, {
			pivot: () => UserRole,
			foreignPivotKey: 'user_id',
			relatedPivotKey: 'role_id',
		}),
		notes: this.morphMany(() => Note, {
			foreignKey: 'target_id',
			typeColumn: 'target_kind',
			typeValue: 'user',
		}),
	};

	get label(): string {
		return `${this.name} <${this.email ?? 'no email'}>`;
	}
}

export class Profile extends Model<typeof Profile.schema> {
	static readonly schema = this.define({
		table: 'profiles',
		columns: {
			id: Column.integer().primary().generated(),
			user_id: Column.integer(),
			bio: Column.text().nullable(),
		},
	});

	declare user: User | null;

	static readonly relations = {
		user: this.belongsTo(() => User, { foreignKey: 'user_id' }),
	};
}

export class Post extends Model<typeof Post.schema> {
	static readonly schema = this.define({
		table: 'posts',
		columns: {
			id: Column.integer().primary().generated(),
			user_id: Column.integer().nullable(),
			title: Column.text(),
			published: Column.boolean(),
			published_at: Column.date().nullable(),
		},
		guarded: ['published'],
	});

	declare author: User | null;
	declare comments: Collection<Comment>;
	declare tags: Collection<PostTag>;

	static readonly relations = {
		author: this.belongsTo(() => User, { foreignKey: 'user_id' }),
		comments: this.hasMany(() => Comment, { foreignKey: 'post_id' }),
		tags: this.hasMany(() => PostTag, { foreignKey: 'post_id' }),
	};
}

export class Comment extends Model<typeof Comment.schema> {
	static readonly schema = this.define({
		table: 'comments',
		columns: {
			id: Column.integer().primary().generated(),
			post_id: Column.integer(),
			body: Column.text(),
			sort: Column.integer(),
		},
		fillable: ['post_id', 'body', 'sort'],
	});

	declare post: Post | null;

	static readonly relations = {
		post: this.belongsTo(() => Post, { foreignKey: 'post_id' }),
	};
}

export class PostTag extends Model<typeof PostTag.schema> {
	static readonly schema = this.define({
		table: 'post_tags',
		columns: {
			post_id: Column.integer().primary(),
			tag: Column.text().primary(),
			sort: Column.integer(),
		},
	});
}

export class UserRole extends Model<typeof UserRole.schema> {
	static readonly schema = this.define({
		table: 'user_roles',
		columns: {
			user_id: Column.integer().primary(),
			role_id: Column.integer().primary(),
		},
	});
}

export class Role extends Model<typeof Role.schema> {
	static readonly schema = this.define({
		table: 'roles',
		columns: {
			id: Column.integer().primary().generated(),
			name: Column.text(),
		},
	});
}

export class Note extends Model<typeof Note.schema> {
	static readonly schema = this.define({
		table: 'notes',
		columns: {
			id: Column.integer().primary().generated(),
			target_kind: Column.text().nullable(),
			target_id: Column.integer().nullable(),
			body: Column.text(),
		},
	});

	declare target: User | Post | null;

	static readonly relations = {
		target: this.morphTo<User | Post>({
			typeColumn: 'target_kind',
			keyColumn: 'target_id',
			types: { user: () => User, post: () => Post },
		}),
	};
}

export class Order extends Model<typeof Order.schema> {
	static readonly schema = this.define({
		table: 'orders',
		columns: {
			tenant: Column.text().primary(),
			number: Column.integer().primary(),
			total: Column.integer(),
		},
	});

	declare lines: Collection<OrderLine>;

	static readonly relations = {
		lines: this.hasMany(() => OrderLine, {
			foreignKey: ['tenant', 'order_number'],
		}),
	};
}

export class OrderLine extends Model<typeof OrderLine.schema> {
	static readonly schema = this.define({
		table: 'order_lines',
		columns: {
			id: Column.integer().primary().generated(),
			tenant: Column.text(),
			order_number: Column.integer(),
			sku: Column.text(),
		},
	});

	declare order: Order | null;

	static readonly relations = {
		order: this.belongsTo(() => Order, {
			foreignKey: ['tenant', 'order_number'],
		}),
	};
}

export class Money {
	constructor(readonly cents: number) {}
}

export const MoneyCodec: Codec<Money, number> = {
	decode: cents => new Money(Number(cents)),
	encode: money => money.cents,
	clone: money => new Money(money.cents),
	equals: (a, b) => a.cents === b.cents,
};

export class Article extends Model<typeof Article.schema> {
	static readonly schema = this.define({
		table: 'articles',
		columns: {
			ref: Column.text().primary(),
			title: Column.text().nullable(),
			summary: Column.text().nullable().emptyToNull(),
		},
	});
}

const EVENTS = (['create', 'update', 'delete', 'save'] as const).flatMap(verb =>
	(['before', 'after', 'committed'] as const).map(
		moment => `${verb}:${moment}` as ModelEvent,
	),
);

/** Removes every event a test registered, so none leaks into the next. */
export function resetEvents(): void {
	for (const model of [
		Model,
		User,
		Profile,
		Post,
		Comment,
		PostTag,
		Role,
		UserRole,
		Note,
		Order,
		OrderLine,
		Article,
	]) {
		for (const event of EVENTS) model.registerEvent(event, null);
	}
}

export const SCHEMA = [
	`CREATE TABLE users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		email TEXT UNIQUE,
		active INTEGER NOT NULL DEFAULT 1,
		age INTEGER,
		settings TEXT,
		created_at INTEGER,
		updated_at INTEGER
	)`,
	`CREATE TABLE profiles (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		bio TEXT
	)`,
	`CREATE TABLE posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER,
		title TEXT NOT NULL,
		published INTEGER NOT NULL DEFAULT 0,
		published_at TEXT
	)`,
	`CREATE TABLE comments (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		post_id INTEGER NOT NULL,
		body TEXT NOT NULL,
		sort INTEGER NOT NULL DEFAULT 0
	)`,
	`CREATE TABLE post_tags (
		post_id INTEGER NOT NULL,
		tag TEXT NOT NULL,
		sort INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (post_id, tag)
	)`,
	'CREATE TABLE roles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
	'CREATE TABLE user_roles (user_id INTEGER NOT NULL, role_id INTEGER NOT NULL)',
	`CREATE TABLE notes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		target_kind TEXT,
		target_id INTEGER,
		body TEXT NOT NULL
	)`,
	`CREATE TABLE orders (
		tenant TEXT NOT NULL,
		number INTEGER NOT NULL,
		total INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (tenant, number)
	)`,
	`CREATE TABLE order_lines (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		tenant TEXT NOT NULL,
		order_number INTEGER NOT NULL,
		sku TEXT NOT NULL
	)`,
	'CREATE TABLE articles (ref TEXT PRIMARY KEY, title TEXT, summary TEXT)',
];

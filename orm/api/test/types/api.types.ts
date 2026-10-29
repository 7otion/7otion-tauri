/**
 * Written as a consumer writes, against the package name. Never run: the
 * compiler is the test, once against `src` and once against the built typings.
 */

import {
	Column,
	Database,
	Model,
	Statement,
	type Codec,
	type Collection,
	type Draft,
	type ModelEvents,
	type ModelQuery,
	type Transaction,
} from '@7otion-tauri/orm';

class Money {
	constructor(readonly cents: number) {}
}

const MoneyCodec: Codec<Money, number> = {
	decode: cents => new Money(Number(cents)),
	encode: money => money.cents,
};

class Author extends Model<typeof Author.schema> {
	static readonly schema = this.define({
		table: 'authors',
		columns: {
			id: Column.integer().primary().generated(),
			name: Column.text(),
			born: Column.date('datetime').nullable(),
		},
	});

	declare books: Collection<Book>;

	static readonly relations = {
		books: this.hasMany(() => Book, { foreignKey: 'author_id' }),
	};
}

class Book extends Model<typeof Book.schema> {
	static readonly schema = this.define({
		table: 'books',
		columns: {
			id: Column.integer().primary().generated(),
			author_id: Column.integer(),
			title: Column.text(),
			price: Column.custom(MoneyCodec),
			in_print: Column.boolean(),
			meta: Column.json<{ pages: number }>().nullable(),
			state: Column.text<'draft' | 'final'>(),
			created_at: Column.date('unix'),
			updated_at: Column.date('unix'),
		},
		timestamps: true,
		fillable: ['author_id', 'title', 'price', 'in_print', 'meta'],
	});

	declare author: Author | null;
	declare chapters: Collection<Chapter>;

	static readonly relations = {
		author: this.belongsTo(() => Author, { foreignKey: 'author_id' }),
		chapters: this.hasMany(() => Chapter, { foreignKey: 'book_id' }),
	};

	static readonly mutators = this.mutate({
		title: value => value.trim(),
	});

	static readonly events: ModelEvents<Book> = {
		'delete:before': async (written, tx) => {
			await Chapter.query()
				.whereIn(
					'book_id',
					written.map(([book]) => book.id),
				)
				.delete(tx);
		},
	};

	get label(): string {
		return `${this.title} (${this.price.cents})`;
	}
}

class Chapter extends Model<typeof Chapter.schema> {
	static readonly schema = this.define({
		table: 'chapters',
		columns: {
			book_id: Column.integer().primary(),
			number: Column.integer().primary(),
			heading: Column.text(),
		},
	});
}

export class Misdeclared extends Model<typeof Misdeclared.schema> {
	static readonly schema = this.define({
		table: 'misdeclared',
		columns: { id: Column.integer().primary(), name: Column.text() },
		// @ts-expect-error fillable names a column that does not exist
		fillable: ['nmae'],
	});

	static readonly mutators = this.mutate({
		// @ts-expect-error a text column's mutator returns text
		name: value => value.length,
	});
}

export class Untabled extends Model<typeof Untabled.schema> {
	// @ts-expect-error a schema names its table
	static readonly schema = this.define({
		columns: { id: Column.integer().primary() },
	});
}

export async function usage(): Promise<void> {
	const db = new Database({
		path: 'library.sqlite',
		pragmas: { synchronous: 'NORMAL' },
		loggerEnabled: true,
	});
	Model.connect(db);

	const book = await Book.create({
		author_id: 1,
		title: 'Dune',
		price: new Money(999),
		in_print: true,
	});
	const created: Date = book.created_at;
	const pages: number | undefined = book.meta?.pages;
	await Author.query().update({ born: 1_700_000_000 });
	const author1 = await Author.findOrFail(1);
	await author1.update({ born: new Date() });
	const born: Date | null = author1.born;
	const bornOnDraft: Date | null = author1.draft().born;
	void [born, bornOnDraft];

	// @ts-expect-error a model shows the database; the draft takes the edit
	book.title = 'Dune Messiah';
	const draft: Draft<Book> = book.draft();
	draft.title = 'Dune Messiah';
	const owner: Book = draft.model();
	await book.save('title');
	await book.update({ title: 'Dune' });
	book.discard('title');
	void owner;

	const found: Book | null = await Book.find(1);
	const chapter: Chapter = await Chapter.findOrFail([1, 2]);
	await Book.query().whereKey(1).first();
	void [found, chapter];

	const books: Collection<Book> = await Book.query()
		.where('in_print', true)
		.where('price', new Money(999))
		.where('created_at', '>', new Date(0))
		.with('author', 'chapters', {
			chapters: query => query.orderBy('number'),
		})
		.orderBy('title')
		.limit(10)
		.get();

	const author: Author | null = await book.load('author');
	const chapters: Collection<Chapter> = await book.load('chapters');
	await book.sync('chapters', [{ number: 1, heading: 'One' }]);
	await book.refresh(['author.books']);

	await db.transaction(async (tx: Transaction) => {
		await Book.createMany([{ author_id: 1, title: 'A' }], tx);
		await Book.query()
			.where('author_id', 1)
			.update({ in_print: false }, tx);
		await Book.firstOrCreate({ title: 'B' }, { author_id: 1 }, tx);
		await db.run(new Statement('DELETE FROM chapters'), tx);
		const total: number = await Book.query().count(tx);
		void total;
	});

	Book.registerEvent('save:committed', written => {
		for (const [saved, changes] of written) {
			const before: string | undefined = changes.title?.from;
			const after: string | undefined = changes.title?.to;
			// @ts-expect-error not a column
			void changes.nope;
			void [saved.id, before, after];
		}
	});
	Book.registerEvent('save:before', async (written, tx) => {
		await Chapter.query()
			.whereIn(
				'book_id',
				written.map(([b]) => b.id),
			)
			.count(tx);
	});
	Book.registerEvent('save:committed', null);
	Model.registerEvent('delete:committed', written => void written.length);
	// @ts-expect-error a :committed handler runs after the transaction and gets no tx
	Book.registerEvent(
		'save:committed',
		(_written, tx: Transaction) => void tx,
	);
	// @ts-expect-error not an event
	Book.registerEvent('saving', () => {});

	// @ts-expect-error not a column
	book.nope = 1;
	// @ts-expect-error title is text
	book.title = 1;
	// @ts-expect-error a timestamp is the ORM's to set
	book.created_at = new Date();
	// @ts-expect-error not a column
	await Book.create({ nope: 1 });
	// @ts-expect-error not a column
	Book.query().where('nope', 1);
	// @ts-expect-error price is Money
	Book.query().where('price', 999);
	// @ts-expect-error not a relation
	Book.query().with('nope');
	// @ts-expect-error not a relation
	await book.load('title');
	// @ts-expect-error a to-one relation has no set
	await book.sync('author', []);
	// @ts-expect-error the key is a number
	await Book.find('x');
	// @ts-expect-error a composite key is an array
	await Chapter.find(1);
	// @ts-expect-error the key is a number
	Book.query().whereKey('x');
	// @ts-expect-error a query update cannot reassign the key
	await Book.query().update({ id: 5 });

	const inPrint = (query: ModelQuery<Book>) => query.where('in_print', true);
	const annotated: Collection<Book> = await inPrint(Book.query()).get();
	// @ts-expect-error models read through an annotated query keep their column types
	annotated.at(0)!.title = 1;
	// @ts-expect-error price is Money, through the annotation as well
	(query: ModelQuery<Book>) => query.where('price', 999);
	// @ts-expect-error the model's columns are still checked through the annotation
	(query: ModelQuery<Book>) => query.where('nope', 1);
	const cheap = <R>(query: ModelQuery<Book, R>) =>
		query.where('in_print', true);
	// @ts-expect-error a helper generic over R keeps the relation paths checked
	cheap(Book.query()).with('nope');
	// @ts-expect-error a query starts from Model.query(), never from a constructor
	void new ModelQuery();

	void [created, pages, books, author, chapters];
}

import {
	ConnectionStore,
	Store,
	type Query,
	type Stored,
} from '@7otion-tauri/orm';

class Shelf extends ConnectionStore {
	readonly books = this.query(() => Book.query().orderBy('title'));
	readonly view = this.stored<'grid' | 'list'>('view', 'grid');
	rename(title: string): Promise<void> {
		return Promise.resolve(void title);
	}
}

class Preferences extends Store {
	readonly theme = this.stored('theme', 'dark');
}

async function stores() {
	const shelf: Shelf = Shelf.get();
	const preferences: Preferences = Preferences.get();
	const database: Database = shelf.database;
	const books: Query<Book> = shelf.books;
	const rows: readonly Book[] = shelf.books.rows;
	const list: Collection<Book> = shelf.books.collection;
	const first: Book | null = shelf.books.first;
	const titles: string[] = [...shelf.books].map(book => book.title);
	const view: Stored<'grid' | 'list'> = shelf.view;
	shelf.view.current = 'list';
	// @ts-expect-error a stored value keeps its type
	shelf.view.current = 'table';
	// @ts-expect-error a store of the app lives with no database
	void preferences.database;
	// @ts-expect-error a base class is no store to ask for
	Store.get();

	const draft = (await Book.query().firstOrFail()).draft();
	draft.title = 'Renamed';
	// @ts-expect-error a model shows the database; edits go on its draft
	draft.model().title = 'Renamed';

	void [database, books, rows, list, first, titles, view];
}

void stores;

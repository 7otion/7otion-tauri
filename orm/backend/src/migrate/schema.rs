use super::blueprint::{Blueprint, Step};
use super::column::{Column, DefaultValue};
use super::quote;
use super::table::{Declared, Index, Table, Tables};

/// What a migration's `up` is given: the schema as the migrations before it left it.
/// A declaration that cannot hold panics, naming the migration, when the set is built.
pub struct Schema {
    migration: &'static str,
    tables: Tables,
    statements: Vec<String>,
}

impl Schema {
    pub(crate) fn new(migration: &'static str, tables: Tables) -> Self {
        Self {
            migration,
            tables,
            statements: Vec::new(),
        }
    }

    pub(crate) fn finish(self) -> (Tables, Vec<String>) {
        (self.tables, self.statements)
    }

    pub fn create(&mut self, table: &str, define: impl FnOnce(&mut Blueprint)) {
        self.assert_name(table);
        if self.tables.contains_key(table) {
            self.fail(format!("table {table} already exists"));
        }

        let mut blueprint = Blueprint::new();
        define(&mut blueprint);

        let mut created = Table {
            name: table.to_owned(),
            columns: Vec::new(),
            primary: blueprint.primary.clone().unwrap_or_default(),
            indexes: Vec::new(),
        };
        for step in &blueprint.steps {
            match step {
                Step::Add(at) => {
                    let column = blueprint.columns[*at].clone();
                    if created.column(&column.name).is_some() {
                        self.fail(format!("table {table} declares column {} twice", column.name));
                    }
                    created.columns.push(column);
                }
                Step::Index(columns, unique) => self.declare(&mut created, columns, *unique),
                _ => self.fail(format!(
                    "table {table} is being created: rename, drop, change and drop_index are for alter"
                )),
            }
        }

        if created.primary.is_empty() {
            self.fail(format!(
                "table {table} has no primary key: call id() or primary()"
            ));
        }
        for key in &created.primary {
            match created.column(key) {
                None => self.fail(format!("the primary key of {table} names no column {key}")),
                Some(column) if column.nullable => self.fail(format!(
                    "column {key} is in the primary key of {table} and nullable"
                )),
                Some(_) => {}
            }
        }
        for column in &created.columns {
            self.check_column(&created, column);
        }

        self.statements
            .push(created.create_sql(table, &self.tables));
        for index in created.indexes() {
            self.statements.push(index.create_sql(table));
        }
        self.tables.insert(table.to_owned(), created);
    }

    /// Alters the table in place where SQLite can, and rebuilds it where it cannot.
    pub fn alter(&mut self, table: &str, change: impl FnOnce(&mut Blueprint)) {
        let Some(before) = self.tables.get(table).cloned() else {
            self.fail(format!("table {table} does not exist"));
        };

        let mut blueprint = Blueprint::new();
        change(&mut blueprint);
        if blueprint.primary.is_some() {
            self.fail(format!(
                "the primary key of {table} is set when it is created"
            ));
        }

        // What the file holds as the steps run, and what the table becomes.
        let mut physical = before.clone();
        let mut target = before.clone();
        let mut held: Vec<Index> = before.indexes();

        for step in &blueprint.steps {
            match step {
                Step::Add(at) => {
                    let column = blueprint.columns[*at].clone();
                    if target.column(&column.name).is_some() {
                        self.fail(format!("table {table} already has column {}", column.name));
                    }
                    if !column.nullable && column.default.is_none() {
                        self.fail(format!(
                            "column {} is required and has no default, so rows already in {table} \
                             would have no value: add it nullable, fill it with execute, then \
                             change it to required",
                            column.name
                        ));
                    }
                    self.check_column(&target, &column);

                    // SQLite adds a column in place unless its default is an expression, or it
                    // is a foreign key whose default is not null.
                    let in_place = column.default != Some(DefaultValue::Now)
                        && !(column.references.is_some() && column.default.is_some());
                    if in_place {
                        let sql = column.sql(target.referenced_key(&column, &self.tables));
                        self.push(format!("ALTER TABLE {} ADD COLUMN {sql}", quote(table)));
                        physical.columns.push(column.clone());
                    }
                    target.columns.push(column);
                }
                Step::Rename(from, to) => {
                    if target.column(from).is_none() {
                        self.fail(format!("table {table} has no column {from}"));
                    }
                    if target.column(to).is_some() {
                        self.fail(format!("table {table} already has column {to}"));
                    }
                    rename_column(&mut target, from, to);
                    if physical.column(from).is_some() {
                        self.push(format!(
                            "ALTER TABLE {} RENAME COLUMN {} TO {}",
                            quote(table),
                            quote(from),
                            quote(to)
                        ));
                        rename_column(&mut physical, from, to);
                        for index in &mut held {
                            for column in &mut index.columns {
                                if column == from {
                                    *column = to.clone();
                                }
                            }
                        }
                    }
                }
                Step::Drop(name) => {
                    if target.column(name).is_none() {
                        self.fail(format!("table {table} has no column {name}"));
                    }
                    if target.primary.contains(name) {
                        self.fail(format!("column {name} is in the primary key of {table}"));
                    }
                    if let Some(declared) = target
                        .indexes
                        .iter()
                        .find(|declared| declared.columns.contains(name))
                    {
                        self.fail(format!(
                            "column {name} is in the index on {table} ({}): drop that index first",
                            declared.columns.join(", ")
                        ));
                    }
                    target.columns.retain(|column| &column.name != name);

                    // SQLite drops a column in place once no index holds it, unless it is a
                    // foreign key.
                    let in_place = physical
                        .column(name)
                        .is_some_and(|column| column.references.is_none());
                    if in_place {
                        for index in held.iter().filter(|index| index.columns.contains(name)) {
                            self.statements.push(index.drop_sql());
                        }
                        held.retain(|index| !index.columns.contains(name));
                        self.push(format!(
                            "ALTER TABLE {} DROP COLUMN {}",
                            quote(table),
                            quote(name)
                        ));
                        physical.columns.retain(|column| &column.name != name);
                    }
                }
                Step::Change(name, at) => {
                    let Some(column) = target.column_mut(name) else {
                        self.fail(format!("table {table} has no column {name}"));
                    };
                    blueprint.changes[*at].apply(column);
                    let column = column.clone();
                    if target.primary.contains(name) && column.nullable {
                        self.fail(format!("column {name} is in the primary key of {table}"));
                    }
                    self.check_column(&target, &column);
                    if target.primary == [name.clone()] {
                        self.check_referrers(&target, &column);
                    }
                }
                Step::Index(columns, unique) => self.declare(&mut target, columns, *unique),
                Step::DropIndex(columns, unique) => {
                    let before = target.indexes.len();
                    target.indexes.retain(|declared| {
                        !(&declared.columns == columns && declared.unique == *unique)
                    });
                    if target.indexes.len() == before {
                        self.fail(format!(
                            "table {table} declares no {} on ({})",
                            if *unique { "unique index" } else { "index" },
                            columns.join(", ")
                        ));
                    }
                }
            }
        }

        let rebuild = physical.columns.len() != target.columns.len()
            || physical
                .columns
                .iter()
                .zip(&target.columns)
                .any(|(held, wanted)| !held.same_definition(wanted));

        if rebuild {
            self.rebuild(&physical, &target);
        } else {
            let wanted = target.indexes();
            for index in held.iter().filter(|index| !wanted.contains(index)) {
                self.statements.push(index.drop_sql());
            }
            for index in wanted.iter().filter(|index| !held.contains(index)) {
                self.statements.push(index.create_sql(table));
            }
        }
        self.tables.insert(table.to_owned(), target);
    }

    pub fn rename(&mut self, from: &str, to: &str) {
        self.assert_name(to);
        let Some(mut table) = self.tables.get(from).cloned() else {
            self.fail(format!("table {from} does not exist"));
        };
        if self.tables.contains_key(to) {
            self.fail(format!("table {to} already exists"));
        }

        self.push(format!(
            "ALTER TABLE {} RENAME TO {}",
            quote(from),
            quote(to)
        ));
        let held = table.indexes();
        table.name = to.to_owned();
        for column in &mut table.columns {
            if column.references.as_deref() == Some(from) {
                column.references = Some(to.to_owned());
            }
        }
        // SQLite renames the table under its indexes, but not the indexes, which carry its name.
        let wanted = table.indexes();
        for index in held.iter().filter(|index| !wanted.contains(index)) {
            self.statements.push(index.drop_sql());
        }
        for index in wanted.iter().filter(|index| !held.contains(index)) {
            self.statements.push(index.create_sql(to));
        }

        self.tables.remove(from);
        for other in self.tables.values_mut() {
            for column in &mut other.columns {
                if column.references.as_deref() == Some(from) {
                    column.references = Some(to.to_owned());
                }
            }
        }
        self.tables.insert(to.to_owned(), table);
    }

    pub fn drop(&mut self, table: &str) {
        if !self.tables.contains_key(table) {
            self.fail(format!("table {table} does not exist"));
        }
        if let Some((other, column)) = self
            .referrers(table)
            .into_iter()
            .find(|(other, _)| other != table)
        {
            self.fail(format!("table {table} is referenced by {other}.{column}"));
        }
        self.push(format!("DROP TABLE {}", quote(table)));
        self.tables.remove(table);
    }

    /// SQL run as written, for changes to data: filling a column, moving values.
    pub fn execute(&mut self, sql: &str) {
        if sql.trim().is_empty() {
            self.fail("execute was given no SQL".to_owned());
        }
        self.push(sql.to_owned());
    }

    /// The SQLite table rebuild: a new table beside the old, the rows copied, the old dropped.
    fn rebuild(&mut self, physical: &Table, target: &Table) {
        let name = &target.name;
        let temporary = format!("_rebuild_{name}");
        let kept: Vec<String> = target
            .columns
            .iter()
            .filter(|column| physical.column(&column.name).is_some())
            .map(|column| quote(&column.name))
            .collect();
        let kept = kept.join(", ");

        self.push(target.create_sql(&temporary, &self.tables));
        self.push(format!(
            "INSERT INTO {} ({kept}) SELECT {kept} FROM {}",
            quote(&temporary),
            quote(name)
        ));
        self.push(format!("DROP TABLE {}", quote(name)));
        self.push(format!(
            "ALTER TABLE {} RENAME TO {}",
            quote(&temporary),
            quote(name)
        ));
        for index in target.indexes() {
            self.push(index.create_sql(name));
        }
    }

    fn declare(&self, table: &mut Table, columns: &[String], unique: bool) {
        if columns.is_empty() {
            self.fail(format!("an index on {} names no column", table.name));
        }
        if let Some(missing) = columns.iter().find(|column| table.column(column).is_none()) {
            self.fail(format!(
                "table {} has no column {missing} to index",
                table.name
            ));
        }
        if table
            .indexes
            .iter()
            .any(|declared| declared.columns == columns && declared.unique == unique)
        {
            self.fail(format!(
                "table {} already declares that index on ({})",
                table.name,
                columns.join(", ")
            ));
        }
        table.indexes.push(Declared {
            columns: columns.to_vec(),
            unique,
        });
    }

    fn check_column(&self, table: &Table, column: &Column) {
        if let Some(fault) = column.fault() {
            self.fail(format!("table {}: {fault}", table.name));
        }
        let Some(target) = column.references.as_deref() else {
            return;
        };
        let referenced = if target == table.name {
            Some(table)
        } else {
            self.tables.get(target)
        };
        let Some(referenced) = referenced else {
            self.fail(format!(
                "column {}.{} references table {target}, which does not exist",
                table.name, column.name
            ));
        };
        let Some(key) = referenced.key() else {
            self.fail(format!(
                "column {}.{} references {target}, whose primary key is not one column",
                table.name, column.name
            ));
        };
        if key.kind.sql() != column.kind.sql() {
            self.fail(format!(
                "column {}.{} is {} and references {target}.{}, which is {}",
                table.name,
                column.name,
                column.kind.sql(),
                key.name,
                key.kind.sql()
            ));
        }
    }

    /// A key column retyped must still suit the foreign keys that point at it.
    fn check_referrers(&self, table: &Table, key: &Column) {
        for (other, column) in self.referrers(&table.name) {
            let kind = self.tables[&other]
                .column(&column)
                .map(|column| column.kind.sql());
            if other != table.name && kind != Some(key.kind.sql()) {
                self.fail(format!(
                    "{other}.{column} references {}.{}, which would become {}",
                    table.name,
                    key.name,
                    key.kind.sql()
                ));
            }
        }
    }

    /// Every column of every table that references `table`, as `(table, column)`.
    fn referrers(&self, table: &str) -> Vec<(String, String)> {
        self.tables
            .values()
            .flat_map(|other| {
                other
                    .columns
                    .iter()
                    .filter(|column| column.references.as_deref() == Some(table))
                    .map(|column| (other.name.clone(), column.name.clone()))
            })
            .collect()
    }

    fn assert_name(&self, table: &str) {
        let reserved = table.is_empty()
            || table == "migrations"
            || table.starts_with("sqlite_")
            || table.starts_with("_rebuild_");
        if reserved {
            self.fail(format!("{table:?} cannot name a table"));
        }
    }

    fn push(&mut self, sql: String) {
        self.statements.push(sql);
    }

    fn fail(&self, message: String) -> ! {
        panic!("migration {}: {message}", self.migration);
    }
}

fn rename_column(table: &mut Table, from: &str, to: &str) {
    if let Some(column) = table.column_mut(from) {
        column.name = to.to_owned();
    }
    for key in &mut table.primary {
        if key == from {
            *key = to.to_owned();
        }
    }
    for declared in &mut table.indexes {
        for column in &mut declared.columns {
            if column == from {
                *column = to.to_owned();
            }
        }
    }
}

use std::collections::BTreeMap;

use super::column::Column;
use super::quote;

/// Every table the migrations so far have made, by name.
pub(crate) type Tables = BTreeMap<String, Table>;

/// A table as the migrations so far have shaped it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Table {
    pub(crate) name: String,
    pub(crate) columns: Vec<Column>,
    pub(crate) primary: Vec<String>,
    /// Declared with `index` and `unique`; a unique column and a foreign key add their own.
    pub(crate) indexes: Vec<Declared>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Declared {
    pub(crate) columns: Vec<String>,
    pub(crate) unique: bool,
}

/// An index as the file holds it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Index {
    pub(crate) name: String,
    pub(crate) columns: Vec<String>,
    pub(crate) unique: bool,
}

impl Index {
    pub(crate) fn new(table: &str, columns: Vec<String>, unique: bool) -> Self {
        let kind = if unique { "unique" } else { "index" };
        Self {
            name: format!("{table}_{}_{kind}", columns.join("_")),
            columns,
            unique,
        }
    }

    pub(crate) fn create_sql(&self, table: &str) -> String {
        let columns: Vec<String> = self.columns.iter().map(|column| quote(column)).collect();
        format!(
            "CREATE {}INDEX {} ON {} ({})",
            if self.unique { "UNIQUE " } else { "" },
            quote(&self.name),
            quote(table),
            columns.join(", ")
        )
    }

    pub(crate) fn drop_sql(&self) -> String {
        format!("DROP INDEX {}", quote(&self.name))
    }
}

impl Table {
    pub(crate) fn column(&self, name: &str) -> Option<&Column> {
        self.columns.iter().find(|column| column.name == name)
    }

    pub(crate) fn column_mut(&mut self, name: &str) -> Option<&mut Column> {
        self.columns.iter_mut().find(|column| column.name == name)
    }

    /// The single key column another table's foreign key points at.
    pub(crate) fn key(&self) -> Option<&Column> {
        match self.primary.as_slice() {
            [key] => self.column(key),
            _ => None,
        }
    }

    /// Every index the file holds for this table: declared ones, then one per unique column,
    /// then one per foreign key column that no other index leads with.
    pub(crate) fn indexes(&self) -> Vec<Index> {
        let mut indexes: Vec<Index> = Vec::new();
        let add = |indexes: &mut Vec<Index>, columns: Vec<String>, unique: bool| {
            if !indexes
                .iter()
                .any(|index| index.columns == columns && index.unique == unique)
            {
                indexes.push(Index::new(&self.name, columns, unique));
            }
        };

        for declared in &self.indexes {
            add(&mut indexes, declared.columns.clone(), declared.unique);
        }
        for column in self.columns.iter().filter(|column| column.unique) {
            add(&mut indexes, vec![column.name.clone()], true);
        }
        for column in self
            .columns
            .iter()
            .filter(|column| column.references.is_some())
        {
            let led = self.primary.first() == Some(&column.name)
                || indexes.iter().any(|index| index.columns[0] == column.name);
            if !led {
                add(&mut indexes, vec![column.name.clone()], false);
            }
        }
        indexes
    }

    /// `CREATE TABLE`, under `name` so a rebuild can make the new table beside the old.
    pub(crate) fn create_sql(&self, name: &str, tables: &Tables) -> String {
        let mut lines: Vec<String> = self
            .columns
            .iter()
            .map(|column| column.sql(self.referenced_key(column, tables)))
            .collect();
        let primary: Vec<String> = self.primary.iter().map(|column| quote(column)).collect();
        lines.push(format!("PRIMARY KEY ({})", primary.join(", ")));
        format!(
            "CREATE TABLE {} (\n    {}\n) STRICT",
            quote(name),
            lines.join(",\n    ")
        )
    }

    pub(crate) fn referenced_key<'t>(
        &'t self,
        column: &Column,
        tables: &'t Tables,
    ) -> Option<&'t str> {
        let target = column.references.as_deref()?;
        let table = if target == self.name {
            Some(self)
        } else {
            tables.get(target)
        };
        table.and_then(Table::key).map(|key| key.name.as_str())
    }
}

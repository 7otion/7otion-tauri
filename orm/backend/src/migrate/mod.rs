//! Migrations: typed changes to a database's schema, which the plugin plans when the app starts
//! and runs when a file they apply to opens.

mod blueprint;
mod column;

mod runner;
mod schema;
mod table;

#[cfg(test)]
mod tests;

pub use blueprint::Blueprint;
pub use column::{Change, Column, DateStorage, DefaultValue, Type};
pub use schema::Schema;

use table::Tables;

/// One change to a schema, run once per file.
pub trait Migration {
    /// What the file's `migrations` table records; a shipped name never changes.
    const NAME: &'static str;

    fn up(schema: &mut Schema);
}

/// The migrations one kind of file runs, in order; each is planned as it is added.
#[derive(Default)]
pub struct Migrations {
    planned: Vec<Planned>,
    /// The schema the migrations leave, which every file they run on must match.
    tables: Tables,
}

struct Planned {
    name: &'static str,
    statements: Vec<String>,
}

impl Migrations {
    pub fn new() -> Self {
        Self::default()
    }

    /// Plans `M` against the schema the migrations before it made. A declaration that cannot
    /// hold panics here, naming `M`, so it fails when the app starts rather than on a file.
    pub fn add<M: Migration>(mut self) -> Self {
        assert!(!M::NAME.is_empty(), "a migration's NAME is empty");
        assert!(
            self.planned.iter().all(|planned| planned.name != M::NAME),
            "migration {} is listed twice",
            M::NAME
        );

        let mut schema = Schema::new(M::NAME, std::mem::take(&mut self.tables));
        M::up(&mut schema);
        let (tables, statements) = schema.finish();
        self.tables = tables;
        self.planned.push(Planned {
            name: M::NAME,
            statements,
        });
        self
    }

    /// The SQL each migration runs, in order.
    pub fn sql(&self) -> String {
        self.planned
            .iter()
            .map(|planned| format!("-- {}\n{};", planned.name, planned.statements.join(";\n")))
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

/// `migrations![CreateUsers, AddEmail]`: a set, in the order listed.
#[macro_export]
macro_rules! migrations {
    ($($migration:ty),* $(,)?) => {
        $crate::migrate::Migrations::new()$(.add::<$migration>())*
    };
}

pub(crate) fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

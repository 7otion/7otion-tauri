use super::column::{Change, Column, DateStorage, Type};

/// What `create` and `alter` are given: the table's columns, keys and indexes, as recorded.
/// Nothing is decided until the closure returns.
pub struct Blueprint {
    pub(crate) columns: Vec<Column>,
    pub(crate) changes: Vec<Change>,
    pub(crate) primary: Option<Vec<String>>,
    pub(crate) steps: Vec<Step>,
}

/// One recorded instruction, in the order given.
#[derive(Debug)]
pub(crate) enum Step {
    Add(usize),
    Rename(String, String),
    Drop(String),
    Change(String, usize),
    Index(Vec<String>, bool),
    DropIndex(Vec<String>, bool),
}

impl Blueprint {
    pub(crate) fn new() -> Self {
        Self {
            columns: Vec::new(),
            changes: Vec::new(),
            primary: None,
            steps: Vec::new(),
        }
    }

    /// An `INTEGER` column `id`, the primary key.
    pub fn id(&mut self) -> &mut Column {
        self.primary = Some(vec!["id".to_owned()]);
        self.column("id", Type::Integer)
    }

    pub fn integer(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Integer)
    }

    pub fn real(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Real)
    }

    pub fn text(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Text)
    }

    pub fn blob(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Blob)
    }

    pub fn boolean(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Boolean)
    }

    pub fn json(&mut self, name: &str) -> &mut Column {
        self.column(name, Type::Json)
    }

    pub fn date(&mut self, name: &str, storage: DateStorage) -> &mut Column {
        self.column(name, Type::Date(storage))
    }

    pub fn column(&mut self, name: &str, kind: Type) -> &mut Column {
        self.columns.push(Column::new(name, kind));
        let at = self.columns.len() - 1;
        self.steps.push(Step::Add(at));
        &mut self.columns[at]
    }

    /// The primary key of a table being created, when it is not `id`.
    pub fn primary(&mut self, columns: &[&str]) {
        self.primary = Some(owned(columns));
    }

    pub fn index(&mut self, columns: &[&str]) {
        self.steps.push(Step::Index(owned(columns), false));
    }

    pub fn unique(&mut self, columns: &[&str]) {
        self.steps.push(Step::Index(owned(columns), true));
    }

    pub fn drop_index(&mut self, columns: &[&str]) {
        self.steps.push(Step::DropIndex(owned(columns), false));
    }

    pub fn drop_unique(&mut self, columns: &[&str]) {
        self.steps.push(Step::DropIndex(owned(columns), true));
    }

    pub fn rename(&mut self, from: &str, to: &str) {
        self.steps
            .push(Step::Rename(from.to_owned(), to.to_owned()));
    }

    pub fn drop(&mut self, column: &str) {
        self.steps.push(Step::Drop(column.to_owned()));
    }

    /// Changes the column as it stands at this point of the alteration.
    pub fn change(&mut self, column: &str) -> &mut Change {
        self.changes.push(<Change as Default>::default());
        let at = self.changes.len() - 1;
        self.steps.push(Step::Change(column.to_owned(), at));
        &mut self.changes[at]
    }
}

fn owned(columns: &[&str]) -> Vec<String> {
    columns.iter().map(|column| (*column).to_owned()).collect()
}

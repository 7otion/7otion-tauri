use super::quote;

/// How a date column stores its value, as the ORM's `date()` storages name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateStorage {
    /// ISO 8601 text.
    Iso,
    /// `YYYY-MM-DD HH:MM:SS` in UTC, as SQLite's own date functions write it.
    Datetime,
    /// Whole seconds.
    Unix,
    /// Milliseconds.
    UnixMs,
}

/// A column's type, in the ORM's vocabulary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    Integer,
    Real,
    Text,
    Blob,
    /// 1 or 0.
    Boolean,
    /// Text that is valid JSON.
    Json,
    Date(DateStorage),
}

impl Type {
    pub(crate) fn sql(self) -> &'static str {
        match self {
            Type::Integer | Type::Boolean => "INTEGER",
            Type::Date(DateStorage::Unix | DateStorage::UnixMs) => "INTEGER",
            Type::Real => "REAL",
            Type::Text | Type::Json => "TEXT",
            Type::Date(DateStorage::Iso | DateStorage::Datetime) => "TEXT",
            Type::Blob => "BLOB",
        }
    }

    /// The expression for the current time, as this storage holds it.
    fn now(self) -> Option<&'static str> {
        match self {
            Type::Date(DateStorage::Iso) => Some("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"),
            Type::Date(DateStorage::Datetime) => Some("datetime('now')"),
            Type::Date(DateStorage::Unix) => Some("unixepoch()"),
            Type::Date(DateStorage::UnixMs) => Some("CAST(unixepoch('subsec') * 1000 AS INTEGER)"),
            _ => None,
        }
    }

    fn check(self, column: &str) -> Option<String> {
        match self {
            Type::Boolean => Some(format!("{} IN (0, 1)", quote(column))),
            Type::Json => Some(format!("json_valid({})", quote(column))),
            _ => None,
        }
    }
}

/// What a row holds in a column a write leaves out.
#[derive(Clone, Debug, PartialEq)]
pub enum DefaultValue {
    Integer(i64),
    Real(f64),
    Text(String),
    Boolean(bool),
    /// The time of the write, in the date column's storage.
    Now,
}

impl From<i64> for DefaultValue {
    fn from(value: i64) -> Self {
        Self::Integer(value)
    }
}

impl From<i32> for DefaultValue {
    fn from(value: i32) -> Self {
        Self::Integer(value.into())
    }
}

impl From<f64> for DefaultValue {
    fn from(value: f64) -> Self {
        Self::Real(value)
    }
}

impl From<bool> for DefaultValue {
    fn from(value: bool) -> Self {
        Self::Boolean(value)
    }
}

impl From<&str> for DefaultValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

impl From<String> for DefaultValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

/// A column of a table being created or altered. Required unless made nullable.
#[derive(Clone, Debug, PartialEq)]
pub struct Column {
    pub(crate) name: String,
    pub(crate) kind: Type,
    pub(crate) nullable: bool,
    pub(crate) default: Option<DefaultValue>,
    pub(crate) unique: bool,
    pub(crate) references: Option<String>,
}

impl Column {
    pub(crate) fn new(name: &str, kind: Type) -> Self {
        Self {
            name: name.to_owned(),
            kind,
            nullable: false,
            default: None,
            unique: false,
            references: None,
        }
    }

    pub fn nullable(&mut self) -> &mut Self {
        self.nullable = true;
        self
    }

    pub fn default(&mut self, value: impl Into<DefaultValue>) -> &mut Self {
        self.default = Some(value.into());
        self
    }

    /// Dates only.
    pub fn default_now(&mut self) -> &mut Self {
        self.default = Some(DefaultValue::Now);
        self
    }

    /// Carried by a unique index on this column alone.
    pub fn unique(&mut self) -> &mut Self {
        self.unique = true;
        self
    }

    /// A foreign key to the table's primary key, which must be one column; indexed.
    pub fn references(&mut self, table: &str) -> &mut Self {
        self.references = Some(table.to_owned());
        self
    }

    /// Everything but uniqueness, which an index carries rather than the table.
    pub(crate) fn same_definition(&self, other: &Column) -> bool {
        self.name == other.name
            && self.kind == other.kind
            && self.nullable == other.nullable
            && self.default == other.default
            && self.references == other.references
    }

    /// `referenced_key` is the key column of the table `references` names.
    pub(crate) fn sql(&self, referenced_key: Option<&str>) -> String {
        let mut sql = format!("{} {}", quote(&self.name), self.kind.sql());
        if !self.nullable {
            sql.push_str(" NOT NULL");
        }
        if let Some(default) = &self.default {
            sql.push_str(" DEFAULT ");
            sql.push_str(&self.default_sql(default));
        }
        if let Some(check) = self.kind.check(&self.name) {
            sql.push_str(&format!(" CHECK ({check})"));
        }
        if let (Some(table), Some(key)) = (&self.references, referenced_key) {
            sql.push_str(&format!(" REFERENCES {} ({})", quote(table), quote(key)));
        }
        sql
    }

    /// The default as `PRAGMA table_xinfo` reports it: an expression without its parentheses.
    pub(crate) fn reported_default(&self) -> Option<String> {
        self.default.as_ref().map(|default| match default {
            DefaultValue::Now => self.kind.now().unwrap_or_default().to_owned(),
            _ => self.default_sql(default),
        })
    }

    fn default_sql(&self, default: &DefaultValue) -> String {
        match default {
            DefaultValue::Integer(value) => value.to_string(),
            DefaultValue::Real(value) => format!("{value:?}"),
            DefaultValue::Text(value) => format!("'{}'", value.replace('\'', "''")),
            DefaultValue::Boolean(value) => (if *value { "1" } else { "0" }).to_owned(),
            DefaultValue::Now => format!("({})", self.kind.now().unwrap_or_default()),
        }
    }

    /// Why this column cannot be declared as it is, if it cannot.
    pub(crate) fn fault(&self) -> Option<String> {
        let name = &self.name;
        let Some(default) = &self.default else {
            return None;
        };
        let fits = match (default, self.kind) {
            (DefaultValue::Now, kind) => kind.now().is_some(),
            (DefaultValue::Integer(_), Type::Integer | Type::Real) => true,
            (DefaultValue::Integer(_), Type::Date(DateStorage::Unix | DateStorage::UnixMs)) => true,
            (DefaultValue::Real(value), Type::Real) => value.is_finite(),
            (DefaultValue::Boolean(_), Type::Boolean) => true,
            (DefaultValue::Text(_), Type::Text) => true,
            (DefaultValue::Text(_), Type::Date(DateStorage::Iso | DateStorage::Datetime)) => true,
            (DefaultValue::Text(text), Type::Json) => {
                return serde_json::from_str::<serde_json::Value>(text)
                    .err()
                    .map(|_| format!("column {name}'s default is not valid JSON"));
            }
            _ => false,
        };
        (!fits).then(|| {
            format!(
                "column {name}'s default {default:?} does not fit a {:?} column",
                self.kind
            )
        })
    }
}

/// Changes to a column's definition, made to it as it stands when the alteration runs.
#[derive(Clone, Debug, Default)]
pub struct Change {
    pub(crate) kind: Option<Type>,
    pub(crate) nullable: Option<bool>,
    pub(crate) default: Option<Option<DefaultValue>>,
    pub(crate) unique: Option<bool>,
    pub(crate) references: Option<Option<String>>,
}

impl Change {
    pub fn retype(&mut self, kind: Type) -> &mut Self {
        self.kind = Some(kind);
        self
    }

    pub fn nullable(&mut self) -> &mut Self {
        self.nullable = Some(true);
        self
    }

    pub fn required(&mut self) -> &mut Self {
        self.nullable = Some(false);
        self
    }

    pub fn default(&mut self, value: impl Into<DefaultValue>) -> &mut Self {
        self.default = Some(Some(value.into()));
        self
    }

    pub fn default_now(&mut self) -> &mut Self {
        self.default = Some(Some(DefaultValue::Now));
        self
    }

    pub fn without_default(&mut self) -> &mut Self {
        self.default = Some(None);
        self
    }

    pub fn unique(&mut self) -> &mut Self {
        self.unique = Some(true);
        self
    }

    pub fn not_unique(&mut self) -> &mut Self {
        self.unique = Some(false);
        self
    }

    pub fn references(&mut self, table: &str) -> &mut Self {
        self.references = Some(Some(table.to_owned()));
        self
    }

    pub fn without_reference(&mut self) -> &mut Self {
        self.references = Some(None);
        self
    }

    pub(crate) fn apply(&self, column: &mut Column) {
        if let Some(kind) = self.kind {
            column.kind = kind;
        }
        if let Some(nullable) = self.nullable {
            column.nullable = nullable;
        }
        if let Some(default) = &self.default {
            column.default = default.clone();
        }
        if let Some(unique) = self.unique {
            column.unique = unique;
        }
        if let Some(references) = &self.references {
            column.references = references.clone();
        }
    }
}

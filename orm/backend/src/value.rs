use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Number, Value as JsonValue, json};
use sqlx::query::Query;
use sqlx::sqlite::{Sqlite, SqliteArguments, SqliteValueRef};
use sqlx::{TypeInfo, Value, ValueRef};

use crate::error::{Error, Result};

pub(crate) type SqliteQuery<'q> = Query<'q, Sqlite, SqliteArguments<'q>>;

/// The largest integer a JavaScript number holds exactly.
const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// A whole number JavaScript holds exactly binds as INTEGER, any other number as REAL,
/// `{ "blob": base64 }` as BLOB. A larger whole number is refused: an INTEGER column stores it
/// as an integer whatever it was bound as, and an integer beyond 2^53 cannot be read back.
pub(crate) fn bind(query: SqliteQuery<'_>, value: JsonValue) -> Result<SqliteQuery<'_>> {
    Ok(match value {
        JsonValue::Null => query.bind(None::<String>),
        JsonValue::Bool(value) => query.bind(i64::from(value)),
        JsonValue::Number(number) => {
            if let Some(integer) = number.as_i64()
                && (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer)
            {
                return Ok(query.bind(integer));
            }
            let float = number
                .as_f64()
                .ok_or(Error::Unbindable("a number beyond f64"))?;
            if float.fract() == 0.0 && float.abs() > MAX_SAFE_INTEGER as f64 {
                return Err(Error::WholeNumberRange(number.to_string()));
            }
            query.bind(float)
        }
        JsonValue::String(text) => query.bind(text),
        JsonValue::Array(_) => return Err(Error::Unbindable("an array")),
        JsonValue::Object(object) => match object.get("blob") {
            Some(JsonValue::String(encoded)) if object.len() == 1 => query.bind(
                STANDARD
                    .decode(encoded)
                    .map_err(|_| Error::Unbindable("a blob that is not base64"))?,
            ),
            _ => return Err(Error::Unbindable("an object other than { blob }")),
        },
    })
}

/// Decoded by the value's own storage class, not the column's declared type.
pub(crate) fn to_json(value: SqliteValueRef<'_>) -> Result<JsonValue> {
    if value.is_null() {
        return Ok(JsonValue::Null);
    }

    let storage = value.type_info().name().to_owned();
    let owned = ValueRef::to_owned(&value);

    Ok(match storage.as_str() {
        "INTEGER" => {
            let integer = owned.try_decode::<i64>()?;
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&integer) {
                return Err(Error::IntegerRange(integer));
            }
            JsonValue::from(integer)
        }
        // JSON has no infinity; SQLite never stores NaN.
        "REAL" => {
            let real = owned.try_decode::<f64>()?;
            JsonValue::Number(Number::from_f64(real).ok_or(Error::NotFinite(real))?)
        }
        "BLOB" => json!({ "blob": STANDARD.encode(owned.try_decode::<Vec<u8>>()?) }),
        _ => JsonValue::String(owned.try_decode::<String>()?),
    })
}

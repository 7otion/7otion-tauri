use std::time::Instant;

use serde_json::Value as JsonValue;
use tauri::State;

use crate::database::{Answer, TxId};
use crate::databases::{Databases, HandleId};
use crate::error::Failure;

#[tauri::command]
pub(crate) async fn run(
    databases: State<'_, Databases>,
    handle: HandleId,
    sql: String,
    params: Vec<JsonValue>,
    tx: Option<TxId>,
) -> Result<Answer, Failure> {
    let entered = Instant::now();
    let mut answer = databases
        .handle(handle)
        .await?
        .run(handle, &sql, params, tx)
        .await?;
    answer.plugin_ms = entered.elapsed().as_secs_f64() * 1000.0;
    Ok(answer)
}

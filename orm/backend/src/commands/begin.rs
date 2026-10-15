use serde::Serialize;
use tauri::State;

use crate::database::TxId;
use crate::databases::{Databases, HandleId};
use crate::error::Failure;

#[derive(Serialize)]
pub(crate) struct Begun {
    tx: TxId,
}

#[tauri::command]
pub(crate) async fn begin(
    databases: State<'_, Databases>,
    handle: HandleId,
) -> Result<Begun, Failure> {
    let tx = databases.begin(handle).await?;
    Ok(Begun { tx })
}

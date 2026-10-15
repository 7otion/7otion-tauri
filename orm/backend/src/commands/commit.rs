use tauri::State;

use crate::database::TxId;
use crate::databases::{Databases, HandleId};
use crate::error::Failure;

#[tauri::command]
pub(crate) async fn commit(
    databases: State<'_, Databases>,
    handle: HandleId,
    tx: TxId,
) -> Result<(), Failure> {
    Ok(databases.handle(handle).await?.commit(handle, tx).await?)
}

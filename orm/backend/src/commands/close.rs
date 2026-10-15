use tauri::State;

use crate::databases::{Databases, HandleId};
use crate::error::Failure;

#[tauri::command]
pub(crate) async fn close(
    databases: State<'_, Databases>,
    handle: HandleId,
) -> Result<(), Failure> {
    Ok(databases.release_handle(handle).await?)
}

use serde::Serialize;
use tauri::{Runtime, State, Webview};

use crate::config::DatabaseConfig;
use crate::databases::{Databases, HandleId};
use crate::error::Failure;

#[derive(Serialize)]
pub(crate) struct Loaded {
    handle: HandleId,
    path: String,
}

#[tauri::command]
pub(crate) async fn load<R: Runtime>(
    webview: Webview<R>,
    databases: State<'_, Databases>,
    path: String,
    migrations: Option<String>,
    config: Option<DatabaseConfig>,
) -> Result<Loaded, Failure> {
    if config.as_ref().is_some_and(|config| config.key.is_some()) {
        tracing::warn!(
            path,
            "an encryption key was passed from JavaScript: it crosses IPC and stays in webview memory;              supply it from Rust with app.sqlite().load() instead"
        );
    }

    let (handle, database) = databases
        .load_handle(&path, migrations.as_deref(), config, webview.label())
        .await?;

    Ok(Loaded {
        handle,
        path: database.id().to_owned(),
    })
}

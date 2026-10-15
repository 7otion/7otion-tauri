//! SQLite for Tauri, as `@7otion-tauri/orm` speaks to it: one writer connection per database
//! file, which a transaction holds from BEGIN to COMMIT, and read-only connections beside it.

mod commands;
mod config;
mod database;
mod databases;
mod error;
pub mod migrate;
mod value;

#[cfg(test)]
mod tests;

pub use config::DatabaseConfig;
pub use database::{Database, WriterGuard};
pub use databases::Databases;
pub use error::{Code, Error, Failure, Result};

use tauri::plugin::TauriPlugin;
use tauri::webview::PageLoadEvent;
use tauri::{Manager, Runtime};

use std::collections::HashMap;

use migrate::Migrations;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new().build()
}

/// The plugin, with the migration sets a file may name when it opens.
#[derive(Default)]
pub struct Builder {
    migrations: HashMap<String, Migrations>,
}

impl Builder {
    pub fn new() -> Self {
        Self::default()
    }

    /// A set of migrations under `name`. A file opened with that name, from JavaScript or from
    /// Rust, runs the set before any statement reaches it.
    pub fn migrations(mut self, name: &str, migrations: Migrations) -> Self {
        assert!(
            self.migrations
                .insert(name.to_owned(), migrations)
                .is_none(),
            "migrations {name:?} are registered twice"
        );
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let migrations = self.migrations;
        tauri::plugin::Builder::new("7otion-sqlite")
            .invoke_handler(tauri::generate_handler![
                commands::load::load,
                commands::run::run,
                commands::begin::begin,
                commands::commit::commit,
                commands::rollback::rollback,
                commands::close::close,
            ])
            .setup(move |app, _api| {
                app.manage(Databases::new(app.path().app_data_dir().ok(), migrations));
                Ok(())
            })
            .on_page_load(|webview, payload| {
                if !matches!(payload.event(), PageLoadEvent::Started) {
                    return;
                }

                let app = webview.app_handle().clone();
                let webview = webview.label().to_owned();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = app.sqlite().release_webview(&webview).await {
                        tracing::error!(%error, webview, "releasing a replaced page's database handles failed");
                    }
                });
            })
            .build()
    }
}

/// `app.sqlite()`, from anything that can reach the app's managed state.
pub trait SqliteExt<R: Runtime> {
    fn sqlite(&self) -> &Databases;
}

impl<R: Runtime, T: Manager<R>> SqliteExt<R> for T {
    fn sqlite(&self) -> &Databases {
        self.state::<Databases>().inner()
    }
}

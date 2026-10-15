use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::config::DatabaseConfig;
use crate::database::{Database, TxId};
use crate::error::{Error, Result};
use crate::migrate::Migrations;

/// Identifies one JavaScript `load` of a database.
pub(crate) type HandleId = u64;

/// Every database the app has open, one set of connections per file, and who holds each.
pub struct Databases {
    data_directory: Option<PathBuf>,
    migrations: HashMap<String, Migrations>,
    registry: Mutex<Registry>,
}

struct Registry {
    databases: HashMap<String, Entry>,
    handles: HashMap<HandleId, Handle>,
    next_handle: HandleId,
}

struct Entry {
    database: Arc<Database>,
    handles: HashSet<HandleId>,
    /// The set the file was opened under; a later open must name the same one, or none.
    migrations: Option<String>,
    /// Loaded from Rust, which keeps it open until Rust releases or closes it.
    held_by_rust: bool,
}

struct Handle {
    database_id: String,
    webview: String,
}

impl Databases {
    pub(crate) fn new(
        data_directory: Option<PathBuf>,
        migrations: HashMap<String, Migrations>,
    ) -> Self {
        Self {
            data_directory,
            migrations,
            registry: Mutex::new(Registry {
                databases: HashMap::new(),
                handles: HashMap::new(),
                next_handle: 1,
            }),
        }
    }

    /// Opens `path`, running the named migrations, or attaches to its open connections, and keeps
    /// it open until [`Self::release`] or [`Self::close`]. With no migrations and no config it
    /// attaches whatever the database was opened with; either given must match that.
    pub async fn load(
        &self,
        path: impl AsRef<Path>,
        migrations: Option<&str>,
        config: Option<DatabaseConfig>,
    ) -> Result<Arc<Database>> {
        let mut registry = self.registry.lock().await;
        let entry = self
            .entry(&mut registry, path.as_ref(), migrations, config)
            .await?;
        entry.held_by_rust = true;
        Ok(entry.database.clone())
    }

    /// Lets go of Rust's hold: the database closes once no JavaScript handle holds it either.
    pub async fn release(&self, id: &str) -> Result<()> {
        let mut registry = self.registry.lock().await;

        let Some(entry) = registry.databases.get_mut(id) else {
            return Ok(());
        };
        entry.held_by_rust = false;
        if !entry.handles.is_empty() {
            return Ok(());
        }
        let entry = registry.databases.remove(id).expect("found above");
        entry.database.close().await?;
        tracing::info!(database = %id, "closed");
        Ok(())
    }

    /// Closes the database outright, ending every handle to it; closing one not open does nothing.
    pub async fn close(&self, id: &str) -> Result<()> {
        let mut registry = self.registry.lock().await;

        if let Some(entry) = registry.databases.remove(id) {
            registry
                .handles
                .retain(|_, handle| handle.database_id != id);
            entry.database.close().await?;
            tracing::info!(database = %id, "closed");
        }
        Ok(())
    }

    pub(crate) async fn load_handle(
        &self,
        path: &str,
        migrations: Option<&str>,
        config: Option<DatabaseConfig>,
        webview: &str,
    ) -> Result<(HandleId, Arc<Database>)> {
        let mut registry = self.registry.lock().await;
        let handle = registry.next_handle;

        let entry = self
            .entry(&mut registry, Path::new(path), migrations, config)
            .await?;
        entry.handles.insert(handle);
        let database = entry.database.clone();
        database.attach(handle);

        registry.next_handle += 1;
        registry.handles.insert(
            handle,
            Handle {
                database_id: database.id().to_owned(),
                webview: webview.to_owned(),
            },
        );

        Ok((handle, database))
    }

    pub(crate) async fn handle(&self, handle: HandleId) -> Result<Arc<Database>> {
        let registry = self.registry.lock().await;

        registry
            .handles
            .get(&handle)
            .and_then(|held| registry.databases.get(&held.database_id))
            .map(|entry| entry.database.clone())
            .ok_or(Error::UnknownHandle(handle))
    }

    /// Begins a transaction for `handle`. The wait for the writer may outlast the handle, and
    /// a transaction whose handle is gone could never be ended.
    pub(crate) async fn begin(&self, handle: HandleId) -> Result<TxId> {
        self.handle(handle).await?.begin(handle).await
    }

    /// Releasing a handle twice does nothing.
    pub(crate) async fn release_handle(&self, handle: HandleId) -> Result<()> {
        let mut registry = self.registry.lock().await;

        match registry.handles.remove(&handle) {
            Some(held) => Self::release_from(&mut registry, handle, &held.database_id).await,
            None => Ok(()),
        }
    }

    /// For a page that is being replaced, whose handles will never be released.
    pub(crate) async fn release_webview(&self, webview: &str) -> Result<()> {
        let mut registry = self.registry.lock().await;

        let owned: Vec<(HandleId, String)> = registry
            .handles
            .iter()
            .filter(|(_, held)| held.webview == webview)
            .map(|(handle, held)| (*handle, held.database_id.clone()))
            .collect();

        for (handle, database_id) in owned {
            registry.handles.remove(&handle);
            // One handle that fails to release does not keep the page's others.
            if let Err(error) = Self::release_from(&mut registry, handle, &database_id).await {
                tracing::error!(database = %database_id, handle, %error, "releasing a handle failed");
            }
        }
        Ok(())
    }

    async fn release_from(
        registry: &mut Registry,
        handle: HandleId,
        database_id: &str,
    ) -> Result<()> {
        let Some(entry) = registry.databases.get_mut(database_id) else {
            return Ok(());
        };
        entry.handles.remove(&handle);
        let database = entry.database.clone();
        let unheld = entry.handles.is_empty() && !entry.held_by_rust;

        let left_open = database.release_handle(handle).await;
        if left_open > 0 {
            tracing::warn!(database = %database_id, handle, left_open, "rolled back transactions their handle left open");
        }

        if unheld {
            registry.databases.remove(database_id);
            database.close().await?;
            tracing::info!(database = %database_id, "closed");
        }
        Ok(())
    }

    async fn entry<'r>(
        &self,
        registry: &'r mut Registry,
        path: &Path,
        migrations: Option<&str>,
        config: Option<DatabaseConfig>,
    ) -> Result<&'r mut Entry> {
        let path = self.resolve(path)?;
        let id = Self::identity(&path)?;

        if let Some(entry) = registry.databases.get(&id) {
            if let Some(config) = config
                && !config.opens_like(entry.database.config())
            {
                return Err(Error::ConfigMismatch(id));
            }
            if let Some(given) = migrations
                && entry.migrations.as_deref() != Some(given)
            {
                return Err(Error::MigrationsMismatch {
                    database: id,
                    open: entry.migrations.clone(),
                    given: given.to_owned(),
                });
            }
        } else {
            let set = match migrations {
                Some(name) => Some(
                    self.migrations
                        .get(name)
                        .ok_or_else(|| Error::UnknownMigrations(name.to_owned()))?,
                ),
                None => None,
            };
            let database =
                Database::open(id.clone(), &path, config.unwrap_or_default(), set).await?;
            tracing::info!(database = %id, "opened");
            registry.databases.insert(
                id.clone(),
                Entry {
                    database: Arc::new(database),
                    handles: HashSet::new(),
                    migrations: migrations.map(str::to_owned),
                    held_by_rust: false,
                },
            );
        }

        Ok(registry
            .databases
            .get_mut(&id)
            .expect("the entry was found or inserted above"))
    }

    fn resolve(&self, path: &Path) -> Result<PathBuf> {
        if path.is_absolute() {
            return Ok(path.to_path_buf());
        }

        let data_directory = self
            .data_directory
            .as_ref()
            .ok_or_else(|| Error::NoDataDirectory(path.display().to_string()))?;
        let resolved = data_directory.join(path);

        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(resolved)
    }

    /// The canonical path, so two spellings of one file share their connections.
    fn identity(path: &Path) -> Result<String> {
        let canonical = match path.canonicalize() {
            Ok(canonical) => canonical,
            Err(_) => {
                let name = path
                    .file_name()
                    .ok_or_else(|| Error::NoFileName(path.display().to_string()))?;
                let parent = match path.parent() {
                    Some(parent) if !parent.as_os_str().is_empty() => parent,
                    _ => Path::new("."),
                };
                parent.canonicalize()?.join(name)
            }
        };

        Ok(canonical.to_string_lossy().into_owned())
    }
}

pub mod postgres;
pub mod sqlite;

use std::{
    fs::{self, File, OpenOptions, TryLockError},
    path::PathBuf,
    sync::Arc,
};

use notarium_core::{epoch::DataRoot, error::PortError};

use crate::codec::{internal_not_committed, unavailable_retryable};

/// Exclusive OS-level process lock over a `DataRoot`'s v1 canonical store.
///
/// Held for the full lifetime of `CanonicalRuntime` so a second writer instance
/// on the same `DataRoot` fails closed before mutating SQLite or local CAS files.
#[derive(Debug)]
pub struct DataRootOwnerLock {
    path: PathBuf,
    _file: Arc<File>,
}

impl DataRootOwnerLock {
    pub fn acquire(data_root: &DataRoot) -> Result<Self, PortError> {
        let v1_dir = data_root.root().join("v1");
        fs::create_dir_all(&v1_dir)
            .map_err(|err| internal_not_committed("dataroot_mkdir_v1", err.to_string()))?;
        let lock_path = v1_dir.join("canonical-owner.lock");
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)
            .map_err(|err| internal_not_committed("dataroot_open_lock", err.to_string()))?;

        match file.try_lock() {
            Ok(()) => Ok(Self {
                path: lock_path,
                _file: Arc::new(file),
            }),
            Err(TryLockError::WouldBlock) => Err(unavailable_retryable(
                "dataroot_already_locked",
                format!("DataRoot lock busy at {}", lock_path.display()),
                std::time::Duration::from_millis(250),
            )),
            Err(TryLockError::Error(err)) => {
                Err(internal_not_committed("dataroot_lock_io", err.to_string()))
            }
        }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

//! Cooperative cross-process SQLite writer fencing.
use crate::{error::unavailable, store::lease::OperationBudget};
use cap_fs_ext::OpenOptionsSyncExt;
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::error::{CommitEffect, PortError};
use std::{
    fs::{File, TryLockError},
    path::{Path, PathBuf},
    time::Duration,
};

fn failure() -> PortError {
    unavailable("control file fence", CommitEffect::NotCommitted)
}

/// Each acquisition opens a separate handle. The stable lockfile is never
/// unlinked: replacing its inode would split the cooperating writer domain.
pub(crate) struct FileFence(File);
impl FileFence {
    pub(crate) fn acquire(
        path: &Path,
        exclusive: bool,
        check: impl Fn() -> Result<(), PortError>,
    ) -> Result<Self, PortError> {
        check()?;
        let parent = path.parent().ok_or_else(failure)?;
        let name = path.file_name().ok_or_else(failure)?;
        let root = Dir::open_ambient_dir(parent, ambient_authority()).map_err(|_| failure())?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .nonblock(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = root
            .open_with(name, &options)
            .map_err(|_| failure())?
            .into_std();
        if !file.metadata().map_err(|_| failure())?.is_file() {
            return Err(failure());
        }
        loop {
            check()?;
            let result = if exclusive {
                file.try_lock()
            } else {
                file.try_lock_shared()
            };
            match result {
                Ok(()) => {
                    check()?;
                    return Ok(Self(file));
                }
                Err(TryLockError::WouldBlock) => std::thread::sleep(if exclusive {
                    Duration::from_micros(50)
                } else {
                    Duration::from_millis(1)
                }),
                Err(TryLockError::Error(_)) => return Err(failure()),
            }
        }
    }

    pub(crate) async fn writer(path: PathBuf, budget: OperationBudget) -> Result<Self, PortError> {
        // The calling owned transaction/bootstrap task retains its admission
        // until this blocking owner returns, even if its external waiter drops.
        tokio::task::spawn_blocking(move || {
            Self::acquire(&path, false, || budget.check(CommitEffect::NotCommitted))
        })
        .await
        .map_err(|_| failure())?
    }

    pub(crate) fn release(self) -> Result<(), PortError> {
        // The file is closed on both success and failure, so its OS lock cannot
        // escape into a pool or another phase.
        self.0.unlock().map_err(|_| failure())
    }
}

pub(crate) fn sqlite_writer_lock(database: &Path) -> PathBuf {
    let mut name = database.as_os_str().to_os_string();
    name.push(".write.lock");
    PathBuf::from(name)
}

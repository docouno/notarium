pub mod postgres;
pub mod sqlite;

use std::{
    fs::{self, File, TryLockError},
    io,
    path::PathBuf,
    sync::Arc,
};

use cap_fs_ext::{DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, Metadata, OpenOptions},
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
        const LOCK: &str = "canonical-owner.lock";
        let lock_path = data_root.root().join("v1").join(LOCK);
        let file = (|| {
            fs::create_dir_all(data_root.root())?;
            let root = Dir::open_ambient_dir(data_root.root(), ambient_authority())?;
            match root.create_dir("v1") {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
            let directory = service_dir(&root)?;
            let mut options = service_open_options();
            options.write(true).create(true);
            #[cfg(unix)]
            {
                use cap_std::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = directory.open_with(LOCK, &options)?;
            check_private_regular_file(&file.metadata()?)?;
            Ok::<_, io::Error>(file.into_std())
        })()
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

pub(super) fn service_dir(root: &Dir) -> io::Result<Dir> {
    let directory = root.open_dir_nofollow("v1")?;
    if metadata_is_link(&directory.dir_metadata()?) {
        return Err(io::Error::other(
            "v1 service directory aliases another path",
        ));
    }
    Ok(directory)
}

fn metadata_is_link(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use cap_std::fs::MetadataExt as _;
        // FILE_ATTRIBUTE_REPARSE_POINT also covers junctions.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn service_open_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No).nonblock(true);
    options
}

fn check_private_regular_file(metadata: &Metadata) -> io::Result<()> {
    if metadata_is_link(metadata) || !metadata.is_file() || metadata.nlink() != 1 {
        return Err(io::Error::other(
            "service file must be a regular file with one name",
        ));
    }
    Ok(())
}

pub(super) fn service_file_is_present(directory: &Dir, name: &str) -> io::Result<bool> {
    let metadata = match directory.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    if metadata_is_link(&metadata) || !metadata.is_file() {
        return Err(io::Error::other(
            "service file aliases another path or is not regular",
        ));
    }
    let opened = directory
        .open_with(name, &service_open_options())
        .map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                io::Error::other("service name changed during validation")
            } else {
                error
            }
        })?;
    check_private_regular_file(&opened.metadata()?)?;
    Ok(true)
}

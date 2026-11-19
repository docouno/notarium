use super::recovery::RecoveryRoot;
use super::{
    EntryKind, FileIdentity, VaultDir, acquire_lock, checked_file_metadata, entry_kind, invalid,
    open_child_dir, platform, present, sync_dir,
};
use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt, OpenOptionsSyncExt};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use notarium_core::epoch::DataRoot;
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

/// Resolves the OS-specific data directory. Directory creation and verification
/// occur in [`ValidatedRoots::open`].
pub fn platform_data_root() -> io::Result<DataRoot> {
    platform::system_data_path().map(DataRoot::new)
}

/// The sidecar must keep both capabilities for its whole lifetime. The private
/// `DataRoot` path remains available for storage libraries that accept paths.
#[derive(Debug)]
pub struct ValidatedRoots {
    data: DataRoot,
    private: Dir,
    private_id: FileIdentity,
    storage: StorageLayout,
    vault: Option<VaultDir>,
}

impl ValidatedRoots {
    pub fn open(data: &DataRoot, vault: Option<&Path>) -> io::Result<Self> {
        let mut private = walk_private(data.root())?;
        let vault = vault.map(walk_absolute).transpose()?;
        if let Some(vault) = &vault {
            if !vault.missing.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "selected vault does not exist",
                ));
            }
            disjoint(&private, vault)?;
        }

        if !private.missing.is_empty() {
            private.complete_private_path()?;
        }
        platform::verify_private_dir(&private.dir)?;
        platform::exclude_private_backup(&private.dir, &private.path)?;
        let storage = StorageLayout::open(&private.dir)?;

        let data = DataRoot::new(private.path);
        let vault = vault
            .map(|vault| {
                let recovery = RecoveryRoot::new(private.dir.try_clone()?, data.root().to_owned());
                VaultDir::new(vault.path, vault.dir, Arc::new(recovery), false)
            })
            .transpose()?;
        let roots = Self {
            data,
            private: private.dir,
            private_id: private.identity,
            storage,
            vault,
        };
        roots.verify_current()?;
        Ok(roots)
    }

    pub fn data_root(&self) -> &DataRoot {
        &self.data
    }

    pub fn private_dir(&self) -> &Dir {
        &self.private
    }

    pub fn vault(&self) -> Option<&VaultDir> {
        self.vault.as_ref()
    }

    /// Repeat namespace validation near handoff to ambient storage use and
    /// before starting an ambient watcher.
    pub fn verify_current(&self) -> io::Result<()> {
        let private = walk_private(self.data.root())?;
        if !private.missing.is_empty() || private.identity != self.private_id {
            return Err(invalid("private desktop data directory was replaced"));
        }
        platform::verify_private_dir(&private.dir)?;
        self.storage.verify(&private.dir)?;
        if let Some(vault) = &self.vault {
            let current = walk_absolute(&vault.path)?;
            if !current.missing.is_empty() || current.identity != vault.identity {
                return Err(invalid("selected vault directory was replaced"));
            }
            disjoint(&private, &current)?;
        }
        Ok(())
    }

    /// Acquires a non-destructive process lock rooted in the verified private
    /// directory. Leaving the lock file after closing the handle is intentional.
    pub fn acquire_sidecar_lock(&self) -> io::Result<File> {
        self.verify_current()?;
        let path = self.data.sidecar_lock();
        let name = path.file_name().expect("DataRoot defines a lock filename");
        acquire_lock(&self.private, name)
    }
}

#[derive(Debug)]
struct StorageLayout {
    dir: Dir,
    identity: FileIdentity,
}

pub(super) const STORAGE_FILES: &[&str] = &[
    "canonical-owner.lock",
    "canonical.sqlite",
    "canonical.sqlite-wal",
    "canonical.sqlite-shm",
    "canonical.sqlite-journal",
    "control.sqlite.write.lock",
    "control.sqlite",
    "control.sqlite-wal",
    "control.sqlite-shm",
    "control.sqlite-journal",
];

impl StorageLayout {
    fn open(private: &Dir) -> io::Result<Self> {
        let dir = open_or_create_private_dir(private, OsStr::new("v1"))?;
        platform::verify_storage_dir(&dir)?;
        Self::verify_files(&dir)?;
        let identity = platform::directory_identity(&dir)?;
        Ok(Self { dir, identity })
    }

    fn verify(&self, private: &Dir) -> io::Result<()> {
        let current = open_child_dir(private, OsStr::new("v1"))?;
        platform::require_same_mount(private, &current)?;
        if platform::directory_identity(&current)? != self.identity {
            return Err(invalid("private SQLite directory was replaced"));
        }
        platform::verify_storage_dir(&self.dir)?;
        Self::verify_files(&self.dir)
    }

    fn verify_files(dir: &Dir) -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.read(true).nonblock(true).follow(FollowSymlinks::No);
        platform::set_metadata_options(&mut options);
        for name in STORAGE_FILES.iter().copied().map(OsStr::new) {
            let Some(metadata) = present(dir.symlink_metadata(name))? else {
                continue;
            };
            if entry_kind(&metadata) != EntryKind::File {
                return Err(invalid(
                    "private SQLite paths require unlinked regular files",
                ));
            }
            // SQLite can remove a regular WAL or SHM between the two reads.
            let Some(file) = present(dir.open_with(name, &options))? else {
                continue;
            };
            checked_file_metadata(&file)?;
            platform::require_file_mount(dir, &file)?;
            platform::verify_name(&file, name)?;
        }
        Ok(())
    }
}

pub(super) fn open_or_create_private_dir(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    let dir = match open_child_dir(parent, name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match platform::create_private_dir(parent, name) {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                result => result?,
            }
            sync_dir(parent)?;
            open_child_dir(parent, name)?
        }
        result => result?,
    };
    platform::require_same_mount(parent, &dir)?;
    Ok(dir)
}

pub(super) struct WalkedPath {
    pub path: PathBuf,
    pub dir: Dir,
    pub identity: FileIdentity,
    ancestors: Vec<FileIdentity>,
    reached: PathBuf,
    pub missing: Vec<OsString>,
}

impl WalkedPath {
    fn complete_private_path(&mut self) -> io::Result<()> {
        for component in std::mem::take(&mut self.missing) {
            let result = platform::create_private_dir(&self.dir, &component);
            match result {
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                result => result?,
            }
            sync_dir(&self.dir)?;
            let next = platform::open_child_dir(&self.dir, &component)?;
            platform::require_same_mount(&self.dir, &next)?;
            #[cfg(unix)]
            platform::verify_private_ancestor(&next)?;
            self.reached.push(component);
            self.identity = platform::directory_identity(&next)?;
            self.ancestors.push(self.identity);
            self.dir = next;
        }
        Ok(())
    }

    fn backing_path(&self) -> io::Result<PathBuf> {
        let mut path = platform::backing_path(&self.dir, &self.reached)?;
        path.extend(&self.missing);
        Ok(path)
    }
}

pub(super) fn walk_absolute(path: &Path) -> io::Result<WalkedPath> {
    walk(path, false)
}

fn walk_private(path: &Path) -> io::Result<WalkedPath> {
    walk(path, true)
}

fn walk(path: &Path, verify_ancestors: bool) -> io::Result<WalkedPath> {
    if !path.is_absolute() {
        return Err(invalid("desktop roots must be absolute paths"));
    }
    let mut components = path.components().peekable();
    let mut reached = PathBuf::new();
    if let Some(Component::Prefix(prefix)) = components.peek() {
        platform::verify_prefix(prefix.kind())?;
        reached.push(prefix.as_os_str());
        components.next();
    }
    let Some(Component::RootDir) = components.next() else {
        return Err(invalid("desktop roots must start at a filesystem root"));
    };
    reached.push(std::path::MAIN_SEPARATOR_STR);
    let components = components
        .map(|component| match component {
            Component::Normal(name) => {
                #[cfg(windows)]
                {
                    let component = name
                        .to_str()
                        .ok_or_else(|| invalid("invalid Windows root component"))?;
                    notarium_syntax::unicode::PortableFilename::parse(component)
                        .map_err(|_| invalid("invalid Windows root component"))?;
                }
                Ok(name)
            }
            _ => Err(invalid("desktop roots cannot traverse parents")),
        })
        .collect::<io::Result<Vec<_>>>()?;
    let mut dir = Dir::open_ambient_dir(&reached, ambient_authority())?;
    #[cfg(unix)]
    if verify_ancestors {
        platform::verify_private_ancestor(&dir)?;
    }
    #[cfg(windows)]
    let _ = verify_ancestors;
    let mut identity = platform::directory_identity(&dir)?;
    let mut ancestors = vec![identity];
    let mut missing = Vec::new();
    let mut rest = components.iter();
    while let Some(name) = rest.next() {
        match platform::open_child_dir(&dir, name) {
            Ok(child) => {
                #[cfg(unix)]
                if verify_ancestors {
                    platform::verify_private_ancestor(&child)?;
                }
                identity = platform::directory_identity(&child)?;
                ancestors.push(identity);
                dir = child;
                reached.push(name);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                // An existing reparse point or a dangling symlink is an error,
                // even when the platform reports a missing target on open.
                match dir.symlink_metadata(name) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Err(error) => return Err(error),
                    Ok(_) => {
                        return Err(invalid(
                            "desktop root contains an ambiguous directory entry",
                        ));
                    }
                }
                missing.push((*name).to_owned());
                missing.extend(rest.map(|name| (*name).to_owned()));
                break;
            }
            Err(error) => return Err(error),
        }
    }
    let mut absolute = reached.clone();
    absolute.extend(&missing);
    Ok(WalkedPath {
        path: absolute,
        dir,
        identity,
        ancestors,
        reached,
        missing,
    })
}

fn disjoint(private: &WalkedPath, vault: &WalkedPath) -> io::Result<()> {
    if (private.missing.is_empty() && vault.ancestors.contains(&private.identity))
        || private.ancestors.contains(&vault.identity)
        || (private.identity.volume == vault.identity.volume && {
            let private = private.backing_path()?;
            let vault = vault.backing_path()?;
            private.starts_with(&vault) || vault.starts_with(&private)
        })
    {
        return Err(invalid(
            "private data and vault directories must be disjoint",
        ));
    }
    Ok(())
}

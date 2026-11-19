use std::{
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};

use super::{
    EntryKind, FileIdentity, FileStamp, VaultDir, conflict, entry_kind, open_child_dir, platform,
    present, read_matching_stamp, roots, split_target, stamp_from_file, sync_dir,
    validate_slot_name,
};

const RECOVERY_DIR: &str = "vault-recovery";

#[derive(Debug)]
pub enum CaptureCleanup {
    Removed,
    /// An absolute path for the operator to inspect. Data may still change if
    /// an editor holds the inode open.
    Retained {
        path: PathBuf,
    },
}

#[derive(Debug)]
pub(super) struct RecoveryRoot {
    data: Dir,
    path: PathBuf,
}

impl RecoveryRoot {
    pub(super) fn new(data: Dir, path: PathBuf) -> Self {
        Self {
            data,
            path: path.join(RECOVERY_DIR),
        }
    }

    fn open(&self, create: bool) -> io::Result<Option<Dir>> {
        let name = OsStr::new(RECOVERY_DIR);
        let dir = if create {
            roots::open_or_create_private_dir(&self.data, name)?
        } else {
            let Some(dir) = present(open_child_dir(&self.data, name))? else {
                return Ok(None);
            };
            platform::require_same_mount(&self.data, &dir)?;
            dir
        };
        platform::verify_private_dir(&dir)?;
        Ok(Some(dir))
    }

    pub(super) fn for_conversion(&self, source: &Dir) -> io::Result<Dir> {
        let recovery = self
            .open(true)?
            .expect("create opens the recovery directory");
        platform::require_same_mount(source, &recovery).map_err(|error| {
            if error.kind() == io::ErrorKind::InvalidInput {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    "conversion requires private recovery on the same mounted filesystem",
                )
            } else {
                error
            }
        })?;
        Ok(recovery)
    }

    /// Exercise the same mounted filesystem using only private probe names.
    /// A marker must never require an unlink-by-name in the shared vault.
    pub(super) fn probe(&self, recovery: &Dir, from: &OsStr, to: &OsStr) -> io::Result<()> {
        let probe = roots::open_or_create_private_dir(recovery, OsStr::new(".probe"))?;
        platform::verify_private_dir(&probe)?;
        platform::probe_conversion(&probe, from, to)?;

        let mut marker = from.to_owned();
        marker.push("-probe");
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        platform::set_stage_options(&mut options);
        let file = probe.open_with(&marker, &options)?;
        file.sync_all()?;
        let expected = stamp_from_file(&file, b"")?;
        drop(file);

        let moved = platform::rename_no_replace_between(&probe, &marker, recovery, &marker);
        let holder = if moved.is_ok() { recovery } else { &probe };
        if read_matching_stamp(holder, &marker, &expected)?.is_none() {
            return Err(conflict("private filesystem probe changed"));
        }
        holder.remove_file(&marker)?;
        sync_dir(&probe)?;
        sync_dir(recovery)?;
        moved
    }
}

enum Parked {
    Missing,
    Shared(PathBuf),
    Private { dir: Dir, path: PathBuf },
}

impl VaultDir {
    /// Report a durable relocation even if the original slot vanished before
    /// the operation journal could acknowledge cleanup.
    pub fn recovered_capture(&self, slot: &Path) -> io::Result<Option<PathBuf>> {
        let (_, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let Some(recovery) = self.recovery.open(false)? else {
            return Ok(None);
        };
        if present(recovery.symlink_metadata(name))?.is_none() {
            return Ok(None);
        }
        platform::verify_parked_capture(&recovery, name)?;
        let source = match present(self.parent(slot)) {
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory
                ) =>
            {
                None
            }
            result => result?,
        };
        sync_recovery(&recovery, source.as_ref().map(|(dir, _)| dir))?;
        Ok(Some(self.recovery.path.join(name)))
    }

    /// Capture the actual slot entry before inspecting or deleting it. A
    /// changed file or a still-open writer leaves the original inode intact.
    pub fn clean_capture(&self, slot: &Path, expected: &FileStamp) -> io::Result<CaptureCleanup> {
        self.clean_capture_after_observation(slot, expected, || {})
    }

    pub(super) fn clean_capture_after_observation(
        &self,
        slot: &Path,
        expected: &FileStamp,
        before_park: impl FnOnce(),
    ) -> io::Result<CaptureCleanup> {
        match self.park(slot, before_park)? {
            Parked::Missing => Ok(CaptureCleanup::Removed),
            Parked::Shared(path) => Ok(CaptureCleanup::Retained { path }),
            Parked::Private { dir, path } => {
                let name = path.file_name().expect("recovery captures have a name");
                let metadata = present(dir.symlink_metadata(name))?;
                if metadata.is_none()
                    || (metadata.is_some_and(|metadata| entry_kind(&metadata) == EntryKind::File)
                        && platform::clean_slot(&dir, name, expected)?)
                {
                    Ok(CaptureCleanup::Removed)
                } else {
                    Ok(CaptureCleanup::Retained { path })
                }
            }
        }
    }

    /// Preserve a displaced package as a coherent tree. If the selected
    /// filesystem has no same-volume relocation, its shared slot stays intact.
    pub fn retain_tree(&self, slot: &Path) -> io::Result<PathBuf> {
        match self.park(slot, || {})? {
            Parked::Shared(path) | Parked::Private { path, .. } => Ok(path),
            Parked::Missing => Err(io::Error::new(
                io::ErrorKind::NotFound,
                "displaced package is absent from both capture locations",
            )),
        }
    }

    pub(crate) fn open_recovered_tree(&self, slot: &Path) -> io::Result<Option<VaultDir>> {
        let (_, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let Some(path) = self.recovered_capture(slot)? else {
            return Ok(None);
        };
        let Some(recovery) = self.recovery.open(false)? else {
            return Ok(None);
        };
        let Some(metadata) = present(recovery.symlink_metadata(name))? else {
            return Ok(None);
        };
        if entry_kind(&metadata) != EntryKind::Directory {
            return Ok(None);
        }
        let Some(dir) = present(open_child_dir(&recovery, name))? else {
            return Ok(None);
        };
        platform::require_same_mount(&recovery, &dir)?;
        VaultDir::new(path, dir, Arc::clone(&self.recovery), true).map(Some)
    }

    pub(crate) fn remove_recovered_empty_tree(
        &self,
        slot: &Path,
        expected: FileIdentity,
    ) -> io::Result<bool> {
        let (_, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let Some(recovery) = self.recovery.open(false)? else {
            return Ok(true);
        };
        let Some(dir) = present(open_child_dir(&recovery, name))? else {
            return Ok(true);
        };
        platform::require_same_mount(&recovery, &dir)?;
        if platform::directory_identity(&dir)? != expected {
            return Ok(false);
        }
        // A live Windows directory handle excludes delete sharing.
        drop(dir);
        match recovery.remove_dir(name) {
            Err(error) if error.kind() == io::ErrorKind::DirectoryNotEmpty => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            result => {
                result?;
                sync_dir(&recovery)?;
                Ok(true)
            }
        }
    }

    fn park(&self, slot: &Path, before_park: impl FnOnce()) -> io::Result<Parked> {
        let (_, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let shared = self.path.join(slot);
        let private = self.recovery.path.join(name);
        let source = present(self.parent(slot))?;

        if let Some(recovery) = self.recovery.open(false)?
            && present(recovery.symlink_metadata(name))?.is_some()
        {
            platform::verify_parked_capture(&recovery, name)?;
            // Replay may have observed the private name before the first
            // operation reached its directory barriers.
            sync_recovery(&recovery, source.as_ref().map(|(dir, _)| dir))?;
            if let Some((parent, _)) = &source
                && present(parent.symlink_metadata(name))?.is_some()
            {
                // Both names survived, or an editor repopulated the shared
                // slot after parking. Do not consume either independent entry.
                return Ok(Parked::Shared(private));
            }
            return Ok(Parked::Private {
                dir: recovery,
                path: private,
            });
        }

        let Some((parent, _)) = source else {
            return Ok(Parked::Missing);
        };
        if present(parent.symlink_metadata(name))?.is_none() {
            return Ok(Parked::Missing);
        }

        let recovery = self
            .recovery
            .open(true)?
            .expect("create opens the recovery directory");
        match platform::require_same_mount(&parent, &recovery) {
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                return Ok(Parked::Shared(shared));
            }
            result => result?,
        }
        before_park();
        match platform::park_private_capture(&parent, name, &recovery, name) {
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists
                        | io::ErrorKind::CrossesDevices
                        | io::ErrorKind::Unsupported
                        | io::ErrorKind::PermissionDenied
                        | io::ErrorKind::InvalidInput
                        | io::ErrorKind::WouldBlock
                ) =>
            {
                Ok(Parked::Shared(shared))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if present(parent.symlink_metadata(name))?.is_some() {
                    Ok(Parked::Shared(shared))
                } else {
                    Ok(Parked::Missing)
                }
            }
            Err(error) => Err(error),
            Ok(()) => {
                sync_recovery(&recovery, Some(&parent))?;
                Ok(Parked::Private {
                    dir: recovery,
                    path: private,
                })
            }
        }
    }
}

fn sync_recovery(recovery: &Dir, source: Option<&Dir>) -> io::Result<()> {
    if let Some(source) = source {
        sync_dir(source)?;
    }
    sync_dir(recovery)
}

use std::{
    ffi::OsStr,
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};

use super::{
    EntryKind, FileIdentity, FileStamp, VaultDir, conflict, entry_kind, open_child_dir, path_error,
    platform, present, read_matching_stamp, roots, split_target, stamp_from_file, sync_dir,
    validate_slot_name,
};

const RECOVERY_DIR: &str = "vault-recovery";

#[derive(Debug)]
pub enum CaptureCleanup {
    Removed,
    /// The exact slot was absent, without proof that its inode was removed.
    Absent,
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

pub(super) enum ParkAction {
    Relocated,
    #[cfg(windows)]
    Disposed,
}

enum Parked {
    Absent,
    #[cfg(windows)]
    Disposed,
    Shared(PathBuf),
    Private {
        dir: Dir,
        path: PathBuf,
    },
}

impl VaultDir {
    /// Report a durable relocation even if the original slot vanished before
    /// the operation journal could acknowledge cleanup.
    pub fn recovered_capture(&self, slot: &Path) -> io::Result<Option<PathBuf>> {
        let (source_path, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let Some(recovery) = self.recovery.open(false)? else {
            return Ok(None);
        };
        if present(recovery.symlink_metadata(name))?.is_none() {
            return Ok(None);
        }
        platform::verify_parked_capture(&recovery, name)?;
        self.probe_capture_source(source_path, |dir| sync_dir(&dir))?;
        sync_dir(&recovery)?;
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
        match self.park(slot, Some(expected), before_park)? {
            Parked::Absent => Ok(CaptureCleanup::Absent),
            #[cfg(windows)]
            Parked::Disposed => Ok(CaptureCleanup::Removed),
            Parked::Shared(path) => Ok(CaptureCleanup::Retained { path }),
            Parked::Private { dir, path } => {
                let name = path.file_name().expect("recovery captures have a name");
                let Some(metadata) = present(dir.symlink_metadata(name))? else {
                    return Ok(CaptureCleanup::Absent);
                };
                if entry_kind(&metadata) == EntryKind::File
                    && platform::clean_slot(&dir, name, expected)?
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
        match self.park(slot, None, || {})? {
            Parked::Shared(path) | Parked::Private { path, .. } => Ok(path),
            _ => Err(io::Error::new(
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

    /// The former location only participates in recovery when the exact old
    /// parent is accessible and still within the held vault mount.
    fn probe_capture_source<T>(
        &self,
        path: &Path,
        probe: impl FnOnce(Dir) -> io::Result<T>,
    ) -> io::Result<Option<T>> {
        match self
            .open_dir_exact(path)
            .and_then(|dir| dir.map(probe).transpose())
        {
            Err(error) if path_error(&error) => Ok(None),
            result => result,
        }
    }

    fn park(
        &self,
        slot: &Path,
        expected: Option<&FileStamp>,
        before_park: impl FnOnce(),
    ) -> io::Result<Parked> {
        let (source_path, name) = split_target(slot)?;
        validate_slot_name(name)?;
        let shared = self.path.join(slot);
        let private = self.recovery.path.join(name);

        if let Some(recovery) = self.recovery.open(false)?
            && present(recovery.symlink_metadata(name))?.is_some()
        {
            platform::verify_parked_capture(&recovery, name)?;
            // The verified private capture survives changes to its former
            // parent. Inspect a shared slot only through that exact directory.
            let shared = self.probe_capture_source(source_path, |parent| {
                let occupied = present(parent.symlink_metadata(name))?.is_some();
                if !occupied {
                    // Replay may have observed the private name before the
                    // first operation reached the source directory barrier.
                    sync_dir(&parent)?;
                }
                Ok(occupied)
            })?;
            sync_dir(&recovery)?;
            if shared == Some(true) {
                // Both names survived, or an editor repopulated the shared
                // slot after parking. Do not consume either independent entry.
                return Ok(Parked::Shared(private));
            }
            return Ok(Parked::Private {
                dir: recovery,
                path: private,
            });
        }

        let source = self.probe_capture_source(source_path, |parent| {
            let occupied = present(parent.symlink_metadata(name))?.is_some();
            #[cfg(windows)]
            if !occupied {
                // Replay can observe an earlier disposition before a directory flush.
                sync_dir(&parent)?;
            }
            Ok((parent, occupied))
        })?;
        let Some((parent, occupied)) = source else {
            // Without a verified private copy or the exact old parent, the
            // shared slot may have moved with its directory.
            return Ok(Parked::Shared(shared));
        };
        if !occupied {
            return Ok(Parked::Absent);
        }

        let recovery = self
            .recovery
            .open(true)?
            .expect("create opens the recovery directory");
        match platform::require_same_mount(&parent, &recovery) {
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => {
                #[cfg(windows)]
                if let Some(expected) = expected
                    && platform::dispose_cross_volume_capture(&parent, name, expected)?
                {
                    sync_dir(&parent)?;
                    return Ok(Parked::Disposed);
                }
                return Ok(Parked::Shared(shared));
            }
            result => result?,
        }
        before_park();
        match platform::park_private_capture(&parent, name, &recovery, name, expected) {
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
                    Ok(Parked::Absent)
                }
            }
            Err(error) => Err(error),
            #[cfg(windows)]
            Ok(ParkAction::Disposed) => {
                sync_dir(&parent)?;
                Ok(Parked::Disposed)
            }
            Ok(ParkAction::Relocated) => {
                sync_dir(&parent)?;
                sync_dir(&recovery)?;
                Ok(Parked::Private {
                    dir: recovery,
                    path: private,
                })
            }
        }
    }
}

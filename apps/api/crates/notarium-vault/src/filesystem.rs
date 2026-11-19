//! Capability-scoped access to a private data root and an optional Markdown vault.
use std::{
    ffi::OsStr,
    fs::{File, TryLockError},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

use cap_fs_ext::{
    DirExt, FollowSymlinks, OpenOptionsFollowExt, OpenOptionsMaybeDirExt, OpenOptionsSyncExt,
};
use cap_std::fs::{Dir, File as CapFile, Metadata, OpenOptions};
use notarium_core::ids::ContentDigest;
use notarium_syntax::unicode::{PortableFilename, lookup_key};
use serde::{Deserialize, Serialize};

mod recovery;
mod roots;
#[cfg(test)]
mod tests;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

pub use recovery::CaptureCleanup;
pub use roots::{ValidatedRoots, platform_data_root};

#[cfg(all(test, windows))]
pub(crate) fn create_owner_only_test_vault(parent: &Path, name: &OsStr) -> io::Result<()> {
    let parent = Dir::open_ambient_dir(parent, cap_std::ambient_authority())?;
    platform::create_private_dir(&parent, name)
}

pub type FsError = io::Error;

/// A problem with one vault name can be reported without detaching the root.
/// Callers validate the private root and its journal separately.
pub(crate) fn path_error(error: &io::Error) -> bool {
    #[cfg(windows)]
    if error.raw_os_error() == Some(windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION as i32)
    {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error() == Some(libc::ELOOP) {
        return true;
    }
    matches!(
        error.kind(),
        io::ErrorKind::InvalidData
            | io::ErrorKind::InvalidInput
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::AlreadyExists
            | io::ErrorKind::NotADirectory
            | io::ErrorKind::NotFound
            | io::ErrorKind::Unsupported
            | io::ErrorKind::WouldBlock
    )
}

const STAGE_PREFIX: &str = ".notarium-stage-";
const DISPLACED_PREFIX: &str = ".notarium-displaced-";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct FileIdentity {
    pub volume: u64,
    pub file: u128,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileStamp {
    pub identity: FileIdentity,
    pub size: u64,
    pub mtime_ns: i128,
    pub digest: ContentDigest,
}

#[derive(Debug)]
pub struct ObservedFile {
    pub stamp: FileStamp,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryKind {
    Directory,
    File,
    Special,
}

#[derive(Debug)]
pub struct VaultEntry {
    pub name: String,
    pub kind: EntryKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PublishMode {
    Regular,
    /// The existing file may contain plaintext. Its bytes must never be copied.
    Conversion,
}

#[derive(Debug)]
pub struct CapturedFile {
    pub path: PathBuf,
    pub stamp: FileStamp,
}

#[derive(Debug)]
#[allow(clippy::large_enum_variant)] // Keep the fixed-size file witnesses inline on the publication path.
pub enum Publication {
    Applied {
        published: FileStamp,
        displaced: Option<CapturedFile>,
    },
    /// An unexpected file was found. Any entry already captured remains in its intent slot.
    Conflict,
}

#[derive(Debug)]
pub enum Withdrawal {
    Captured(CapturedFile),
    Missing,
    Conflict,
}

/// A held root directory. The path identifies an event source, while every I/O
/// operation starts from the capability and rejects links on every component.
#[derive(Debug)]
pub struct VaultDir {
    path: PathBuf,
    dir: Dir,
    identity: FileIdentity,
    recovery: Arc<recovery::RecoveryRoot>,
    private_tree: bool,
}

impl VaultDir {
    fn new(
        path: PathBuf,
        dir: Dir,
        recovery: Arc<recovery::RecoveryRoot>,
        private_tree: bool,
    ) -> io::Result<Self> {
        let identity = platform::directory_identity(&dir)?;
        Ok(Self {
            path,
            dir,
            identity,
            recovery,
            private_tree,
        })
    }

    pub fn path_for_watcher(&self) -> &Path {
        &self.path
    }

    pub fn root_identity(&self) -> FileIdentity {
        self.identity
    }

    /// Checks that the event source still names the held directory. A replaced
    /// root requires explicit reattachment instead of watching a different tree.
    pub fn verify_current(&self) -> io::Result<()> {
        let current = roots::walk_absolute(&self.path)?;
        if !current.missing.is_empty() || current.identity != self.identity {
            return Err(conflict("vault directory was replaced"));
        }
        Ok(())
    }

    pub fn open_dir(&self, path: &Path) -> io::Result<Dir> {
        self.open_or_create_dir(path, false)
    }

    /// Makes observed namespace state durable before replay acknowledges it.
    pub fn sync_parent(&self, path: &Path) -> io::Result<()> {
        let (parent, _) = self.parent(path)?;
        sync_dir(&parent)
    }

    pub fn subdir(&self, path: &Path) -> io::Result<Self> {
        Self::new(
            self.path.join(path),
            self.open_dir(path)?,
            Arc::clone(&self.recovery),
            self.private_tree,
        )
    }

    pub fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.open_or_create_dir(path, true).map(drop)
    }

    /// Create an exclusive directory for a staged package.
    pub fn create_dir(&self, path: &Path) -> io::Result<()> {
        let (parent, name) = self.parent(path)?;
        reject_alias(&parent, name)?;
        parent.create_dir(name)?;
        sync_dir(&parent)
    }

    pub(crate) fn remove_empty_dir(&self, path: &Path) -> io::Result<()> {
        if !self.private_tree {
            return Err(invalid(
                "park the captured package before removing its directories",
            ));
        }
        let (parent, name) = self.parent(path)?;
        // rmdir does not follow links or remove nonempty directories.
        parent.remove_dir(name)?;
        sync_dir(&parent)
    }

    pub fn dir_identity(&self, path: &Path) -> io::Result<Option<FileIdentity>> {
        present(self.open_dir(path))?
            .as_ref()
            .map(platform::directory_identity)
            .transpose()
    }

    pub fn list(&self, path: &Path) -> io::Result<Vec<VaultEntry>> {
        let dir = self.open_dir(path)?;
        let mut entries = Vec::new();
        for entry in dir.entries()? {
            let entry = entry?;
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if PortableFilename::parse(&name).is_err() {
                continue;
            }
            let kind = entry_kind(&dir.symlink_metadata(&name)?);
            entries.push(VaultEntry { name, kind });
        }
        Ok(entries)
    }

    pub fn entry_kind(&self, path: &Path) -> io::Result<Option<EntryKind>> {
        let Some((parent, name)) = present(self.parent(path))? else {
            return Ok(None);
        };
        Ok(present(parent.symlink_metadata(name))?
            .as_ref()
            .map(entry_kind))
    }

    /// Checks the exact spelling of each component. A case or normalization
    /// alias can resolve to an object whose former spelling is now absent.
    pub fn entry_kind_exact(&self, path: &Path) -> io::Result<Option<EntryKind>> {
        let (parent, leaf) = split_target(path)?;
        let Some(dir) = self.open_dir_exact(parent)? else {
            return Ok(None);
        };
        let Some(metadata) = present(dir.symlink_metadata(leaf))? else {
            return Ok(None);
        };
        let kind = entry_kind(&metadata);
        // Never follow a special entry in order to infer its physical name.
        if kind == EntryKind::Special {
            return Ok(Some(kind));
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .maybe_dir(true)
            .nonblock(true)
            .follow(FollowSymlinks::No);
        platform::set_metadata_options(&mut options);
        let file = dir.open_with(leaf, &options)?;
        if kind != entry_kind(&file.metadata()?) {
            return Err(conflict("vault entry kind changed during exact lookup"));
        }
        platform::require_file_mount(&dir, &file)?;
        Ok(platform::file_name_matches(&file, leaf)?.then_some(kind))
    }

    /// Returns only a held directory whose components have the requested spelling.
    fn open_dir_exact(&self, path: &Path) -> io::Result<Option<Dir>> {
        validate_relative_path(path)?;
        let mut dir = self.dir.try_clone()?;
        for component in path.components() {
            let name = relative_component(component)?;
            let Some(metadata) = present(dir.symlink_metadata(name))? else {
                return Ok(None);
            };
            if entry_kind(&metadata) != EntryKind::Directory {
                return Err(invalid("exact path traversal requires a regular directory"));
            }
            let next = dir.open_dir_nofollow(name)?;
            if entry_kind(&next.dir_metadata()?) != EntryKind::Directory {
                return Err(invalid("exact path traversal requires a regular directory"));
            }
            platform::require_same_mount(&dir, &next)?;
            if !platform::directory_name_matches(&next, name)? {
                return Ok(None);
            }
            dir = next;
        }
        Ok(Some(dir))
    }

    pub fn read(&self, path: &Path, max_bytes: usize) -> io::Result<Option<ObservedFile>> {
        let Some((parent, name)) = present(self.parent(path))? else {
            return Ok(None);
        };
        observe(&parent, name, max_bytes)
    }

    pub fn operation_slot(target: &Path, operation_id: &str) -> io::Result<PathBuf> {
        split_target(target)?;
        if !(16..=64).contains(&operation_id.len())
            || !operation_id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid("invalid filesystem operation id"));
        }
        Ok(target.with_file_name(format!("{STAGE_PREFIX}{operation_id}")))
    }

    pub fn displaced_slot(slot: &Path) -> io::Result<PathBuf> {
        let (_, name) = split_target(slot)?;
        let id = name
            .to_str()
            .and_then(|s| s.strip_prefix(STAGE_PREFIX))
            .ok_or_else(|| invalid("invalid staging slot"))?;
        Self::operation_slot(slot, id)?;
        Ok(slot.with_file_name(format!("{DISPLACED_PREFIX}{id}")))
    }

    /// Writes an exclusive sibling. The caller records the intent before calling
    /// this method and retains it until publication and cleanup are acknowledged.
    pub fn stage(&self, target: &Path, slot: &Path, bytes: &[u8]) -> io::Result<FileStamp> {
        let (parent, _, stage_name) = self.publication_names(target, slot)?;
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(true)
            .create_new(true)
            .follow(FollowSymlinks::No);
        platform::set_stage_options(&mut options);
        let mut file = parent.open_with(stage_name, &options)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        let stamp = stamp_from_file(&file, bytes)?;
        drop(file);
        #[cfg(windows)]
        let stamp = {
            // NTFS can defer the visible last-write time until the writer closes.
            let current = observe(&parent, stage_name, bytes.len())?
                .ok_or_else(|| conflict("the staged file disappeared"))?
                .stamp;
            if current.identity != stamp.identity || current.digest != stamp.digest {
                return Err(conflict("the staged file changed"));
            }
            current
        };
        sync_dir(&parent)?;
        Ok(stamp)
    }

    pub fn publish(
        &self,
        target: &Path,
        slot: &Path,
        expected: Option<&FileStamp>,
        staged: &FileStamp,
        mode: PublishMode,
    ) -> io::Result<Publication> {
        self.publish_after_check(target, slot, expected, staged, mode, || {})
    }

    fn publish_after_check(
        &self,
        target: &Path,
        slot: &Path,
        expected: Option<&FileStamp>,
        staged: &FileStamp,
        mode: PublishMode,
        before_namespace_change: impl FnOnce(),
    ) -> io::Result<Publication> {
        let (parent, target_name, stage_name) = self.publication_names(target, slot)?;
        if !matches_stamp(&parent, stage_name, staged)? {
            return Ok(Publication::Conflict);
        }
        let captured_path = match expected {
            None => {
                if present(parent.symlink_metadata(target_name))?.is_some() {
                    return Ok(Publication::Conflict);
                }
                reject_alias(&parent, target_name)?;
                before_namespace_change();
                match platform::rename_no_replace(&parent, stage_name, target_name) {
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        return Ok(Publication::Conflict);
                    }
                    result => result?,
                }
                None
            }
            Some(expected) => {
                if !matches_stamp(&parent, target_name, expected)? {
                    return Ok(Publication::Conflict);
                }
                if mode == PublishMode::Conversion {
                    let recovery = self.recovery.for_conversion(&parent)?;
                    let displaced = Self::displaced_slot(slot)?;
                    let displaced_name = displaced.file_name().expect("validated slot");
                    self.recovery.probe(&recovery, stage_name, displaced_name)?;
                }
                before_namespace_change();
                let displaced = Self::displaced_slot(slot)?;
                let displaced_name = displaced.file_name().expect("validated slot");
                let captured = platform::replace_existing(
                    &parent,
                    stage_name,
                    target_name,
                    displaced_name,
                    expected,
                    staged,
                    mode,
                )?;
                match captured {
                    CapturedAt::Stage => Some(slot.to_owned()),
                    CapturedAt::Displaced => Some(displaced),
                    CapturedAt::Absent => None,
                    CapturedAt::Conflict => return Ok(Publication::Conflict),
                }
            }
        };
        sync_dir(&parent)?;
        let Some(published) = read_matching_stamp(&parent, target_name, staged)? else {
            return Ok(Publication::Conflict);
        };
        let displaced = match (expected, captured_path) {
            (Some(expected), Some(path)) => {
                let name = path.file_name().expect("validated slot");
                let Some(stamp) = read_matching_stamp(&parent, name, expected)? else {
                    return Ok(Publication::Conflict);
                };
                Some(CapturedFile { path, stamp })
            }
            _ => None,
        };
        Ok(Publication::Applied {
            published,
            displaced,
        })
    }

    /// Verify the exact selected volume can perform an atomic conversion before
    /// admitting a local Mint-and-Purge. Probe files contain only marker bytes.
    pub fn probe_conversion(&self, target: &Path, probe_id: &str) -> io::Result<()> {
        let (parent, _) = self.parent(target)?;
        let recovery = self.recovery.for_conversion(&parent)?;
        let slot = Self::operation_slot(target, probe_id)?;
        let displaced = Self::displaced_slot(&slot)?;
        self.recovery.probe(
            &recovery,
            slot.file_name().expect("validated probe slot"),
            displaced.file_name().expect("validated probe slot"),
        )
    }

    /// Capture the actual directory entry before verification. Replaced or
    /// modified captures survive in the slot so reconciliation can preserve them.
    pub fn withdraw(
        &self,
        target: &Path,
        slot: &Path,
        expected: &FileStamp,
    ) -> io::Result<Withdrawal> {
        self.withdraw_after_check(target, slot, expected, || {})
    }

    fn withdraw_after_check(
        &self,
        target: &Path,
        slot: &Path,
        expected: &FileStamp,
        before_namespace_change: impl FnOnce(),
    ) -> io::Result<Withdrawal> {
        let Some((parent, target_name, slot_name)) = present(self.publication_names(target, slot))?
        else {
            return Ok(Withdrawal::Missing);
        };
        if present(parent.symlink_metadata(target_name))?.is_none() {
            return Ok(Withdrawal::Missing);
        }
        if !matches_stamp(&parent, target_name, expected)? {
            return Ok(Withdrawal::Conflict);
        }
        before_namespace_change();
        platform::rename_no_replace(&parent, target_name, slot_name)?;
        sync_dir(&parent)?;
        let Some(stamp) = read_matching_stamp(&parent, slot_name, expected)? else {
            return Ok(Withdrawal::Conflict);
        };
        Ok(Withdrawal::Captured(CapturedFile {
            path: slot.to_owned(),
            stamp,
        }))
    }

    /// Atomically move an entry between sibling names, keeping an occupied target.
    pub fn rename_path_no_replace(&self, source: &Path, target: &Path) -> io::Result<()> {
        let (parent, source_name, target_name) = self.sibling_names(source, target)?;
        reject_alias(&parent, target_name)?;
        if entry_kind(&parent.symlink_metadata(source_name)?) == EntryKind::Special {
            return Err(invalid("cannot publish a link or special entry"));
        }
        platform::rename_no_replace(&parent, source_name, target_name)?;
        sync_dir(&parent)
    }

    /// Atomically exchange two already staged sibling directories.
    pub fn exchange_paths(&self, source: &Path, target: &Path) -> io::Result<()> {
        let (parent, source_name, target_name) = self.sibling_names(source, target)?;
        for name in [source_name, target_name] {
            if entry_kind(&parent.symlink_metadata(name)?) != EntryKind::Directory {
                return Err(invalid("package exchange requires two regular directories"));
            }
        }
        platform::exchange_dirs(&parent, source_name, target_name)?;
        sync_dir(&parent)
    }

    fn open_or_create_dir(&self, path: &Path, create: bool) -> io::Result<Dir> {
        validate_relative_path(path)?;
        let mut dir = self.dir.try_clone()?;
        for name in path.components() {
            let name = relative_component(name)?;
            let next = match open_child_dir(&dir, name) {
                Err(error) if create && error.kind() == io::ErrorKind::NotFound => {
                    reject_alias(&dir, name)?;
                    match dir.create_dir(name) {
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                        result => result?,
                    }
                    sync_dir(&dir)?;
                    open_child_dir(&dir, name)?
                }
                result => result?,
            };
            platform::require_same_mount(&dir, &next)?;
            dir = next;
        }
        Ok(dir)
    }

    fn parent<'p>(&self, path: &'p Path) -> io::Result<(Dir, &'p OsStr)> {
        let (parent, name) = split_target(path)?;
        Ok((self.open_dir(parent)?, name))
    }

    fn sibling_names<'p>(
        &self,
        source: &'p Path,
        target: &'p Path,
    ) -> io::Result<(Dir, &'p OsStr, &'p OsStr)> {
        let (source_parent, source_name) = split_target(source)?;
        let (target_parent, target_name) = split_target(target)?;
        if source_parent != target_parent || logical_name(source_name) == logical_name(target_name)
        {
            return Err(invalid("publication requires distinct sibling names"));
        }
        Ok((self.open_dir(source_parent)?, source_name, target_name))
    }

    fn publication_names<'p>(
        &self,
        target: &'p Path,
        stage: &'p Path,
    ) -> io::Result<(Dir, &'p OsStr, &'p OsStr)> {
        let (parent, target_name, stage_name) = self.sibling_names(target, stage)?;
        let stage_id = stage_name
            .to_str()
            .and_then(|name| name.strip_prefix(STAGE_PREFIX))
            .ok_or_else(|| invalid("invalid staging slot"))?;
        Self::operation_slot(target, stage_id)?;
        if is_internal_name(target_name) {
            return Err(invalid("cannot publish to an operation slot"));
        }
        Ok((parent, target_name, stage_name))
    }
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Native implementations return different capture locations.
enum CapturedAt {
    Stage,
    Displaced,
    Absent,
    Conflict,
}

pub fn is_internal_name(name: &OsStr) -> bool {
    name.to_str().is_some_and(|s| {
        let key = lookup_key(s);
        key.starts_with(STAGE_PREFIX) || key.starts_with(DISPLACED_PREFIX)
    })
}

pub fn sync_dir(dir: &Dir) -> io::Result<()> {
    platform::sync_dir(dir)
}

fn validate_slot_name(name: &OsStr) -> io::Result<()> {
    let id = name
        .to_str()
        .and_then(|s| {
            s.strip_prefix(STAGE_PREFIX)
                .or_else(|| s.strip_prefix(DISPLACED_PREFIX))
        })
        .ok_or_else(|| invalid("cleanup requires a reserved operation slot"))?;
    VaultDir::operation_slot(Path::new("witness"), id)?;
    Ok(())
}

fn split_target(path: &Path) -> io::Result<(&Path, &OsStr)> {
    validate_relative_path(path)?;
    let name = path.file_name().ok_or_else(|| invalid("empty file path"))?;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("invalid file parent"))?;
    Ok((parent, name))
}

fn validate_relative_path(path: &Path) -> io::Result<()> {
    let raw = path
        .to_str()
        .ok_or_else(|| invalid("vault filenames must be UTF-8"))?;
    if raw.is_empty() {
        return Ok(());
    }
    #[cfg(windows)]
    let parts = raw.split(['/', '\\']);
    #[cfg(unix)]
    let parts = raw.split('/');
    for name in parts {
        PortableFilename::parse(name).map_err(|_| invalid("invalid portable filename"))?;
    }
    Ok(())
}

fn relative_component(component: Component<'_>) -> io::Result<&OsStr> {
    if let Component::Normal(name) = component {
        Ok(name)
    } else {
        Err(invalid(
            "vault paths must be relative and cannot traverse parents",
        ))
    }
}

fn open_child_dir(parent: &Dir, name: &OsStr) -> io::Result<Dir> {
    match platform::open_child_dir(parent, name) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            if present(parent.symlink_metadata(name))?.is_some() {
                return Err(invalid("vault path contains an ambiguous directory entry"));
            }
            Err(error)
        }
        result => result,
    }
}

fn entry_kind(metadata: &Metadata) -> EntryKind {
    if platform::is_link(metadata) {
        EntryKind::Special
    } else if metadata.is_dir() {
        EntryKind::Directory
    } else if metadata.is_file() {
        EntryKind::File
    } else {
        EntryKind::Special
    }
}

fn present<T>(result: io::Result<T>) -> io::Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn conflict(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::AlreadyExists, message)
}

fn logical_name(name: &OsStr) -> String {
    lookup_key(name.to_str().expect("validated UTF-8 name"))
}

fn reject_alias(parent: &Dir, name: &OsStr) -> io::Result<()> {
    let key = logical_name(name);
    for entry in parent.entries()? {
        let actual = entry?.file_name();
        if actual != name
            && actual
                .to_str()
                .is_some_and(|actual| lookup_key(actual) == key)
        {
            return Err(conflict("case or Unicode filename collision"));
        }
    }
    Ok(())
}

fn observe(parent: &Dir, name: &OsStr, max_bytes: usize) -> io::Result<Option<ObservedFile>> {
    let Some(before) = present(parent.symlink_metadata(name))? else {
        return Ok(None);
    };
    if entry_kind(&before) != EntryKind::File {
        return Err(invalid("vault entry is not a regular file"));
    }
    let mut options = OpenOptions::new();
    options.read(true).nonblock(true).follow(FollowSymlinks::No);
    platform::set_read_options(&mut options);
    let Some(mut file) = present(parent.open_with(name, &options))? else {
        return Err(conflict("vault file disappeared while reading"));
    };
    platform::require_file_mount(parent, &file)?;
    platform::verify_name(&file, name)?;
    let observed = observe_open(&mut file, max_bytes)?;
    if !platform::still_names(parent, name, &file)? {
        return Err(conflict("vault file changed while reading"));
    }
    Ok(Some(observed))
}

fn observe_open(file: &mut CapFile, max_bytes: usize) -> io::Result<ObservedFile> {
    let metadata = checked_file_metadata(file)?;
    let limit = u64::try_from(max_bytes).unwrap_or(u64::MAX);
    if metadata.len() > limit {
        return Err(invalid("vault entry exceeds its byte budget"));
    }
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1)).read_to_end(&mut bytes)?;
    if bytes.len() > max_bytes || bytes.len() as u64 != metadata.len() {
        return Err(conflict("vault file size changed while reading"));
    }
    let stamp = stamp_from_file(file, &bytes)?;
    if !platform::same_read_metadata(&metadata, &checked_file_metadata(file)?)? {
        return Err(conflict("vault file metadata changed while reading"));
    }
    Ok(ObservedFile { stamp, bytes })
}

fn checked_file_metadata(file: &CapFile) -> io::Result<Metadata> {
    let metadata = file.metadata()?;
    if entry_kind(&metadata) != EntryKind::File || platform::link_count(file, &metadata)? != 1 {
        return Err(invalid("links and special files cannot be imported"));
    }
    Ok(metadata)
}

fn stamp_from_file(file: &CapFile, bytes: &[u8]) -> io::Result<FileStamp> {
    let metadata = checked_file_metadata(file)?;
    let unix_epoch = cap_std::time::SystemTime::from_std(std::time::UNIX_EPOCH);
    let modified = metadata.modified()?;
    let mtime_ns = match modified.duration_since(unix_epoch) {
        Ok(duration) => duration.as_nanos() as i128,
        Err(error) => -(error.duration().as_nanos() as i128),
    };
    Ok(FileStamp {
        identity: platform::file_identity(file, &metadata)?,
        size: metadata.len(),
        mtime_ns,
        digest: ContentDigest::from_bytes(*blake3::hash(bytes).as_bytes()),
    })
}

fn read_matching_stamp(
    parent: &Dir,
    name: &OsStr,
    stamp: &FileStamp,
) -> io::Result<Option<FileStamp>> {
    let max =
        usize::try_from(stamp.size).map_err(|_| invalid("file size exceeds platform limit"))?;
    match observe(parent, name, max) {
        Ok(Some(observed)) if same_file_content(&observed.stamp, stamp) => Ok(Some(observed.stamp)),
        Ok(_) => Ok(None),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::InvalidInput | io::ErrorKind::AlreadyExists
            ) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

pub(crate) fn same_file_content(left: &FileStamp, right: &FileStamp) -> bool {
    left.identity == right.identity && left.size == right.size && left.digest == right.digest
}

fn matches_stamp(parent: &Dir, name: &OsStr, stamp: &FileStamp) -> io::Result<bool> {
    Ok(read_matching_stamp(parent, name, stamp)?.is_some())
}

fn private_file_entry(dir: &Dir, name: &OsStr) -> io::Result<Option<CapFile>> {
    let Some(metadata) = present(dir.symlink_metadata(name))? else {
        return Ok(None);
    };
    if entry_kind(&metadata) != EntryKind::File {
        return Err(invalid(
            "private data paths require single-link regular files",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true).nonblock(true).follow(FollowSymlinks::No);
    platform::set_private_metadata_options(&mut options);
    let Some(file) = present(dir.open_with(name, &options))? else {
        // SQLite can remove a regular WAL or SHM between the two reads.
        return Ok(None);
    };
    checked_file_metadata(&file)?;
    platform::require_file_mount(dir, &file)?;
    platform::verify_name(&file, name)?;
    platform::verify_private_file(&file)?;
    Ok(Some(file))
}

fn acquire_lock(dir: &Dir, name: &OsStr) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .create_new(true)
        .nonblock(true)
        .follow(FollowSymlinks::No);
    platform::set_lock_options(&mut options);
    let file = if let Some(existing) = private_file_entry(dir, name)? {
        platform::open_existing_lock(dir, name, &existing)?
    } else {
        match dir.open_with(name, &options) {
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let existing = private_file_entry(dir, name)?.ok_or_else(|| {
                    conflict("sidecar lock disappeared after another process created it")
                })?;
                platform::open_existing_lock(dir, name, &existing)?
            }
            result => result?,
        }
    };
    checked_file_metadata(&file)?;
    platform::verify_private_file(&file)?;
    let file = file.into_std();
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "the desktop data root is already locked",
        )),
        Err(TryLockError::Error(error)) => Err(error),
    }
}

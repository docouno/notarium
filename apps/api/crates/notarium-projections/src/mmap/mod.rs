//! Private immutable checkpoint I/O. A persisted writer record is mandatory on reopen.

mod format;
mod raw;

use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    num::NonZeroUsize,
    path::{Component, Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex, Weak,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

use croaring::{Bitmap, BitmapView};
use memmap2::Mmap;
#[cfg(any(test, feature = "test-support"))]
use notarium_core::model::Lifecycle;
use notarium_core::{
    DomainError, DomainResult,
    ids::{FolderId, NoteId, ProjectionGeneration, SpaceSeq},
    model::HistoryScope,
};

use format::{Directory, u16_at, u32_at, u64_at};
pub(crate) use format::{FORMAT_VERSION, SectionKind, WriteSection};

#[cfg(any(test, feature = "test-support"))]
use crate::index::model::folder_lifecycle;
use crate::{
    derived::PostgresCacheOwner,
    index::{IndexError, NoteSortHeader},
};

const PENDING: u8 = 0;
const LIVE: u8 = 1;
const RETIRED: u8 = 2;
const REPAIR_PENDING: u8 = 3;
const INVALIDATED: u8 = 4;
const PURGED: u8 = 5;
const PENDING_PURGED: u8 = 6;
const UNLINKED: u8 = 7;

// Both retirement and publication change immutable names. Serialize the
// witness-and-unlink step with the new publication within this cache owner.
static FILE_MUTATIONS: Mutex<()> = Mutex::new(());

fn file_mutations() -> std::sync::MutexGuard<'static, ()> {
    FILE_MUTATIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// The native view format is tied to both libraries and its platform ABI.
pub(crate) fn platform_abi() -> String {
    format!(
        "fast-index/{};croaring/2.9.0;CRoaring/5.5.5;frozen;le;{};{};{}",
        format::FORMAT_VERSION,
        std::env::consts::ARCH,
        std::env::consts::OS,
        usize::BITS,
    )
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IndexIdentity {
    pub generation: ProjectionGeneration,
    pub scope: HistoryScope,
    pub seq: SpaceSeq,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedCheckpoint {
    pub size: u64,
    pub digest: [u8; 32],
    pub abi: String,
}

#[derive(Clone, Debug)]
pub struct BaseIndexHandle(Arc<FileLease>);

#[derive(Debug)]
struct FileLease {
    path: PathBuf,
    identity: IndexIdentity,
    record: TrustedCheckpoint,
    state: AtomicU8,
    witness: Option<FileWitness>,
    // The last local reader or pending writer may outlive both runtimes.
    _cache_owner: Option<Arc<PostgresCacheOwner>>,
}

struct RegisteredCheckpoint {
    identity: IndexIdentity,
    witness: Option<FileWitness>,
    lease: Weak<FileLease>,
    pool: Weak<MmapPoolInner>,
    retired: bool,
}

// These weak edges survive engine replacement while a snapshot actually owns
// the file. They hold no mapping, file lease, or generation lease open.
static CHECKPOINTS: Mutex<BTreeMap<PathBuf, Vec<RegisteredCheckpoint>>> =
    Mutex::new(BTreeMap::new());

impl FileLease {
    fn registered_file(&self, entry: &RegisteredCheckpoint) -> bool {
        self.witness.is_some() && self.identity == entry.identity && self.witness == entry.witness
    }

    fn mark_retired(&self) {
        let _ = self
            .state
            .compare_exchange(LIVE, RETIRED, Ordering::AcqRel, Ordering::Acquire);
    }

    fn unlink_original(&self) -> io::Result<()> {
        let Some(expected) = &self.witness else {
            return Ok(());
        };
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if metadata.is_file() && FileWitness::from_metadata(&metadata) == *expected {
            #[cfg(not(unix))]
            {
                // Portable timestamps and size are weaker than a vnode ID.
                // Verify the exact writer digest before unlinking on these hosts.
                let mut source = File::open(&self.path)?;
                let mut hasher = blake3::Hasher::new();
                io::copy(&mut source, &mut hasher)?;
                if hasher.finalize().as_bytes() != &self.record.digest {
                    return Ok(());
                }
                drop(source);
            }
            remove_readonly(&self.path)?;
            if let Some(directory) = self.path.parent() {
                sync_directory(directory)?;
            }
        }
        Ok(())
    }
}

impl Drop for FileLease {
    fn drop(&mut self) {
        let Some(directory) = self.path.parent() else {
            return;
        };
        // Keep the registry locked through unlink so a late registration
        // either joins the retired vnode or can no longer open its name.
        let _mutation = file_mutations();
        let mut checkpoints = CHECKPOINTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let state = self.state.load(Ordering::Acquire);
        let mut reclaim = matches!(state, PENDING | RETIRED | PURGED | PENDING_PURGED);
        let mut held = false;
        if let Some(entries) = checkpoints.get_mut(directory) {
            entries.retain(|entry| {
                let ours = std::ptr::eq(entry.lease.as_ptr(), self);
                reclaim |= ours && entry.retired && !matches!(state, INVALIDATED | UNLINKED);
                !ours
            });
            held = entries
                .iter()
                .any(|entry| self.registered_file(entry) && entry.lease.strong_count() != 0);
            if entries.is_empty() {
                checkpoints.remove(directory);
            }
        }
        if reclaim && !held {
            let _ = self.unlink_original();
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct FileWitness {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(unix)]
    changed_at: (i64, i64),
    #[cfg(not(unix))]
    created: Option<std::time::SystemTime>,
    #[cfg(not(unix))]
    modified: Option<std::time::SystemTime>,
    #[cfg(not(unix))]
    size: u64,
}

impl FileWitness {
    fn from_metadata(metadata: &fs::Metadata) -> Self {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            Self {
                device: metadata.dev(),
                inode: metadata.ino(),
                changed_at: (metadata.ctime(), metadata.ctime_nsec()),
            }
        }
        #[cfg(not(unix))]
        {
            Self {
                created: metadata.created().ok(),
                modified: metadata.modified().ok(),
                size: metadata.len(),
            }
        }
    }

    #[cfg(unix)]
    fn same_vnode(&self, other: &Self) -> bool {
        (self.device, self.inode) == (other.device, other.inode)
    }
}

impl BaseIndexHandle {
    pub(crate) fn register_for_erasure(&self, pool: &MmapPool) {
        let Some(directory) = self.0.path.parent() else {
            return;
        };
        let lease = Arc::downgrade(&self.0);
        let pool = Arc::downgrade(&pool.0);
        let mut checkpoints = CHECKPOINTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entries = checkpoints.entry(directory.to_owned()).or_default();
        // The marker outlives weak upgrades while a last holder is in Drop.
        let retired = self.0.state.load(Ordering::Acquire) == RETIRED
            || entries
                .iter()
                .any(|entry| entry.retired && self.0.registered_file(entry));
        if retired {
            self.0.mark_retired();
        }
        if !entries
            .iter()
            .any(|entry| entry.lease.ptr_eq(&lease) && entry.pool.ptr_eq(&pool))
        {
            entries.push(RegisteredCheckpoint {
                identity: self.0.identity.clone(),
                witness: self.0.witness.clone(),
                lease,
                pool,
                retired,
            });
        }
    }

    pub(crate) fn purge_registered(
        directory: &Path,
        generation: ProjectionGeneration,
        scope: &HistoryScope,
        through: SpaceSeq,
    ) -> Result<(), IndexError> {
        let directory = absolute(directory)?;
        for (lease, pool) in registered_leases(&directory) {
            if lease.identity.generation == generation
                && lease.identity.scope == *scope
                && lease.identity.seq < through
            {
                let pending = lease.state.compare_exchange(
                    PENDING,
                    PENDING_PURGED,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
                if matches!(pending, Ok(_) | Err(PENDING_PURGED)) {
                    // No cut could have opened this writer's file. A purge
                    // must unlink it before returning even if the writer
                    // still holds the pending handle.
                    let _mutation = file_mutations();
                    lease.unlink_original()?;
                    lease.state.store(UNLINKED, Ordering::Release);
                } else {
                    lease.state.fetch_max(PURGED, Ordering::AcqRel);
                    if let Some(pool) = pool.upgrade() {
                        MmapPool(pool).evict(&Self(Arc::clone(&lease)));
                    }
                    // On Unix, unlinking an already-mapped file is safe and immediately
                    // removes purged bytes from the directory namespace before purge returns.
                    #[cfg(unix)]
                    {
                        let _mutation = file_mutations();
                        if lease.state.load(Ordering::Acquire) != UNLINKED {
                            lease.unlink_original()?;
                            lease.state.store(UNLINKED, Ordering::Release);
                        }
                    }
                    #[cfg(not(unix))]
                    {
                        let _mutation = file_mutations();
                        if lease.state.load(Ordering::Acquire) != UNLINKED
                            && lease.unlink_original().is_ok()
                        {
                            lease.state.store(UNLINKED, Ordering::Release);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Rebind a record read from the trusted local writer registry. The record
    /// must never be reconstructed by digesting the candidate file.
    pub(crate) fn restore(
        path: &Path,
        identity: IndexIdentity,
        record: TrustedCheckpoint,
        cache_owner: Option<Arc<PostgresCacheOwner>>,
    ) -> Result<Self, IndexError> {
        Self::new_lease(path, identity, record, LIVE, cache_owner)
    }

    fn new_lease(
        path: &Path,
        identity: IndexIdentity,
        record: TrustedCheckpoint,
        state: u8,
        cache_owner: Option<Arc<PostgresCacheOwner>>,
    ) -> Result<Self, IndexError> {
        let path = absolute(path)?;
        if record.abi != platform_abi() || cfg!(target_endian = "big") {
            return Err(IndexError::Untrusted(
                "checkpoint ABI differs from this reader",
            ));
        }
        let witness = fs::symlink_metadata(&path)
            .ok()
            .filter(fs::Metadata::is_file)
            .map(|metadata| FileWitness::from_metadata(&metadata));
        if state == PENDING && witness.is_none() {
            return Err(IndexError::Untrusted(
                "published checkpoint lacks a file witness",
            ));
        }
        Ok(Self(Arc::new(FileLease {
            path,
            identity,
            record,
            state: AtomicU8::new(state),
            witness,
            _cache_owner: cache_owner,
        })))
    }

    pub(crate) fn finish_publication(&self) -> Result<(), IndexError> {
        self.0
            .state
            .compare_exchange(PENDING, LIVE, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ())
            .map_err(|_| IndexError::Untrusted("pending checkpoint was revoked"))
    }

    pub(crate) fn same_writer_file(&self, other: &Self) -> bool {
        self.0.state.load(Ordering::Acquire) == LIVE
            && self.0.path == other.0.path
            && self.0.identity == other.0.identity
            && self.0.record == other.0.record
            && self.0.witness.is_some()
            && self.0.witness == other.0.witness
    }

    pub fn identity(&self) -> &IndexIdentity {
        &self.0.identity
    }

    pub fn path(&self) -> &Path {
        &self.0.path
    }

    pub(crate) fn shares_lease(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }

    /// Close old opens without touching the pathname. The worker separately
    /// checks the durable registry and may be able to reopen the same file.
    pub(crate) fn request_repair(&self) -> bool {
        self.0.state.fetch_max(REPAIR_PENDING, Ordering::AcqRel) < INVALIDATED
    }

    pub(crate) fn repair_pending(&self) -> bool {
        self.0.state.load(Ordering::Acquire) == REPAIR_PENDING
    }

    #[cfg(feature = "test-support")]
    pub fn trusted_record(&self) -> &TrustedCheckpoint {
        &self.0.record
    }

    pub fn open(&self, pool: &MmapPool) -> Result<Arc<MappedFastIndex>, IndexError> {
        self.check_open()?;
        let map = pool.open(self)?;
        self.check_open()?;
        Ok(map)
    }

    pub(crate) fn try_open_resident(
        &self,
        pool: &MmapPool,
    ) -> Result<Option<Arc<MappedFastIndex>>, IndexError> {
        self.check_open()?;
        Ok(pool.try_get_resident(self))
    }

    fn check_open(&self) -> Result<(), IndexError> {
        let state = self.0.state.load(Ordering::Acquire);
        if state == PENDING || state >= REPAIR_PENDING {
            return Err(IndexError::Untrusted(
                "checkpoint lease has been invalidated",
            ));
        }
        Ok(())
    }

    /// Existing retained handles may continue to read. Once their last mapping
    /// and logical lease are gone this checkpoint file can be unlinked.
    pub fn retire(&self, pool: &MmapPool) {
        let peers: Vec<_> = {
            let mut checkpoints = CHECKPOINTS
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            self.0.mark_retired();
            self.path()
                .parent()
                .and_then(|directory| checkpoints.get_mut(directory))
                .into_iter()
                .flatten()
                .filter(|entry| self.0.registered_file(entry))
                .filter_map(|entry| {
                    entry.retired = true;
                    let lease = entry.lease.upgrade()?;
                    lease.mark_retired();
                    Some((lease, entry.pool.clone()))
                })
                .collect()
        };
        pool.evict(self);
        for (lease, pool) in peers {
            if let Some(pool) = pool.upgrade() {
                MmapPool(pool).evict(&Self(lease));
            }
        }
    }

    /// Revoke an erased or history-replaced checkpoint before reusing its name.
    /// Outstanding readers must independently honor the canonical revocation.
    /// A failed unlink leaves admissions closed and can be retried by the writer.
    pub(crate) fn invalidate(&self, pool: &MmapPool) -> Result<(), IndexError> {
        self.0.state.fetch_max(INVALIDATED, Ordering::AcqRel);
        pool.evict(self);
        let _mutation = file_mutations();
        if self.0.state.load(Ordering::Acquire) == UNLINKED {
            return Ok(());
        }
        self.0.unlink_original()?;
        // This old lease must never remove a later file at the same path,
        // including on retry or when the final old mapping is dropped.
        self.0.state.store(UNLINKED, Ordering::Release);
        Ok(())
    }

    /// Remove an orphan or invalid checkpoint discovered during startup. Only
    /// call before admitting readers, while the coordinator owns the directory.
    pub(crate) fn discard_unleased(path: &Path) -> Result<(), IndexError> {
        let _mutation = file_mutations();
        let path = absolute(path)?;
        discard_path(&path)
    }

    /// Clear the reserved filename for a head independently proven unpublished
    /// under the exact durable Space writer guard. The old bytes can belong to
    /// a previous history or have a damaged header.
    pub(crate) fn discard_unpublished_name(path: &Path, seq: SpaceSeq) -> Result<bool, IndexError> {
        let _mutation = file_mutations();
        let path = absolute(path)?;
        let name = format!("fast_index_{}.mmap", seq.get());
        let directory = path
            .parent()
            .filter(|_| path.file_name() == Some(std::ffi::OsStr::new(&name)))
            .ok_or(IndexError::Untrusted("invalid unpublished checkpoint path"))?;
        match check_private_directory(directory) {
            Ok(()) => {}
            Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(true);
            }
            Err(error) => return Err(error),
        }
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error.into()),
        };
        let vnode = FileWitness::from_metadata(&metadata);
        let checkpoints = CHECKPOINTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if checkpoints.get(directory).is_some_and(|entries| {
            entries.iter().any(|entry| {
                if entry.lease.strong_count() == 0 {
                    return false;
                }
                #[cfg(unix)]
                {
                    entry.witness.as_ref().is_some_and(|w| w.same_vnode(&vnode))
                }
                #[cfg(not(unix))]
                {
                    // Conservatively protect every lease at this reserved name
                    // on hosts without an inode witness.
                    entry.identity.seq == seq || entry.witness.as_ref() == Some(&vnode)
                }
            })
        }) {
            return Ok(false);
        }
        match fs::symlink_metadata(&path) {
            Ok(current) if current.is_file() && FileWitness::from_metadata(&current) == vnode => {
                discard_path(&path)?;
                Ok(true)
            }
            Ok(_) => Ok(false),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(error) => Err(error.into()),
        }
    }

    /// Retire an unleased file only when its immutable header still matches
    /// the specified cut. A restored history can reuse the exact pathname.
    /// Returns whether that name is now clear for its writer.
    pub(crate) fn discard_unleased_matching(
        path: &Path,
        identity: &IndexIdentity,
    ) -> Result<bool, IndexError> {
        let _mutation = file_mutations();
        let path = absolute(path)?;
        let checkpoints = CHECKPOINTS
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if path
            .parent()
            .and_then(|directory| checkpoints.get(directory))
            .is_some_and(|entries| {
                entries
                    .iter()
                    .any(|entry| entry.identity == *identity && entry.lease.strong_count() != 0)
            })
        {
            // A previous runtime may still have a snapshot on this cache.
            // Its marked lease, rather than this sweep, owns the unlink.
            return Ok(false);
        }
        discard_matching_header(&path, |header, size| {
            format::matches_header(header, identity, size)
        })
    }
}

fn is_lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub(crate) fn discard_abandoned_temp(
    path: &Path,
    generation: ProjectionGeneration,
    scope: &HistoryScope,
    through: SpaceSeq,
) -> Result<(), IndexError> {
    let name = path.file_name().and_then(|name| name.to_str());
    let is_temp = name
        .and_then(|name| name.strip_prefix(".fast-index-"))
        .and_then(|name| name.strip_suffix(".tmp"))
        .is_some_and(|nonce| is_lower_hex(nonce, 32));
    let is_deleted = name
        .and_then(|name| name.strip_prefix(".deleted-"))
        .is_some_and(|nonce| is_lower_hex(nonce, 16));
    if !is_temp && !is_deleted {
        return Ok(());
    }
    let _mutation = file_mutations();
    let path = absolute(path)?;
    // A cancelled sweep can outlive the runtime maintenance guard. The
    // durable floor rejects a publisher for this history below `through`.
    // Other histories and later cuts cannot satisfy the header witness.
    discard_matching_header(&path, |header, _| {
        format::matches_temp_header(header, generation, scope, through)
    })?;
    Ok(())
}

// Callers serialize immutable name mutations while checking and unlinking.
fn discard_matching_header(
    path: &Path,
    belongs_to_cut: impl FnOnce(&[u8; format::HEADER_SIZE], u64) -> bool,
) -> Result<bool, IndexError> {
    let directory = path
        .parent()
        .ok_or(IndexError::Untrusted("missing checkpoint directory"))?;
    match check_private_directory(directory) {
        Ok(()) => {}
        Err(IndexError::Io(error)) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error),
    }
    let original = match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => FileWitness::from_metadata(&metadata),
        Ok(_) => return Ok(false),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    let mut file = match open_readonly(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file() || FileWitness::from_metadata(&metadata) != original {
        return Ok(false);
    }
    let mut header = [0; format::HEADER_SIZE];
    match file.read_exact(&mut header) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(false),
        Err(error) => return Err(error.into()),
    }
    drop(file);
    if !belongs_to_cut(&header, metadata.len()) {
        return Ok(false);
    }
    let current = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(error.into()),
    };
    if current.is_file() && FileWitness::from_metadata(&current) == original {
        discard_path(path)?;
        return Ok(true);
    }
    Ok(false)
}

fn registered_leases(directory: &Path) -> Vec<(Arc<FileLease>, Weak<MmapPoolInner>)> {
    let checkpoints = CHECKPOINTS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Drop strong references only after the registry lock has been released.
    checkpoints
        .get(directory)
        .into_iter()
        .flatten()
        .filter_map(|entry| Some((entry.lease.upgrade()?, entry.pool.clone())))
        .collect()
}

fn discard_path(path: &Path) -> Result<(), IndexError> {
    let directory = path
        .parent()
        .ok_or(IndexError::Untrusted("missing checkpoint directory"))?;
    match check_private_directory(directory) {
        Ok(()) => {}
        Err(IndexError::Io(err)) if err.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(err),
    }
    match remove_readonly(path) {
        Ok(()) => sync_directory(directory)?,
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => return Err(err.into()),
    }
    Ok(())
}

pub(crate) struct PreparedCheckpoint {
    identity: IndexIdentity,
    bytes: Vec<u8>,
    record: TrustedCheckpoint,
}

pub(crate) fn prepare(
    identity: IndexIdentity,
    nodes: u32,
    folders: u32,
    active: u32,
    sections: Vec<WriteSection>,
) -> Result<PreparedCheckpoint, IndexError> {
    if cfg!(target_endian = "big") {
        return Err(IndexError::Untrusted(
            "checkpoint requires little-endian Frozen ABI",
        ));
    }
    let bytes = format::encode(&identity, nodes, folders, active, &sections)?;
    let record = TrustedCheckpoint {
        size: bytes.len() as u64,
        digest: *blake3::hash(&bytes).as_bytes(),
        abi: platform_abi(),
    };
    Ok(PreparedCheckpoint {
        identity,
        bytes,
        record,
    })
}

impl PreparedCheckpoint {
    pub(crate) fn identity(&self) -> &IndexIdentity {
        &self.identity
    }
}

pub(crate) fn publish(
    prepared: PreparedCheckpoint,
    path: &Path,
    pending_pool: Option<&MmapPool>,
    cache_owner: Option<Arc<PostgresCacheOwner>>,
) -> Result<(BaseIndexHandle, TrustedCheckpoint), IndexError> {
    let PreparedCheckpoint {
        identity,
        bytes,
        record,
    } = prepared;
    let path = absolute(path)?;
    let directory = path
        .parent()
        .ok_or(IndexError::Untrusted("missing checkpoint directory"))?;
    create_private_directory(directory)?;
    check_private_directory(directory)?;
    let mut temp_suffix = [0; 16];
    getrandom::fill(&mut temp_suffix).map_err(|err| io::Error::other(err.to_string()))?;
    let temp_path = directory.join(format!(".fast-index-{}.tmp", hex::encode(temp_suffix)));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp_path)?;
    let pending = PendingFile(Some(&temp_path));
    file.write_all(&bytes)?;
    #[cfg(unix)]
    make_readonly(&file)?;
    file.sync_all()?;
    drop(file);

    let _mutation = file_mutations();
    // Publishing with a hard link is atomic and fails if the immutable name
    // already exists. Both names are in the same directory and filesystem.
    fs::hard_link(&temp_path, &path)?;
    let published = PendingFile(Some(&path));
    // Do not register a lease while a second name can keep its bytes alive.
    pending.remove()?;
    #[cfg(not(unix))]
    {
        // Windows won't unlink a temporary hard link while the readonly
        // attribute is set. Finish publication before returning a writer record.
        let mut permissions = fs::metadata(&path)?.permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&path, permissions)?;
    }
    sync_directory(directory)?;
    let state = if pending_pool.is_some() {
        PENDING
    } else {
        LIVE
    };
    let result =
        BaseIndexHandle::new_lease(&path, identity, record.clone(), state, cache_owner.clone())?;
    if let Some(pool) = pending_pool {
        result.register_for_erasure(pool);
    }
    published.commit();
    Ok((result, record))
}

struct PendingFile<'a>(Option<&'a Path>);

impl PendingFile<'_> {
    fn remove(mut self) -> io::Result<()> {
        if let Some(path) = self.0 {
            remove_readonly(path)?;
        }
        self.0 = None;
        Ok(())
    }

    fn commit(mut self) {
        self.0 = None;
    }
}

impl Drop for PendingFile<'_> {
    fn drop(&mut self) {
        if let Some(path) = self.0 {
            let _ = remove_readonly(path);
        }
    }
}

#[cfg(unix)]
fn make_readonly(file: &File) -> io::Result<()> {
    let mut mode = file.metadata()?.permissions();
    mode.set_readonly(true);
    file.set_permissions(mode)
}

fn absolute(path: &Path) -> Result<PathBuf, IndexError> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(IndexError::Untrusted(
            "checkpoint path escapes its directory",
        ));
    }
    Ok(path)
}

#[cfg(unix)]
fn open_readonly(path: &Path) -> io::Result<File> {
    use rustix::fs::{Mode, OFlags, open};

    open(
        path,
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(io::Error::from)
}

#[cfg(windows)]
fn open_readonly(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    const SHARE_READ: u32 = 0x0000_0001;
    const SHARE_DELETE: u32 = 0x0000_0004;
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    OpenOptions::new()
        .read(true)
        .share_mode(SHARE_READ | SHARE_DELETE)
        .custom_flags(OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
fn open_readonly(path: &Path) -> io::Result<File> {
    File::open(path)
}

fn create_private_directory(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn check_private_directory(path: &Path) -> Result<(), IndexError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() {
        return Err(IndexError::Untrusted("checkpoint directory is aliased"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        for ancestor in path.ancestors().filter(|value| value.has_root()) {
            if fs::symlink_metadata(ancestor)?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(IndexError::Untrusted("checkpoint directory is aliased"));
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        if metadata.uid() != rustix::process::geteuid().as_raw() {
            return Err(IndexError::Untrusted(
                "checkpoint directory has a different owner",
            ));
        }
        if fs::canonicalize(path)? != path {
            return Err(IndexError::Untrusted("checkpoint directory is aliased"));
        }
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(IndexError::Untrusted("checkpoint directory is not private"));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    // Directory handles are not directly flushable on all supported Desktop
    // filesystems. An orphaned/missing file always requires a local rebuild.
    Ok(())
}

fn remove_readonly(path: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        let metadata = fs::symlink_metadata(path)?;
        if metadata.is_file() && metadata.permissions().readonly() {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            fs::set_permissions(path, permissions)?;
        }
        // Rename out of the canonical filename first so FILE_SHARE_DELETE
        // readers do not keep the target filename in delete-pending state.
        if let Some(parent) = path.parent() {
            let mut nonce = [0u8; 8];
            let _ = getrandom::fill(&mut nonce);
            let tombstone = parent.join(format!(".deleted-{}", hex::encode(nonce)));
            if fs::rename(path, &tombstone).is_ok() {
                if let Err(err) = fs::remove_file(&tombstone) {
                    let _ = fs::rename(&tombstone, path);
                    return Err(err);
                }
                return Ok(());
            }
        }
    }
    fs::remove_file(path)
}

pub(crate) fn id_hash(id: &str) -> u32 {
    let digest = blake3::hash(id.as_bytes());
    u32::from_le_bytes(digest.as_bytes()[..4].try_into().expect("four bytes"))
}

/// LRU bounds resident maps. A request can additionally pin an evicted map
/// until it completes. Logical leases do not hold a reference to a map.
#[derive(Clone)]
pub struct MmapPool(Arc<MmapPoolInner>);

struct OpenFlight {
    done: Mutex<bool>,
    ready: Condvar,
}

struct MmapPoolInner {
    capacity: NonZeroUsize,
    maps: Mutex<VecDeque<Arc<MappedFastIndex>>>,
    opening: Mutex<HashMap<usize, Arc<OpenFlight>>>,
    live: Arc<AtomicUsize>,
}

impl MmapPool {
    pub fn new(capacity: NonZeroUsize) -> Self {
        Self(Arc::new(MmapPoolInner {
            capacity,
            maps: Mutex::new(VecDeque::new()),
            opening: Mutex::new(HashMap::new()),
            live: Arc::new(AtomicUsize::new(0)),
        }))
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn live_mmap_count(&self) -> usize {
        self.0.live.load(Ordering::Acquire)
    }

    pub fn evict(&self, handle: &BaseIndexHandle) {
        let evicted = {
            let mut maps = self.lock_maps();
            maps.iter()
                .position(|index| Arc::ptr_eq(&index.lease, &handle.0))
                .and_then(|position| maps.remove(position))
        };
        drop(evicted);
    }

    pub(crate) fn evict_generation(&self, generation: ProjectionGeneration) {
        let evicted: Vec<_> = {
            let mut maps = self.lock_maps();
            let mut removed = Vec::new();
            let mut idx = 0;
            while idx < maps.len() {
                if maps[idx].identity().generation == generation {
                    if let Some(item) = maps.remove(idx) {
                        removed.push(item);
                    }
                } else {
                    idx += 1;
                }
            }
            removed
        };
        drop(evicted);
    }

    pub(crate) fn try_get_resident(
        &self,
        handle: &BaseIndexHandle,
    ) -> Option<Arc<MappedFastIndex>> {
        take_resident(&mut self.lock_maps(), handle)
    }

    fn open(&self, handle: &BaseIndexHandle) -> Result<Arc<MappedFastIndex>, IndexError> {
        let key = Arc::as_ptr(&handle.0) as usize;
        loop {
            if let Some(resident) = take_resident(&mut self.lock_maps(), handle) {
                return Ok(resident);
            }
            // Single-flight deduplication: concurrent cold readers for the same
            // handle wait for the first opener instead of hashing simultaneously.
            let existing = {
                let mut opening = self
                    .0
                    .opening
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if let Some(flight) = opening.get(&key) {
                    Some(Arc::clone(flight))
                } else {
                    opening.insert(
                        key,
                        Arc::new(OpenFlight {
                            done: Mutex::new(false),
                            ready: Condvar::new(),
                        }),
                    );
                    None
                }
            };
            if let Some(flight) = existing {
                let mut done = flight
                    .done
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                while !*done {
                    done = flight
                        .ready
                        .wait(done)
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                }
                if let Some(resident) = take_resident(&mut self.lock_maps(), handle) {
                    return Ok(resident);
                }
                // First opener failed or handle was no longer LIVE; fall through to retry.
                continue;
            }

            struct FlightGuard<'a> {
                pool: &'a MmapPoolInner,
                key: usize,
            }
            impl Drop for FlightGuard<'_> {
                fn drop(&mut self) {
                    let flight = self
                        .pool
                        .opening
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .remove(&self.key);
                    if let Some(flight) = flight {
                        let mut done = flight
                            .done
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        *done = true;
                        flight.ready.notify_all();
                    }
                }
            }
            let _guard = FlightGuard { pool: &self.0, key };

            // Authentication faults in checkpoint pages. Keep that I/O out of the
            // shared LRU lock so a cold Space does not delay unrelated hot Spaces.
            let index = Arc::new(MappedFastIndex::open(
                Arc::clone(&handle.0),
                Arc::clone(&self.0.live),
            )?);
            let evicted = {
                let mut maps = self.lock_maps();
                if let Some(resident) = take_resident(&mut maps, handle) {
                    return Ok(resident);
                }
                let mut evicted = None;
                if handle.0.state.load(Ordering::Acquire) == LIVE {
                    if let Some(position) = maps.iter().position(|older| {
                        older.identity().scope.space_id == index.identity().scope.space_id
                    }) {
                        evicted = maps.remove(position);
                    } else if maps.len() == self.0.capacity.get() {
                        evicted = maps.pop_front();
                    }
                    maps.push_back(Arc::clone(&index));
                }
                evicted
            };
            drop(evicted);
            return Ok(index);
        }
    }

    fn lock_maps(&self) -> std::sync::MutexGuard<'_, VecDeque<Arc<MappedFastIndex>>> {
        self.0
            .maps
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn take_resident(
    maps: &mut VecDeque<Arc<MappedFastIndex>>,
    handle: &BaseIndexHandle,
) -> Option<Arc<MappedFastIndex>> {
    let position = maps
        .iter()
        .position(|map| Arc::ptr_eq(&map.lease, &handle.0))?;
    let index = maps.remove(position)?;
    maps.push_back(Arc::clone(&index));
    Some(index)
}

pub struct MappedFastIndex {
    // Drop the map before releasing the file lease, including on Windows.
    map: Mmap,
    // Mandatory Windows sharing denies writable handles until the map drops.
    #[cfg(windows)]
    _immutable_file: File,
    directory: Directory,
    live: Arc<AtomicUsize>,
    lease: Arc<FileLease>,
}

impl Drop for MappedFastIndex {
    fn drop(&mut self) {
        self.live.fetch_sub(1, Ordering::AcqRel);
    }
}

impl MappedFastIndex {
    fn open(lease: Arc<FileLease>, live: Arc<AtomicUsize>) -> Result<Self, IndexError> {
        let parent = lease
            .path
            .parent()
            .ok_or(IndexError::Untrusted("missing checkpoint directory"))?;
        check_private_directory(parent)?;
        let witness = fs::symlink_metadata(&lease.path)?;
        if !witness.is_file() || !witness.permissions().readonly() {
            return Err(IndexError::Untrusted(
                "checkpoint is not an immutable regular file",
            ));
        }
        let file = open_readonly(&lease.path)?;
        let meta = file.metadata()?;
        if !meta.is_file()
            || !meta.permissions().readonly()
            || meta.len() != lease.record.size
            || meta.len() < (format::HEADER_SIZE + format::DIGEST_SIZE) as u64
        {
            return Err(IndexError::Untrusted(
                "checkpoint size or file type differs from registry",
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if (meta.dev(), meta.ino()) != (witness.dev(), witness.ino()) {
                return Err(IndexError::Untrusted(
                    "checkpoint file changed during opening",
                ));
            }
            if meta.uid() != rustix::process::geteuid().as_raw() {
                return Err(IndexError::Untrusted(
                    "checkpoint file has a different owner",
                ));
            }
        }
        let map = raw::map_immutable(&file)?;
        let directory = format::decode(
            &map,
            &lease.identity,
            lease.record.size,
            &lease.record.digest,
        )?;
        live.fetch_add(1, Ordering::AcqRel);
        Ok(Self {
            map,
            #[cfg(windows)]
            _immutable_file: file,
            directory,
            live,
            lease,
        })
    }

    pub fn identity(&self) -> &IndexIdentity {
        &self.lease.identity
    }

    pub fn node_count(&self) -> u32 {
        self.directory.node_count
    }

    pub fn folder_count(&self) -> u32 {
        self.directory.folder_count
    }

    #[cfg(feature = "test-support")]
    pub fn active_count(&self) -> u32 {
        self.directory.active_count
    }

    fn section(&self, kind: SectionKind) -> &[u8] {
        self.directory.section(&self.map, kind)
    }

    pub fn note_id_str(&self, index: u32) -> Option<&str> {
        self.id_slot(SectionKind::NoteIdentities, self.node_count(), index)
            .map(|(id, _)| id)
    }

    pub fn note_id(&self, index: u32) -> DomainResult<NoteId> {
        let stored = self
            .note_id_str(index)
            .ok_or(DomainError::ResourceNotFound)?;
        NoteId::parse(stored)
    }

    pub fn folder_id_str(&self, index: u32) -> Option<&str> {
        self.id_slot(SectionKind::FolderIdentities, self.folder_count(), index)
            .map(|(id, _)| id)
    }

    #[cfg(any(test, feature = "test-support"))]
    pub fn folder_lifecycle(&self, index: u32) -> Option<Lifecycle> {
        self.id_slot(SectionKind::FolderIdentities, self.folder_count(), index)
            .and_then(|(_, state)| folder_lifecycle(state))
    }

    fn id_slot(&self, kind: SectionKind, count: u32, index: u32) -> Option<(&str, u8)> {
        if index >= count {
            return None;
        }
        let section = self.section(kind);
        let at = index as usize * 8;
        let slot = section.get(at..at + 8)?;
        let offset = u32_at(slot, 0)? as usize;
        let len = usize::from(u16_at(slot, 4)?);
        if len == 0 {
            return None;
        }
        let start = (count as usize).checked_mul(8)?.checked_add(offset)?;
        let id = std::str::from_utf8(section.get(start..start.checked_add(len)?)?).ok()?;
        Some((id, slot[6]))
    }

    pub fn lookup(&self, id: &NoteId) -> Option<u32> {
        self.id_lookup(SectionKind::NoteLookup, id.as_str(), |slot| {
            self.note_id_str(slot)
        })
    }

    pub fn dense_folder_id(&self, id: &FolderId) -> Option<u32> {
        self.id_lookup(SectionKind::FolderLookup, id.as_str(), |slot| {
            self.folder_id_str(slot)
        })
    }

    fn id_lookup<'a>(
        &'a self,
        kind: SectionKind,
        id: &str,
        read: impl Fn(u32) -> Option<&'a str>,
    ) -> Option<u32> {
        let bytes = self.section(kind);
        let slots = self.directory.count(kind) as usize;
        let mask = slots - 1;
        let hash = id_hash(id);
        let first = hash as usize & mask;
        for distance in 0..slots {
            let slot = (first + distance) & mask;
            let offset = slot * 8;
            let occupant_hash = u32_at(bytes, offset)?;
            let occupant = u32_at(bytes, offset + 4)?;
            if occupant == u32::MAX
                || slot.wrapping_sub(occupant_hash as usize & mask) & mask < distance
            {
                break;
            }
            if occupant_hash == hash && read(occupant) == Some(id) {
                return Some(occupant);
            }
        }
        None
    }

    fn note_header_bytes(&self, index: u32) -> Option<&[u8]> {
        if index >= self.node_count() {
            return None;
        }
        let start = index as usize * NoteSortHeader::WIDTH;
        self.section(SectionKind::SortHeaders)
            .get(start..start + NoteSortHeader::WIDTH)
    }

    pub(crate) fn updated_at_prefix(&self, index: u32) -> Option<(i64, u16)> {
        NoteSortHeader::decode_updated_prefix(self.note_header_bytes(index)?)
    }

    pub fn note_header(&self, index: u32) -> Option<NoteSortHeader> {
        NoteSortHeader::decode(self.note_header_bytes(index)?, || {
            let records = self
                .section(SectionKind::TimestampRemainder)
                .as_chunks::<8>()
                .0;
            let at = records
                .binary_search_by_key(&index, |row| u32_at(row, 0).expect("fixed row"))
                .ok()?;
            u16_at(&records[at], 4)
        })
    }

    fn catalog(&self, bsi: bool) -> format::Catalog<'_> {
        use SectionKind::*;
        let (dir, arena) = if bsi {
            (BsiCatalog, BsiPlanes)
        } else {
            (BitmapCatalog, BitmapArena)
        };
        self.directory.catalog(&self.map, dir, arena)
    }

    pub(crate) fn has_posting(&self, key: &[u8], bsi: bool) -> bool {
        self.catalog(bsi).contains(key)
    }

    pub(crate) fn bitmap_view(
        &self,
        key: &[u8],
        bsi: bool,
    ) -> Result<Option<BitmapView<'_>>, IndexError> {
        let catalog = self.catalog(bsi);
        let Some(token) = catalog.frozen(key) else {
            return Ok(None);
        };
        raw::frozen(token)
            .map(Some)
            .ok_or(IndexError::Untrusted("invalid Frozen bitmap"))
    }

    pub(crate) fn bitmap(&self, key: &[u8], bsi: bool) -> Result<Bitmap, IndexError> {
        Ok(self
            .bitmap_view(key, bsi)?
            .map_or_else(Bitmap::new, |view| view.to_bitmap()))
    }

    pub(crate) fn visit_posting_keys(
        &self,
        prefix: &[u8],
        visit: impl FnMut(&[u8]) -> bool,
    ) -> bool {
        self.catalog(false).with_prefix(prefix).all(visit)
    }

    pub(crate) fn exact_integer(&self, key: &[u8], index: u32) -> Option<i128> {
        let records = self
            .directory
            .exact_catalog(&self.map)
            .value(key)?
            .as_chunks::<20>()
            .0;
        let at = records
            .binary_search_by_key(&index, |row| u32_at(row, 0).expect("fixed row"))
            .ok()?;
        Some(i128::from_le_bytes(records[at][4..].try_into().ok()?))
    }

    pub(crate) fn neighbors(&self, incoming: bool, index: u32) -> &[[u8; 4]] {
        if index >= self.node_count() {
            return &[];
        }
        let kind = if incoming {
            SectionKind::GraphIncoming
        } else {
            SectionKind::GraphOutgoing
        };
        let (offsets, targets) = self
            .section(kind)
            .split_at((self.node_count() as usize + 1) * 8);
        let offset = index as usize * 8;
        let start = u64_at(offsets, offset).expect("validated adjacency offset") as usize;
        let end = u64_at(offsets, offset + 8).expect("validated adjacency offset") as usize;
        targets
            .as_chunks::<4>()
            .0
            .get(start..end)
            .unwrap_or_default()
    }

    pub fn cluster_bytes(&self, node: u32) -> Option<[u8; 16]> {
        let (assignments, ids) = self
            .section(SectionKind::Clusters)
            .split_at(self.node_count() as usize * 4);
        let slot = u32_at(assignments, (node as usize).checked_mul(4)?)?;
        ids.as_chunks::<16>().0.get(slot as usize).copied()
    }
}

#[cfg(test)]
mod tests;

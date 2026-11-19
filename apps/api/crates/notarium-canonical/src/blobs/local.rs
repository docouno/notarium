use std::{
    collections::{BTreeMap, HashMap},
    io::{self, Read, Write},
    sync::{
        Arc, Mutex, RwLock as StdRwLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

use cap_fs_ext::{
    DirExt, FollowSymlinks, MetadataExt, OpenOptionsFollowExt, OpenOptionsMaybeDirExt,
    OpenOptionsSyncExt,
};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};

use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{ContentDigest, SpaceId},
};
use tokio::sync::{Mutex as AsyncMutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::{blobs::decode_zstd_verified, codec::internal_not_committed};

/// Shared per-`(SpaceId, ContentDigest)` guard held from Phase 1 local staging through SQL commit/rollback.
#[derive(Debug)]
pub struct LocalSharedGuard {
    _guard: OwnedRwLockReadGuard<()>,
}

/// Exclusive per-`(SpaceId, ContentDigest)` guard held during local blob retirement unlink.
#[derive(Debug)]
pub struct LocalExclusiveGuard {
    _guard: OwnedRwLockWriteGuard<()>,
}

#[derive(Clone)]
pub struct DeferredLocalStaging {
    local: Arc<LocalBlobStore>,
    space_id: SpaceId,
    digest: ContentDigest,
    raw_size: u64,
    compressed_frame: Arc<[u8]>,
    presynced: Option<Arc<Mutex<Option<PreparedLocalStagingEntry>>>>,
}

impl std::fmt::Debug for DeferredLocalStaging {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredLocalStaging")
            .field("space_id", &self.space_id)
            .field("digest", &self.digest)
            .field("raw_size", &self.raw_size)
            .finish()
    }
}

impl DeferredLocalStaging {
    pub fn new(
        local: Arc<LocalBlobStore>,
        space_id: SpaceId,
        digest: ContentDigest,
        raw_size: u64,
        compressed_frame: Arc<[u8]>,
    ) -> Self {
        Self {
            local,
            space_id,
            digest,
            raw_size,
            compressed_frame,
            presynced: None,
        }
    }

    pub fn new_presynced(
        local: Arc<LocalBlobStore>,
        space_id: SpaceId,
        digest: ContentDigest,
        raw_size: u64,
        compressed_frame: Arc<[u8]>,
        entry: PreparedLocalStagingEntry,
    ) -> Self {
        Self {
            local,
            space_id,
            digest,
            raw_size,
            compressed_frame,
            presynced: Some(Arc::new(Mutex::new(Some(entry)))),
        }
    }

    pub fn take_presynced(&self) -> Option<PreparedLocalStagingEntry> {
        self.presynced
            .as_ref()
            .and_then(|m| m.lock().unwrap_or_else(|p| p.into_inner()).take())
    }

    pub fn dedup_unique(mut items: Vec<Self>) -> Vec<Self> {
        items.sort_unstable_by(|a, b| {
            a.space_id
                .as_str()
                .cmp(b.space_id.as_str())
                .then_with(|| a.digest.cmp(&b.digest))
        });
        items.dedup_by(|a, b| a.space_id == b.space_id && a.digest == b.digest);
        items
    }

    pub fn open_and_write_chunk(
        items: Vec<Self>,
    ) -> Result<Vec<PreparedLocalStagingEntry>, PortError> {
        let mut entries = Vec::with_capacity(items.len());
        for item in items {
            let space_id_str = item.space_id.as_str().to_owned();
            let space_id = item.space_id;
            let digest = item.digest;
            let (item_dirs, temp_file) = item.local.stage_physical_file_deferred(
                &space_id,
                digest,
                item.raw_size,
                &item.compressed_frame,
            )?;
            entries.push(PreparedLocalStagingEntry {
                space_id,
                space_id_str,
                digest,
                item_dirs,
                temp_file,
            });
        }
        Ok(entries)
    }

    /// Opens and writes `.staging/*.part` files for all unique `(SpaceId, ContentDigest)` entries
    /// in the batch on a blocking thread right before Wave A1 (`sync_data_only`), preventing Phase-1
    /// `O_CREAT` syscalls from running on Tokio async threads or dirtying ext4's journal mid-barrier.
    pub fn open_and_write_entries(
        items: Vec<Self>,
    ) -> Result<Vec<PreparedLocalStagingEntry>, PortError> {
        Self::open_and_write_chunk(Self::dedup_unique(items))
    }
}

pub struct PreparedLocalStagingEntry {
    pub space_id: SpaceId,
    pub space_id_str: String,
    pub digest: ContentDigest,
    pub item_dirs: PendingDirSyncs,
    pub temp_file: Option<DeferredLocalTempFile>,
}

#[derive(Debug)]
struct PinnedDir {
    dir: Dir,
    identity: (u64, u64),
}

impl PinnedDir {
    fn new(dir: Dir) -> io::Result<Self> {
        // open_dir_nofollow can return O_PATH on Linux. Open "." through that
        // descriptor to get an fsync-capable handle to the very same directory.
        let file = dir.open_with(".", OpenOptions::new().read(true).maybe_dir(true))?;
        let metadata = file.metadata()?;
        Ok(Self {
            identity: (metadata.dev(), metadata.ino()),
            dir: Dir::from_std_file(file.into_std()),
        })
    }
    fn sync(&self) -> io::Result<()> {
        #[cfg(windows)]
        {
            // FlushFileBuffers requires GENERIC_WRITE. Reopen the pinned
            // directory through its own handle with backup semantics.
            self.dir
                .open_with(".", OpenOptions::new().write(true).maybe_dir(true))?
                .sync_all()
        }
        #[cfg(not(windows))]
        {
            self.dir.try_clone()?.into_std_file().sync_all()
        }
    }
}

pub struct DeferredLocalTempFile {
    staging_dir: Arc<PinnedDir>,
    shard_dir: Arc<PinnedDir>,
    free_slots: Arc<Mutex<Vec<u32>>>,
    slot: Option<u32>,
    tmp_file: Option<cap_std::fs::File>,
    tmp_name: String,
    file_name: String,
    published: bool,
}

impl std::fmt::Debug for DeferredLocalTempFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeferredLocalTempFile")
            .field("file_name", &self.file_name)
            .field("published", &self.published)
            .finish()
    }
}

impl DeferredLocalTempFile {
    /// Wave A1: flushes blob data durability (`fdatasync` / `F_FULLFSYNC`) without mutating
    /// directory entries so concurrent `sync_data_only` calls coalesce into one journal commit.
    pub fn sync_data_only(&mut self) -> Result<(), PortError> {
        if let Some(file) = self.tmp_file.take() {
            sync_blob_file(&file)?;
            drop(file);
        }
        Ok(())
    }

    /// Wave A2: atomically renames the already-synced `.staging/*.part` file into `blobs/`.
    pub fn rename_into_place(mut self) -> Result<(), PortError> {
        if let Some(file) = self.tmp_file.take() {
            sync_blob_file(&file)?;
            drop(file);
        }
        self.staging_dir
            .dir
            .rename(&self.tmp_name, &self.shard_dir.dir, &self.file_name)
            .map_err(|err| internal_not_committed("local_cas_rename", err.to_string()))?;
        self.published = true;
        Ok(())
    }
}

impl Drop for DeferredLocalTempFile {
    fn drop(&mut self) {
        self.tmp_file.take();
        if !self.published {
            let _ = self.staging_dir.dir.remove_file(&self.tmp_name);
        }
        if let Some(slot) = self.slot.take() {
            self.free_slots
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(slot);
        }
    }
}

/// Directory barriers retain the exact parent object changed by the publication.
/// The path-only variant remains available for explicit callers.
#[derive(Clone, Debug, Default)]
pub struct PendingDirSyncs {
    dirs: BTreeMap<DirectoryKey, Option<Arc<PinnedDir>>>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct DirectoryKey {
    path: String,
    identity: Option<(u64, u64)>,
}

pub(super) struct DirectoryBarrier {
    key: DirectoryKey,
    pinned: Option<Arc<PinnedDir>>,
}

impl DirectoryBarrier {
    pub(super) fn sync(self, store: &LocalBlobStore) -> Result<(), PortError> {
        if let Some(pinned) = self.pinned {
            let current = store.resolve_dir(&self.key.path, false)?;
            if current.identity != pinned.identity {
                return Err(internal_not_committed(
                    "local_cas_directory_replaced",
                    &self.key.path,
                ));
            }
            pinned
                .sync()
                .map_err(|e| internal_not_committed("local_cas_sync_dir", e.to_string()))
        } else {
            store.flush_single_dir(&self.key.path)
        }
    }
}

impl PartialEq for PendingDirSyncs {
    fn eq(&self, other: &Self) -> bool {
        self.dirs.keys().eq(other.dirs.keys())
    }
}
impl Eq for PendingDirSyncs {}

impl PendingDirSyncs {
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty()
    }
    pub fn insert(&mut self, rel_dir: impl Into<String>) {
        self.dirs.insert(
            DirectoryKey {
                path: rel_dir.into(),
                identity: None,
            },
            None,
        );
    }
    fn pin(&mut self, rel: &str, dir: &Arc<PinnedDir>) {
        self.dirs.insert(
            DirectoryKey {
                path: rel.to_owned(),
                identity: Some(dir.identity),
            },
            Some(Arc::clone(dir)),
        );
    }
    pub fn merge(&mut self, other: &Self) {
        self.dirs.extend(other.dirs.clone());
    }
    pub fn len(&self) -> usize {
        self.dirs.len()
    }
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.dirs.keys().map(|key| key.path.as_str())
    }
    pub fn without(&self, already_synced: &Self) -> Self {
        Self {
            dirs: self
                .dirs
                .iter()
                .filter(|(key, _)| !already_synced.dirs.contains_key(*key))
                .map(|(key, dir)| (key.clone(), dir.clone()))
                .collect(),
        }
    }
    pub(super) fn barriers(&self) -> impl Iterator<Item = DirectoryBarrier> + '_ {
        self.dirs.iter().map(|(key, pinned)| DirectoryBarrier {
            key: key.clone(),
            pinned: pinned.clone(),
        })
    }
}

type DigestGuardKey = (SpaceId, ContentDigest);
type DigestGuardTable = HashMap<DigestGuardKey, Weak<RwLock<()>>>;

const GUARD_SHARDS: usize = 64;
const MAX_CACHED_SPACE_DIRS: usize = 264;

fn is_fd_exhausted_io_err(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(23 | 24))
}

/// Capability-confined local content-addressed Zstd blob store (`LocalZstdV1`).
pub struct LocalBlobStore {
    root_dir: Arc<PinnedDir>,
    free_staging_slots: Arc<Mutex<Vec<u32>>>,
    guards: Box<[AsyncMutex<DigestGuardTable>; GUARD_SHARDS]>,
    dir_cache: StdRwLock<HashMap<String, Arc<PinnedDir>>>,
    next_staging_seq: AtomicU64,
}

impl std::fmt::Debug for LocalBlobStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalBlobStore").finish_non_exhaustive()
    }
}

impl LocalBlobStore {
    pub fn open(data_root: &DataRoot) -> Result<Self, PortError> {
        std::fs::create_dir_all(data_root.root())
            .map_err(|err| internal_not_committed("local_cas_open_root_mkdir", err.to_string()))?;
        let root_dir = Dir::open_ambient_dir(data_root.root(), ambient_authority())
            .map_err(|err| internal_not_committed("local_cas_open_ambient_dir", err.to_string()))?;

        let guards = Box::new(std::array::from_fn(|_| AsyncMutex::new(HashMap::new())));
        let store = Self {
            root_dir: Arc::new(
                PinnedDir::new(root_dir)
                    .map_err(|e| internal_not_committed("local_cas_root", e.to_string()))?,
            ),
            free_staging_slots: Arc::new(Mutex::new(Vec::with_capacity(64))),
            guards,
            dir_cache: StdRwLock::new(HashMap::new()),
            next_staging_seq: AtomicU64::new(0),
        };

        let staging = store.resolve_dir("blobs/.staging", true)?;
        let sdir = &staging.dir;
        // Sweep any orphan temp files left in `blobs/.staging` by an unrecovered crash so dentry slots stay compact.
        for entry in sdir
            .entries()
            .map_err(|err| internal_not_committed("local_cas_read_staging", err.to_string()))?
        {
            let entry = entry
                .map_err(|err| internal_not_committed("local_cas_read_staging", err.to_string()))?;
            let kind = entry
                .file_type()
                .map_err(|err| internal_not_committed("local_cas_stat_staging", err.to_string()))?;
            if kind.is_file() {
                sdir.remove_file(entry.file_name()).map_err(|err| {
                    internal_not_committed("local_cas_clean_staging", err.to_string())
                })?;
            }
        }
        staging
            .sync()
            .map_err(|e| internal_not_committed("local_cas_sync_staging", e.to_string()))?;
        let quarantine = store.resolve_dir("blobs/.quarantine", true)?;
        // Older staging diagnostics lacked a Space identifier. They have no live references.
        for entry in quarantine
            .dir
            .entries()
            .map_err(|err| internal_not_committed("local_cas_read_quarantine", err.to_string()))?
        {
            let entry = entry.map_err(|err| {
                internal_not_committed("local_cas_read_quarantine", err.to_string())
            })?;
            let name = entry.file_name();
            let Some((hex, suffix)) = name
                .to_str()
                .and_then(|s| s.strip_suffix(".corrupt"))
                .and_then(|s| s.split_once("-quar_"))
            else {
                continue;
            };
            if hex.len() == 64
                && suffix.len() == 32
                && hex
                    .bytes()
                    .chain(suffix.bytes())
                    .all(|b| b.is_ascii_hexdigit())
            {
                quarantine.dir.remove_file(&name).map_err(|err| {
                    internal_not_committed("local_cas_clean_legacy_quarantine", err.to_string())
                })?;
            }
        }
        quarantine
            .sync()
            .map_err(|e| internal_not_committed("local_cas_sync_quarantine", e.to_string()))?;

        Ok(store)
    }

    fn alloc_staging_slot(&self) -> u32 {
        if let Some(reused) = self
            .free_staging_slots
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .pop()
        {
            return reused;
        }
        self.next_staging_seq.fetch_add(1, Ordering::Relaxed) as u32
    }

    pub fn clear_cached_dirs(&self) {
        self.dir_cache
            .write()
            .unwrap_or_else(|p| p.into_inner())
            .clear();
    }

    fn evict_some_cached_dirs(&self, count: usize) {
        let mut w = self.dir_cache.write().unwrap_or_else(|p| p.into_inner());
        let keys: Vec<String> = w.keys().take(count).cloned().collect();
        for k in keys {
            w.remove(&k);
        }
    }

    // Verify each namespace entry against its already-open parent. Cached handles
    // are reusable only while that parent still names the same non-link inode.
    fn walk_dir(&self, rel: &str, create: bool) -> io::Result<Arc<PinnedDir>> {
        let mut parent = self.root_dir.clone();
        let mut path = String::new();
        if rel.is_empty() {
            return Ok(parent);
        }
        for component in rel.split('/') {
            if !safe_component(component) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "invalid CAS path component",
                ));
            }
            if !path.is_empty() {
                path.push('/');
            }
            path.push_str(component);
            let cached = self
                .dir_cache
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .get(&path)
                .cloned();
            if let Some(cached) = cached {
                #[cfg(not(windows))]
                let metadata = parent.dir.symlink_metadata(component);
                #[cfg(windows)]
                let metadata = parent
                    .dir
                    .open_dir_nofollow(component)
                    .and_then(|dir| dir.dir_metadata());
                match metadata {
                    Ok(md) if !md.is_dir() => {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "not a CAS directory",
                        ));
                    }
                    Ok(md) if (md.dev(), md.ino()) == cached.identity => {
                        parent = cached;
                        continue;
                    }
                    Ok(_) => (),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e),
                }
            }
            let child = match parent.dir.open_dir_nofollow(component) {
                Ok(child) => child,
                Err(e) if create && e.kind() == io::ErrorKind::NotFound => {
                    match parent.dir.create_dir(component) {
                        Ok(()) => (),
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                        Err(e) => return Err(e),
                    }
                    parent.dir.open_dir_nofollow(component)?
                }
                Err(e) => return Err(e),
            };
            let child = Arc::new(PinnedDir::new(child)?);
            if create {
                // A competing creator may have installed this name but not synced it.
                parent.sync()?;
                let mut cache = self.dir_cache.write().unwrap_or_else(|p| p.into_inner());
                if cache.len() >= MAX_CACHED_SPACE_DIRS {
                    let victims: Vec<_> = cache.keys().take(64).cloned().collect();
                    for key in victims {
                        cache.remove(&key);
                    }
                }
                cache.insert(path.clone(), child.clone());
            }
            parent = child;
        }
        Ok(parent)
    }
    fn open_dir(&self, rel: &str, create: bool) -> io::Result<Arc<PinnedDir>> {
        match self.walk_dir(rel, create) {
            Err(e) if is_fd_exhausted_io_err(&e) => {
                self.evict_some_cached_dirs(128);
                self.walk_dir(rel, create)
            }
            result => result,
        }
    }
    fn resolve_dir(&self, rel: &str, create: bool) -> Result<Arc<PinnedDir>, PortError> {
        self.open_dir(rel, create)
            .map_err(|e| internal_not_committed("local_cas_open_dir", format!("{rel}: {e}")))
    }

    fn guard_shard(&self, digest: ContentDigest) -> &AsyncMutex<DigestGuardTable> {
        &self.guards[usize::from(digest.as_bytes()[0]) & (GUARD_SHARDS - 1)]
    }

    fn digest_lock(
        map: &mut DigestGuardTable,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Arc<RwLock<()>> {
        let key = (space_id.clone(), digest);
        if let Some(existing) = map.get(&key).and_then(Weak::upgrade) {
            return existing;
        }
        // Opportunistically prune dead weak entries when shard grows.
        if map.len() >= 512 {
            map.retain(|_, weak| weak.strong_count() > 0);
        }
        let arc = Arc::new(RwLock::new(()));
        map.insert(key, Arc::downgrade(&arc));
        arc
    }

    async fn wait_for_digest_lock(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Arc<RwLock<()>> {
        let mut map = self.guard_shard(digest).lock().await;
        Self::digest_lock(&mut map, space_id, digest)
    }

    pub async fn acquire_shared_guard(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Arc<LocalSharedGuard> {
        let lock = self.wait_for_digest_lock(space_id, digest).await;
        let guard = lock.read_owned().await;
        Arc::new(LocalSharedGuard { _guard: guard })
    }

    pub fn try_acquire_shared_guard(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Option<Arc<LocalSharedGuard>> {
        // A contended registry must also defer the read until the SQL snapshot closes.
        let lock = {
            let mut map = self.guard_shard(digest).try_lock().ok()?;
            Self::digest_lock(&mut map, space_id, digest)
        };
        let guard = lock.try_read_owned().ok()?;
        Some(Arc::new(LocalSharedGuard { _guard: guard }))
    }

    /// Acquires shared guards in canonical ascending `ContentDigest` order to forbid lock-order cycles.
    pub async fn acquire_shared_guards_sorted(
        &self,
        space_id: &SpaceId,
        digests: &[ContentDigest],
    ) -> HashMap<ContentDigest, Arc<LocalSharedGuard>> {
        let mut sorted: Vec<ContentDigest> = digests.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        let mut out = HashMap::with_capacity(sorted.len());
        for digest in sorted {
            let g = self.acquire_shared_guard(space_id, digest).await;
            out.insert(digest, g);
        }
        out
    }

    pub async fn acquire_exclusive_guard(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> LocalExclusiveGuard {
        let lock = self.wait_for_digest_lock(space_id, digest).await;
        let guard = lock.write_owned().await;
        LocalExclusiveGuard { _guard: guard }
    }

    pub fn has_physical_file(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Result<bool, PortError> {
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        for (parent, name) in [
            (
                format!("blobs/{}/{}", space_id.as_str(), &hex[..2]),
                format!("{hex}.zst"),
            ),
            (
                "blobs/.quarantine".to_owned(),
                format!("{}.{hex}.corrupt", space_id.as_str()),
            ),
        ] {
            let metadata = self
                .open_dir(&parent, false)
                .and_then(|parent| parent.dir.symlink_metadata(&name));
            match metadata {
                Ok(md) if md.is_file() => return Ok(true),
                Ok(_) => return Err(internal_not_committed("local_cas_nonregular_entry", name)),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => return Err(internal_not_committed("local_cas_stat", e.to_string())),
            }
        }
        Ok(false)
    }

    /// Writes `compressed_frame` to a same-filesystem temp file, flushes data durability,
    /// atomically publishes `blobs/<space>/<aa>/<hex>.zst`, and returns directories to `fsync` before SQL commit.
    pub fn stage_physical_file(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
        expected_raw_size: u64,
        compressed_frame: &[u8],
    ) -> Result<PendingDirSyncs, PortError> {
        let (pending, temp) = self.stage_physical_file_deferred(
            space_id,
            digest,
            expected_raw_size,
            compressed_frame,
        )?;
        if let Some(temp) = temp {
            temp.rename_into_place()?;
        }
        Ok(pending)
    }

    /// Writes `compressed_frame` to a same-filesystem `.staging/` temp file so `WriteBatchActor`
    /// can coalesce `fdatasync` + atomic `rename` across the entire batch before directory `fsync` and SQL `COMMIT`.
    pub fn stage_physical_file_deferred(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
        expected_raw_size: u64,
        compressed_frame: &[u8],
    ) -> Result<(PendingDirSyncs, Option<DeferredLocalTempFile>), PortError> {
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        let shard = &hex[..2];
        let shard_rel = format!("blobs/{}/{shard}", space_id.as_str());
        let file_name = format!("{hex}.zst");

        let mut pending = PendingDirSyncs::default();
        let shard_dir = self.resolve_dir(&shard_rel, true)?;
        pending.pin(&shard_rel, &shard_dir);

        match shard_dir.dir.symlink_metadata(&file_name) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(internal_not_committed(
                        "local_cas_symlink_rejected",
                        format!("refusing non-regular CAS entry at {shard_rel}/{file_name}"),
                    ));
                }
                let existing = self.read_from_dir(&shard_dir, &file_name)?;
                match decode_zstd_verified(&existing, None, expected_raw_size, digest) {
                    Ok(_) => {
                        return Ok((pending, None));
                    }
                    Err(_) => {
                        let quarantine = self.resolve_dir("blobs/.quarantine", true)?;
                        shard_dir
                            .dir
                            .rename(
                                &file_name,
                                &quarantine.dir,
                                format!("{}.{hex}.corrupt", space_id.as_str()),
                            )
                            .map_err(|e| {
                                internal_not_committed("local_cas_quarantine_rename", e.to_string())
                            })?;
                        pending.pin("blobs/.quarantine", &quarantine);
                    }
                }
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(internal_not_committed(
                    "local_cas_target_stat",
                    err.to_string(),
                ));
            }
        }

        let staging_dir = self.resolve_dir("blobs/.staging", true)?;
        let mut slot = self.alloc_staging_slot();
        let mut tmp_name = format!("p{slot:x}.tmp");

        let mut opts = cap_std::fs::OpenOptions::new();
        opts.write(true).create_new(true).follow(FollowSymlinks::No);
        let mut tmp_file = match staging_dir.dir.open_with(&tmp_name, &opts) {
            Ok(f) => f,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                slot = self.next_staging_seq.fetch_add(1, Ordering::Relaxed) as u32;
                tmp_name = format!("p{slot:x}.tmp");
                staging_dir
                    .dir
                    .open_with(&tmp_name, &opts)
                    .map_err(|e| internal_not_committed("local_cas_open_tmp", e.to_string()))?
            }
            Err(err) if is_fd_exhausted_io_err(&err) => {
                self.evict_some_cached_dirs(64);
                match staging_dir.dir.open_with(&tmp_name, &opts) {
                    Ok(f) => f,
                    Err(e2) => {
                        self.free_staging_slots
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .push(slot);
                        return Err(internal_not_committed("local_cas_open_tmp", e2.to_string()));
                    }
                }
            }
            Err(err) => {
                self.free_staging_slots
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .push(slot);
                return Err(internal_not_committed(
                    "local_cas_open_tmp",
                    err.to_string(),
                ));
            }
        };
        if let Err(err) = tmp_file.write_all(compressed_frame) {
            drop(tmp_file);
            let _ = staging_dir.dir.remove_file(&tmp_name);
            self.free_staging_slots
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(slot);
            return Err(internal_not_committed(
                "local_cas_write_tmp",
                err.to_string(),
            ));
        }

        pending.pin("blobs/.staging", &staging_dir);
        Ok((
            pending,
            Some(DeferredLocalTempFile {
                staging_dir,
                shard_dir,
                free_slots: Arc::clone(&self.free_staging_slots),
                slot: Some(slot),
                tmp_file: Some(tmp_file),
                tmp_name,
                file_name,
                published: false,
            }),
        ))
    }

    /// Reads `blobs/<space>/<aa>/<hex>.zst` without following symlinks and verifies Zstd + length + `BLAKE3`.
    pub fn read_verified(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
        expected_raw_size: u64,
    ) -> Result<Vec<u8>, PortError> {
        let compressed = self.read_compressed(space_id, digest)?;
        decode_zstd_verified(&compressed, None, expected_raw_size, digest)
    }

    fn read_compressed(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Result<Vec<u8>, PortError> {
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        let shard_rel = format!("blobs/{}/{}", space_id.as_str(), &hex[..2]);
        let file_name = format!("{hex}.zst");

        let shard = self.resolve_dir(&shard_rel, false)?;
        self.read_from_dir(&shard, &file_name)
    }

    fn read_from_dir(&self, shard: &PinnedDir, name: &str) -> Result<Vec<u8>, PortError> {
        let options = &mut OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No).nonblock(true);
        // Reject non-regular files before open (in particular FIFOs), then verify
        // the descriptor actually opened, independently of the directory entry.
        if !shard
            .dir
            .symlink_metadata(name)
            .map_err(|e| internal_not_committed("local_cas_read_stat", e.to_string()))?
            .is_file()
        {
            return Err(internal_not_committed(
                "corrupt_local_blob_nonregular",
                name,
            ));
        }
        let mut file = match shard.dir.open_with(name, options) {
            Err(e) if is_fd_exhausted_io_err(&e) => {
                self.evict_some_cached_dirs(64);
                shard.dir.open_with(name, options)
            }
            result => result,
        }
        .map_err(|e| internal_not_committed("local_cas_read_open", e.to_string()))?;
        let meta = file
            .metadata()
            .map_err(|e| internal_not_committed("local_cas_read_stat", e.to_string()))?;
        if !meta.is_file() {
            return Err(internal_not_committed(
                "corrupt_local_blob_nonregular",
                name,
            ));
        }
        let len = usize::try_from(meta.len()).map_err(|_| {
            internal_not_committed("local_cas_read_too_large", "blob exceeds usize")
        })?;
        let mut compressed = vec![0u8; len];
        file.read_exact(&mut compressed)
            .map_err(|err| internal_not_committed("local_cas_read_bytes", err.to_string()))?;

        Ok(compressed)
    }

    /// Deletes `blobs/<space>/<aa>/<hex>.zst` and syncs the shard directory.
    /// Caller MUST hold `LocalExclusiveGuard` and have verified zero live refs and zero backup holds.
    pub fn delete_physical_file(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Result<(), PortError> {
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        let shard_rel = format!("blobs/{}/{}", space_id.as_str(), &hex[..2]);
        self.unlink_and_sync(&shard_rel, &format!("{hex}.zst"))?;
        self.unlink_and_sync(
            "blobs/.quarantine",
            &format!("{}.{hex}.corrupt", space_id.as_str()),
        )
    }

    fn unlink_and_sync(&self, parent: &str, name: &str) -> Result<(), PortError> {
        // The durable target is valid. The filesystem can become available again
        // after a mount, permission, non-regular entry, or sync problem is repaired.
        let blocked = |tag, detail: String| {
            crate::codec::unavailable_retryable(tag, detail, std::time::Duration::from_millis(250))
        };
        let dir = match self.open_dir(parent, false) {
            Ok(dir) => dir,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(blocked("local_cas_delete_dir", e.to_string()));
            }
        };
        match dir.dir.symlink_metadata(name) {
            Ok(md) if !md.is_file() => {
                return Err(blocked("local_cas_nonregular_entry", name.to_owned()));
            }
            Ok(_) => match dir.dir.remove_file(name) {
                Ok(()) => (),
                Err(e) if e.kind() == io::ErrorKind::NotFound => (),
                Err(e) => {
                    return Err(blocked("local_cas_unlink_failed", e.to_string()));
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => (),
            Err(e) => {
                return Err(blocked("local_cas_delete_stat", e.to_string()));
            }
        }
        dir.sync()
            .map_err(|e| blocked("local_cas_sync_dir", e.to_string()))
    }
    pub fn flush_single_dir(&self, rel: &str) -> Result<(), PortError> {
        self.resolve_dir(rel, false)?
            .sync()
            .map_err(|e| internal_not_committed("local_cas_sync_dir", e.to_string()))
    }
    pub fn flush_dir_syncs(&self, pending: &PendingDirSyncs) -> Result<(), PortError> {
        for barrier in pending.barriers() {
            barrier.sync(self)?;
        }
        Ok(())
    }
}

fn safe_component(comp: &str) -> bool {
    !comp.is_empty() && comp != "." && comp != ".." && !comp.contains(['/', '\\', '\0'])
}
fn validate_safe_component(comp: &str) -> Result<(), PortError> {
    if safe_component(comp) {
        Ok(())
    } else {
        Err(internal_not_committed(
            "local_cas_invalid_path_component",
            comp,
        ))
    }
}

fn sync_blob_file(file: &cap_std::fs::File) -> Result<(), PortError> {
    #[cfg(target_os = "macos")]
    {
        // On macOS, std::fs::File::sync_all issues fcntl(F_FULLFSYNC) for true media durability.
        file.sync_all()
            .map_err(|err| internal_not_committed("local_cas_fullfsync", err.to_string()))
    }
    #[cfg(not(target_os = "macos"))]
    {
        file.sync_data()
            .map_err(|err| internal_not_committed("local_cas_fdatasync", err.to_string()))
    }
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[tokio::test]
    async fn eager_read_defers_on_registry_or_digest_contention() {
        let path = std::env::temp_dir()
            .join(crate::codec::new_prefixed_hex_id("local-guard-test-").unwrap());
        let store = LocalBlobStore::open(&DataRoot::new(&path)).unwrap();
        let space = SpaceId::parse("GuardSpace01").unwrap();
        let digest = ContentDigest::from_bytes([0; 32]);

        let shard = store.guard_shard(digest).lock().await;
        std::thread::scope(|threads| {
            let (send, receive) = std::sync::mpsc::channel();
            let store_ref = &store;
            let space_ref = &space;
            threads.spawn(move || {
                let deferred = store_ref
                    .try_acquire_shared_guard(space_ref, digest)
                    .is_none();
                let _ = send.send(deferred);
            });
            let result = receive.recv_timeout(std::time::Duration::from_secs(2));
            drop(shard);
            assert!(result.expect("eager read waited for the held registry shard"));
        });

        let exclusive = store.acquire_exclusive_guard(&space, digest).await;
        assert!(store.try_acquire_shared_guard(&space, digest).is_none());
        drop(exclusive);
        assert!(store.try_acquire_shared_guard(&space, digest).is_some());
        drop(store);
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn dropping_a_queued_blob_read_releases_its_digest_guard() {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap()
            .block_on(async {
                let path = std::env::temp_dir()
                    .join(crate::codec::new_prefixed_hex_id("queued-blob-test-").unwrap());
                let store = Arc::new(LocalBlobStore::open(&DataRoot::new(&path)).unwrap());
                let space = SpaceId::from_bytes([1; 16]);
                let digest = ContentDigest::from_bytes([4; 32]);
                let guard = store.acquire_shared_guard(&space, digest).await;
                let observed = Arc::downgrade(&guard);
                let plan = crate::blobs::FastLocalBlobReadPlan::new(
                    store.clone(),
                    space,
                    digest,
                    10,
                    guard,
                );

                let (started, ready) = tokio::sync::oneshot::channel();
                let (release, hold) = std::sync::mpsc::channel::<()>();
                let blocker = tokio::task::spawn_blocking(move || {
                    started.send(()).unwrap();
                    let _ = hold.recv_timeout(std::time::Duration::from_secs(3));
                });
                ready.await.unwrap();
                {
                    let read = plan.read_verified_async();
                    tokio::pin!(read);
                    tokio::select! {
                        biased;
                        _ = &mut read => panic!("read ran while the only worker was busy"),
                        _ = std::future::ready(()) => {}
                    }
                }
                let released = observed.upgrade().is_none();
                drop(release);
                blocker.await.unwrap();
                assert!(
                    released,
                    "a queued read retained the digest after caller drop"
                );
                drop(store);
                std::fs::remove_dir_all(path).unwrap();
            });
    }
}

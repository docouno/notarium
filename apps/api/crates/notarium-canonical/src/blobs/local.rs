use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::{self, Read, Write},
    path::Path,
    sync::{
        Arc, Mutex, RwLock as StdRwLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
};

use cap_std::{ambient_authority, fs::Dir};
use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{ContentDigest, SpaceId},
};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use crate::{
    blobs::decode_zstd_verified,
    codec::{internal_not_committed, new_prefixed_hex_id},
};

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

pub(crate) struct CachedRelDir {
    pub(crate) dir: Dir,
    pub(crate) sync_file: cap_std::fs::File,
}

pub struct DeferredLocalTempFile {
    staging_dir: Arc<Dir>,
    shard_dir: Arc<CachedRelDir>,
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
            let _ = self.staging_dir.remove_file(&self.tmp_name);
        }
        if let Some(slot) = self.slot.take() {
            self.free_slots
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(slot);
        }
    }
}

/// Relative directory paths inside `DataRoot` that require durable `fsync` before SQL metadata commit.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PendingDirSyncs {
    dirs: BTreeSet<String>,
}

impl PendingDirSyncs {
    pub fn is_empty(&self) -> bool {
        self.dirs.is_empty()
    }

    pub fn insert(&mut self, rel_dir: impl Into<String>) {
        self.dirs.insert(rel_dir.into());
    }

    pub fn merge(&mut self, other: &Self) {
        for dir in &other.dirs {
            self.dirs.insert(dir.clone());
        }
    }

    pub fn len(&self) -> usize {
        self.dirs.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.dirs.iter().map(String::as_str)
    }

    pub fn without(&self, already_synced: &Self) -> Self {
        Self {
            dirs: self
                .dirs
                .difference(&already_synced.dirs)
                .cloned()
                .collect(),
        }
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
    root_dir: Dir,
    staging_dir: Arc<Dir>,
    free_staging_slots: Arc<Mutex<Vec<u32>>>,
    guards: Box<[Mutex<DigestGuardTable>; GUARD_SHARDS]>,
    known_dirs: StdRwLock<HashSet<String>>,
    dir_cache: StdRwLock<HashMap<String, Arc<CachedRelDir>>>,
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

        let dummy_staging = Arc::new(
            root_dir
                .try_clone()
                .expect("clone ambient root_dir during bootstrap"),
        );
        let guards = Box::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        let mut store = Self {
            root_dir,
            staging_dir: dummy_staging,
            free_staging_slots: Arc::new(Mutex::new(Vec::with_capacity(64))),
            guards,
            known_dirs: StdRwLock::new(HashSet::new()),
            dir_cache: StdRwLock::new(HashMap::new()),
            next_staging_seq: AtomicU64::new(0),
        };

        // Validate base `blobs`, `blobs/.staging`, and `blobs/.quarantine` directories with no-follow checks.
        let mut init_syncs = PendingDirSyncs::default();
        store.ensure_dir_chain(&["blobs", ".staging"], &mut init_syncs)?;
        let sdir = store.root_dir.open_dir("blobs/.staging").map_err(|err| {
            internal_not_committed(
                "local_cas_open_staging_dir",
                format!("failed opening 'blobs/.staging': {err}"),
            )
        })?;
        // Sweep any orphan temp files left in `blobs/.staging` by an unrecovered crash so dentry slots stay compact.
        if let Ok(entries) = sdir.entries() {
            for ent in entries.flatten() {
                if let Ok(ft) = ent.file_type()
                    && ft.is_file()
                    && !ft.is_symlink()
                {
                    let _ = sdir.remove_file(ent.file_name());
                }
            }
            init_syncs.insert("blobs/.staging");
        }
        store.staging_dir = Arc::new(sdir);

        let _ = store.get_or_create_cached_dir(
            "blobs/.quarantine",
            &["blobs", ".quarantine"],
            &mut init_syncs,
        )?;
        store.flush_dir_syncs(&init_syncs)?;

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

    fn get_or_create_cached_dir(
        &self,
        full_rel: &str,
        components: &[&str],
        pending: &mut PendingDirSyncs,
    ) -> Result<Arc<CachedRelDir>, PortError> {
        if let Some(existing) = self
            .dir_cache
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(full_rel)
        {
            return Ok(Arc::clone(existing));
        }

        self.ensure_dir_chain(components, pending)?;

        let open_pair = || -> io::Result<(Dir, cap_std::fs::File)> {
            let dir = self.root_dir.open_dir(full_rel)?;
            let sync_file = self.root_dir.open(full_rel)?;
            Ok((dir, sync_file))
        };

        let (dir, sync_file) = match open_pair() {
            Ok(pair) => pair,
            Err(first_err) => {
                // Self-tune under low OS `RLIMIT_NOFILE` (e.g. macOS default 256) by evicting cached handles and retrying.
                self.evict_some_cached_dirs(128);
                open_pair().map_err(|err| {
                    internal_not_committed(
                        "local_cas_open_cached_dir",
                        format!("failed opening dir '{full_rel}' (initial: {first_err}): {err}"),
                    )
                })?
            }
        };

        let meta = sync_file.metadata().map_err(|err| {
            internal_not_committed(
                "local_cas_stat_sync_dir",
                format!("failed stat dir '{full_rel}' for sync: {err}"),
            )
        })?;
        if !meta.is_dir() {
            return Err(internal_not_committed(
                "local_cas_sync_non_dir",
                format!("expected directory for sync at '{full_rel}'"),
            ));
        }

        let arc = Arc::new(CachedRelDir { dir, sync_file });
        let mut w = self.dir_cache.write().unwrap_or_else(|p| p.into_inner());
        if w.len() >= MAX_CACHED_SPACE_DIRS && !w.contains_key(full_rel) {
            let keys: Vec<String> = w.keys().take(64).cloned().collect();
            for k in keys {
                w.remove(&k);
            }
        }
        Ok(Arc::clone(
            w.entry(full_rel.to_owned())
                .or_insert_with(|| Arc::clone(&arc)),
        ))
    }

    fn lock_arc(&self, space_id: &SpaceId, digest: ContentDigest) -> Arc<RwLock<()>> {
        let shard_idx = usize::from(digest.as_bytes()[0]) & (GUARD_SHARDS - 1);
        let mut map = self.guards[shard_idx]
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
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

    pub async fn acquire_shared_guard(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Arc<LocalSharedGuard> {
        let lock = self.lock_arc(space_id, digest);
        let guard = lock.read_owned().await;
        Arc::new(LocalSharedGuard { _guard: guard })
    }

    pub fn try_acquire_shared_guard(
        &self,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Option<Arc<LocalSharedGuard>> {
        let lock = self.lock_arc(space_id, digest);
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
        let lock = self.lock_arc(space_id, digest);
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
        let target_rel = format!("blobs/{}/{}/{hex}.zst", space_id.as_str(), &hex[..2]);
        match self.root_dir.symlink_metadata(&target_rel) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(internal_not_committed(
                        "local_cas_nonregular_entry",
                        format!("non-regular entry at {target_rel}"),
                    ));
                }
                Ok(true)
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(err) => Err(internal_not_committed("local_cas_stat", err.to_string())),
        }
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
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        let shard = &hex[..2];
        let shard_rel = format!("blobs/{}/{shard}", space_id.as_str());
        let target_rel = format!("{shard_rel}/{hex}.zst");

        let mut pending = PendingDirSyncs::default();
        self.ensure_dir_chain(&["blobs", space_id.as_str(), shard], &mut pending)?;

        match self.root_dir.symlink_metadata(&target_rel) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(internal_not_committed(
                        "local_cas_symlink_rejected",
                        format!("refusing non-regular CAS entry at {target_rel}"),
                    ));
                }
                match self.read_verified(space_id, digest, expected_raw_size) {
                    Ok(_) => {
                        // Existing physical blob is verified intact; still sync shard dir before commit
                        // in case an earlier process crashed between rename and directory fsync.
                        pending.insert(shard_rel);
                        return Ok(pending);
                    }
                    Err(_) => {
                        // Corrupt physical file from an unreferenced torn write or fault: quarantine and replace.
                        self.quarantine_corrupt_file(&target_rel, &hex, &mut pending)?;
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

        let staging_dir = &self.staging_dir;
        let slot = self.alloc_staging_slot();
        let tmp_name = format!("t{slot:x}.tmp");

        let write_res = (|| -> Result<(), PortError> {
            let mut opts = cap_std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            let mut tmp_file = staging_dir
                .open_with(&tmp_name, &opts)
                .map_err(|err| internal_not_committed("local_cas_open_tmp", err.to_string()))?;
            tmp_file
                .write_all(compressed_frame)
                .map_err(|err| internal_not_committed("local_cas_write_tmp", err.to_string()))?;
            sync_blob_file(&tmp_file)?;
            drop(tmp_file);

            staging_dir
                .rename(&tmp_name, &self.root_dir, &target_rel)
                .map_err(|err| internal_not_committed("local_cas_rename", err.to_string()))?;
            Ok(())
        })();

        if let Err(err) = write_res {
            let _ = staging_dir.remove_file(&tmp_name);
            self.free_staging_slots
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(slot);
            return Err(err);
        }
        self.free_staging_slots
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .push(slot);

        pending.insert(shard_rel);
        Ok(pending)
    }

    /// Writes `compressed_frame` to a same-filesystem `.staging/` temp file so `WriteBatchActor`
    /// can coalesce `fdatasync` + atomic `rename` across the entire batch before directory `fsync` and SQL `COMMIT`.
    pub fn stage_physical_file_deferred(
        self: &Arc<Self>,
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
        let shard_dir = self.get_or_create_cached_dir(
            &shard_rel,
            &["blobs", space_id.as_str(), shard],
            &mut pending,
        )?;

        match shard_dir.dir.symlink_metadata(&file_name) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || !meta.is_file() {
                    return Err(internal_not_committed(
                        "local_cas_symlink_rejected",
                        format!("refusing non-regular CAS entry at {shard_rel}/{file_name}"),
                    ));
                }
                match self.read_verified(space_id, digest, expected_raw_size) {
                    Ok(_) => {
                        pending.insert(shard_rel);
                        return Ok((pending, None));
                    }
                    Err(_) => {
                        let target_rel = format!("{shard_rel}/{file_name}");
                        self.quarantine_corrupt_file(&target_rel, &hex, &mut pending)?;
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

        let staging_dir = Arc::clone(&self.staging_dir);
        let mut slot = self.alloc_staging_slot();
        let mut tmp_name = format!("p{slot:x}.tmp");

        let mut opts = cap_std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        let mut tmp_file = match staging_dir.open_with(&tmp_name, &opts) {
            Ok(f) => f,
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                slot = self.next_staging_seq.fetch_add(1, Ordering::Relaxed) as u32;
                tmp_name = format!("p{slot:x}.tmp");
                staging_dir
                    .open_with(&tmp_name, &opts)
                    .map_err(|e| internal_not_committed("local_cas_open_tmp", e.to_string()))?
            }
            Err(err) if is_fd_exhausted_io_err(&err) => {
                self.evict_some_cached_dirs(64);
                match staging_dir.open_with(&tmp_name, &opts) {
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
            let _ = staging_dir.remove_file(&tmp_name);
            self.free_staging_slots
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .push(slot);
            return Err(internal_not_committed(
                "local_cas_write_tmp",
                err.to_string(),
            ));
        }

        pending.insert(shard_rel);
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
        validate_safe_component(space_id.as_str())?;
        let hex = digest.to_hex();
        let shard_rel = format!("blobs/{}/{}", space_id.as_str(), &hex[..2]);
        let file_name = format!("{hex}.zst");

        let cached_shard = self
            .dir_cache
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .get(&shard_rel)
            .cloned();

        let mut file = if let Some(ref shard) = cached_shard {
            let open_res = match shard.dir.open(&file_name) {
                Ok(f) => Ok(f),
                Err(err) if is_fd_exhausted_io_err(&err) => {
                    self.evict_some_cached_dirs(64);
                    shard.dir.open(&file_name)
                }
                Err(err) => Err(err),
            };
            match open_res {
                Ok(f) => f,
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    return Err(internal_not_committed(
                        "corrupt_local_blob_missing",
                        format!("referenced local CAS blob missing at {shard_rel}/{file_name}"),
                    ));
                }
                Err(err) => {
                    if let Ok(meta) = shard.dir.symlink_metadata(&file_name)
                        && (meta.file_type().is_symlink() || !meta.is_file())
                    {
                        return Err(internal_not_committed(
                            "corrupt_local_blob_nonregular",
                            format!("non-regular CAS entry at {shard_rel}/{file_name}"),
                        ));
                    }
                    return Err(internal_not_committed(
                        "local_cas_read_open",
                        err.to_string(),
                    ));
                }
            }
        } else {
            let target_rel = format!("{shard_rel}/{file_name}");
            let open_res = match self.root_dir.open(&target_rel) {
                Ok(f) => Ok(f),
                Err(err) if is_fd_exhausted_io_err(&err) => {
                    self.evict_some_cached_dirs(64);
                    self.root_dir.open(&target_rel)
                }
                Err(err) => Err(err),
            };
            match open_res {
                Ok(f) => f,
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    return Err(internal_not_committed(
                        "corrupt_local_blob_missing",
                        format!("referenced local CAS blob missing at {target_rel}"),
                    ));
                }
                Err(err) => {
                    if let Ok(meta) = self.root_dir.symlink_metadata(&target_rel)
                        && (meta.file_type().is_symlink() || !meta.is_file())
                    {
                        return Err(internal_not_committed(
                            "corrupt_local_blob_nonregular",
                            format!("non-regular CAS entry at {target_rel}"),
                        ));
                    }
                    return Err(internal_not_committed(
                        "local_cas_read_open",
                        err.to_string(),
                    ));
                }
            }
        };

        let meta = file
            .metadata()
            .map_err(|err| internal_not_committed("local_cas_read_stat", err.to_string()))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(internal_not_committed(
                "corrupt_local_blob_nonregular",
                format!("non-regular CAS entry at {shard_rel}/{file_name}"),
            ));
        }

        let len = usize::try_from(meta.len()).map_err(|_| {
            internal_not_committed("local_cas_read_too_large", "blob exceeds usize")
        })?;
        let mut compressed = vec![0u8; len];
        file.read_exact(&mut compressed)
            .map_err(|err| internal_not_committed("local_cas_read_bytes", err.to_string()))?;

        decode_zstd_verified(&compressed, None, expected_raw_size, digest)
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
        let target_rel = format!("{shard_rel}/{hex}.zst");

        match self.root_dir.symlink_metadata(&target_rel) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(internal_not_committed(
                        "local_cas_delete_symlink_rejected",
                        format!("refusing to unlink symlink at {target_rel}"),
                    ));
                }
                match self.root_dir.remove_file(&target_rel) {
                    Ok(()) => {}
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => {
                        return Err(internal_not_committed(
                            "local_cas_unlink_failed",
                            err.to_string(),
                        ));
                    }
                }
                let mut syncs = PendingDirSyncs::default();
                syncs.insert(shard_rel);
                self.flush_dir_syncs(&syncs)?;
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => {
                return Err(internal_not_committed(
                    "local_cas_delete_stat",
                    err.to_string(),
                ));
            }
        }
        Ok(())
    }

    /// Flushes `fsync` on a single relative CAS directory. Any error blocks SQL `COMMIT`.
    pub fn flush_single_dir(&self, rel: &str) -> Result<(), PortError> {
        if !rel.is_empty()
            && let Some(cached) = self
                .dir_cache
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .get(rel)
                .cloned()
        {
            cached.sync_file.sync_all().map_err(|err| {
                internal_not_committed(
                    "local_cas_sync_dir",
                    format!("failed syncing dir '{rel}': {err}"),
                )
            })?;
            return Ok(());
        }

        let target_path = if rel.is_empty() {
            Path::new(".")
        } else {
            Path::new(rel)
        };
        // `Dir::open` opens an `O_RDONLY` capability-confined descriptor (unlike `Dir::open_dir`
        // which uses `O_PATH` on Linux and cannot be passed to `fsync`).
        let dir_file = self.root_dir.open(target_path).map_err(|err| {
            internal_not_committed(
                "local_cas_open_sync_dir",
                format!("failed opening dir '{rel}' for sync: {err}"),
            )
        })?;
        let meta = dir_file.metadata().map_err(|err| {
            internal_not_committed(
                "local_cas_stat_sync_dir",
                format!("failed stat dir '{rel}' for sync: {err}"),
            )
        })?;
        if !meta.is_dir() {
            return Err(internal_not_committed(
                "local_cas_sync_non_dir",
                format!("expected directory for sync at '{rel}'"),
            ));
        }
        dir_file.sync_all().map_err(|err| {
            internal_not_committed(
                "local_cas_sync_dir",
                format!("failed syncing dir '{rel}': {err}"),
            )
        })?;
        Ok(())
    }

    /// Flushes `fsync` on all deduplicated directories in `pending`. Any error blocks SQL `COMMIT`.
    pub fn flush_dir_syncs(&self, pending: &PendingDirSyncs) -> Result<(), PortError> {
        for rel in &pending.dirs {
            self.flush_single_dir(rel)?;
        }
        Ok(())
    }

    fn quarantine_corrupt_file(
        &self,
        target_rel: &str,
        hex: &str,
        pending: &mut PendingDirSyncs,
    ) -> Result<(), PortError> {
        self.ensure_dir_chain(&["blobs", ".quarantine"], pending)?;
        let q_id = new_prefixed_hex_id("quar_")?;
        let q_rel = format!("blobs/.quarantine/{hex}-{q_id}.corrupt");
        match self.root_dir.rename(target_rel, &self.root_dir, &q_rel) {
            Ok(()) => {
                pending.insert("blobs/.quarantine");
                Ok(())
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(internal_not_committed(
                "local_cas_quarantine_rename",
                err.to_string(),
            )),
        }
    }

    fn ensure_dir_chain(
        &self,
        components: &[&str],
        pending: &mut PendingDirSyncs,
    ) -> Result<(), PortError> {
        for comp in components {
            validate_safe_component(comp)?;
        }
        let full_rel = components.join("/");
        if self
            .known_dirs
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .contains(&full_rel)
        {
            return Ok(());
        }

        let mut current = String::new();
        for comp in components {
            let parent = current.clone();
            if current.is_empty() {
                current.push_str(comp);
            } else {
                current.push('/');
                current.push_str(comp);
            }

            if self
                .known_dirs
                .read()
                .unwrap_or_else(|p| p.into_inner())
                .contains(&current)
            {
                continue;
            }

            match self.root_dir.symlink_metadata(&current) {
                Ok(meta) => {
                    if meta.file_type().is_symlink() || !meta.is_dir() {
                        return Err(internal_not_committed(
                            "local_cas_dir_not_regular",
                            format!("expected regular directory at '{current}'"),
                        ));
                    }
                }
                Err(err) if err.kind() == io::ErrorKind::NotFound => {
                    match self.root_dir.create_dir(&current) {
                        Ok(()) => {
                            pending.insert(parent);
                        }
                        Err(race_err) if race_err.kind() == io::ErrorKind::AlreadyExists => {
                            let meta = self.root_dir.symlink_metadata(&current).map_err(|e| {
                                internal_not_committed("local_cas_dir_race_stat", e.to_string())
                            })?;
                            if meta.file_type().is_symlink() || !meta.is_dir() {
                                return Err(internal_not_committed(
                                    "local_cas_dir_race_nonregular",
                                    format!("non-directory raced at '{current}'"),
                                ));
                            }
                            pending.insert(parent);
                        }
                        Err(other) => {
                            return Err(internal_not_committed(
                                "local_cas_mkdir",
                                format!("failed creating '{current}': {other}"),
                            ));
                        }
                    }
                }
                Err(err) => {
                    return Err(internal_not_committed(
                        "local_cas_dir_stat",
                        format!("failed stat '{current}': {err}"),
                    ));
                }
            }

            self.known_dirs
                .write()
                .unwrap_or_else(|p| p.into_inner())
                .insert(current.clone());
        }
        Ok(())
    }
}

fn validate_safe_component(comp: &str) -> Result<(), PortError> {
    if comp.is_empty()
        || comp == "."
        || comp == ".."
        || comp.contains('/')
        || comp.contains('\\')
        || comp.contains('\0')
    {
        return Err(internal_not_committed(
            "local_cas_invalid_path_component",
            format!("unsafe path component '{comp}'"),
        ));
    }
    Ok(())
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

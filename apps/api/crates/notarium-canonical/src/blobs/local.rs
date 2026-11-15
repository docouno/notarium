use std::{
    collections::{BTreeSet, HashMap},
    io::{self, Write},
    path::Path,
    sync::{Arc, Mutex, Weak},
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
}

type DigestGuardKey = (String, ContentDigest);
type DigestGuardTable = HashMap<DigestGuardKey, Weak<RwLock<()>>>;

/// Capability-confined local content-addressed Zstd blob store (`LocalZstdV1`).
pub struct LocalBlobStore {
    root_dir: Dir,
    guards: Mutex<DigestGuardTable>,
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

        let store = Self {
            root_dir,
            guards: Mutex::new(HashMap::new()),
        };

        // Validate base `blobs`, `blobs/.staging`, and `blobs/.quarantine` directories with no-follow checks.
        let mut init_syncs = PendingDirSyncs::default();
        store.ensure_dir_chain(&["blobs", ".staging"], &mut init_syncs)?;
        store.ensure_dir_chain(&["blobs", ".quarantine"], &mut init_syncs)?;
        store.flush_dir_syncs(&init_syncs)?;

        Ok(store)
    }

    fn lock_arc(&self, space_id: &SpaceId, digest: ContentDigest) -> Arc<RwLock<()>> {
        let mut map = self
            .guards
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let key = (space_id.as_str().to_owned(), digest);
        if let Some(existing) = map.get(&key).and_then(Weak::upgrade) {
            return existing;
        }
        // Opportunistically prune dead weak entries when map grows.
        if map.len() >= 1024 {
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

        self.ensure_dir_chain(&["blobs", ".staging"], &mut pending)?;
        let tmp_token = new_prefixed_hex_id("tmp_")?;
        let tmp_rel = format!("blobs/.staging/{hex}-{tmp_token}.part");

        let write_res = (|| -> Result<(), PortError> {
            let mut opts = cap_std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            let mut tmp_file = self
                .root_dir
                .open_with(&tmp_rel, &opts)
                .map_err(|err| internal_not_committed("local_cas_open_tmp", err.to_string()))?;
            tmp_file
                .write_all(compressed_frame)
                .map_err(|err| internal_not_committed("local_cas_write_tmp", err.to_string()))?;
            sync_blob_file(&tmp_file)?;
            drop(tmp_file);

            self.root_dir
                .rename(&tmp_rel, &self.root_dir, &target_rel)
                .map_err(|err| internal_not_committed("local_cas_rename", err.to_string()))?;
            Ok(())
        })();

        if let Err(err) = write_res {
            let _ = self.root_dir.remove_file(&tmp_rel);
            return Err(err);
        }

        pending.insert(shard_rel);

        // Always verify the published target (covers loser verification on same-digest races).
        self.read_verified(space_id, digest, expected_raw_size)?;

        Ok(pending)
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
        let target_rel = format!("blobs/{}/{}/{hex}.zst", space_id.as_str(), &hex[..2]);

        let meta = self
            .root_dir
            .symlink_metadata(&target_rel)
            .map_err(|err| match err.kind() {
                io::ErrorKind::NotFound => internal_not_committed(
                    "corrupt_local_blob_missing",
                    format!("referenced local CAS blob missing at {target_rel}"),
                ),
                _ => internal_not_committed("local_cas_read_stat", err.to_string()),
            })?;

        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(internal_not_committed(
                "corrupt_local_blob_nonregular",
                format!("non-regular CAS entry at {target_rel}"),
            ));
        }

        let compressed = self
            .root_dir
            .read(&target_rel)
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

    /// Flushes `fsync` on all deduplicated directories in `pending`. Any error blocks SQL `COMMIT`.
    pub fn flush_dir_syncs(&self, pending: &PendingDirSyncs) -> Result<(), PortError> {
        for rel in &pending.dirs {
            let target_path = if rel.is_empty() {
                Path::new(".")
            } else {
                Path::new(rel.as_str())
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
        let mut current = String::new();
        for comp in components {
            validate_safe_component(comp)?;
            let parent = current.clone();
            if current.is_empty() {
                current.push_str(comp);
            } else {
                current.push('/');
                current.push_str(comp);
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

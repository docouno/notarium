pub mod local;
pub(crate) mod retirement_worker;
pub mod s3;

use std::{
    collections::{BTreeSet, HashMap, HashSet},
    io::{Cursor, Read},
    sync::Arc,
    time::Duration,
};

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, SpaceId, SpaceSeq},
    model::HistoryScope,
    ports::CallBudget,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

pub use crate::blobs::local::PendingDirSyncs;
use crate::{
    blobs::{
        local::{
            DeferredLocalStaging, LocalBlobStore, LocalSharedGuard, PreparedLocalStagingEntry,
        },
        s3::{S3BlobStore, S3Transport},
    },
    codec::{internal_not_committed, new_prefixed_hex_id, now_unix_ms, unavailable_retryable},
    config::BlobBackendConfig,
    runtime::load_space_record,
    sql_exec::BackendConn,
};

pub const ZSTD_COMPRESSION_LEVEL: i32 = 3;
pub const S3_MAX_RAW_CHUNK_BYTES: usize = 4 * 1024 * 1024;
pub const S3_MAX_COMPRESSED_PART_BYTES: usize = 8 * 1024 * 1024;
pub const TERMINAL_MARKER_MAGIC: &[u8] = b"NOTARIUM_RETIRED_BLOB_V1\n";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlobCodecTag {
    LocalZstdV1,
    S3ChunkedV1,
}

impl BlobCodecTag {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::LocalZstdV1 => "local_zstd_v1",
            Self::S3ChunkedV1 => "s3_chunked_v1",
        }
    }

    pub fn from_db_str(raw: &str) -> Result<Self, PortError> {
        match raw {
            "local_zstd_v1" => Ok(Self::LocalZstdV1),
            "s3_chunked_v1" => Ok(Self::S3ChunkedV1),
            other => Err(internal_not_committed(
                "corrupt_blob_codec",
                format!("unknown blob codec '{other}'"),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum BlobOwnerKind {
    NoteRevision,
    AbilityResource,
    ChatEntry,
    ChatPendingInput,
    CollabSnapshot,
    StagedChat,
}

impl BlobOwnerKind {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::NoteRevision => "note_revision",
            Self::AbilityResource => "ability_resource",
            Self::ChatEntry => "chat_entry",
            Self::ChatPendingInput => "chat_pending_input",
            Self::CollabSnapshot => "collab_snapshot",
            Self::StagedChat => "staged_chat",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetirementReason {
    Purge,
    Gc,
}

impl RetirementReason {
    pub fn as_db_str(self) -> &'static str {
        match self {
            Self::Purge => "purge",
            Self::Gc => "gc",
        }
    }
}

/// Nonsecret terminal marker written over every retired S3 part key (including unsent keys).
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct TerminalMarkerMeta {
    pub space_id: String,
    pub publication_id: String,
    pub part_index: u32,
    pub retirement_id: String,
    pub reason: RetirementReason,
}

impl TerminalMarkerMeta {
    pub fn encode(&self) -> Result<Vec<u8>, PortError> {
        let json = serde_json::to_vec(self)
            .map_err(|err| internal_not_committed("encode_terminal_marker", err.to_string()))?;
        let mut out = Vec::with_capacity(TERMINAL_MARKER_MAGIC.len() + json.len());
        out.extend_from_slice(TERMINAL_MARKER_MAGIC);
        out.extend_from_slice(&json);
        Ok(out)
    }

    pub fn is_terminal_marker(bytes: &[u8]) -> bool {
        bytes.starts_with(TERMINAL_MARKER_MAGIC)
    }
}

#[derive(Clone, Debug)]
pub struct PreparedBlobPart {
    pub part_index: u32,
    pub raw_size: u64,
    pub part_blake3: ContentDigest,
    pub compressed: Arc<[u8]>,
}

/// Immutable, replayable prepared CAS payload computed before any external I/O.
#[derive(Clone, Debug)]
pub struct PreparedBlobSource {
    pub(crate) digest: ContentDigest,
    pub(crate) raw_size: u64,
    pub(crate) codec: BlobCodecTag,
    pub(crate) total_compressed_size: u64,
    pub(crate) local_frame: Option<Arc<[u8]>>,
    pub(crate) s3_parts: Vec<PreparedBlobPart>,
}

impl PreparedBlobSource {
    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn raw_size(&self) -> u64 {
        self.raw_size
    }
    pub fn compressed_size(&self) -> u64 {
        self.total_compressed_size
    }
    #[cfg(feature = "test-support")]
    pub fn s3_parts(&self) -> &[PreparedBlobPart] {
        &self.s3_parts
    }

    pub fn prepare(raw: &[u8], codec: BlobCodecTag) -> Result<Self, PortError> {
        let digest = ContentDigest::from_bytes(*blake3::hash(raw).as_bytes());
        let raw_size = raw.len() as u64;

        match codec {
            BlobCodecTag::LocalZstdV1 => {
                let encoded = encode_zstd_level3(raw)?;
                let total_compressed_size = encoded.len() as u64;
                Ok(Self {
                    digest,
                    raw_size,
                    codec,
                    total_compressed_size,
                    local_frame: Some(Arc::from(encoded)),
                    s3_parts: Vec::new(),
                })
            }
            BlobCodecTag::S3ChunkedV1 => {
                let mut parts = Vec::new();
                let mut total_compressed: u64 = 0;

                if raw.is_empty() {
                    // Empty blob is represented by exactly one valid empty Zstd-3 frame.
                    let encoded = encode_zstd_level3(&[])?;
                    check_s3_frame_bounds(encoded.len())?;
                    total_compressed += encoded.len() as u64;
                    parts.push(PreparedBlobPart {
                        part_index: 0,
                        raw_size: 0,
                        part_blake3: digest,
                        compressed: Arc::from(encoded),
                    });
                } else {
                    for (idx, chunk) in raw.chunks(S3_MAX_RAW_CHUNK_BYTES).enumerate() {
                        let part_idx = u32::try_from(idx).map_err(|_| {
                            internal_not_committed("s3_part_index_overflow", "too many parts")
                        })?;
                        let part_digest =
                            ContentDigest::from_bytes(*blake3::hash(chunk).as_bytes());
                        let encoded = encode_zstd_level3(chunk)?;
                        check_s3_frame_bounds(encoded.len())?;
                        total_compressed += encoded.len() as u64;
                        parts.push(PreparedBlobPart {
                            part_index: part_idx,
                            raw_size: chunk.len() as u64,
                            part_blake3: part_digest,
                            compressed: Arc::from(encoded),
                        });
                    }
                }

                Ok(Self {
                    digest,
                    raw_size,
                    codec,
                    total_compressed_size: total_compressed,
                    local_frame: None,
                    s3_parts: parts,
                })
            }
        }
    }
}

fn check_s3_frame_bounds(compressed_len: usize) -> Result<(), PortError> {
    if compressed_len == 0 || compressed_len >= S3_MAX_COMPRESSED_PART_BYTES {
        return Err(internal_not_committed(
            "s3_frame_size_invalid",
            format!(
                "compressed chunk size {compressed_len} outside 1..{S3_MAX_COMPRESSED_PART_BYTES}"
            ),
        ));
    }
    Ok(())
}

pub fn encode_zstd_level3(raw: &[u8]) -> Result<Vec<u8>, PortError> {
    thread_local! {
        static ZSTD_ENC: std::cell::RefCell<Option<zstd::bulk::Compressor<'static>>> =
            const { std::cell::RefCell::new(None) };
    }
    ZSTD_ENC.with(|cell| {
        if let Ok(mut borrow) = cell.try_borrow_mut() {
            if borrow.is_none() {
                *borrow = zstd::bulk::Compressor::new(ZSTD_COMPRESSION_LEVEL).ok();
            }
            if let Some(comp) = borrow.as_mut() {
                return comp
                    .compress(raw)
                    .map_err(|err| internal_not_committed("zstd_encode_failed", err.to_string()));
            }
        }
        zstd::stream::encode_all(Cursor::new(raw), ZSTD_COMPRESSION_LEVEL)
            .map_err(|err| internal_not_committed("zstd_encode_failed", err.to_string()))
    })
}

/// Bounded Zstd decompression + exact raw length + full BLAKE3 integrity check.
pub fn decode_zstd_verified(
    compressed: &[u8],
    expected_compressed_size: Option<u64>,
    expected_raw_size: u64,
    expected_blake3: ContentDigest,
) -> Result<Vec<u8>, PortError> {
    if let Some(exp_comp) = expected_compressed_size
        && compressed.len() as u64 != exp_comp
    {
        return Err(internal_not_committed(
            "corrupt_blob_compressed_len",
            format!(
                "expected compressed length {exp_comp}, found {}",
                compressed.len()
            ),
        ));
    }

    let cap = usize::try_from(expected_raw_size)
        .map_err(|_| internal_not_committed("corrupt_blob_raw_len", "raw_size exceeds usize"))?;

    let decoded = if cap <= 8 * 1024 * 1024 {
        thread_local! {
            static ZSTD_DEC: std::cell::RefCell<Option<zstd::bulk::Decompressor<'static>>> =
                const { std::cell::RefCell::new(None) };
        }
        ZSTD_DEC.with(|cell| -> Result<Vec<u8>, PortError> {
            if let Ok(mut borrow) = cell.try_borrow_mut() {
                if borrow.is_none() {
                    *borrow = zstd::bulk::Decompressor::new().ok();
                }
                if let Some(dec) = borrow.as_mut() {
                    return dec.decompress(compressed, cap).map_err(|err| {
                        internal_not_committed("corrupt_blob_zstd_stream", err.to_string())
                    });
                }
            }
            let decoder = zstd::stream::read::Decoder::new(compressed).map_err(|err| {
                internal_not_committed("corrupt_blob_zstd_header", err.to_string())
            })?;
            let mut limited = decoder.take(expected_raw_size.saturating_add(1));
            let mut buf = Vec::with_capacity(cap.min(64 * 1024));
            limited.read_to_end(&mut buf).map_err(|err| {
                internal_not_committed("corrupt_blob_zstd_stream", err.to_string())
            })?;
            Ok(buf)
        })?
    } else {
        let decoder = zstd::stream::read::Decoder::new(compressed)
            .map_err(|err| internal_not_committed("corrupt_blob_zstd_header", err.to_string()))?;
        let max_read = expected_raw_size.saturating_add(1);
        let mut limited = decoder.take(max_read);
        let mut buf = Vec::with_capacity(cap.min(64 * 1024));
        limited
            .read_to_end(&mut buf)
            .map_err(|err| internal_not_committed("corrupt_blob_zstd_stream", err.to_string()))?;
        buf
    };

    if decoded.len() as u64 != expected_raw_size {
        return Err(internal_not_committed(
            "corrupt_blob_decoded_len",
            format!(
                "expected decoded length {expected_raw_size}, got {}",
                decoded.len()
            ),
        ));
    }

    let actual_digest = ContentDigest::from_bytes(*blake3::hash(&decoded).as_bytes());
    if actual_digest != expected_blake3 {
        return Err(internal_not_committed(
            "corrupt_blob_digest_mismatch",
            format!(
                "expected digest {}, decoded {}",
                expected_blake3.to_hex(),
                actual_digest.to_hex()
            ),
        ));
    }

    Ok(decoded)
}

/// Kept by the writer until the outer transaction resolves. On a lost commit ACK
/// the worker determines the result from the durable retirement IDs.
pub(crate) struct RetirementHandoff {
    store: crate::CanonicalStore,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    ids: Vec<String>,
    first_attempt: Option<retirement_worker::HandoffSender>,
}

impl Drop for RetirementHandoff {
    fn drop(&mut self) {
        let attempts =
            self.store
                .schedule_retirements(&self.scope, self.epoch, std::mem::take(&mut self.ids));
        if let Some(sender) = self.first_attempt.take() {
            let _ = sender.send(attempts);
        }
    }
}

/// Owns a provisionally registered S3 publication until the last uploader or writer
/// releases it. SQL removes the discard intent atomically when that publication wins.
#[derive(Debug)]
pub(crate) struct PublicationDiscard {
    store: crate::CanonicalStore,
    scope: HistoryScope,
    epoch: LeaseEpoch,
    publication: String,
    finished: std::sync::atomic::AtomicBool,
}

impl PublicationDiscard {
    pub(crate) async fn finish(&self) -> Result<(), PortError> {
        self.store
            .discard_publication(&self.scope, self.epoch, &self.publication)
            .await?;
        self.finished
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(())
    }
}

impl Drop for PublicationDiscard {
    fn drop(&mut self) {
        if self.finished.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        self.store
            .schedule_retirements(&self.scope, self.epoch, vec![self.publication.clone()]);
    }
}

#[derive(Clone, Debug)]
pub struct StagedBlobTicket {
    pub(crate) space_id: SpaceId,
    incarnation: notarium_core::ids::HistoryIncarnation,
    epoch: LeaseEpoch,
    pub(crate) digest: ContentDigest,
    pub(crate) raw_size: u64,
    pub(crate) compressed_size: u64,
    pub(crate) publication_id: String,
    pub(crate) codec: BlobCodecTag,
    discard: Option<Arc<PublicationDiscard>>,
    pub(crate) local_pending_dirs: PendingDirSyncs,
    /// Retains the shared per-`(SpaceId, ContentDigest)` guard until outer Phase-2 commit/rollback drops it.
    pub(crate) _local_guard: Option<Arc<LocalSharedGuard>>,
    /// Key `(space_id, digest)` when this ticket requires a Wave-A local CAS durability barrier before SQL `COMMIT`.
    pub(crate) deferred_local_key: Option<(String, ContentDigest)>,
    /// Optional deferred local CAS staging descriptor materialized, synced, and renamed in `WriteBatchActor` Wave A.
    pub(crate) deferred_local_publish: Option<Arc<std::sync::Mutex<Option<DeferredLocalStaging>>>>,
}

impl StagedBlobTicket {
    pub(crate) fn discard(&self) -> Option<Arc<PublicationDiscard>> {
        self.discard.clone()
    }

    pub fn digest(&self) -> ContentDigest {
        self.digest
    }
    pub fn raw_size(&self) -> u64 {
        self.raw_size
    }
    pub fn pending_directory_syncs(&self) -> &PendingDirSyncs {
        &self.local_pending_dirs
    }

    pub fn publication_id(&self) -> &str {
        &self.publication_id
    }

    pub(crate) fn check_authority(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
    ) -> Result<(), PortError> {
        if self.space_id != scope.space_id {
            return Err(DomainError::ResourceNotFound.into());
        }
        if self.incarnation != scope.incarnation {
            return Err(
                DomainError::validation(ValidationReason::HistoryIncarnationMismatch).into(),
            );
        }
        if self.epoch != epoch {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        Ok(())
    }

    pub(crate) fn requires_local_wave_barrier(&self) -> bool {
        self.deferred_local_key.is_some()
    }

    pub(crate) fn take_deferred_local_staging(&self) -> Option<DeferredLocalStaging> {
        self.deferred_local_publish
            .as_ref()
            .and_then(|slot| slot.lock().expect("deferred publish mutex").take())
    }
}

#[derive(Clone, Debug)]
pub struct BlobReferenceClaim {
    pub owner_kind: BlobOwnerKind,
    pub owner_id: String,
    pub owner_rev_id: String,
    pub resource_key: String,
    pub ticket: StagedBlobTicket,
}

pub(crate) enum BlobBackendDriver {
    Local(Arc<LocalBlobStore>),
    S3(Arc<S3BlobStore>),
}

impl BlobBackendDriver {
    pub async fn open(
        cfg: &BlobBackendConfig,
        custom_s3_transport: Option<Arc<dyn S3Transport>>,
    ) -> Result<Self, PortError> {
        match cfg {
            BlobBackendConfig::Local { data_root } => {
                let store = LocalBlobStore::open(data_root)?;
                Ok(Self::Local(Arc::new(store)))
            }
            BlobBackendConfig::S3(s3_cfg) => {
                let store = S3BlobStore::open((**s3_cfg).clone(), custom_s3_transport).await?;
                Ok(Self::S3(Arc::new(store)))
            }
        }
    }

    pub fn codec_tag(&self) -> BlobCodecTag {
        match self {
            Self::Local(_) => BlobCodecTag::LocalZstdV1,
            Self::S3(_) => BlobCodecTag::S3ChunkedV1,
        }
    }
}

pub(crate) struct FastLocalBlobReadPlan {
    local: Arc<LocalBlobStore>,
    space_id: SpaceId,
    digest: ContentDigest,
    raw_size: u64,
    _guard: Arc<LocalSharedGuard>,
}

impl FastLocalBlobReadPlan {
    pub(crate) fn new(
        local: Arc<LocalBlobStore>,
        space_id: SpaceId,
        digest: ContentDigest,
        raw_size: u64,
        guard: Arc<LocalSharedGuard>,
    ) -> Self {
        Self {
            local,
            space_id,
            digest,
            raw_size,
            _guard: guard,
        }
    }

    pub fn read_verified(&self) -> Result<Vec<u8>, PortError> {
        self.local
            .read_verified(&self.space_id, self.digest, self.raw_size)
    }

    pub async fn read_verified_async(self) -> Result<Vec<u8>, PortError> {
        // A queued job must not keep a digest alive after its caller leaves.
        // A worker that has started the read keeps its own guard until verification ends.
        let plan = Arc::new(self);
        let pending = Arc::downgrade(&plan);
        let read = tokio::task::spawn_blocking(move || {
            let plan = pending.upgrade().ok_or_else(|| {
                crate::codec::cancelled_not_committed(
                    "local_cas_read_cancelled",
                    "caller left before the local blob read started",
                )
            })?;
            plan.read_verified()
        })
        .await
        .map_err(|err| internal_not_committed("local_cas_fast_read_join", err.to_string()))?;
        drop(plan);
        read
    }
}

/// Coordinates Phase-1 blob staging, Phase-2 SQL reference activation, verified reads, and retirement.
impl crate::CanonicalStore {
    pub fn blob_codec(&self) -> BlobCodecTag {
        self.inner.blobs.codec_tag()
    }

    pub(crate) fn local_store_arc(&self) -> Option<Arc<LocalBlobStore>> {
        match &self.inner.blobs {
            BlobBackendDriver::Local(l) => Some(Arc::clone(l)),
            BlobBackendDriver::S3(_) => None,
        }
    }

    pub(crate) async fn ensure_blob_backend_ready(&self) -> Result<(), PortError> {
        if let BlobBackendDriver::S3(s3) = &self.inner.blobs {
            s3.verify_runtime_bucket_mode().await?;
        }
        Ok(())
    }

    pub fn prepare_blob(&self, raw: &[u8]) -> Result<PreparedBlobSource, PortError> {
        PreparedBlobSource::prepare(raw, self.blob_codec())
    }

    /// Flushes deduplicated local CAS directories (`fsync`) before SQL metadata `COMMIT`.
    pub fn flush_pending_local_dirs(&self, pending: &PendingDirSyncs) -> Result<(), PortError> {
        if pending.is_empty() {
            return Ok(());
        }
        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => local.flush_dir_syncs(pending),
            BlobBackendDriver::S3(_) => Ok(()),
        }
    }

    /// Flushes deduplicated local CAS directories (`fsync`) concurrently across cached open directory
    /// descriptors so ext4's JBD2 `jbd2_trans_will_send_data_barrier` coalesces all shard directory
    /// syncs into a single journal commit + single hardware flush before SQL `COMMIT`.
    pub async fn flush_pending_local_dirs_async(
        &self,
        pending: &PendingDirSyncs,
    ) -> Result<(), PortError> {
        if pending.is_empty() {
            return Ok(());
        }
        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                if pending.len() == 1 {
                    let local_cl = Arc::clone(local);
                    let barrier = pending.barriers().next().unwrap();
                    return tokio::task::spawn_blocking(move || barrier.sync(&local_cl))
                        .await
                        .map_err(|err| {
                            internal_not_committed("local_cas_sync_dir_join", err.to_string())
                        })?;
                }
                let mut set = tokio::task::JoinSet::new();
                for barrier in pending.barriers() {
                    let local_cl = Arc::clone(local);
                    set.spawn_blocking(move || barrier.sync(&local_cl));
                }
                let mut first_err: Option<PortError> = None;
                while let Some(res) = set.join_next().await {
                    match res {
                        Ok(Ok(())) => {}
                        Ok(Err(err)) => {
                            if first_err.is_none() {
                                first_err = Some(err);
                            }
                        }
                        Err(join_err) => {
                            if first_err.is_none() {
                                first_err = Some(internal_not_committed(
                                    "local_cas_sync_dir_join",
                                    join_err.to_string(),
                                ));
                            }
                        }
                    }
                }
                if let Some(err) = first_err {
                    return Err(err);
                }
                Ok(())
            }
            BlobBackendDriver::S3(_) => Ok(()),
        }
    }

    /// Schedules synchronized orphan local CAS cleanup asynchronously on `backup_executor`
    /// so callers on `WriteBatchActor` or auxiliary writer paths NEVER block awaiting
    /// `LocalExclusiveGuard` while holding `writer.lock()`, `live_visibility`, `commit_gate`,
    /// or `ActiveCanonicalEffect`, or while sibling commands holding `LocalSharedGuard` wait
    /// in `WriteBatchActor`'s mailbox.
    pub(crate) fn schedule_unretained_local_files_cleanup(
        &self,
        to_cleanup: Vec<(SpaceId, ContentDigest)>,
    ) {
        if to_cleanup.is_empty() {
            return;
        }
        if !matches!(self.inner.blobs, BlobBackendDriver::Local(_)) {
            return;
        }
        let store = self.clone();
        let handle = self.inner.backup_executor.spawn(async move {
            store.cleanup_unretained_local_files_async(to_cleanup).await;
        });
        if let Ok(mut tasks) = self.inner.backup_cleanups.lock() {
            tasks.retain(|t| !t.is_finished());
            tasks.push(handle);
        }
    }

    #[cfg(test)]
    pub(crate) async fn drain_scheduled_cleanups_for_test(&self) {
        loop {
            let pending = {
                let mut tasks = self
                    .inner
                    .backup_cleanups
                    .lock()
                    .unwrap_or_else(|p| p.into_inner());
                std::mem::take(&mut *tasks)
            };
            if pending.is_empty() {
                break;
            }
            for task in pending {
                let _ = task.await;
            }
        }
    }

    /// Synchronized cleanup for local CAS `.zst` files that were newly renamed into `blobs/`
    /// by a command or batch whose SQL transaction aborted/rolled back (or had an unknown commit
    /// outcome). Callers MUST have dropped all their own `StagedBlobTicket`s (`LocalSharedGuard`s)
    /// and finalized (rolled back or committed) their SQL transaction BEFORE calling this method.
    /// Acquires `LocalExclusiveGuard` per `(space_id, digest)` and verifies zero backup holds,
    /// zero live `blob_references`, and no `blob_catalog` row before deleting the physical file.
    pub(crate) async fn cleanup_unretained_local_files_async(
        &self,
        to_cleanup: Vec<(SpaceId, ContentDigest)>,
    ) {
        if to_cleanup.is_empty() {
            return;
        }
        let BlobBackendDriver::Local(local) = &self.inner.blobs else {
            return;
        };
        let mut seen: HashSet<(SpaceId, ContentDigest)> = HashSet::with_capacity(to_cleanup.len());
        for (space_id, digest) in to_cleanup {
            if !seen.insert((space_id.clone(), digest)) {
                continue;
            }
            let guard = local.acquire_exclusive_guard(&space_id, digest).await;
            let space_chk = space_id.clone();
            let can_delete = self
                .with_read_tx(|tx| {
                    Box::pin(async move {
                        ensure_no_backup_holds_tx(tx, &space_chk).await?;
                        ensure_zero_reachable_refs_tx(tx, &space_chk, digest).await?;
                        let cataloged: Option<i64> = match tx {
                            BackendConn::Sqlite(conn) => sqlx::query_scalar(
                                "SELECT 1 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ? LIMIT 1",
                            )
                            .bind(space_chk.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .fetch_optional(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_check_orphan_catalog", err.to_string())
                            })?,
                            BackendConn::Postgres(conn) => sqlx::query_scalar(
                                "SELECT 1::BIGINT FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2 LIMIT 1",
                            )
                            .bind(space_chk.as_str())
                            .bind(digest.as_bytes().as_slice())
                            .fetch_optional(&mut **conn)
                            .await
                            .map_err(|err| {
                                crate::runtime::pg_read_error("pg_check_orphan_catalog", err)
                            })?,
                        };
                        Ok(cataloged.is_none())
                    })
                })
                .await
                .unwrap_or(false);
            if can_delete {
                let local_cl = Arc::clone(local);
                let space_del = space_id.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let _guard = guard;
                    let _ = local_cl.delete_physical_file(&space_del, digest);
                })
                .await;
            }
        }
    }

    /// Wave A0 + A1: materializes unique `.staging/*.part` files and flushes `fdatasync` / `F_FULLFSYNC`
    /// in parallel WITHOUT renaming into `blobs/`, allowing CPU-bound SQL Stage 1 to overlap safely.
    pub(crate) async fn prepare_and_sync_local_stagings_async(
        &self,
        pending_stagings: Vec<DeferredLocalStaging>,
    ) -> Result<Vec<PreparedLocalStagingEntry>, PortError> {
        if pending_stagings.is_empty() {
            return Ok(Vec::new());
        }

        let mut preopened = Vec::with_capacity(pending_stagings.len());
        let mut remaining = Vec::new();
        for item in pending_stagings {
            if let Some(pre) = item.take_presynced() {
                preopened.push(pre);
            } else {
                remaining.push(item);
            }
        }

        let unique_stagings = DeferredLocalStaging::dedup_unique(remaining);
        let mut entries = if unique_stagings.is_empty() {
            preopened
        } else if unique_stagings.len() <= 8 {
            let mut opened = tokio::task::spawn_blocking(move || {
                DeferredLocalStaging::open_and_write_chunk(unique_stagings)
            })
            .await
            .map_err(|err| {
                internal_not_committed("local_cas_open_batch_join", err.to_string())
            })??;
            opened.extend(preopened);
            opened
        } else {
            let chunk_size = unique_stagings.len().div_ceil(4);
            let mut open_set = tokio::task::JoinSet::new();
            let mut iter = unique_stagings.into_iter();
            loop {
                let chunk: Vec<DeferredLocalStaging> = iter.by_ref().take(chunk_size).collect();
                if chunk.is_empty() {
                    break;
                }
                open_set.spawn_blocking(move || DeferredLocalStaging::open_and_write_chunk(chunk));
            }
            let mut merged = preopened;
            let mut open_err: Option<PortError> = None;
            while let Some(res) = open_set.join_next().await {
                match res {
                    Ok(Ok(part)) => merged.extend(part),
                    Ok(Err(e)) => {
                        if open_err.is_none() {
                            open_err = Some(e);
                        }
                    }
                    Err(je) => {
                        if open_err.is_none() {
                            open_err = Some(internal_not_committed(
                                "local_cas_open_batch_join",
                                je.to_string(),
                            ));
                        }
                    }
                }
            }
            if let Some(err) = open_err {
                drop(merged);
                return Err(err);
            }
            merged
        };

        let open_count = entries.iter().filter(|e| e.temp_file.is_some()).count();
        if open_count == 0 {
            return Ok(entries);
        }

        if open_count == 1 {
            let synced = tokio::task::spawn_blocking(move || -> Result<_, PortError> {
                for entry in &mut entries {
                    if let Some(tf) = &mut entry.temp_file {
                        tf.sync_data_only()?;
                    }
                }
                Ok(entries)
            })
            .await
            .map_err(|err| internal_not_committed("local_cas_publish_join", err.to_string()))??;
            return Ok(synced);
        }

        // Step A1: parallel `fdatasync` across all open `.part` files so ext4 JBD2 coalesces them into 1 commit!
        let mut passthrough = Vec::new();
        let mut join_set = tokio::task::JoinSet::new();
        for mut entry in entries {
            if entry.temp_file.is_some() {
                join_set.spawn_blocking(move || {
                    if let Some(tf) = &mut entry.temp_file {
                        tf.sync_data_only()?;
                    }
                    Ok::<_, PortError>(entry)
                });
            } else {
                passthrough.push(entry);
            }
        }

        let mut synced_entries = passthrough;
        let mut first_err: Option<PortError> = None;
        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(entry)) => synced_entries.push(entry),
                Ok(Err(err)) => {
                    if first_err.is_none() {
                        first_err = Some(err);
                    }
                }
                Err(join_err) => {
                    if first_err.is_none() {
                        first_err = Some(internal_not_committed(
                            "local_cas_publish_join",
                            join_err.to_string(),
                        ));
                    }
                }
            }
        }
        if let Some(err) = first_err {
            drop(synced_entries);
            return Err(err);
        }

        Ok(synced_entries)
    }

    /// Wave A2: atomically renames ONLY `.staging/*.part` files whose `(space_id, digest)` succeeded
    /// in SQL Stage 1 (`retained_keys`) into `blobs/`, dropping and unlinking any rolled-back items.
    /// Appends every `(space_id, digest)` newly renamed into `blobs/` to `published_out` (including
    /// partial renames before an I/O error) so callers can run `cleanup_unretained_local_files_async`
    /// AFTER SQL rollback and AFTER dropping their `StagedBlobTicket`s.
    pub(crate) async fn rename_synced_local_entries_async(
        &self,
        synced_entries: Vec<PreparedLocalStagingEntry>,
        retained_keys: &HashSet<(String, ContentDigest)>,
        published_out: &mut Vec<(SpaceId, ContentDigest)>,
    ) -> Result<PendingDirSyncs, PortError> {
        let mut extra_dirs = PendingDirSyncs::default();
        let mut to_rename: Vec<(SpaceId, ContentDigest, local::DeferredLocalTempFile)> =
            Vec::with_capacity(synced_entries.len());
        let mut to_unlink = Vec::new();
        let mut seen_renamed: HashSet<(String, ContentDigest)> =
            HashSet::with_capacity(synced_entries.len());

        for entry in synced_entries {
            let key = (entry.space_id_str, entry.digest);
            if retained_keys.contains(&key) {
                extra_dirs.merge(&entry.item_dirs);
                if let Some(tf) = entry.temp_file {
                    if seen_renamed.insert(key) {
                        to_rename.push((entry.space_id, entry.digest, tf));
                    } else {
                        to_unlink.push(tf);
                    }
                }
            } else if let Some(tf) = entry.temp_file {
                to_unlink.push(tf);
            }
        }

        if !to_unlink.is_empty() {
            tokio::task::spawn_blocking(move || drop(to_unlink))
                .await
                .map_err(|err| {
                    internal_not_committed("local_cas_unlink_batch_join", err.to_string())
                })?;
        }
        if to_rename.len() <= 8 {
            if !to_rename.is_empty() {
                let (published, err) = tokio::task::spawn_blocking(move || {
                    let mut done = Vec::with_capacity(to_rename.len());
                    for (space_id, digest, tf) in to_rename {
                        if let Err(e) = tf.rename_into_place() {
                            return (done, Some(e));
                        }
                        done.push((space_id, digest));
                    }
                    (done, None)
                })
                .await
                .map_err(|err| {
                    internal_not_committed("local_cas_rename_batch_join", err.to_string())
                })?;
                published_out.extend(published);
                if let Some(err) = err {
                    return Err(err);
                }
            }
        } else {
            let chunk_size = to_rename.len().div_ceil(16);
            let mut ren_set = tokio::task::JoinSet::new();
            let mut iter = to_rename.into_iter();
            loop {
                let chunk: Vec<_> = iter.by_ref().take(chunk_size).collect();
                if chunk.is_empty() {
                    break;
                }
                ren_set.spawn_blocking(move || {
                    let mut done = Vec::with_capacity(chunk.len());
                    for (space_id, digest, tf) in chunk {
                        if let Err(e) = tf.rename_into_place() {
                            return (done, Some(e));
                        }
                        done.push((space_id, digest));
                    }
                    (done, None)
                });
            }
            let mut first_err: Option<PortError> = None;
            while let Some(res) = ren_set.join_next().await {
                match res {
                    Ok((done, None)) => published_out.extend(done),
                    Ok((done, Some(e))) => {
                        published_out.extend(done);
                        if first_err.is_none() {
                            first_err = Some(e);
                        }
                    }
                    Err(je) => {
                        if first_err.is_none() {
                            first_err = Some(internal_not_committed(
                                "local_cas_rename_batch_join",
                                je.to_string(),
                            ));
                        }
                    }
                }
            }
            if let Some(err) = first_err {
                return Err(err);
            }
        }

        Ok(extra_dirs)
    }

    /// Sequential Wave A0 + A1 + A2 helper used by async `execute_batch_on_conn`.
    pub(crate) async fn publish_deferred_local_tickets_async(
        &self,
        tickets: &[StagedBlobTicket],
        published_out: &mut Vec<(SpaceId, ContentDigest)>,
    ) -> Result<PendingDirSyncs, PortError> {
        let mut pending_stagings = Vec::new();
        let mut retained_keys = HashSet::with_capacity(tickets.len());
        for ticket in tickets {
            if let Some(key) = &ticket.deferred_local_key {
                retained_keys.insert(key.clone());
            }
            if let Some(deferred) = ticket.take_deferred_local_staging() {
                pending_stagings.push(deferred);
            }
        }
        if pending_stagings.is_empty() {
            return Ok(PendingDirSyncs::default());
        }
        let synced = self
            .prepare_and_sync_local_stagings_async(pending_stagings)
            .await?;
        self.rename_synced_local_entries_async(synced, &retained_keys, published_out)
            .await
    }

    /// Attempts to prepare a verified local CAS read inside an already-open read transaction
    /// without checking out a second pool connection.
    pub(crate) async fn try_prepare_local_blob_read_in_tx(
        &self,
        tx: &mut BackendConn<'_>,
        space_id: &SpaceId,
        digest: ContentDigest,
    ) -> Result<Option<FastLocalBlobReadPlan>, PortError> {
        let BlobBackendDriver::Local(local) = &self.inner.blobs else {
            return Ok(None);
        };
        let Some(guard) = local.try_acquire_shared_guard(space_id, digest) else {
            return Ok(None);
        };
        let meta = load_active_blob_meta_tx(tx, space_id, digest).await?;
        Ok(Some(FastLocalBlobReadPlan {
            local: Arc::clone(local),
            space_id: space_id.clone(),
            digest,
            raw_size: meta.raw_size,
            _guard: guard,
        }))
    }

    /// Stages multiple prepared blobs in canonical sorted `ContentDigest` lock order.
    pub async fn stage_blobs_sorted(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared_items: &[PreparedBlobSource],
    ) -> Result<Vec<StagedBlobTicket>, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        for item in prepared_items {
            if item.codec != self.blob_codec() {
                return Err(internal_not_committed(
                    "blob_codec_mismatch",
                    "PreparedBlobSource codec does not match store backend",
                ));
            }
        }

        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let digests: Vec<ContentDigest> = prepared_items.iter().map(|p| p.digest).collect();
                let guards = local
                    .acquire_shared_guards_sorted(&scope.space_id, &digests)
                    .await;
                let mut tickets = Vec::with_capacity(prepared_items.len());
                for item in prepared_items {
                    let guard = guards.get(&item.digest).cloned().ok_or_else(|| {
                        internal_not_committed("missing_sorted_guard", "digest guard missing")
                    })?;
                    tickets.push(
                        self.stage_local_blob_with_guard(local, scope, active_epoch, item, guard)
                            .await?,
                    );
                }
                Ok(tickets)
            }
            BlobBackendDriver::S3(s3) => {
                let mut tickets = Vec::with_capacity(prepared_items.len());
                for item in prepared_items {
                    tickets.push(self.stage_s3_blob(s3, scope, active_epoch, item).await?);
                }
                Ok(tickets)
            }
        }
    }

    /// Stages a prepared CAS payload durably before metadata commit, honoring Space epoch & admission.
    pub async fn stage_blob(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
    ) -> Result<StagedBlobTicket, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        if prepared.codec != self.blob_codec() {
            return Err(internal_not_committed(
                "blob_codec_mismatch",
                "PreparedBlobSource codec does not match store backend",
            ));
        }

        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let guard = local
                    .acquire_shared_guard(&scope.space_id, prepared.digest)
                    .await;
                self.stage_local_blob_with_guard(local, scope, active_epoch, prepared, guard)
                    .await
            }
            BlobBackendDriver::S3(s3) => {
                self.stage_s3_blob(s3, scope, active_epoch, prepared).await
            }
        }
    }

    /// Stages multiple prepared CAS payloads for execution inside `WriteBatchActor` in canonical
    /// sorted, deduplicated `ContentDigest` order so multi-blob batches (`accept_batch`,
    /// `publish_ability_package`) never acquire `LocalSharedGuard` re-entrantly or out-of-order.
    pub(crate) async fn stage_blobs_for_batch_sorted(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared_items: &[&PreparedBlobSource],
    ) -> Result<HashMap<ContentDigest, StagedBlobTicket>, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        if prepared_items.is_empty() {
            return Ok(HashMap::new());
        }
        let mut unique: Vec<&PreparedBlobSource> = Vec::with_capacity(prepared_items.len());
        let mut seen: HashSet<ContentDigest> = HashSet::with_capacity(prepared_items.len());
        for &item in prepared_items {
            if item.codec != self.blob_codec() {
                return Err(internal_not_committed(
                    "blob_codec_mismatch",
                    "PreparedBlobSource codec does not match store backend",
                ));
            }
            if seen.insert(item.digest) {
                unique.push(item);
            }
        }
        unique.sort_unstable_by_key(|item| item.digest);

        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let digests: Vec<ContentDigest> = unique.iter().map(|p| p.digest).collect();
                let guards = local
                    .acquire_shared_guards_sorted(&scope.space_id, &digests)
                    .await;
                let scope_cl = scope.clone();
                let digests_cl = digests.clone();
                let existing_pubs: HashMap<ContentDigest, String> = self
                    .with_read_tx(|tx| {
                        Box::pin(async move {
                            let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                            space_rec.scope.check(&scope_cl)?;
                            if space_rec.active_epoch != active_epoch {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidAuthority,
                                )
                                .into());
                            }
                            let mut pubs = HashMap::new();
                            for digest in digests_cl {
                                if let Some(pub_id) =
                                    check_local_catalog_open_read_tx(tx, &scope_cl.space_id, digest)
                                        .await?
                                {
                                    pubs.insert(digest, pub_id);
                                }
                            }
                            Ok(pubs)
                        })
                    })
                    .await?;

                let mut out = HashMap::with_capacity(unique.len());
                for item in unique {
                    let guard = guards.get(&item.digest).cloned().ok_or_else(|| {
                        internal_not_committed("missing_sorted_guard", "digest guard missing")
                    })?;
                    let frame = Arc::clone(item.local_frame.as_ref().ok_or_else(|| {
                        internal_not_committed("missing_local_frame", "local frame not prepared")
                    })?);
                    let deferred = DeferredLocalStaging::new(
                        Arc::clone(local),
                        scope.space_id.clone(),
                        item.digest,
                        item.raw_size,
                        frame,
                    );
                    let pub_id = match existing_pubs.get(&item.digest) {
                        Some(id) => id.clone(),
                        None => new_prefixed_hex_id("pub_")?,
                    };
                    out.insert(
                        item.digest,
                        StagedBlobTicket {
                            space_id: scope.space_id.clone(),
                            incarnation: scope.incarnation,
                            epoch: active_epoch,
                            digest: item.digest,
                            raw_size: item.raw_size,
                            compressed_size: item.total_compressed_size,
                            publication_id: pub_id,
                            codec: BlobCodecTag::LocalZstdV1,
                            discard: None,
                            local_pending_dirs: PendingDirSyncs::default(),
                            _local_guard: Some(guard),
                            deferred_local_key: Some((
                                scope.space_id.as_str().to_owned(),
                                item.digest,
                            )),
                            deferred_local_publish: Some(Arc::new(std::sync::Mutex::new(Some(
                                deferred,
                            )))),
                        },
                    );
                }
                Ok(out)
            }
            BlobBackendDriver::S3(s3) => {
                let mut out = HashMap::with_capacity(unique.len());
                for item in unique {
                    let ticket = self
                        .stage_owned_s3_blob(s3, scope, active_epoch, item)
                        .await?;
                    out.insert(item.digest, ticket);
                }
                Ok(out)
            }
        }
    }

    /// Stages a prepared CAS payload for execution inside `WriteBatchActor`, deferring local
    /// `fdatasync` + atomic `rename` to the batch's coalesced Wave A before directory `fsync` and SQL `COMMIT`.
    pub(crate) async fn stage_blob_for_batch(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
    ) -> Result<StagedBlobTicket, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        if prepared.codec != self.blob_codec() {
            return Err(internal_not_committed(
                "blob_codec_mismatch",
                "PreparedBlobSource codec does not match store backend",
            ));
        }

        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let guard = local
                    .acquire_shared_guard(&scope.space_id, prepared.digest)
                    .await;
                let scope_cl = scope.clone();
                let digest = prepared.digest;
                let raw_size = prepared.raw_size;
                let comp_size = prepared.total_compressed_size;

                let existing_pub: Option<String> = self
                    .with_read_tx(|tx| {
                        Box::pin(async move {
                            let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                            space_rec.scope.check(&scope_cl)?;
                            if space_rec.active_epoch != active_epoch {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidAuthority,
                                )
                                .into());
                            }
                            check_local_catalog_open_read_tx(tx, &scope_cl.space_id, digest).await
                        })
                    })
                    .await?;

                let frame = Arc::clone(prepared.local_frame.as_ref().ok_or_else(|| {
                    internal_not_committed("missing_local_frame", "local frame not prepared")
                })?);
                let presync_in_phase1 = comp_size <= 64 * 1024
                    && self
                        .inner
                        .writer_coord
                        .get()
                        .is_some_and(|w| w.active_sqlite_ops_count() >= 32);

                let deferred = if presync_in_phase1 {
                    let sp_str = scope.space_id.as_str().to_owned();
                    let (item_dirs, temp_file) = local.stage_physical_file_deferred(
                        &scope.space_id,
                        digest,
                        raw_size,
                        &frame,
                    )?;
                    DeferredLocalStaging::new_presynced(
                        Arc::clone(local),
                        scope.space_id.clone(),
                        digest,
                        raw_size,
                        frame,
                        PreparedLocalStagingEntry {
                            space_id: scope.space_id.clone(),
                            space_id_str: sp_str,
                            digest,
                            item_dirs,
                            temp_file,
                        },
                    )
                } else {
                    DeferredLocalStaging::new(
                        Arc::clone(local),
                        scope.space_id.clone(),
                        digest,
                        raw_size,
                        frame,
                    )
                };

                let pub_id = match existing_pub {
                    Some(id) => id,
                    None => new_prefixed_hex_id("pub_")?,
                };

                Ok(StagedBlobTicket {
                    space_id: scope.space_id.clone(),
                    incarnation: scope.incarnation,
                    epoch: active_epoch,
                    digest,
                    raw_size,
                    compressed_size: comp_size,
                    publication_id: pub_id,
                    codec: BlobCodecTag::LocalZstdV1,
                    discard: None,
                    local_pending_dirs: PendingDirSyncs::default(),
                    _local_guard: Some(guard),
                    deferred_local_key: Some((scope.space_id.as_str().to_owned(), digest)),
                    deferred_local_publish: Some(Arc::new(std::sync::Mutex::new(Some(deferred)))),
                })
            }
            BlobBackendDriver::S3(s3) => {
                self.stage_owned_s3_blob(s3, scope, active_epoch, prepared)
                    .await
            }
        }
    }

    /// Stages a prepared CAS payload for `WriteBatchActor` when the caller has ALREADY validated
    /// `SpaceRecord` (`scope` + `active_epoch`) in Phase 1. On `LocalZstdV1`, Phase 1 acquires
    /// `LocalSharedGuard` in canonical lock order without blocking Tokio async worker threads on
    /// filesystem `O_CREAT`, while Phase-2 SQL `activate_and_bind_blob_ref` authoritatively enforces
    /// `active_epoch` and `admission_state = 'open'` before Wave A materializes, syncs, and renames `.part`.
    pub(crate) async fn stage_blob_for_batch_prechecked(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
    ) -> Result<StagedBlobTicket, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        if prepared.codec != self.blob_codec() {
            return Err(internal_not_committed(
                "blob_codec_mismatch",
                "PreparedBlobSource codec does not match store backend",
            ));
        }

        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let guard = local
                    .acquire_shared_guard(&scope.space_id, prepared.digest)
                    .await;
                let digest = prepared.digest;
                let raw_size = prepared.raw_size;
                let comp_size = prepared.total_compressed_size;
                let frame = Arc::clone(prepared.local_frame.as_ref().ok_or_else(|| {
                    internal_not_committed("missing_local_frame", "local frame not prepared")
                })?);
                let presync_in_phase1 = comp_size <= 64 * 1024
                    && self
                        .inner
                        .writer_coord
                        .get()
                        .is_some_and(|w| w.active_sqlite_ops_count() >= 32);

                let deferred = if presync_in_phase1 {
                    let sp_str = scope.space_id.as_str().to_owned();
                    let (item_dirs, temp_file) = local.stage_physical_file_deferred(
                        &scope.space_id,
                        digest,
                        raw_size,
                        &frame,
                    )?;
                    DeferredLocalStaging::new_presynced(
                        Arc::clone(local),
                        scope.space_id.clone(),
                        digest,
                        raw_size,
                        frame,
                        PreparedLocalStagingEntry {
                            space_id: scope.space_id.clone(),
                            space_id_str: sp_str,
                            digest,
                            item_dirs,
                            temp_file,
                        },
                    )
                } else {
                    DeferredLocalStaging::new(
                        Arc::clone(local),
                        scope.space_id.clone(),
                        digest,
                        raw_size,
                        frame,
                    )
                };

                let pub_id = new_prefixed_hex_id("pub_")?;
                Ok(StagedBlobTicket {
                    space_id: scope.space_id.clone(),
                    incarnation: scope.incarnation,
                    epoch: active_epoch,
                    digest,
                    raw_size,
                    compressed_size: comp_size,
                    publication_id: pub_id,
                    codec: BlobCodecTag::LocalZstdV1,
                    discard: None,
                    local_pending_dirs: PendingDirSyncs::default(),
                    _local_guard: Some(guard),
                    deferred_local_key: Some((scope.space_id.as_str().to_owned(), digest)),
                    deferred_local_publish: Some(Arc::new(std::sync::Mutex::new(Some(deferred)))),
                })
            }
            BlobBackendDriver::S3(s3) => {
                self.stage_owned_s3_blob(s3, scope, active_epoch, prepared)
                    .await
            }
        }
    }

    async fn stage_local_blob_with_guard(
        &self,
        local: &Arc<LocalBlobStore>,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
        guard: Arc<LocalSharedGuard>,
    ) -> Result<StagedBlobTicket, PortError> {
        let scope_cl = scope.clone();
        let digest = prepared.digest;
        let raw_size = prepared.raw_size;
        let comp_size = prepared.total_compressed_size;

        // Read-only Space authority + admission check in Phase 1 (allows full 50-writer parallel staging!).
        let existing_pub: Option<String> = self
            .with_read_tx(|tx| {
                Box::pin(async move {
                    let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                    space_rec.scope.check(&scope_cl)?;
                    if space_rec.active_epoch != active_epoch {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    check_local_catalog_open_read_tx(tx, &scope_cl.space_id, digest).await
                })
            })
            .await?;

        let frame = Arc::clone(prepared.local_frame.as_ref().ok_or_else(|| {
            internal_not_committed("missing_local_frame", "local frame not prepared")
        })?);
        let local_cl = Arc::clone(local);
        let space_id_cl = scope.space_id.clone();
        let pending_dirs = tokio::task::spawn_blocking(move || {
            local_cl.stage_physical_file(&space_id_cl, digest, raw_size, &frame)
        })
        .await
        .map_err(|err| internal_not_committed("local_cas_stage_join", err.to_string()))??;

        let pub_id = match existing_pub {
            Some(id) => id,
            None => new_prefixed_hex_id("pub_")?,
        };

        Ok(StagedBlobTicket {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            epoch: active_epoch,
            digest,
            raw_size,
            compressed_size: comp_size,
            publication_id: pub_id,
            codec: BlobCodecTag::LocalZstdV1,
            discard: None,
            local_pending_dirs: pending_dirs,
            _local_guard: Some(guard),
            deferred_local_key: None,
            deferred_local_publish: None,
        })
    }

    async fn stage_s3_blob(
        &self,
        s3: &S3BlobStore,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
    ) -> Result<StagedBlobTicket, PortError> {
        self.stage_s3_publication(s3, scope, active_epoch, prepared, None)
            .await
    }

    async fn stage_owned_s3_blob(
        &self,
        s3: &S3BlobStore,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
    ) -> Result<StagedBlobTicket, PortError> {
        let discard = Arc::new(PublicationDiscard {
            store: self.clone(),
            scope: scope.clone(),
            epoch,
            publication: new_prefixed_hex_id("pub_")?,
            finished: Default::default(),
        });
        let staged = self
            .stage_s3_publication(s3, scope, epoch, prepared, Some(&discard.publication))
            .await;
        match staged {
            Ok(mut ticket) => {
                if ticket.publication_id == discard.publication {
                    ticket.discard = Some(discard);
                } else {
                    // Reusing a committed publication created no private keys or discard intent.
                    discard
                        .finished
                        .store(true, std::sync::atomic::Ordering::Release);
                }
                Ok(ticket)
            }
            Err(error) => {
                discard.finish().await?;
                Err(error)
            }
        }
    }

    pub(crate) fn retirement_handoff(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        ids: Vec<String>,
        first_attempt: Option<retirement_worker::HandoffSender>,
    ) -> RetirementHandoff {
        RetirementHandoff {
            store: self.clone(),
            scope: scope.clone(),
            epoch,
            ids,
            first_attempt,
        }
    }

    async fn discard_publication(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        publication: &str,
    ) -> Result<(), PortError> {
        match self
            .drive_retirement_to_completion(scope, epoch, publication)
            .await
        {
            // A successful bind removed the provisional discard in the same transaction.
            Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(()),
            result => result,
        }
    }

    async fn stage_s3_publication(
        &self,
        s3: &S3BlobStore,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        prepared: &PreparedBlobSource,
        provisional_publication: Option<&str>,
    ) -> Result<StagedBlobTicket, PortError> {
        s3.verify_runtime_bucket_mode().await?;

        let provisional = provisional_publication.is_some();
        let pub_id = match provisional_publication {
            Some(id) => id.to_owned(),
            None => new_prefixed_hex_id("pub_")?,
        };
        let scope_cl = scope.clone();
        let prepared_cl = prepared.clone();
        let pub_id_cl = pub_id.clone();
        let app_prefix = s3.application_prefix().to_owned();

        // Step 1: Under Space lock + active_epoch, either reuse an Active publication OR durably
        // register the Staging publication and ALL part keys BEFORE sending any HTTP PUT!
        let registration = self
            .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                Box::pin(async move {
                    lock_and_check_space_tx(tx, &scope_cl, active_epoch).await?;
                    let registration = register_s3_staging_or_reuse_tx(
                        tx,
                        &scope_cl.space_id,
                        active_epoch,
                        &prepared_cl,
                        &pub_id_cl,
                        &app_prefix,
                    )
                    .await?;
                    if provisional && matches!(registration, S3StageRegistration::NewStaging { .. })
                    {
                        record_publication_discard_tx(tx, &scope_cl, active_epoch, &pub_id_cl)
                            .await?;
                    }
                    Ok(registration)
                })
            })
            .await?;

        let registered_parts = match registration {
            S3StageRegistration::ReusedActive { publication_id } => {
                return Ok(StagedBlobTicket {
                    space_id: scope.space_id.clone(),
                    incarnation: scope.incarnation,
                    epoch: active_epoch,
                    digest: prepared.digest,
                    raw_size: prepared.raw_size,
                    compressed_size: prepared.total_compressed_size,
                    publication_id,
                    codec: BlobCodecTag::S3ChunkedV1,
                    discard: None,
                    local_pending_dirs: PendingDirSyncs::default(),
                    _local_guard: None,
                    deferred_local_key: None,
                    deferred_local_publish: None,
                });
            }
            S3StageRegistration::NewStaging { parts } => parts,
        };

        // Step 2: Upload each registered part via `If-None-Match: *` and record upload_confirmed.
        for (part, physical_key) in prepared.s3_parts.iter().zip(registered_parts.iter()) {
            let observed_vid = s3
                .put_part_if_absent_or_reconcile(physical_key, part)
                .await?;

            let scope_part = scope.clone();
            let pub_part = pub_id.clone();
            let part_idx = part.part_index;
            let digest = prepared.digest;
            self.with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                Box::pin(async move {
                    lock_and_check_space_tx(tx, &scope_part, active_epoch).await?;
                    confirm_s3_part_uploaded_tx(
                        tx,
                        &scope_part.space_id,
                        active_epoch,
                        digest,
                        &pub_part,
                        part_idx,
                        observed_vid.as_deref(),
                    )
                    .await
                })
            })
            .await?;
        }

        Ok(StagedBlobTicket {
            space_id: scope.space_id.clone(),
            incarnation: scope.incarnation,
            epoch: active_epoch,
            digest: prepared.digest,
            raw_size: prepared.raw_size,
            compressed_size: prepared.total_compressed_size,
            publication_id: pub_id,
            codec: BlobCodecTag::S3ChunkedV1,
            discard: None,
            local_pending_dirs: PendingDirSyncs::default(),
            _local_guard: None,
            deferred_local_key: None,
            deferred_local_publish: None,
        })
    }

    /// Reads and cryptographically verifies a canonical blob (`length` + bounded Zstd + `BLAKE3`).
    pub async fn read_verified_blob(
        &self,
        scope: &HistoryScope,
        digest: ContentDigest,
    ) -> Result<Vec<u8>, PortError> {
        self.read_verified_blob_with_budget(scope, digest, None)
            .await
    }

    pub(crate) async fn read_verified_blob_with_budget(
        &self,
        scope: &HistoryScope,
        digest: ContentDigest,
        budget: Option<&CallBudget>,
    ) -> Result<Vec<u8>, PortError> {
        match &self.inner.blobs {
            BlobBackendDriver::Local(local) => {
                let started = tokio::time::Instant::now();
                let guard = local.acquire_shared_guard(&scope.space_id, digest).await;
                let budget = budget.cloned().map(|mut budget| {
                    budget.remaining = budget.remaining.saturating_sub(started.elapsed());
                    budget
                });
                let scope_cl = scope.clone();
                let meta = self
                    .with_read_tx_budget(budget.as_ref(), |tx| {
                        Box::pin(async move {
                            let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                            space_rec.scope.check(&scope_cl)?;
                            load_active_blob_meta_tx(tx, &scope_cl.space_id, digest).await
                        })
                    })
                    .await?;
                FastLocalBlobReadPlan::new(
                    Arc::clone(local),
                    scope.space_id.clone(),
                    digest,
                    meta.raw_size,
                    guard,
                )
                .read_verified_async()
                .await
            }
            BlobBackendDriver::S3(s3) => {
                let scope_cl = scope.clone();
                let (meta, parts) = self
                    .with_read_tx_budget(budget, |tx| {
                        Box::pin(async move {
                            let space_rec = load_space_record(tx, &scope_cl.space_id).await?;
                            space_rec.scope.check(&scope_cl)?;
                            let meta =
                                load_active_blob_meta_tx(tx, &scope_cl.space_id, digest).await?;
                            let pub_id = meta.publication_id.clone().ok_or_else(|| {
                                internal_not_committed(
                                    "missing_s3_publication_id",
                                    "active S3 blob missing current_publication_id",
                                )
                            })?;
                            let parts = load_s3_manifest_parts_tx(
                                tx,
                                &scope_cl.space_id,
                                &pub_id,
                                meta.part_count,
                            )
                            .await?;
                            Ok((meta, parts))
                        })
                    })
                    .await?;
                s3.read_verified_chunked(digest, meta.raw_size, &parts)
                    .await
            }
        }
    }

    /// Retires zero-ref digests in `scope` (`Purge` or `Gc`), fencing stale PUT/DELETE and preserving shared refs.
    pub async fn retire_zero_ref_digests(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        digests: &[ContentDigest],
        reason: RetirementReason,
        purge_id: Option<&str>,
    ) -> Result<Vec<String>, PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;
        let mut unique_digests = BTreeSet::new();
        for d in digests {
            unique_digests.insert(*d);
        }
        if unique_digests.is_empty() {
            return Ok(Vec::new());
        }

        if let BlobBackendDriver::S3(s3) = &self.inner.blobs {
            s3.verify_runtime_bucket_mode().await?;
        }

        let scope_cl = scope.clone();
        let purge_opt = purge_id.map(str::to_owned);
        let digests_vec: Vec<ContentDigest> = unique_digests.into_iter().collect();

        let local_opt = match &self.inner.blobs {
            BlobBackendDriver::Local(l) => Some(Arc::clone(l)),
            BlobBackendDriver::S3(_) => None,
        };

        // Step 1: Under the Space lock and epoch, seal zero-ref publications into `retiring`
        // and create durable `blob_retirements` + `blob_retirement_targets`.
        let worker = self.clone();
        let (notify, attempted) = tokio::sync::oneshot::channel();
        let (planned_retirements, handoff) = self
            .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                let scope_in = scope_cl.clone();
                let digests_in = digests_vec.clone();
                let purge_in = purge_opt.clone();
                let local_in = local_opt.clone();
                Box::pin(async move {
                    lock_and_check_space_tx(tx, &scope_in, active_epoch).await?;
                    if reason == RetirementReason::Purge {
                        ensure_no_backup_holds_tx(tx, &scope_in.space_id).await?;
                    }

                    let mut ids = Vec::new();
                    for digest in digests_in {
                        if let Some(ret_id) = initiate_digest_retirement_tx(
                            tx,
                            &scope_in,
                            active_epoch,
                            digest,
                            reason,
                            purge_in.as_deref(),
                            local_in.as_deref(),
                        )
                        .await?
                        {
                            ids.push(ret_id);
                        }
                    }
                    let handoff = (reason == RetirementReason::Gc && !ids.is_empty()).then(|| {
                        worker.retirement_handoff(
                            &scope_in,
                            active_epoch,
                            ids.clone(),
                            Some(notify),
                        )
                    });
                    Ok((ids, handoff))
                })
            })
            .await?;

        if let Some(handoff) = handoff {
            drop(handoff);
            retirement_worker::handoff_outcome(attempted).await?;
        } else {
            for ret_id in &planned_retirements {
                self.drive_retirement_to_completion(scope, active_epoch, ret_id)
                    .await?;
            }
        }

        Ok(planned_retirements)
    }

    /// Drives an existing durable `blob_retirements` record (including after restart/takeover) to `completed`.
    pub async fn drive_retirement_to_completion(
        &self,
        scope: &HistoryScope,
        active_epoch: LeaseEpoch,
        retirement_id: &str,
    ) -> Result<(), PortError> {
        self.inner
            .check_writer_epoch(&scope.space_id, active_epoch)?;

        let scope_cl = scope.clone();
        let ret_cl = retirement_id.to_owned();
        let (reason, targets) = self
            .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                let scope_in = scope_cl.clone();
                let ret_in = ret_cl.clone();
                Box::pin(async move {
                    lock_and_check_space_tx(tx, &scope_in, active_epoch).await?;
                    let result =
                        load_pending_retirement_targets_tx(tx, &scope_in, active_epoch, &ret_in)
                            .await?;
                    if result
                        .1
                        .first()
                        .is_some_and(|part| part.publication_id == ret_in)
                    {
                        const SEAL: &str = "UPDATE blob_publications SET state='retiring'
                            WHERE space_id=$1 AND publication_id=$2 AND state='staging'";
                        match tx {
                            BackendConn::Sqlite(conn) => sqlx::query(SEAL)
                                .bind(scope_in.space_id.as_str())
                                .bind(&ret_in)
                                .execute(&mut **conn)
                                .await
                                .map(|_| ()),
                            BackendConn::Postgres(conn) => sqlx::query(SEAL)
                                .bind(scope_in.space_id.as_str())
                                .bind(&ret_in)
                                .execute(&mut **conn)
                                .await
                                .map(|_| ()),
                        }
                        .map_err(|err| {
                            internal_not_committed("seal_discarded_publication", err.to_string())
                        })?;
                    } else if !result.1.is_empty() {
                        ensure_no_backup_holds_tx(tx, &scope_in.space_id).await?;
                    }
                    Ok(result)
                })
            })
            .await?;

        if targets.is_empty() {
            return Ok(());
        }
        if let BlobBackendDriver::S3(s3) = &self.inner.blobs {
            s3.verify_runtime_bucket_mode().await?;
        }
        for target in targets {
            if target.target_completed {
                continue;
            }
            match (&self.inner.blobs, target.codec) {
                (BlobBackendDriver::Local(local), BlobCodecTag::LocalZstdV1) => {
                    let guard = local
                        .acquire_exclusive_guard(&scope.space_id, target.digest)
                        .await;
                    // Re-verify zero refs & zero holds while holding exclusive local guard!
                    let scope_chk = scope.clone();
                    let digest = target.digest;
                    let target_retirement = retirement_id.to_owned();
                    let still_pending = self
                        .with_read_tx(|tx| {
                            Box::pin(async move {
                                let space = load_space_record(tx, &scope_chk.space_id).await?;
                                space.scope.check(&scope_chk)?;
                                if space.active_epoch != active_epoch {
                                    return Err(DomainError::validation(
                                        ValidationReason::InvalidAuthority,
                                    )
                                    .into());
                                }
                                let current =
                                    pending_retirement_for_digest_tx(tx, &scope_chk, digest)
                                        .await?;
                                if current.as_deref() != Some(target_retirement.as_str()) {
                                    return Ok(false);
                                }
                                ensure_no_backup_holds_tx(tx, &scope_chk.space_id).await?;
                                ensure_zero_reachable_refs_tx(tx, &scope_chk.space_id, digest)
                                    .await?;
                                Ok(true)
                            })
                        })
                        .await?;
                    if !still_pending {
                        continue;
                    }

                    local.delete_physical_file(&scope.space_id, target.digest)?;
                    drop(guard);

                    let scope_done = scope.clone();
                    let ret_done = retirement_id.to_owned();
                    let pub_done = target.publication_id.clone();
                    let part_idx = target.part_index;
                    self.with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                        Box::pin(async move {
                            lock_and_check_space_tx(tx, &scope_done, active_epoch).await?;
                            mark_retirement_target_completed_tx(
                                tx,
                                &scope_done.space_id,
                                &ret_done,
                                &pub_done,
                                part_idx,
                            )
                            .await
                        })
                    })
                    .await?;
                }
                (BlobBackendDriver::S3(s3), BlobCodecTag::S3ChunkedV1) => {
                    let marker = TerminalMarkerMeta {
                        space_id: scope.space_id.as_str().to_owned(),
                        publication_id: target.publication_id.clone(),
                        part_index: target.part_index,
                        retirement_id: retirement_id.to_owned(),
                        reason,
                    };
                    s3.execute_target_retirement(
                        self,
                        scope,
                        active_epoch,
                        retirement_id,
                        &target,
                        &marker,
                    )
                    .await?;
                }
                (BlobBackendDriver::S3(_), BlobCodecTag::LocalZstdV1)
                    if target.publication_id == "local_unstaged" =>
                {
                    // Older duplicate GC attempts recorded a local placeholder after every S3
                    // publication had already been retired. Accept only that proven empty case.
                    let scope_done = scope.clone();
                    let ret_done = retirement_id.to_owned();
                    self.with_write_tx_for_space(Some(scope.space_id.clone()), |tx| Box::pin(async move {
                        lock_and_check_space_tx(tx, &scope_done, active_epoch).await?;
                        const OWNERS: &str = "SELECT COUNT(*), COUNT(*) FILTER (WHERE codec <> 's3_chunked_v1' OR state <> 'retired')
                            FROM blob_publications WHERE space_id = $1 AND content_blake3 = $2";
                        let (total, mismatches): (i64, i64) = match tx {
                            BackendConn::Sqlite(conn) => sqlx::query_as(OWNERS).bind(scope_done.space_id.as_str()).bind(target.digest.as_bytes().as_slice()).fetch_one(&mut **conn).await,
                            BackendConn::Postgres(conn) => sqlx::query_as(OWNERS).bind(scope_done.space_id.as_str()).bind(target.digest.as_bytes().as_slice()).fetch_one(&mut **conn).await,
                        }.map_err(|err| internal_not_committed("verify_empty_retirement",err.to_string()))?;
                        if total == 0 || mismatches != 0 {
                            return Err(internal_not_committed("retirement_backend_mismatch", "local placeholder lacks a retired S3 publication history"));
                        }
                        mark_retirement_target_completed_tx(tx, &scope_done.space_id, &ret_done, &target.publication_id, target.part_index).await
                    })).await?;
                }
                _ => {
                    return Err(internal_not_committed(
                        "retirement_backend_mismatch",
                        "retirement target codec does not match active blob backend",
                    ));
                }
            }
        }

        let scope_fin = scope.clone();
        let ret_fin = retirement_id.to_owned();
        self.with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
            Box::pin(async move {
                lock_and_check_space_tx(tx, &scope_fin, active_epoch).await?;
                finalize_retirement_tx(tx, &scope_fin.space_id, &ret_fin).await
            })
        })
        .await
    }
}

pub(crate) enum S3StageRegistration {
    ReusedActive { publication_id: String },
    NewStaging { parts: Vec<String> },
}

#[derive(Clone, Debug)]
pub(crate) struct ActiveBlobMeta {
    pub raw_size: u64,
    pub publication_id: Option<String>,
    pub part_count: u32,
}

#[derive(Clone, Debug)]
pub struct S3ManifestPart {
    pub part_index: u32,
    pub raw_size: u64,
    pub compressed_size: u64,
    pub part_blake3: ContentDigest,
    pub physical_key: String,
}

#[derive(Clone, Debug)]
pub struct RetirementTargetRow {
    pub publication_id: String,
    pub part_index: u32,
    pub digest: ContentDigest,
    pub codec: BlobCodecTag,
    pub physical_key: String,
    pub marker_verified: bool,
    pub data_version_ids: Option<Vec<String>>,
    pub versions_deleted: bool,
    pub target_completed: bool,
}

pub(crate) async fn lock_and_check_space_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    expected_epoch: LeaseEpoch,
) -> Result<crate::SpaceRecord, PortError> {
    if let BackendConn::Postgres(conn) = tx {
        let locked: Option<i64> =
            sqlx::query_scalar("SELECT active_epoch FROM spaces WHERE space_id = $1 FOR UPDATE")
                .bind(scope.space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_lock_space_row", err.to_string()))?;
        if locked.is_none() {
            return Err(DomainError::ResourceNotFound.into());
        }
    }
    let rec = load_space_record(tx, &scope.space_id).await?;
    rec.scope.check(scope)?;
    if rec.active_epoch != expected_epoch {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(rec)
}

pub(crate) fn held_retirement() -> PortError {
    unavailable_retryable(
        "backup_hold_active",
        "cannot retire or purge blobs while a backup hold is active",
        Duration::from_millis(100),
    )
}

pub(crate) async fn ensure_no_backup_holds_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<(), PortError> {
    let held: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar("SELECT 1 FROM backup_holds WHERE space_id = ? LIMIT 1")
                .bind(space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_check_backup_holds", err.to_string())
                })?
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar("SELECT 1::BIGINT FROM backup_holds WHERE space_id = $1 LIMIT 1")
                .bind(space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_check_backup_holds", err))?
        }
    };
    if held.is_some() {
        return Err(held_retirement());
    }
    Ok(())
}

async fn check_local_catalog_open_read_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    digest: ContentDigest,
) -> Result<Option<String>, PortError> {
    let existing: Option<(String, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_read_blob_catalog", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("admission_state"),
                    r.get("blob_state"),
                    r.get("current_publication_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_read_blob_catalog", err))?;
            row.map(|r| {
                (
                    r.get("admission_state"),
                    r.get("blob_state"),
                    r.get("current_publication_id"),
                )
            })
        }
    };

    if let Some((admission, state, pub_id)) = existing {
        if admission != "open" {
            return Err(unavailable_retryable(
                "blob_admission_retiring",
                "digest is currently retiring; retry after retirement completes",
                Duration::from_millis(25),
            ));
        }
        if state == "active" {
            return Ok(pub_id);
        }
    }
    Ok(None)
}

async fn ensure_local_catalog_open_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    digest: ContentDigest,
    raw_size: u64,
    compressed_size: u64,
) -> Result<Option<String>, PortError> {
    let now_ms = now_unix_ms()?;
    let existing: Option<(String, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_read_blob_catalog", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("admission_state"),
                    r.get("blob_state"),
                    r.get("current_publication_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_read_blob_catalog", err))?;
            row.map(|r| {
                (
                    r.get("admission_state"),
                    r.get("blob_state"),
                    r.get("current_publication_id"),
                )
            })
        }
    };

    if let Some((admission, state, pub_id)) = existing {
        if admission != "open" {
            return Err(unavailable_retryable(
                "blob_admission_retiring",
                "digest is currently retiring; retry after retirement completes",
                Duration::from_millis(25),
            ));
        }
        if state == "active" {
            return Ok(pub_id);
        }
        return Ok(None);
    }

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO blob_catalog (
                    space_id, content_blake3, raw_size, compressed_size, ref_count,
                    current_publication_id, admission_state, blob_state, touched_at_ms
                ) VALUES (?, ?, ?, ?, 0, NULL, 'open', 'staging', ?)",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .bind(raw_size as i64)
            .bind(compressed_size as i64)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_blob_catalog", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO blob_catalog (
                    space_id, content_blake3, raw_size, compressed_size, ref_count,
                    current_publication_id, admission_state, blob_state, touched_at_ms
                ) VALUES ($1, $2, $3, $4, 0, NULL, 'open', 'staging', $5)",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .bind(raw_size as i64)
            .bind(compressed_size as i64)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_blob_catalog", err.to_string()))?;
        }
    }
    Ok(None)
}

async fn register_s3_staging_or_reuse_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    active_epoch: LeaseEpoch,
    prepared: &PreparedBlobSource,
    publication_id: &str,
    app_prefix: &str,
) -> Result<S3StageRegistration, PortError> {
    let now_ms = now_unix_ms()?;
    let existing = ensure_local_catalog_open_tx(
        tx,
        space_id,
        prepared.digest,
        prepared.raw_size,
        prepared.total_compressed_size,
    )
    .await?;

    if let Some(active_pub_id) = existing {
        return Ok(S3StageRegistration::ReusedActive {
            publication_id: active_pub_id,
        });
    }

    let part_count_i32 = i32::try_from(prepared.s3_parts.len())
        .map_err(|_| internal_not_committed("s3_part_count_overflow", "part_count > i32::MAX"))?;
    let epoch_i64 = active_epoch.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO blob_publications (
                    space_id, publication_id, content_blake3, owner_epoch, codec,
                    state, manifest_sealed, part_count, raw_size, compressed_size,
                    created_at_ms, updated_at_ms
                ) VALUES (?, ?, ?, ?, 's3_chunked_v1', 'staging', 1, ?, ?, ?, ?, ?)",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .bind(prepared.digest.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(part_count_i32)
            .bind(prepared.raw_size as i64)
            .bind(prepared.total_compressed_size as i64)
            .bind(now_ms)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_s3_pub", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO blob_publications (
                    space_id, publication_id, content_blake3, owner_epoch, codec,
                    state, manifest_sealed, part_count, raw_size, compressed_size,
                    created_at_ms, updated_at_ms
                ) VALUES ($1, $2, $3, $4, 's3_chunked_v1', 'staging', 1, $5, $6, $7, $8, $8)",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .bind(prepared.digest.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(part_count_i32)
            .bind(prepared.raw_size as i64)
            .bind(prepared.total_compressed_size as i64)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_s3_pub", err.to_string()))?;
        }
    }

    let mut keys = Vec::with_capacity(prepared.s3_parts.len());
    for part in &prepared.s3_parts {
        let key = format!(
            "{}spaces/{}/cas-v1/{}/{}",
            app_prefix,
            space_id.as_str(),
            publication_id,
            part.part_index
        );
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "INSERT INTO blob_parts (
                        space_id, publication_id, part_index, raw_size, compressed_size,
                        part_blake3, physical_key, observed_version_id, upload_confirmed
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)",
                )
                .bind(space_id.as_str())
                .bind(publication_id)
                .bind(part.part_index as i64)
                .bind(part.raw_size as i64)
                .bind(part.compressed.len() as i64)
                .bind(part.part_blake3.as_bytes().as_slice())
                .bind(&key)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_insert_s3_part", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "INSERT INTO blob_parts (
                        space_id, publication_id, part_index, raw_size, compressed_size,
                        part_blake3, physical_key, observed_version_id, upload_confirmed
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, 0)",
                )
                .bind(space_id.as_str())
                .bind(publication_id)
                .bind(part.part_index as i32)
                .bind(part.raw_size as i64)
                .bind(part.compressed.len() as i64)
                .bind(part.part_blake3.as_bytes().as_slice())
                .bind(&key)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_insert_s3_part", err.to_string()))?;
            }
        }
        keys.push(key);
    }

    Ok(S3StageRegistration::NewStaging { parts: keys })
}

async fn confirm_s3_part_uploaded_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    active_epoch: LeaseEpoch,
    digest: ContentDigest,
    publication_id: &str,
    part_index: u32,
    observed_version_id: Option<&str>,
) -> Result<(), PortError> {
    let epoch_i64 = active_epoch.get() as i64;
    let admission: Option<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT admission_state FROM blob_catalog WHERE space_id = ? AND content_blake3 = ?",
        )
        .bind(space_id.as_str())
        .bind(digest.as_bytes().as_slice())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_cat_confirm", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT admission_state FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2",
        )
        .bind(space_id.as_str())
        .bind(digest.as_bytes().as_slice())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_cat_confirm", err.to_string()))?,
    };
    if admission.as_deref() != Some("open") {
        return Err(unavailable_retryable(
            "s3_publication_retiring",
            "digest entered retirement during part upload",
            Duration::from_millis(25),
        ));
    }

    let pub_state: Option<(String, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT state, owner_epoch FROM blob_publications WHERE space_id = ? AND publication_id = ?",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_check_pub_confirm", err.to_string()))?;
            row.map(|r| (r.get("state"), r.get("owner_epoch")))
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT state, owner_epoch FROM blob_publications WHERE space_id = $1 AND publication_id = $2",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_check_pub_confirm", err.to_string()))?;
            row.map(|r| (r.get("state"), r.get("owner_epoch")))
        }
    };
    let Some((state, owner_ep)) = pub_state else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if owner_ep != epoch_i64 {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if state != "staging" && state != "active" {
        return Err(unavailable_retryable(
            "s3_publication_fenced",
            format!("publication state is '{state}', cannot confirm part"),
            Duration::from_millis(25),
        ));
    }

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_parts
                 SET upload_confirmed = 1, observed_version_id = COALESCE(?, observed_version_id)
                 WHERE space_id = ? AND publication_id = ? AND part_index = ?",
            )
            .bind(observed_version_id)
            .bind(space_id.as_str())
            .bind(publication_id)
            .bind(part_index as i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_confirm_part", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_parts
                 SET upload_confirmed = 1, observed_version_id = COALESCE($1, observed_version_id)
                 WHERE space_id = $2 AND publication_id = $3 AND part_index = $4",
            )
            .bind(observed_version_id)
            .bind(space_id.as_str())
            .bind(publication_id)
            .bind(part_index as i32)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_confirm_part", err.to_string()))?;
        }
    }
    Ok(())
}

/// Activates a staged blob ticket and binds an explicit `blob_references` row inside Phase 2 SQL tx.
pub(crate) async fn activate_and_bind_blob_ref_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    claim: &BlobReferenceClaim,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    claim.ticket.check_authority(scope, active_epoch)?;
    let now_ms = now_unix_ms()?;
    let epoch_i64 = active_epoch.get() as i64;
    let space_id = &claim.ticket.space_id;
    let digest = claim.ticket.digest;

    // 1. Check catalog admission is open.
    let cat_row: Option<(String, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_act_cat", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("admission_state"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_act_cat", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("admission_state"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
    };

    let mut inserted_fresh_local_active = false;
    let current_pub_opt = match cat_row {
        Some((admission, _blob_state, pub_opt)) => {
            if admission != "open" {
                return Err(unavailable_retryable(
                    "blob_retiring_on_commit",
                    "digest entered retirement before SQL commit",
                    Duration::from_millis(25),
                ));
            }
            pub_opt
        }
        None => match claim.ticket.codec {
            BlobCodecTag::LocalZstdV1 => {
                // Fast path for brand-new LocalZstdV1 digest: insert active catalog row directly
                // (with `ref_count = 0` incremented below, or `ref_count = 1` directly if reference inserts!)
                let pub_id = &claim.ticket.publication_id;
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO blob_catalog (
                                space_id, content_blake3, raw_size, compressed_size, ref_count,
                                current_publication_id, admission_state, blob_state, touched_at_ms
                            ) VALUES (?, ?, ?, ?, 1, ?, 'open', 'active', ?)",
                        )
                        .bind(space_id.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(claim.ticket.raw_size as i64)
                        .bind(claim.ticket.compressed_size as i64)
                        .bind(pub_id)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed(
                                "sqlite_insert_blob_catalog_fast",
                                err.to_string(),
                            )
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO blob_catalog (
                                space_id, content_blake3, raw_size, compressed_size, ref_count,
                                current_publication_id, admission_state, blob_state, touched_at_ms
                            ) VALUES ($1, $2, $3, $4, 1, $5, 'open', 'active', $6)",
                        )
                        .bind(space_id.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(claim.ticket.raw_size as i64)
                        .bind(claim.ticket.compressed_size as i64)
                        .bind(pub_id)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_insert_blob_catalog_fast", err.to_string())
                        })?;
                    }
                }
                inserted_fresh_local_active = true;
                None
            }
            BlobCodecTag::S3ChunkedV1 => {
                return Err(internal_not_committed(
                    "blob_not_staged",
                    "blob_catalog row missing during Phase 2 S3 activation",
                ));
            }
        },
    };

    let effective_pub_id = match claim.ticket.codec {
        BlobCodecTag::LocalZstdV1 => {
            if let Some(active_pub) = current_pub_opt {
                active_pub
            } else {
                let pub_id = claim.ticket.publication_id.clone();
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO blob_publications (
                                space_id, publication_id, content_blake3, owner_epoch, codec,
                                state, manifest_sealed, part_count, raw_size, compressed_size,
                                created_at_ms, updated_at_ms
                            ) VALUES (?, ?, ?, ?, 'local_zstd_v1', 'active', 1, 1, ?, ?, ?, ?)",
                        )
                        .bind(space_id.as_str())
                        .bind(&pub_id)
                        .bind(digest.as_bytes().as_slice())
                        .bind(epoch_i64)
                        .bind(claim.ticket.raw_size as i64)
                        .bind(claim.ticket.compressed_size as i64)
                        .bind(now_ms)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_insert_local_pub", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO blob_publications (
                                space_id, publication_id, content_blake3, owner_epoch, codec,
                                state, manifest_sealed, part_count, raw_size, compressed_size,
                                created_at_ms, updated_at_ms
                            ) VALUES ($1, $2, $3, $4, 'local_zstd_v1', 'active', 1, 1, $5, $6, $7, $7)",
                        )
                        .bind(space_id.as_str())
                        .bind(&pub_id)
                        .bind(digest.as_bytes().as_slice())
                        .bind(epoch_i64)
                        .bind(claim.ticket.raw_size as i64)
                        .bind(claim.ticket.compressed_size as i64)
                        .bind(now_ms)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_insert_local_pub", err.to_string())
                        })?;
                    }
                }
                pub_id
            }
        }
        BlobCodecTag::S3ChunkedV1 => {
            if let Some(active_pub) = current_pub_opt {
                // Verify the active publication really is in `active` state.
                verify_s3_pub_active_tx(tx, space_id, &active_pub).await?;
                active_pub
            } else {
                promote_s3_staging_to_active_tx(
                    tx,
                    space_id,
                    active_epoch,
                    &claim.ticket.publication_id,
                    now_ms,
                )
                .await?;
                claim.ticket.publication_id.clone()
            }
        }
    };

    if claim.ticket.discard.is_some() && effective_pub_id == claim.ticket.publication_id {
        disarm_publication_discard_tx(tx, space_id, &effective_pub_id).await?;
    }

    // Insert explicit blob_references row (ignoring exact duplicate owner tuple within the same command).
    let inserted = match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "INSERT OR IGNORE INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(space_id.as_str())
        .bind(claim.owner_kind.as_db_str())
        .bind(&claim.owner_id)
        .bind(&claim.owner_rev_id)
        .bind(&claim.resource_key)
        .bind(digest.as_bytes().as_slice())
        .bind(&effective_pub_id)
        .bind(created_seq.get() as i64)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_insert_blob_ref", err.to_string()))?
        .rows_affected(),
        BackendConn::Postgres(conn) => sqlx::query(
            "INSERT INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (space_id, owner_kind, owner_id, owner_rev_id, resource_key) DO NOTHING",
        )
        .bind(space_id.as_str())
        .bind(claim.owner_kind.as_db_str())
        .bind(&claim.owner_id)
        .bind(&claim.owner_rev_id)
        .bind(&claim.resource_key)
        .bind(digest.as_bytes().as_slice())
        .bind(&effective_pub_id)
        .bind(created_seq.get() as i64)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_insert_blob_ref", err.to_string()))?
        .rows_affected(),
    };

    if !inserted_fresh_local_active || inserted != 1 {
        let ref_delta = if inserted_fresh_local_active {
            (inserted as i64) - 1
        } else {
            inserted as i64
        };
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog
                     SET ref_count = ref_count + ?, current_publication_id = ?, blob_state = 'active', touched_at_ms = ?
                     WHERE space_id = ? AND content_blake3 = ?",
                )
                .bind(ref_delta)
                .bind(&effective_pub_id)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_update_cat_active", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog
                     SET ref_count = ref_count + $1, current_publication_id = $2, blob_state = 'active', touched_at_ms = $3
                     WHERE space_id = $4 AND content_blake3 = $5",
                )
                .bind(ref_delta)
                .bind(&effective_pub_id)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_update_cat_active", err.to_string()))?;
            }
        }
    }

    Ok(())
}

/// Binds a new `blob_references` row to an already-active catalog digest in `space_id`
/// (used by metadata-only note revisions such as `MoveNote`, `RenameNote`, `Trash`, `Restore`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn bind_existing_active_blob_ref_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    owner_kind: BlobOwnerKind,
    owner_id: &str,
    owner_rev_id: &str,
    resource_key: &str,
    digest: ContentDigest,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let now_ms = now_unix_ms()?;
    let cat_row: Option<(String, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_rebind_cat", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("admission_state"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT admission_state, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rebind_cat", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("admission_state"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
    };

    let Some((admission, blob_state, Some(pub_id))) = cat_row else {
        return Err(unavailable_retryable(
            "blob_missing_for_rebind",
            "existing blob publication missing during metadata revision bind",
            Duration::from_millis(25),
        ));
    };
    if admission != "open" || blob_state != "active" {
        return Err(unavailable_retryable(
            "blob_retiring_on_rebind",
            "existing blob entered retirement before metadata revision commit",
            Duration::from_millis(25),
        ));
    }

    let inserted = match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "INSERT OR IGNORE INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(space_id.as_str())
        .bind(owner_kind.as_db_str())
        .bind(owner_id)
        .bind(owner_rev_id)
        .bind(resource_key)
        .bind(digest.as_bytes().as_slice())
        .bind(&pub_id)
        .bind(created_seq.get() as i64)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_rebind_blob_ref", err.to_string()))?
        .rows_affected(),
        BackendConn::Postgres(conn) => sqlx::query(
            "INSERT INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (space_id, owner_kind, owner_id, owner_rev_id, resource_key) DO NOTHING",
        )
        .bind(space_id.as_str())
        .bind(owner_kind.as_db_str())
        .bind(owner_id)
        .bind(owner_rev_id)
        .bind(resource_key)
        .bind(digest.as_bytes().as_slice())
        .bind(&pub_id)
        .bind(created_seq.get() as i64)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_rebind_blob_ref", err.to_string()))?
        .rows_affected(),
    };

    let ref_delta = inserted as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_catalog
                 SET ref_count = ref_count + ?, touched_at_ms = ?
                 WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(ref_delta)
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_rebind_cat_cnt", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_catalog
                 SET ref_count = ref_count + $1, touched_at_ms = $2
                 WHERE space_id = $3 AND content_blake3 = $4",
            )
            .bind(ref_delta)
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rebind_cat_cnt", err.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) struct ExistingBlobRefItem {
    pub owner_kind: BlobOwnerKind,
    pub owner_id: String,
    pub owner_rev_id: String,
    pub resource_key: &'static str,
    pub digest: ContentDigest,
    pub created_seq: SpaceSeq,
}

/// Batch version of `bind_existing_active_blob_ref_tx` for brand-new revisions (`owner_rev_id` newly minted),
/// reducing `3 * N` SQL round-trips down to `3` queries on both SQLite and PostgreSQL.
pub(crate) async fn bind_existing_active_blob_refs_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    items: &[ExistingBlobRefItem],
) -> Result<(), PortError> {
    if items.is_empty() {
        return Ok(());
    }
    let now_ms = now_unix_ms()?;
    let mut unique_digests: Vec<ContentDigest> = items.iter().map(|i| i.digest).collect();
    unique_digests.sort_unstable();
    unique_digests.dedup();

    let mut pub_by_digest: HashMap<ContentDigest, String> =
        HashMap::with_capacity(unique_digests.len());

    for chunk in unique_digests.chunks(200) {
        let rows: Vec<(Vec<u8>, String, String, Option<String>)> = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT content_blake3, admission_state, blob_state, current_publication_id
                     FROM blob_catalog WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str())
                    .push(" AND content_blake3 IN (");
                let mut sep = qb.separated(", ");
                for d in chunk {
                    sep.push_bind(d.as_bytes().as_slice());
                }
                sep.push_unseparated(")");
                let fetched = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_rebind_cat_batch", err.to_string())
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("content_blake3"),
                            r.get("admission_state"),
                            r.get("blob_state"),
                            r.get("current_publication_id"),
                        )
                    })
                    .collect()
            }
            BackendConn::Postgres(conn) => {
                let digest_slices: Vec<&[u8]> =
                    chunk.iter().map(|d| d.as_bytes().as_slice()).collect();
                let fetched = sqlx::query(
                    "SELECT content_blake3, admission_state, blob_state, current_publication_id
                     FROM blob_catalog WHERE space_id = $1 AND content_blake3 = ANY($2)",
                )
                .bind(space_id.as_str())
                .bind(digest_slices)
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_rebind_cat_batch", err.to_string()))?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("content_blake3"),
                            r.get("admission_state"),
                            r.get("blob_state"),
                            r.get("current_publication_id"),
                        )
                    })
                    .collect()
            }
        };

        for (d_bytes, admission, blob_state, pub_opt) in rows {
            let arr: [u8; 32] = d_bytes
                .try_into()
                .map_err(|_| internal_not_committed("corrupt_cat_digest", "digest != 32B"))?;
            let digest = ContentDigest::from_bytes(arr);
            let Some(pub_id) = pub_opt else {
                return Err(unavailable_retryable(
                    "blob_missing_for_rebind",
                    "existing blob publication missing during metadata revision bind",
                    Duration::from_millis(25),
                ));
            };
            if admission != "open" || blob_state != "active" {
                return Err(unavailable_retryable(
                    "blob_retiring_on_rebind",
                    "existing blob entered retirement before metadata revision commit",
                    Duration::from_millis(25),
                ));
            }
            pub_by_digest.insert(digest, pub_id);
        }
    }

    if pub_by_digest.len() != unique_digests.len() {
        return Err(unavailable_retryable(
            "blob_missing_for_rebind",
            "existing blob publication missing during metadata revision bind",
            Duration::from_millis(25),
        ));
    }

    // Deduplicate `(owner_kind, owner_id, owner_rev_id, resource_key)` defensively before counting deltas.
    let mut seen_refs = BTreeSet::new();
    let mut dedup_items: Vec<(&ExistingBlobRefItem, &str)> = Vec::with_capacity(items.len());
    let mut delta_by_digest: HashMap<ContentDigest, i64> =
        HashMap::with_capacity(unique_digests.len());

    for item in items {
        let key = (
            item.owner_kind.as_db_str(),
            item.owner_id.as_str(),
            item.owner_rev_id.as_str(),
            item.resource_key,
        );
        if seen_refs.insert(key) {
            let pub_id = pub_by_digest
                .get(&item.digest)
                .expect("verified digest present");
            dedup_items.push((item, pub_id.as_str()));
            *delta_by_digest.entry(item.digest).or_insert(0) += 1;
        }
    }

    match tx {
        BackendConn::Sqlite(conn) => {
            for chunk in dedup_items.chunks(100) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "INSERT INTO blob_references (
                        space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                        content_blake3, publication_id, created_seq
                    ) ",
                );
                qb.push_values(chunk, |mut b, (it, pub_id)| {
                    b.push_bind(space_id.as_str())
                        .push_bind(it.owner_kind.as_db_str())
                        .push_bind(&it.owner_id)
                        .push_bind(&it.owner_rev_id)
                        .push_bind(it.resource_key)
                        .push_bind(it.digest.as_bytes().as_slice())
                        .push_bind(*pub_id)
                        .push_bind(it.created_seq.get() as i64);
                });
                qb.build().execute(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_rebind_blob_refs_batch", err.to_string())
                })?;
            }
        }
        BackendConn::Postgres(conn) => {
            let mut owner_kinds: Vec<&str> = Vec::with_capacity(dedup_items.len());
            let mut owner_ids: Vec<&str> = Vec::with_capacity(dedup_items.len());
            let mut owner_rev_ids: Vec<&str> = Vec::with_capacity(dedup_items.len());
            let mut res_keys: Vec<&str> = Vec::with_capacity(dedup_items.len());
            let mut digests: Vec<&[u8]> = Vec::with_capacity(dedup_items.len());
            let mut pub_ids: Vec<&str> = Vec::with_capacity(dedup_items.len());
            let mut created_seqs: Vec<i64> = Vec::with_capacity(dedup_items.len());

            for (it, pub_id) in &dedup_items {
                owner_kinds.push(it.owner_kind.as_db_str());
                owner_ids.push(&it.owner_id);
                owner_rev_ids.push(&it.owner_rev_id);
                res_keys.push(it.resource_key);
                digests.push(it.digest.as_bytes().as_slice());
                pub_ids.push(*pub_id);
                created_seqs.push(it.created_seq.get() as i64);
            }

            sqlx::query(
                "INSERT INTO blob_references (
                    space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                    content_blake3, publication_id, created_seq
                )
                SELECT $1, u.owner_kind, u.owner_id, u.owner_rev_id, u.res_key,
                       u.digest, u.pub_id, u.cseq
                FROM UNNEST(
                    $2::TEXT[], $3::TEXT[], $4::TEXT[], $5::TEXT[],
                    $6::BYTEA[], $7::TEXT[], $8::BIGINT[]
                ) AS u(owner_kind, owner_id, owner_rev_id, res_key, digest, pub_id, cseq)",
            )
            .bind(space_id.as_str())
            .bind(owner_kinds)
            .bind(owner_ids)
            .bind(owner_rev_ids)
            .bind(res_keys)
            .bind(digests)
            .bind(pub_ids)
            .bind(created_seqs)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rebind_blob_refs_batch", err.to_string()))?;

            let mut cat_digests: Vec<Vec<u8>> = Vec::with_capacity(delta_by_digest.len());
            let mut cat_deltas: Vec<i64> = Vec::with_capacity(delta_by_digest.len());
            for (d, delta) in &delta_by_digest {
                if *delta > 0 {
                    cat_digests.push(d.as_bytes().to_vec());
                    cat_deltas.push(*delta);
                }
            }
            if !cat_digests.is_empty() {
                sqlx::query(
                    "UPDATE blob_catalog AS bc
                     SET ref_count = bc.ref_count + v.delta
                     FROM UNNEST($2::BYTEA[], $3::BIGINT[]) AS v(digest, delta)
                     WHERE bc.space_id = $1 AND bc.content_blake3 = v.digest",
                )
                .bind(space_id.as_str())
                .bind(cat_digests)
                .bind(cat_deltas)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_rebind_cat_cnt_batch", err.to_string())
                })?;
            }
            return Ok(());
        }
    }

    let mut single_digests: Vec<ContentDigest> = Vec::new();
    let mut multi_digests: Vec<(ContentDigest, i64)> = Vec::new();
    for (d, delta) in delta_by_digest {
        if delta == 1 {
            single_digests.push(d);
        } else if delta > 1 {
            multi_digests.push((d, delta));
        }
    }

    if !single_digests.is_empty() {
        match tx {
            BackendConn::Sqlite(conn) => {
                for chunk in single_digests.chunks(200) {
                    let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                        "UPDATE blob_catalog SET ref_count = ref_count + 1, touched_at_ms = ",
                    );
                    qb.push_bind(now_ms)
                        .push(" WHERE space_id = ")
                        .push_bind(space_id.as_str())
                        .push(" AND content_blake3 IN (");
                    let mut sep = qb.separated(", ");
                    for d in chunk {
                        sep.push_bind(d.as_bytes().as_slice());
                    }
                    sep.push_unseparated(")");
                    qb.build().execute(&mut **conn).await.map_err(|err| {
                        internal_not_committed("sqlite_rebind_cat_cnt_batch", err.to_string())
                    })?;
                }
            }
            BackendConn::Postgres(conn) => {
                for chunk in single_digests.chunks(200) {
                    let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
                        "UPDATE blob_catalog SET ref_count = ref_count + 1, touched_at_ms = ",
                    );
                    qb.push_bind(now_ms)
                        .push(" WHERE space_id = ")
                        .push_bind(space_id.as_str())
                        .push(" AND content_blake3 IN (");
                    let mut sep = qb.separated(", ");
                    for d in chunk {
                        sep.push_bind(d.as_bytes().as_slice());
                    }
                    sep.push_unseparated(")");
                    qb.build().execute(&mut **conn).await.map_err(|err| {
                        internal_not_committed("pg_rebind_cat_cnt_batch", err.to_string())
                    })?;
                }
            }
        }
    }

    for (d, delta) in multi_digests {
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog
                     SET ref_count = ref_count + ?, touched_at_ms = ?
                     WHERE space_id = ? AND content_blake3 = ?",
                )
                .bind(delta)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(d.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_rebind_cat_cnt", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog
                     SET ref_count = ref_count + $1, touched_at_ms = $2
                     WHERE space_id = $3 AND content_blake3 = $4",
                )
                .bind(delta)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(d.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_rebind_cat_cnt", err.to_string()))?;
            }
        }
    }

    Ok(())
}

/// Removes all `blob_references` owned by `(owner_kind, owner_id)` and syncs `blob_catalog.ref_count`,
/// returning affected digests whose `ref_count` dropped to `0`.
pub(crate) async fn release_owner_blob_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    owner_kind: BlobOwnerKind,
    owner_id: &str,
) -> Result<Vec<ContentDigest>, PortError> {
    let now_ms = now_unix_ms()?;
    let raw_digests: Vec<Vec<u8>> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "DELETE FROM blob_references
                 WHERE space_id = ? AND owner_kind = ? AND owner_id = ?
                 RETURNING content_blake3",
        )
        .bind(space_id.as_str())
        .bind(owner_kind.as_db_str())
        .bind(owner_id)
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_del_owner_refs", err.to_string()))?,
        BackendConn::Postgres(conn) => {
            let digests: Vec<Vec<u8>> = sqlx::query_scalar(
                "DELETE FROM blob_references
                 WHERE space_id = $1 AND owner_kind = $2 AND owner_id = $3
                 RETURNING content_blake3",
            )
            .bind(space_id.as_str())
            .bind(owner_kind.as_db_str())
            .bind(owner_id)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_del_owner_refs", err.to_string()))?;
            digests
        }
    };

    let mut unique = BTreeSet::new();
    for bytes in raw_digests {
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_ref_digest", "digest != 32 bytes"))?;
        unique.insert(ContentDigest::from_bytes(arr));
    }

    let mut zero_ref = Vec::new();
    for digest in unique {
        let exact_count = count_reachable_refs_tx(tx, space_id, digest).await?;
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog SET ref_count = ?, touched_at_ms = ?
                     WHERE space_id = ? AND content_blake3 = ?",
                )
                .bind(exact_count)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_recompute_ref", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE blob_catalog SET ref_count = $1, touched_at_ms = $2
                     WHERE space_id = $3 AND content_blake3 = $4",
                )
                .bind(exact_count)
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_recompute_ref", err.to_string()))?;
            }
        }
        if exact_count == 0 {
            zero_ref.push(digest);
        }
    }
    Ok(zero_ref)
}

pub(crate) async fn count_reachable_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    digest: ContentDigest,
) -> Result<i64, PortError> {
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT COUNT(*) FROM blob_references WHERE space_id = ? AND content_blake3 = ?",
        )
        .bind(space_id.as_str())
        .bind(digest.as_bytes().as_slice())
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_count_refs", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM blob_references WHERE space_id = $1 AND content_blake3 = $2",
        )
        .bind(space_id.as_str())
        .bind(digest.as_bytes().as_slice())
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_count_refs", err)),
    }
}

async fn ensure_zero_reachable_refs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    digest: ContentDigest,
) -> Result<(), PortError> {
    let count = count_reachable_refs_tx(tx, space_id, digest).await?;
    if count != 0 {
        return Err(internal_not_committed(
            "non_zero_refs_on_retire",
            format!(
                "digest {} still has {count} live references",
                digest.to_hex()
            ),
        ));
    }
    Ok(())
}

async fn verify_s3_pub_active_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    publication_id: &str,
) -> Result<(), PortError> {
    let state: Option<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT state FROM blob_publications WHERE space_id = ? AND publication_id = ?",
        )
        .bind(space_id.as_str())
        .bind(publication_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_verify_s3_pub", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT state FROM blob_publications WHERE space_id = $1 AND publication_id = $2",
        )
        .bind(space_id.as_str())
        .bind(publication_id)
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_verify_s3_pub", err.to_string()))?,
    };
    if state.as_deref() != Some("active") {
        return Err(unavailable_retryable(
            "s3_pub_not_active",
            "referenced S3 publication is no longer active",
            Duration::from_millis(25),
        ));
    }
    Ok(())
}

async fn promote_s3_staging_to_active_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    active_epoch: LeaseEpoch,
    publication_id: &str,
    now_ms: i64,
) -> Result<(), PortError> {
    let epoch_i64 = active_epoch.get() as i64;
    let pub_info: Option<(String, i64, i32, i32)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT state, owner_epoch, manifest_sealed, part_count
                 FROM blob_publications WHERE space_id = ? AND publication_id = ?",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_s3_pub", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("state"),
                    row.get("owner_epoch"),
                    row.get::<i64, _>("manifest_sealed") as i32,
                    row.get::<i64, _>("part_count") as i32,
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT state, owner_epoch, manifest_sealed, part_count
                 FROM blob_publications WHERE space_id = $1 AND publication_id = $2",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_s3_pub", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("state"),
                    row.get("owner_epoch"),
                    row.get("manifest_sealed"),
                    row.get("part_count"),
                )
            })
        }
    };

    let Some((state, owner_ep, sealed, part_count)) = pub_info else {
        return Err(internal_not_committed(
            "missing_s3_staging_pub",
            "staging publication row missing",
        ));
    };
    if owner_ep != epoch_i64 {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if state == "active" {
        return Ok(());
    }
    if state != "staging" || sealed != 1 {
        return Err(unavailable_retryable(
            "s3_staging_fenced",
            format!("cannot activate S3 publication in state '{state}' (sealed={sealed})"),
            Duration::from_millis(25),
        ));
    }

    let confirmed_count: i64 = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT COUNT(*) FROM blob_parts
             WHERE space_id = ? AND publication_id = ? AND upload_confirmed = 1",
        )
        .bind(space_id.as_str())
        .bind(publication_id)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_count_confirmed_parts", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM blob_parts
             WHERE space_id = $1 AND publication_id = $2 AND upload_confirmed = 1",
        )
        .bind(space_id.as_str())
        .bind(publication_id)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_count_confirmed_parts", err.to_string()))?,
    };
    if confirmed_count != i64::from(part_count) {
        return Err(internal_not_committed(
            "s3_incomplete_parts",
            format!("expected {part_count} confirmed parts, found {confirmed_count}"),
        ));
    }

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_publications SET state = 'active', updated_at_ms = ?
                 WHERE space_id = ? AND publication_id = ?",
            )
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(publication_id)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_promote_s3_pub", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_publications SET state = 'active', updated_at_ms = $1
                 WHERE space_id = $2 AND publication_id = $3",
            )
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(publication_id)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_promote_s3_pub", err.to_string()))?;
        }
    }
    Ok(())
}

async fn load_active_blob_meta_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    digest: ContentDigest,
) -> Result<ActiveBlobMeta, PortError> {
    let row_opt: Option<(i64, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT raw_size, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ? AND content_blake3 = ? AND admission_state = 'open' AND ref_count > 0",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_blob_meta", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("raw_size"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT raw_size, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = $1 AND content_blake3 = $2 AND admission_state = 'open' AND ref_count > 0",
            )
            .bind(space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_blob_meta", err))?;
            r.map(|row| {
                (
                    row.get("raw_size"),
                    row.get("blob_state"),
                    row.get("current_publication_id"),
                )
            })
        }
    };

    let Some((raw_size, state, pub_opt)) = row_opt else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if state != "active" {
        return Err(DomainError::ResourceNotFound.into());
    }

    let mut part_count = 1u32;
    if let Some(pub_id) = &pub_opt {
        let p_opt: Option<(String, i32)> = match tx {
            BackendConn::Sqlite(conn) => {
                let r = sqlx::query(
                    "SELECT state, part_count FROM blob_publications WHERE space_id = ? AND publication_id = ?",
                )
                .bind(space_id.as_str())
                .bind(pub_id)
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_load_pub_meta", err.to_string()))?;
                r.map(|row| (row.get("state"), row.get::<i64, _>("part_count") as i32))
            }
            BackendConn::Postgres(conn) => {
                let r = sqlx::query(
                    "SELECT state, part_count FROM blob_publications WHERE space_id = $1 AND publication_id = $2",
                )
                .bind(space_id.as_str())
                .bind(pub_id)
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_load_pub_meta", err))?;
                r.map(|row| (row.get("state"), row.get("part_count")))
            }
        };
        let Some((p_state, p_cnt)) = p_opt else {
            return Err(internal_not_committed(
                "corrupt_active_pub",
                "active publication missing",
            ));
        };
        if p_state != "active" {
            return Err(DomainError::ResourceNotFound.into());
        }
        part_count = u32::try_from(p_cnt)
            .map_err(|_| internal_not_committed("corrupt_part_count", "negative part_count"))?;
    }

    Ok(ActiveBlobMeta {
        raw_size: u64::try_from(raw_size)
            .map_err(|_| internal_not_committed("corrupt_raw_size", "negative raw_size"))?,
        publication_id: pub_opt,
        part_count,
    })
}

async fn load_s3_manifest_parts_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    publication_id: &str,
    expected_part_count: u32,
) -> Result<Vec<S3ManifestPart>, PortError> {
    let raw_rows: Vec<(i32, i64, i64, Vec<u8>, String, i32)> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT part_index, raw_size, compressed_size, part_blake3, physical_key, upload_confirmed
                 FROM blob_parts
                 WHERE space_id = ? AND publication_id = ?
                 ORDER BY part_index ASC",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_s3_parts", err.to_string()))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get::<i64, _>("part_index") as i32,
                        r.get("raw_size"),
                        r.get("compressed_size"),
                        r.get("part_blake3"),
                        r.get("physical_key"),
                        r.get::<i64, _>("upload_confirmed") as i32,
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT part_index, raw_size, compressed_size, part_blake3, physical_key, upload_confirmed
                 FROM blob_parts
                 WHERE space_id = $1 AND publication_id = $2
                 ORDER BY part_index ASC",
            )
            .bind(space_id.as_str())
            .bind(publication_id)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_s3_parts", err))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get("part_index"),
                        r.get("raw_size"),
                        r.get("compressed_size"),
                        r.get("part_blake3"),
                        r.get("physical_key"),
                        r.get("upload_confirmed"),
                    )
                })
                .collect()
        }
    };

    if raw_rows.len() != expected_part_count as usize {
        return Err(internal_not_committed(
            "corrupt_s3_manifest_count",
            format!(
                "expected {expected_part_count} parts, found {}",
                raw_rows.len()
            ),
        ));
    }

    let mut out = Vec::with_capacity(raw_rows.len());
    for (expected_idx, (idx, raw_sz, comp_sz, digest_bytes, key, confirmed)) in
        raw_rows.into_iter().enumerate()
    {
        if idx < 0 || idx as usize != expected_idx {
            return Err(internal_not_committed(
                "corrupt_s3_part_sequence",
                format!("expected part index {expected_idx}, found {idx}"),
            ));
        }
        if confirmed != 1 {
            return Err(internal_not_committed(
                "corrupt_s3_unconfirmed_part",
                format!("part {idx} in active publication not upload_confirmed"),
            ));
        }
        let arr: [u8; 32] = digest_bytes
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_part_digest", "part_blake3 != 32B"))?;
        out.push(S3ManifestPart {
            part_index: idx as u32,
            raw_size: raw_sz as u64,
            compressed_size: comp_sz as u64,
            part_blake3: ContentDigest::from_bytes(arr),
            physical_key: key,
        });
    }

    Ok(out)
}

// A provisional discard uses its unique publication ID as retirement ID. It owns
// exactly those immutable part keys; digest-wide GC may run independently.
async fn record_publication_discard_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    publication: &str,
) -> Result<(), PortError> {
    const PLAN: &str = "INSERT INTO blob_retirements
        (space_id,retirement_id,history_incarnation,owner_epoch,reason,purge_id,status,created_at_ms,completed_at_ms)
        VALUES ($1,$2,$3,$4,'gc',NULL,'pending',$5,NULL)";
    const PARTS: &str = "INSERT INTO blob_retirement_targets
        (space_id,retirement_id,publication_id,part_index,content_blake3,codec,physical_key,marker_verified,data_version_ids_json,versions_deleted,target_completed)
        SELECT p.space_id,p.publication_id,p.publication_id,b.part_index,p.content_blake3,p.codec,b.physical_key,0,NULL,0,0
        FROM blob_publications p JOIN blob_parts b ON b.space_id=p.space_id AND b.publication_id=p.publication_id
        WHERE p.space_id=$1 AND p.publication_id=$2";
    let now = now_unix_ms()?;
    let sid = scope.space_id.as_str();
    let inc = scope.incarnation.as_bytes().as_slice();
    let epoch = epoch.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(PLAN)
                .bind(sid)
                .bind(publication)
                .bind(inc)
                .bind(epoch)
                .bind(now)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("plan_publication_discard", err.to_string())
                })?;
            sqlx::query(PARTS)
                .bind(sid)
                .bind(publication)
                .execute(&mut **conn)
                .await
                .map(|_| ())
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(PLAN)
                .bind(sid)
                .bind(publication)
                .bind(inc)
                .bind(epoch)
                .bind(now)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("plan_publication_discard", err.to_string())
                })?;
            sqlx::query(PARTS)
                .bind(sid)
                .bind(publication)
                .execute(&mut **conn)
                .await
                .map(|_| ())
        }
    }
    .map_err(|err| internal_not_committed("plan_publication_discard_parts", err.to_string()))
}

async fn disarm_publication_discard_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    publication: &str,
) -> Result<(), PortError> {
    for sql in [
        "DELETE FROM blob_retirement_targets WHERE space_id=$1 AND retirement_id=$2",
        "DELETE FROM blob_retirements WHERE space_id=$1 AND retirement_id=$2",
    ] {
        match tx {
            BackendConn::Sqlite(conn) => sqlx::query(sql)
                .bind(space.as_str())
                .bind(publication)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
            BackendConn::Postgres(conn) => sqlx::query(sql)
                .bind(space.as_str())
                .bind(publication)
                .execute(&mut **conn)
                .await
                .map(|_| ()),
        }
        .map_err(|err| internal_not_committed("disarm_publication_discard", err.to_string()))?;
    }
    Ok(())
}

async fn pending_retirement_for_digest_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    digest: ContentDigest,
) -> Result<Option<String>, PortError> {
    const SQL: &str = "SELECT r.retirement_id FROM blob_retirements r
        JOIN blob_retirement_targets t ON t.space_id = r.space_id AND t.retirement_id = r.retirement_id
        WHERE r.space_id = $1 AND r.history_incarnation = $2 AND t.content_blake3 = $3 AND r.status = 'pending'
        AND r.retirement_id <> t.publication_id
        ORDER BY r.created_at_ms, r.retirement_id LIMIT 1";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(digest.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(digest.as_bytes().as_slice())
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|err| crate::runtime::pg_read_error("find_pending_digest_retirement", err))
}

macro_rules! zero_ref_page {
    ($index:literal) => {
        concat!(
            "SELECT c.touched_at_ms, c.content_blake3 FROM blob_catalog c ", $index, "
            WHERE c.space_id=$1 AND c.ref_count=0 AND (c.touched_at_ms, c.content_blake3)>($2,$3)
            AND c.admission_state='open' AND c.blob_state='active'
            AND NOT EXISTS (SELECT 1 FROM blob_references r WHERE r.space_id=c.space_id
                AND r.content_blake3=c.content_blake3)
            ORDER BY c.touched_at_ms, c.content_blake3 LIMIT 128"
        )
    };
}
const SQLITE_ZERO_REF_PAGE: &str = zero_ref_page!("INDEXED BY idx_blob_catalog_zero_ref");
const PG_ZERO_REF_PAGE: &str = zero_ref_page!("");

/// Older redaction receipts could release their last reference while a backup
/// prevented GC planning. Reconcile those catalog rows when opening saved state.
pub(crate) async fn plan_unowned_active_blobs_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
) -> Result<bool, PortError> {
    let mut after = (i64::MIN, Vec::new());
    let mut planned = false;
    loop {
        let rows: Vec<(i64, Vec<u8>)> = match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query_as(SQLITE_ZERO_REF_PAGE)
                    .bind(scope.space_id.as_str())
                    .bind(after.0)
                    .bind(&after.1)
                    .fetch_all(&mut **conn)
                    .await
            }
            BackendConn::Postgres(conn) => {
                sqlx::query_as(PG_ZERO_REF_PAGE)
                    .bind(scope.space_id.as_str())
                    .bind(after.0)
                    .bind(&after.1)
                    .fetch_all(&mut **conn)
                    .await
            }
        }
        .map_err(|err| internal_not_committed("scan_unowned_blobs", err.to_string()))?;
        let Some(last) = rows.last() else {
            return Ok(planned);
        };
        after = last.clone();
        for (_, raw) in rows {
            let digest = ContentDigest::from_bytes(raw.try_into().map_err(|_| {
                internal_not_committed("corrupt_blob_digest", "invalid digest length")
            })?);
            planned |= initiate_digest_retirement_tx(
                tx,
                scope,
                epoch,
                digest,
                RetirementReason::Gc,
                None,
                None,
            )
            .await?
            .is_some();
        }
    }
}

pub(crate) async fn initiate_digest_retirement_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    digest: ContentDigest,
    reason: RetirementReason,
    purge_id: Option<&str>,
    local_store: Option<&LocalBlobStore>,
) -> Result<Option<String>, PortError> {
    let reachable = count_reachable_refs_tx(tx, &scope.space_id, digest).await?;
    if reachable > 0 {
        // Shared digest still has live authorized references; keep intact!
        return Ok(None);
    }

    if let Some(pending) = pending_retirement_for_digest_tx(tx, scope, digest).await? {
        return Ok(Some(pending));
    }

    let now_ms = now_unix_ms()?;
    let ret_id = new_prefixed_hex_id("ret_")?;
    let epoch_i64 = active_epoch.get() as i64;

    // Collect all non-retired publications (`staging`, `active`, `retiring`) for this digest.
    let pubs: Vec<(String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT publication_id, codec FROM blob_publications
                 WHERE space_id = ? AND content_blake3 = ? AND state = 'active'
                 UNION ALL
                 SELECT publication_id, codec FROM blob_publications
                 WHERE space_id = ? AND content_blake3 = ? AND state <> 'active'
                   AND state IN ('staging', 'retiring')",
            )
            .bind(scope.space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .bind(scope.space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_list_ret_pubs", err.to_string()))?;
            rows.into_iter()
                .map(|r| (r.get("publication_id"), r.get("codec")))
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT publication_id, codec FROM blob_publications
                 WHERE space_id = $1 AND content_blake3 = $2 AND state = 'active'
                 UNION ALL
                 SELECT publication_id, codec FROM blob_publications
                 WHERE space_id = $1 AND content_blake3 = $2 AND state <> 'active'
                   AND state IN ('staging', 'retiring')",
            )
            .bind(scope.space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_list_ret_pubs", err.to_string()))?;
            rows.into_iter()
                .map(|r| (r.get("publication_id"), r.get("codec")))
                .collect()
        }
    };

    // A local staging operation may have published its file before allocating SQL metadata.
    // In S3 every physical key belongs to a registered publication.
    if pubs.is_empty() {
        let Some(local) = local_store else {
            return Ok(None);
        };
        if !local.has_physical_file(&scope.space_id, digest)? {
            return Ok(None);
        }
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "INSERT INTO blob_catalog (
                        space_id, content_blake3, raw_size, compressed_size, ref_count,
                        current_publication_id, admission_state, blob_state, touched_at_ms
                    ) VALUES (?, ?, 0, 0, 0, NULL, 'retiring', 'staging', ?) ON CONFLICT (space_id, content_blake3) DO NOTHING",
                )
                .bind(scope.space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .bind(now_ms)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_insert_retiring_cat", err.to_string())
                })?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "INSERT INTO blob_catalog (
                        space_id, content_blake3, raw_size, compressed_size, ref_count,
                        current_publication_id, admission_state, blob_state, touched_at_ms
                    ) VALUES ($1, $2, 0, 0, 0, NULL, 'retiring', 'staging', $3) ON CONFLICT (space_id, content_blake3) DO NOTHING",
                )
                .bind(scope.space_id.as_str())
                .bind(digest.as_bytes().as_slice())
                .bind(now_ms)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_insert_retiring_cat", err.to_string()))?;
            }
        }
    }

    // Close admission on catalog and clear current_publication_id.
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_catalog
                 SET admission_state = 'retiring', current_publication_id = NULL, ref_count = 0, touched_at_ms = ?
                 WHERE space_id = ? AND content_blake3 = ?",
            )
            .bind(now_ms)
            .bind(scope.space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_close_cat_adm", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_catalog
                 SET admission_state = 'retiring', current_publication_id = NULL, ref_count = 0, touched_at_ms = $1
                 WHERE space_id = $2 AND content_blake3 = $3",
            )
            .bind(now_ms)
            .bind(scope.space_id.as_str())
            .bind(digest.as_bytes().as_slice())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_close_cat_adm", err.to_string()))?;
        }
    }

    // Seal all candidate publications into `retiring`.
    match tx {
        BackendConn::Sqlite(conn) => {
            for (pub_id, _) in &pubs {
                sqlx::query(
                    "UPDATE blob_publications
                     SET state = 'retiring', manifest_sealed = 1, updated_at_ms = ?
                     WHERE space_id = ? AND publication_id = ? AND state IN ('staging', 'active')",
                )
                .bind(now_ms)
                .bind(scope.space_id.as_str())
                .bind(pub_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_seal_ret_pubs", err.to_string()))?;
            }

            sqlx::query(
                "INSERT INTO blob_retirements (
                    space_id, retirement_id, history_incarnation, owner_epoch,
                    reason, purge_id, status, created_at_ms, completed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)",
            )
            .bind(scope.space_id.as_str())
            .bind(&ret_id)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(reason.as_db_str())
            .bind(purge_id)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_retirement", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            for (pub_id, _) in &pubs {
                sqlx::query(
                    "UPDATE blob_publications
                     SET state = 'retiring', manifest_sealed = 1, updated_at_ms = $1
                     WHERE space_id = $2 AND publication_id = $3 AND state IN ('staging', 'active')",
                )
                .bind(now_ms)
                .bind(scope.space_id.as_str())
                .bind(pub_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_seal_ret_pubs", err.to_string()))?;
            }

            sqlx::query(
                "INSERT INTO blob_retirements (
                    space_id, retirement_id, history_incarnation, owner_epoch,
                    reason, purge_id, status, created_at_ms, completed_at_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, NULL)",
            )
            .bind(scope.space_id.as_str())
            .bind(&ret_id)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(epoch_i64)
            .bind(reason.as_db_str())
            .bind(purge_id)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_retirement", err.to_string()))?;
        }
    }

    // If no publications were registered yet (e.g. local staged before Phase 2 commit), still add a local target!
    if pubs.is_empty() {
        let local_rel_key = format!(
            "blobs/{}/{}/{}.zst",
            scope.space_id.as_str(),
            &digest.to_hex()[..2],
            digest.to_hex()
        );
        insert_retirement_target_tx(
            tx,
            &scope.space_id,
            &ret_id,
            "local_unstaged",
            0,
            digest,
            BlobCodecTag::LocalZstdV1,
            &local_rel_key,
        )
        .await?;
    } else {
        for (pub_id, codec_raw) in pubs {
            let codec = BlobCodecTag::from_db_str(&codec_raw)?;
            match codec {
                BlobCodecTag::LocalZstdV1 => {
                    let local_rel_key = format!(
                        "blobs/{}/{}/{}.zst",
                        scope.space_id.as_str(),
                        &digest.to_hex()[..2],
                        digest.to_hex()
                    );
                    insert_retirement_target_tx(
                        tx,
                        &scope.space_id,
                        &ret_id,
                        &pub_id,
                        0,
                        digest,
                        BlobCodecTag::LocalZstdV1,
                        &local_rel_key,
                    )
                    .await?;
                }
                BlobCodecTag::S3ChunkedV1 => {
                    // Include EVERY registered part (including upload_confirmed = 0)!
                    let parts: Vec<(i32, String)> = match tx {
                        BackendConn::Sqlite(conn) => {
                            let rows = sqlx::query(
                                "SELECT part_index, physical_key FROM blob_parts
                                 WHERE space_id = ? AND publication_id = ?
                                 ORDER BY part_index ASC",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(&pub_id)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_ret_parts", err.to_string())
                            })?;
                            rows.into_iter()
                                .map(|r| {
                                    (r.get::<i64, _>("part_index") as i32, r.get("physical_key"))
                                })
                                .collect()
                        }
                        BackendConn::Postgres(conn) => {
                            let rows = sqlx::query(
                                "SELECT part_index, physical_key FROM blob_parts
                                 WHERE space_id = $1 AND publication_id = $2
                                 ORDER BY part_index ASC",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(&pub_id)
                            .fetch_all(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_ret_parts", err.to_string())
                            })?;
                            rows.into_iter()
                                .map(|r| (r.get("part_index"), r.get("physical_key")))
                                .collect()
                        }
                    };
                    for (part_idx, key) in parts {
                        insert_retirement_target_tx(
                            tx,
                            &scope.space_id,
                            &ret_id,
                            &pub_id,
                            part_idx as u32,
                            digest,
                            BlobCodecTag::S3ChunkedV1,
                            &key,
                        )
                        .await?;
                    }
                }
            }
        }
    }

    Ok(Some(ret_id))
}

#[allow(clippy::too_many_arguments)]
async fn insert_retirement_target_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    retirement_id: &str,
    publication_id: &str,
    part_index: u32,
    digest: ContentDigest,
    codec: BlobCodecTag,
    physical_key: &str,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO blob_retirement_targets (
                    space_id, retirement_id, publication_id, part_index,
                    content_blake3, codec, physical_key,
                    marker_verified, data_version_ids_json, versions_deleted, target_completed
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, 0)",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i64)
            .bind(digest.as_bytes().as_slice())
            .bind(codec.as_db_str())
            .bind(physical_key)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_ret_target", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO blob_retirement_targets (
                    space_id, retirement_id, publication_id, part_index,
                    content_blake3, codec, physical_key,
                    marker_verified, data_version_ids_json, versions_deleted, target_completed
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, NULL, 0, 0)",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i32)
            .bind(digest.as_bytes().as_slice())
            .bind(codec.as_db_str())
            .bind(physical_key)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_ret_target", err.to_string()))?;
        }
    }
    Ok(())
}

#[allow(clippy::type_complexity)]
async fn load_pending_retirement_targets_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    retirement_id: &str,
) -> Result<(RetirementReason, Vec<RetirementTargetRow>), PortError> {
    let space_id = &scope.space_id;
    const ADOPT: &str = "UPDATE blob_retirements
        SET owner_epoch = CASE WHEN status = 'pending' THEN $1 ELSE owner_epoch END
        WHERE space_id = $2 AND history_incarnation = $3 AND retirement_id = $4 RETURNING reason, status";
    let epoch = active_epoch.get() as i64;
    let incarnation = scope.incarnation.as_bytes().as_slice();
    let reason_raw: Option<(String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_as(ADOPT)
                .bind(epoch)
                .bind(space_id.as_str())
                .bind(incarnation)
                .bind(retirement_id)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_as(ADOPT)
                .bind(epoch)
                .bind(space_id.as_str())
                .bind(incarnation)
                .bind(retirement_id)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("adopt_blob_retirement", err.to_string()))?;

    let Some((reason_str, status_str)) = reason_raw else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let reason = match reason_str.as_str() {
        "purge" => RetirementReason::Purge,
        "gc" => RetirementReason::Gc,
        other => {
            return Err(internal_not_committed(
                "corrupt_ret_reason",
                format!("unknown reason '{other}'"),
            ));
        }
    };
    if status_str == "completed" {
        return Ok((reason, Vec::new()));
    }

    let raw_targets: Vec<(
        String,
        i32,
        Vec<u8>,
        String,
        String,
        i32,
        Option<String>,
        i32,
        i32,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT publication_id, part_index, content_blake3, codec, physical_key,
                        marker_verified, data_version_ids_json, versions_deleted, target_completed
                 FROM blob_retirement_targets
                 WHERE space_id = ? AND retirement_id = ?
                 ORDER BY publication_id ASC, part_index ASC",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_ret_targets", err.to_string()))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get("publication_id"),
                        r.get::<i64, _>("part_index") as i32,
                        r.get("content_blake3"),
                        r.get("codec"),
                        r.get("physical_key"),
                        r.get::<i64, _>("marker_verified") as i32,
                        r.get("data_version_ids_json"),
                        r.get::<i64, _>("versions_deleted") as i32,
                        r.get::<i64, _>("target_completed") as i32,
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT publication_id, part_index, content_blake3, codec, physical_key,
                        marker_verified, data_version_ids_json, versions_deleted, target_completed
                 FROM blob_retirement_targets
                 WHERE space_id = $1 AND retirement_id = $2
                 ORDER BY publication_id ASC, part_index ASC",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_ret_targets", err.to_string()))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get("publication_id"),
                        r.get("part_index"),
                        r.get("content_blake3"),
                        r.get("codec"),
                        r.get("physical_key"),
                        r.get("marker_verified"),
                        r.get("data_version_ids_json"),
                        r.get("versions_deleted"),
                        r.get("target_completed"),
                    )
                })
                .collect()
        }
    };

    if raw_targets.is_empty() {
        return Err(internal_not_committed(
            "missing_retirement_targets",
            "pending blob retirement has no registered targets",
        ));
    }
    let mut targets = Vec::with_capacity(raw_targets.len());
    for (pub_id, p_idx, d_bytes, c_str, key, mv, vids_json, vd, tc) in raw_targets {
        let arr: [u8; 32] = d_bytes
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_ret_digest", "digest != 32B"))?;
        let data_version_ids: Option<Vec<String>> = match vids_json {
            Some(j) => Some(
                serde_json::from_str(&j)
                    .map_err(|err| internal_not_committed("corrupt_ret_vids", err.to_string()))?,
            ),
            None => None,
        };
        targets.push(RetirementTargetRow {
            publication_id: pub_id,
            part_index: p_idx as u32,
            digest: ContentDigest::from_bytes(arr),
            codec: BlobCodecTag::from_db_str(&c_str)?,
            physical_key: key,
            marker_verified: mv != 0,
            data_version_ids,
            versions_deleted: vd != 0,
            target_completed: tc != 0,
        });
    }

    Ok((reason, targets))
}

pub(crate) async fn persist_s3_target_version_ids_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    retirement_id: &str,
    publication_id: &str,
    part_index: u32,
    version_ids: &[String],
) -> Result<(), PortError> {
    let vids_json = serde_json::to_string(version_ids)
        .map_err(|err| internal_not_committed("encode_ret_vids", err.to_string()))?;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_retirement_targets
                 SET marker_verified = 1, data_version_ids_json = COALESCE(data_version_ids_json, ?)
                 WHERE space_id = ? AND retirement_id = ? AND publication_id = ? AND part_index = ?",
            )
            .bind(&vids_json)
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_save_ret_vids", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_retirement_targets
                 SET marker_verified = 1, data_version_ids_json = COALESCE(data_version_ids_json, $1)
                 WHERE space_id = $2 AND retirement_id = $3 AND publication_id = $4 AND part_index = $5",
            )
            .bind(&vids_json)
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i32)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_save_ret_vids", err.to_string()))?;
        }
    }
    Ok(())
}

pub(crate) async fn mark_retirement_target_completed_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    retirement_id: &str,
    publication_id: &str,
    part_index: u32,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_retirement_targets
                 SET marker_verified = 1, versions_deleted = 1, target_completed = 1
                 WHERE space_id = ? AND retirement_id = ? AND publication_id = ? AND part_index = ?",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_complete_ret_target", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_retirement_targets
                 SET marker_verified = 1, versions_deleted = 1, target_completed = 1
                 WHERE space_id = $1 AND retirement_id = $2 AND publication_id = $3 AND part_index = $4",
            )
            .bind(space_id.as_str())
            .bind(retirement_id)
            .bind(publication_id)
            .bind(part_index as i32)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_complete_ret_target", err.to_string()))?;
        }
    }
    Ok(())
}

async fn finalize_retirement_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    retirement_id: &str,
) -> Result<(), PortError> {
    const PENDING: &str = "SELECT retirement_id FROM blob_retirements WHERE space_id = $1 AND retirement_id = $2 AND status = 'pending'";
    let pending: Option<String> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(PENDING)
                .bind(space_id.as_str())
                .bind(retirement_id)
                .fetch_optional(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(PENDING)
                .bind(space_id.as_str())
                .bind(retirement_id)
                .fetch_optional(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("check_retirement_status", err.to_string()))?;
    if pending.is_none() {
        return Ok(());
    }
    let incomplete: i64 = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT COUNT(*) FROM blob_retirement_targets
             WHERE space_id = ? AND retirement_id = ? AND target_completed = 0",
        )
        .bind(space_id.as_str())
        .bind(retirement_id)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_check_ret_done", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT COUNT(*)::BIGINT FROM blob_retirement_targets
             WHERE space_id = $1 AND retirement_id = $2 AND target_completed = 0",
        )
        .bind(space_id.as_str())
        .bind(retirement_id)
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_check_ret_done", err.to_string()))?,
    };
    if incomplete != 0 {
        return Err(internal_not_committed(
            "retirement_targets_incomplete",
            format!("{incomplete} retirement targets still incomplete"),
        ));
    }

    let now_ms = now_unix_ms()?;
    let target_digests: Vec<(Vec<u8>, i32)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(
            "SELECT DISTINCT content_blake3, CASE WHEN publication_id = retirement_id THEN 1 ELSE 0 END FROM blob_retirement_targets
             WHERE space_id = ? AND retirement_id = ?",
        )
        .bind(space_id.as_str())
        .bind(retirement_id)
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_ret_digests", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(
            "SELECT DISTINCT content_blake3, CASE WHEN publication_id = retirement_id THEN 1 ELSE 0 END FROM blob_retirement_targets
             WHERE space_id = $1 AND retirement_id = $2",
        )
        .bind(space_id.as_str())
        .bind(retirement_id)
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_ret_digests", err.to_string()))?,
    };

    // Keep the immutable publication audit, but a discarded upload cannot leave
    // a digest indefinitely advertised as staging. A sibling in flight still owns it.
    const RETIRE_UNUSED_DIGEST: &str = "UPDATE blob_catalog SET blob_state='retired', touched_at_ms=$1
        WHERE space_id=$2 AND content_blake3=$3 AND admission_state='open' AND blob_state='staging'
        AND ref_count=0 AND current_publication_id IS NULL AND NOT EXISTS (
            SELECT 1 FROM blob_publications WHERE space_id=$2 AND content_blake3=$3 AND state <> 'retired')";
    for (d_bytes, publication_only) in target_digests {
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE blob_publications
                     SET state = 'retired', updated_at_ms = $1
                     WHERE space_id = $2 AND content_blake3 = $3 AND state <> 'active' AND state = 'retiring'
                       AND publication_id IN (SELECT t.publication_id FROM blob_retirement_targets t
                           WHERE t.space_id=blob_publications.space_id AND t.retirement_id=$4)",
                )
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(&d_bytes)
                .bind(retirement_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_retire_pubs", err.to_string()))?;
                if publication_only != 0 {
                    sqlx::query(RETIRE_UNUSED_DIGEST)
                        .bind(now_ms)
                        .bind(space_id.as_str())
                        .bind(&d_bytes)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("retire_unused_digest", err.to_string())
                        })?;
                    continue;
                }

                sqlx::query(
                    "UPDATE blob_catalog
                     SET blob_state = 'retired', admission_state = 'open', current_publication_id = NULL, touched_at_ms = ?
                     WHERE space_id = ? AND content_blake3 = ? AND admission_state = 'retiring'",
                )
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(&d_bytes)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_reopen_cat", err.to_string()))?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE blob_publications
                     SET state = 'retired', updated_at_ms = $1
                     WHERE space_id = $2 AND content_blake3 = $3 AND state <> 'active' AND state = 'retiring'
                       AND publication_id IN (SELECT t.publication_id FROM blob_retirement_targets t
                           WHERE t.space_id=blob_publications.space_id AND t.retirement_id=$4)",
                )
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(&d_bytes)
                .bind(retirement_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_retire_pubs", err.to_string()))?;
                if publication_only != 0 {
                    sqlx::query(RETIRE_UNUSED_DIGEST)
                        .bind(now_ms)
                        .bind(space_id.as_str())
                        .bind(&d_bytes)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("retire_unused_digest", err.to_string())
                        })?;
                    continue;
                }

                sqlx::query(
                    "UPDATE blob_catalog
                     SET blob_state = 'retired', admission_state = 'open', current_publication_id = NULL, touched_at_ms = $1
                     WHERE space_id = $2 AND content_blake3 = $3 AND admission_state = 'retiring'",
                )
                .bind(now_ms)
                .bind(space_id.as_str())
                .bind(&d_bytes)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_reopen_cat", err.to_string()))?;
            }
        }
    }

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE blob_retirements SET status = 'completed', completed_at_ms = ?
                 WHERE space_id = ? AND retirement_id = ?",
            )
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(retirement_id)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_complete_ret", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE blob_retirements SET status = 'completed', completed_at_ms = $1
                 WHERE space_id = $2 AND retirement_id = $3",
            )
            .bind(now_ms)
            .bind(space_id.as_str())
            .bind(retirement_id)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_complete_ret", err.to_string()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod zero_ref_tests {
    use super::SQLITE_ZERO_REF_PAGE;
    use rusqlite::{Connection, StatementStatus, params};

    #[test]
    fn zero_ref_pages_skip_live_catalog_and_page_tied_timestamps() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(crate::schema::SQLITE_BASELINE_DDL)
            .unwrap();
        let mut insert = db
            .prepare("INSERT INTO blob_catalog VALUES ('s',?1,1,1,?2,NULL,'open','active',?3)")
            .unwrap();
        for n in 0..10_000u32 {
            let digest = *blake3::hash(&n.to_be_bytes()).as_bytes();
            insert.execute(params![digest.as_slice(), 1, 0]).unwrap();
        }
        let mut page = db.prepare(SQLITE_ZERO_REF_PAGE).unwrap();
        assert!(
            page.query(params!["s", i64::MIN, &[] as &[u8]])
                .unwrap()
                .next()
                .unwrap()
                .is_none()
        );
        assert!(page.get_status(StatementStatus::VmStep) < 100);
        let mut expected = Vec::new();
        for n in 10_000..10_257u32 {
            let digest = *blake3::hash(&n.to_be_bytes()).as_bytes();
            insert
                .execute(params![digest.as_slice(), 0, i64::MIN])
                .unwrap();
            expected.push(digest.to_vec());
        }
        expected.sort();
        let mut seen = Vec::new();
        let mut after = (i64::MIN, Vec::new());
        loop {
            let rows: Vec<(i64, Vec<u8>)> = page
                .query_map(params!["s", after.0, &after.1], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            let Some(last) = rows.last() else { break };
            after = last.clone();
            seen.extend(rows.into_iter().map(|(_, digest)| digest));
        }
        assert_eq!(seen, expected);
    }
}

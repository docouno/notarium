mod admission;
mod fence;
mod wal;

pub(crate) use admission::list_fenced_collab_leases_tx;
pub use admission::{ActiveRoomFacts, FencedCollabRecovery, NoteCollabAdmission};
use fence::RoomTransition;
use std::{
    collections::{BTreeSet, VecDeque},
    sync::Mutex as StdMutex,
    time::{Duration, Instant},
};
use wal::{PendingWalBatch, append_collab_updates_impl};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, ResourceFacts, Space, SpaceLifecycle},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        ArtifactId, ContentDigest, EffectiveReadId, JobId, LeaseEpoch, LineageEpoch,
        ModelProfileId, NoteId, PrincipalId, ProjectionGeneration, RevisionId, SpaceId, SpaceSeq,
    },
    model::{HistoryScope, Lifecycle, SnapshotCut},
    ports::{
        CallBudget, CancelJob, CommandSeqRange, Committed, ContentJob, ContentJobKind,
        ContentJobPort, JobQuery, JobState, Mutation, PageLimit, PortFuture, ServiceAuthority,
        ServicePurpose, SpaceContext,
    },
    query::{CursorPage, EffectiveRead, KeysetCursor, ReadRequest, SortCell, SortTuple},
    receipt::{CausalBasis, MutationReceiptToken, ReceiptSet},
    value::{ExactNumber, ScalarValue},
};
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{BlobOwnerKind, BlobReferenceClaim, activate_and_bind_blob_ref_tx},
    changes::{
        ChangedNoteSummaryV1, EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft,
    },
    codec::{
        MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, doc_class_to_db, encode_msgpack,
        encode_timestamp_parts, evaluate_fields_with_schema, i64_to_space_seq,
        internal_not_committed, new_prefixed_hex_id, new_revision_id, now_unix_ms,
        now_utc_timestamp, unavailable_retryable,
    },
    domain::{
        common::{
            FolderAncestryCache, NoteHeadRow, build_resource_facts_tx,
            derive_command_identity_spec, load_current_space_schema_tx, load_note_head_row_tx,
            note_rank_version_digest, validate_mutation_identity,
        },
        notes::{
            analyze_and_prepare_carrier_opt_preparsed, changed_revision_fields_tx,
            enforce_room_frontmatter_unchanged_with_header,
        },
    },
    runtime::{
        CanonicalInner, SpaceRecord, insert_revision_row, is_note_purge_fenced_tx,
        load_space_record, load_space_record_for_update_opt,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent, RoomWalAdmission},
};

const MAX_RETAINED_JOB_READS: usize = 1024;
const JOB_READ_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
struct RetainedJobRead {
    id: EffectiveReadId,
    scope: HistoryScope,
    principal: PrincipalId,
    fingerprint: ContentDigest,
    base_cut: SpaceSeq,
    progress_digest: Option<ContentDigest>,
    states: Vec<JobState>,
    limit: PageLimit,
    created_at: Instant,
}

#[derive(Default)]
pub(crate) struct JobReadRegistry {
    entries: StdMutex<VecDeque<RetainedJobRead>>,
}

impl JobReadRegistry {
    fn register(&self, entry: RetainedJobRead) {
        let mut guard = self.entries.lock().expect("job read registry mutex");
        let now = Instant::now();
        while guard
            .front()
            .is_some_and(|front| now.saturating_duration_since(front.created_at) > JOB_READ_TTL)
        {
            guard.pop_front();
        }
        while guard.len() >= MAX_RETAINED_JOB_READS {
            guard.pop_front();
        }
        guard.push_back(entry);
    }

    fn get(&self, id: &EffectiveReadId) -> Option<RetainedJobRead> {
        let mut guard = self.entries.lock().expect("job read registry mutex");
        let now = Instant::now();
        while guard
            .front()
            .is_some_and(|front| now.saturating_duration_since(front.created_at) > JOB_READ_TTL)
        {
            guard.pop_front();
        }
        guard.iter().find(|e| e.id == *id).cloned()
    }

    pub(crate) fn remove_space(&self, space_id: &SpaceId) {
        let mut guard = self.entries.lock().expect("job read registry mutex");
        guard.retain(|e| e.scope.space_id != *space_id);
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
enum StoredJobPayloadV1 {
    Import { artifact: ArtifactId },
    Export { notes: Vec<NoteId>, encrypted: bool },
    Backup,
    Restore { artifact: ArtifactId },
    Reindex,
    Reembed { model: ModelProfileId },
}

impl From<&ContentJobKind> for StoredJobPayloadV1 {
    fn from(k: &ContentJobKind) -> Self {
        match k {
            ContentJobKind::Import { artifact } => Self::Import {
                artifact: artifact.clone(),
            },
            ContentJobKind::Export { notes, encrypted } => Self::Export {
                notes: notes.clone(),
                encrypted: *encrypted,
            },
            ContentJobKind::Backup => Self::Backup,
            ContentJobKind::Restore { artifact } => Self::Restore {
                artifact: artifact.clone(),
            },
            ContentJobKind::Reindex => Self::Reindex,
            ContentJobKind::Reembed { model } => Self::Reembed {
                model: model.clone(),
            },
        }
    }
}

impl From<StoredJobPayloadV1> for ContentJobKind {
    fn from(w: StoredJobPayloadV1) -> Self {
        match w {
            StoredJobPayloadV1::Import { artifact } => Self::Import { artifact },
            StoredJobPayloadV1::Export { notes, encrypted } => Self::Export { notes, encrypted },
            StoredJobPayloadV1::Backup => Self::Backup,
            StoredJobPayloadV1::Restore { artifact } => Self::Restore { artifact },
            StoredJobPayloadV1::Reindex => Self::Reindex,
            StoredJobPayloadV1::Reembed { model } => Self::Reembed { model },
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum StoredJobStateV1 {
    Queued,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

impl From<JobState> for StoredJobStateV1 {
    fn from(s: JobState) -> Self {
        match s {
            JobState::Queued => Self::Queued,
            JobState::Running => Self::Running,
            JobState::Succeeded => Self::Succeeded,
            JobState::Failed => Self::Failed,
            JobState::Cancelled => Self::Cancelled,
        }
    }
}

impl From<StoredJobStateV1> for JobState {
    fn from(s: StoredJobStateV1) -> Self {
        match s {
            StoredJobStateV1::Queued => Self::Queued,
            StoredJobStateV1::Running => Self::Running,
            StoredJobStateV1::Succeeded => Self::Succeeded,
            StoredJobStateV1::Failed => Self::Failed,
            StoredJobStateV1::Cancelled => Self::Cancelled,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredContentJobV1 {
    id: JobId,
    kind: StoredJobPayloadV1,
    state: StoredJobStateV1,
    completed_units: u64,
    total_units: Option<u64>,
    lease: LeaseEpoch,
    artifacts: Vec<ArtifactId>,
}

impl From<&ContentJob> for StoredContentJobV1 {
    fn from(j: &ContentJob) -> Self {
        Self {
            id: j.id.clone(),
            kind: (&j.kind).into(),
            state: j.state.into(),
            completed_units: j.completed_units,
            total_units: j.total_units,
            lease: j.lease,
            artifacts: j.artifacts.clone(),
        }
    }
}

impl From<StoredContentJobV1> for ContentJob {
    fn from(w: StoredContentJobV1) -> Self {
        Self {
            id: w.id,
            kind: w.kind.into(),
            state: w.state.into(),
            completed_units: w.completed_units,
            total_units: w.total_units,
            lease: w.lease,
            artifacts: w.artifacts,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCommittedJobV1 {
    value: StoredContentJobV1,
    receipt: MutationReceiptToken,
}

impl StoredCommittedJobV1 {
    fn into_committed(self) -> Committed<ContentJob> {
        Committed {
            value: self.value.into(),
            receipt: self.receipt,
        }
    }
}

/// Canonical worker lease claim returned by [`CanonicalStore::claim_next_job`].
#[derive(Clone, Debug)]
pub struct ClaimedContentJob {
    pub job: ContentJob,
    pub lease_owner: String,
    pub lease_until_ms: i64,
    pub attempts: u64,
    pub payload_erased_by_purge: bool,
}

/// Terminal worker job completion outcome passed to [`CanonicalStore::complete_job`].
#[derive(Clone, Debug)]
pub enum JobCompletionOutcome {
    Succeeded {
        completed_units: u64,
        total_units: Option<u64>,
        artifacts: Vec<ArtifactId>,
        result_msgpack: Option<Vec<u8>>,
    },
    Failed {
        completed_units: u64,
        total_units: Option<u64>,
        error_ref: ContentDigest,
    },
}

/// Persistent collaborative room state stored in `collab_sessions`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CollabRoomState {
    Closed,
    Active,
    Fenced,
}

impl CollabRoomState {
    fn from_db(raw: &str) -> Result<Self, PortError> {
        match raw {
            "closed" => Ok(Self::Closed),
            "active" => Ok(Self::Active),
            "fenced" => Ok(Self::Fenced),
            other => Err(internal_not_committed(
                "corrupt_collab_room_state",
                format!("unknown collab room_state '{other}'"),
            )),
        }
    }

    fn as_db(self) -> &'static str {
        match self {
            Self::Closed => "closed",
            Self::Active => "active",
            Self::Fenced => "fenced",
        }
    }
}

/// Canonical `collab_sessions` row summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabSessionRecord {
    pub note: NoteId,
    pub lease_epoch: LeaseEpoch,
    pub lineage_epoch: LineageEpoch,
    pub carrier_rev_id: RevisionId,
    pub yrs_snapshot_blob: Option<Vec<u8>>,
    pub yrs_snapshot_digest: Option<ContentDigest>,
    /// Inclusive (lease, update sequence) already represented by the snapshot.
    pub snapshot_coverage: Option<(LeaseEpoch, u64)>,
    /// The canonical carrier still requires reconciliation with collaborative state.
    pub carrier_dirty: bool,
    pub room_state: CollabRoomState,
    pub owner_id: Option<String>,
    pub updated_seq: SpaceSeq,
}

/// Single ordered entry in `collab_update_log`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabUpdateEntry {
    pub lease_epoch: LeaseEpoch,
    pub update_seq: u64,
    pub update_bytes: Vec<u8>,
    pub created_at_ms: i64,
}

/// Full persisted snapshot of a note's collaborative session and uncompacted update log.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabSessionSnapshot {
    pub session: CollabSessionRecord,
    pub updates: Vec<CollabUpdateEntry>,
}

/// Input specification for opening or recovering a live collaborative session.
#[derive(Clone, Debug)]
pub struct OpenCollabSession {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: String,
    pub expected_carrier_rev: RevisionId,
    pub expected_lease: Option<LeaseEpoch>,
    pub expected_lineage: Option<LineageEpoch>,
    pub initial_yrs_snapshot: Option<Vec<u8>>,
    pub allow_fenced_recovery: bool,
}

/// Input specification for appending an incremental Yrs update under an active room lease (test-only seam).
#[cfg(any(test, feature = "test-support"))]
#[derive(Clone, Debug)]
pub struct AppendCollabUpdate {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: String,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
    pub update_seq: u64,
    pub update_bytes: Vec<u8>,
}

/// A peer's newly accepted edit. The authorization context is used in the writer
/// transaction and is never persisted with the WAL row.
#[derive(Clone, Debug)]
pub struct RoomWalEntry {
    pub update_seq: u64,
    pub update_bytes: Vec<u8>,
    pub auth: EngineAuthContext,
}

/// Ordered updates from one room. An exact retry resolves ambiguous commits.
#[derive(Clone, Debug)]
pub struct AppendCollabUpdates {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: String,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
    pub updates: Vec<RoomWalEntry>,
}

/// Revocable writer credentials and service-only recovery of a durable room
/// have separate authority. Recovery is limited to settling accepted edits.
#[derive(Clone, Debug)]
pub enum CollabSettlementActor {
    Writer(Box<EngineAuthContext>),
    Recovery { authority: ServiceAuthority },
}

impl CollabSettlementActor {
    pub fn writer(auth: EngineAuthContext) -> Self {
        Self::Writer(Box::new(auth))
    }
}

/// Optional canonical carrier settlement written during collaborative checkpoint or room close.
#[derive(Clone, Debug)]
pub struct CollabCarrierSettlement {
    pub actor: CollabSettlementActor,
    pub carrier: String,
}

/// Input specification for checkpointing an active collaborative session.
#[derive(Clone, Debug)]
pub struct CheckpointCollabSession {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: String,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
    pub yrs_snapshot: Vec<u8>,
    pub compacted_through_update_seq: Option<u64>,
    pub carrier_settlement: Option<CollabCarrierSettlement>,
    pub unchanged_carrier_digest: Option<ContentDigest>,
}

/// Input specification for closing an active or fenced collaborative session cleanly.
#[derive(Clone, Debug)]
pub struct CloseCollabSession {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: Option<String>,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
    pub final_yrs_snapshot: Option<Vec<u8>>,
    /// Inclusive prefix covered by the supplied final snapshot in this room lease.
    pub compacted_through_update_seq: Option<u64>,
    pub carrier_settlement: Option<CollabCarrierSettlement>,
    pub unchanged_carrier_digest: Option<ContentDigest>,
}

/// Detaches an active owner without changing the durable snapshot or WAL.
#[derive(Clone, Debug)]
pub struct FenceCollabSession {
    pub scope: HistoryScope,
    pub note: NoteId,
    pub owner_id: String,
    pub expected_lease: LeaseEpoch,
    pub expected_lineage: LineageEpoch,
}

impl ContentJobPort for CanonicalStore {
    fn create_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<ContentJobKind>,
    ) -> PortFuture<'_, Committed<ContentJob>> {
        let store = self.clone();
        Box::pin(async move { create_job_impl(&store, ctx, request).await })
    }

    fn get_job(&self, ctx: SpaceContext, job: JobId) -> PortFuture<'_, ContentJob> {
        let store = self.clone();
        Box::pin(async move { get_job_impl(&store, ctx, job).await })
    }

    fn list_jobs(
        &self,
        ctx: SpaceContext,
        request: ReadRequest<JobQuery, JobId>,
    ) -> PortFuture<'_, CursorPage<ContentJob, JobId>> {
        let store = self.clone();
        Box::pin(async move { list_jobs_impl(&store, ctx, request).await })
    }

    fn cancel_job(
        &self,
        ctx: SpaceContext,
        request: Mutation<CancelJob>,
    ) -> PortFuture<'_, Committed<ContentJob>> {
        let store = self.clone();
        Box::pin(async move { cancel_job_impl(&store, ctx, request).await })
    }
}

impl CanonicalStore {
    /// Claims the next queued or expired-lease content job in `scope`, advancing `lease_epoch`
    /// and emitting an observable job edit change.
    pub async fn claim_next_job(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        worker_id: &str,
        lease_duration: Duration,
    ) -> Result<Option<ClaimedContentJob>, PortError> {
        claim_next_job_impl(self, budget, scope, worker_id, lease_duration).await
    }

    /// Renews an active worker lease and updates progress units without advancing `SpaceSeq`.
    #[allow(clippy::too_many_arguments)]
    pub async fn heartbeat_job_lease(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        job: &JobId,
        worker_id: &str,
        expected_lease: LeaseEpoch,
        lease_duration: Duration,
        completed_units: u64,
        total_units: Option<u64>,
    ) -> Result<ContentJob, PortError> {
        heartbeat_job_lease_impl(
            self,
            budget,
            scope,
            job,
            worker_id,
            expected_lease,
            lease_duration,
            completed_units,
            total_units,
        )
        .await
    }

    /// Completes a leased running job (`Succeeded` or `Failed`), advancing `lease_epoch` and `SpaceSeq`.
    pub async fn complete_job(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        job: &JobId,
        worker_id: &str,
        expected_lease: LeaseEpoch,
        outcome: JobCompletionOutcome,
    ) -> Result<Committed<ContentJob>, PortError> {
        complete_job_impl(self, budget, scope, job, worker_id, expected_lease, outcome).await
    }

    /// Reads the persisted collaborative session and ordered `collab_update_log` for `note`.
    pub async fn read_collab_session(
        &self,
        budget: Option<&CallBudget>,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<Option<CollabSessionSnapshot>, PortError> {
        read_collab_session_impl(self, budget, scope, note).await
    }

    /// Waits for a locally pending room transition to settle before reading
    /// durable state. Waiting uses no SQL checkout or writer commit guard.
    pub async fn read_collab_session_after_transition(
        &self,
        budget: &CallBudget,
        scope: &HistoryScope,
        note: &NoteId,
    ) -> Result<Option<CollabSessionSnapshot>, PortError> {
        let deadline =
            crate::domain::common::CommandDeadline::start(budget, "read_room_after_transition");
        if let Some(fence) = self.inner.room_fences.existing_fence(scope, note) {
            drop(deadline.wait(budget, || fence.lock_owned()).await?);
        }
        let mut remaining = budget.clone();
        remaining.remaining = deadline.remaining(budget)?;
        self.read_collab_session(Some(&remaining), scope, note)
            .await
    }

    /// Opens (or takes fenced recovery ownership of) a collaborative session, synchronizing
    /// both `RoomFenceTable` and `collab_sessions` under a single fence lock.
    pub async fn open_collab_session(
        &self,
        budget: &CallBudget,
        spec: OpenCollabSession,
    ) -> Result<CollabSessionRecord, PortError> {
        open_collab_session_impl(self, budget, spec).await
    }

    /// Appends an incremental Yrs update to `collab_update_log` under exact `(lease_epoch, lineage_epoch)`.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn append_collab_update(
        &self,
        budget: &CallBudget,
        spec: AppendCollabUpdate,
    ) -> Result<u64, PortError> {
        append_collab_updates_impl(self, budget, PendingWalBatch::single(spec), None).await
    }

    /// Group commits an authorized batch in the canonical writer. A lost
    /// acknowledgement can be resolved by resubmitting the same batch.
    pub async fn append_collab_updates(
        &self,
        budget: &CallBudget,
        spec: AppendCollabUpdates,
    ) -> Result<u64, PortError> {
        append_collab_updates_impl(self, budget, PendingWalBatch::from(spec), None).await
    }

    /// Admits the group under the authors' live registrations after reserving
    /// writer capacity. The callback must enqueue while those registrations
    /// are held, or return a failure without enqueueing.
    pub async fn append_collab_updates_with_admission(
        &self,
        budget: &CallBudget,
        spec: AppendCollabUpdates,
        admit: &RoomWalAdmission<'_>,
    ) -> Result<u64, PortError> {
        append_collab_updates_impl(self, budget, PendingWalBatch::from(spec), Some(admit)).await
    }

    /// Checkpoints an active collaborative session, compacting `collab_update_log` and optionally
    /// settling a new canonical note carrier revision atomically.
    pub async fn checkpoint_collab_session(
        &self,
        budget: &CallBudget,
        spec: CheckpointCollabSession,
    ) -> Result<CollabSessionRecord, PortError> {
        checkpoint_collab_session_impl(self, budget, spec).await
    }

    /// Closes an active or fenced collaborative session cleanly, optionally settling a final
    /// canonical note carrier revision and synchronizing `RoomFenceTable` to closed.
    pub async fn close_collab_session(
        &self,
        budget: &CallBudget,
        spec: CloseCollabSession,
    ) -> Result<CollabSessionRecord, PortError> {
        close_collab_session_impl(self, budget, spec).await
    }

    /// Fences a room while retaining its last durable state for the next owner.
    pub async fn fence_collab_session(
        &self,
        budget: &CallBudget,
        spec: FenceCollabSession,
    ) -> Result<CollabSessionRecord, PortError> {
        fence_collab_session_impl(self, budget, spec).await
    }
}

/// Fence active rooms when a Space writer changes. Snapshots and uncompacted
/// updates remain available to the new owner for explicit recovery.
pub(crate) async fn fence_rooms_on_takeover_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
) -> Result<(), PortError> {
    let sql = "UPDATE collab_sessions SET room_state = 'fenced',
               lease_epoch = lease_epoch + 1, owner_id = NULL
               WHERE space_id = $1 AND room_state = 'active'";
    match tx {
        BackendConn::Postgres(conn) => sqlx::query(sql)
            .bind(scope.space_id.as_str())
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Sqlite(conn) => sqlx::query(sql)
            .bind(scope.space_id.as_str())
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
    .map_err(|err| internal_not_committed("fence_takeover_rooms", err.to_string()))
}

/// Startup fenced recovery: on single-writer SQLite, transitions any leftover `'active'`
/// `collab_sessions` from an uncleanly terminated process to `'fenced'` (`lease_epoch += 1`),
/// then seeds `RoomFenceTable` from persisted `collab_sessions` before direct serving begins.
pub(crate) async fn reconcile_collab_fences_on_startup(
    store: &CanonicalStore,
) -> Result<(), PortError> {
    if matches!(
        store.inner.config.sql,
        crate::config::SqlBackendConfig::Sqlite { .. }
    ) {
        store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    if let BackendConn::Sqlite(conn) = tx {
                        sqlx::query(
                            "UPDATE collab_sessions
                             SET room_state = 'fenced',
                                 lease_epoch = lease_epoch + 1,
                                 owner_id = NULL
                             WHERE room_state = 'active'",
                        )
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_fence_active_collab", err.to_string())
                        })?;
                    }
                    Ok(())
                })
            })
            .await?;
    }

    let persisted_rows: Vec<(String, Vec<u8>, String, i64, String)> = store
        .with_read_tx(|tx| {
            Box::pin(async move {
                match tx {
                    BackendConn::Sqlite(conn) => {
                        let rows = sqlx::query(
                            "SELECT c.space_id, s.history_incarnation, c.note_id, c.lease_epoch, c.room_state
                             FROM collab_sessions c
                             JOIN spaces s ON s.space_id = c.space_id",
                        )
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_scan_collab_startup", err.to_string())
                        })?;
                        Ok(rows
                            .into_iter()
                            .map(|r| {
                                (
                                    r.get("space_id"),
                                    r.get("history_incarnation"),
                                    r.get("note_id"),
                                    r.get("lease_epoch"),
                                    r.get("room_state"),
                                )
                            })
                            .collect())
                    }
                    BackendConn::Postgres(conn) => {
                        let rows = sqlx::query(
                            "SELECT c.space_id, s.history_incarnation, c.note_id, c.lease_epoch, c.room_state
                             FROM collab_sessions c
                             JOIN spaces s ON s.space_id = c.space_id",
                        )
                        .fetch_all(&mut **conn)
                        .await
                        .map_err(|err| {
                            crate::runtime::pg_read_error("pg_scan_collab_startup", err)
                        })?;
                        Ok(rows
                            .into_iter()
                            .map(|r| {
                                (
                                    r.get("space_id"),
                                    r.get("history_incarnation"),
                                    r.get("note_id"),
                                    r.get("lease_epoch"),
                                    r.get("room_state"),
                                )
                            })
                            .collect())
                    }
                }
            })
        })
        .await?;

    for (space_raw, inc_bytes, note_raw, lease_raw, state_raw) in persisted_rows {
        let space_id = SpaceId::parse(&space_raw)
            .map_err(|_| internal_not_committed("corrupt_collab_space", "invalid SpaceId"))?;
        let inc_arr: [u8; 16] = inc_bytes.try_into().map_err(|_| {
            internal_not_committed("corrupt_collab_inc", "history_incarnation != 16B")
        })?;
        let note_id = NoteId::parse(&note_raw)
            .map_err(|_| internal_not_committed("corrupt_collab_note", "invalid NoteId"))?;
        let epoch = LeaseEpoch::new(u64::try_from(lease_raw).map_err(|_| {
            internal_not_committed("corrupt_collab_lease", "negative lease_epoch")
        })?)?;
        let scope = HistoryScope {
            space_id,
            incarnation: notarium_core::ids::HistoryIncarnation::from_bytes(inc_arr),
        };
        let state = CollabRoomState::from_db(&state_raw)?;
        store
            .inner
            .room_fences
            .seed_persisted_room(&scope, &note_id, epoch, state == CollabRoomState::Active)
            .await?;
        store.inner.room_fences.set_room_fenced(
            &scope.space_id,
            &note_id,
            state == CollabRoomState::Fenced,
        );
    }

    Ok(())
}

fn job_kind_to_db(kind: &ContentJobKind) -> &'static str {
    match kind {
        ContentJobKind::Import { .. } => "import",
        ContentJobKind::Export { .. } => "export",
        ContentJobKind::Backup => "backup",
        ContentJobKind::Restore { .. } => "restore",
        ContentJobKind::Reindex => "reindex",
        ContentJobKind::Reembed { .. } => "reembed",
    }
}

fn job_state_to_db(state: JobState) -> &'static str {
    match state {
        JobState::Queued => "queued",
        JobState::Running => "running",
        JobState::Succeeded => "succeeded",
        JobState::Failed => "failed",
        JobState::Cancelled => "cancelled",
    }
}

fn job_state_from_db(raw: &str) -> Result<JobState, PortError> {
    match raw {
        "queued" => Ok(JobState::Queued),
        "running" => Ok(JobState::Running),
        "succeeded" => Ok(JobState::Succeeded),
        "failed" => Ok(JobState::Failed),
        "cancelled" => Ok(JobState::Cancelled),
        other => Err(internal_not_committed(
            "corrupt_job_state",
            format!("unknown content_jobs.state '{other}'"),
        )),
    }
}

fn authorize_job_read_on_space(auth: &EngineAuthContext, space: &Space) -> Result<(), DomainError> {
    let grant = auth
        .spaces()
        .get(&space.id)
        .ok_or(DomainError::ResourceNotFound)?;
    if space.lifecycle != SpaceLifecycle::Active || grant.project_root.is_some() {
        return Err(DomainError::ResourceNotFound);
    }
    // Note: EngineAuthContext::authorize_chat_read marks external read taint when reading outside write_space;
    // mirror that whole-Space read check for unscoped job metadata.
    auth.authorize_chat_read(space, None, false)
}

fn authorize_job_write_on_space(
    auth: &EngineAuthContext,
    space: &Space,
) -> Result<(), DomainError> {
    auth.authorize_space_write(space)?;
    let grant = auth
        .spaces()
        .get(&space.id)
        .ok_or(DomainError::ResourceNotFound)?;
    if grant.project_root.is_some() {
        return Err(DomainError::SpaceReadOnly);
    }
    Ok(())
}

fn new_job_id() -> Result<JobId, PortError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|err| internal_not_committed("csprng_job_id", err.to_string()))?;
    Ok(JobId::from_bytes(bytes))
}

fn new_effective_read_id() -> Result<EffectiveReadId, PortError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|err| internal_not_committed("csprng_read_id", err.to_string()))?;
    Ok(EffectiveReadId::from_bytes(bytes))
}

fn sanitize_erased_job_kind(job_kind_raw: &str) -> Result<ContentJobKind, PortError> {
    match job_kind_raw {
        "export" => Ok(ContentJobKind::Export {
            notes: Vec::new(),
            encrypted: false,
        }),
        "backup" => Ok(ContentJobKind::Backup),
        "reindex" => Ok(ContentJobKind::Reindex),
        other => Err(internal_not_committed(
            "unexpected_erased_job_kind",
            format!("job_kind '{other}' lacks payload_msgpack"),
        )),
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_content_job_row(
    job_id_raw: String,
    job_kind_raw: String,
    payload_msgpack: Option<Vec<u8>>,
    payload_erased: i64,
    state_raw: String,
    completed_raw: i64,
    total_opt: Option<i64>,
    lease_raw: i64,
    artifacts_json: String,
) -> Result<ContentJob, PortError> {
    let id = JobId::parse(&job_id_raw)
        .map_err(|_| internal_not_committed("corrupt_job_id", "invalid JobId"))?;
    let state = job_state_from_db(&state_raw)?;
    let completed_units = u64::try_from(completed_raw)
        .map_err(|_| internal_not_committed("corrupt_job_completed", "negative completed_units"))?;
    let total_units = match total_opt {
        Some(t) => Some(
            u64::try_from(t)
                .map_err(|_| internal_not_committed("corrupt_job_total", "negative total_units"))?,
        ),
        None => None,
    };
    let lease = LeaseEpoch::new(
        u64::try_from(lease_raw)
            .map_err(|_| internal_not_committed("corrupt_job_lease", "negative lease_epoch"))?,
    )?;

    let (kind, artifacts) = if payload_erased != 0 {
        (sanitize_erased_job_kind(&job_kind_raw)?, Vec::new())
    } else {
        let bytes = payload_msgpack.ok_or_else(|| {
            internal_not_committed("missing_job_payload", "active job lacks payload_msgpack")
        })?;
        let stored_kind: StoredJobPayloadV1 =
            decode_msgpack_bounded(&bytes, MAX_MSGPACK_DECODE_BYTES)?;
        let parsed_artifacts: Vec<ArtifactId> = serde_json::from_str(&artifacts_json)
            .map_err(|err| internal_not_committed("corrupt_job_artifacts", err.to_string()))?;
        (stored_kind.into(), parsed_artifacts)
    };

    Ok(ContentJob {
        id,
        kind,
        state,
        completed_units,
        total_units,
        lease,
        artifacts,
    })
}

#[allow(clippy::type_complexity)]
async fn load_job_row_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    job_id: &JobId,
) -> Result<Option<(ContentJob, Option<String>, Option<i64>, u64, bool, SpaceSeq)>, PortError> {
    let raw: Option<(
        String,
        Option<Vec<u8>>,
        i64,
        String,
        Option<String>,
        i64,
        Option<i64>,
        i64,
        i64,
        Option<i64>,
        String,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT job_kind, payload_msgpack, payload_erased_by_purge, state,
                        lease_owner, lease_epoch, lease_until_ms, attempts,
                        completed_units, total_units, artifacts_json, created_seq
                 FROM content_jobs
                 WHERE space_id = ? AND job_id = ?",
            )
            .bind(space_id.as_str())
            .bind(job_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_job", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("job_kind"),
                    row.get("payload_msgpack"),
                    row.get("payload_erased_by_purge"),
                    row.get("state"),
                    row.get("lease_owner"),
                    row.get("lease_epoch"),
                    row.get("lease_until_ms"),
                    row.get("attempts"),
                    row.get("completed_units"),
                    row.get("total_units"),
                    row.get("artifacts_json"),
                    row.get("created_seq"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT job_kind, payload_msgpack, payload_erased_by_purge::BIGINT AS pe, state,
                        lease_owner, lease_epoch, lease_until_ms, attempts::BIGINT AS att,
                        completed_units, total_units, artifacts_json, created_seq
                 FROM content_jobs
                 WHERE space_id = $1 AND job_id = $2",
            )
            .bind(space_id.as_str())
            .bind(job_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_job", err))?;
            r.map(|row| {
                (
                    row.get("job_kind"),
                    row.get("payload_msgpack"),
                    row.get("pe"),
                    row.get("state"),
                    row.get("lease_owner"),
                    row.get("lease_epoch"),
                    row.get("lease_until_ms"),
                    row.get("att"),
                    row.get("completed_units"),
                    row.get("total_units"),
                    row.get("artifacts_json"),
                    row.get("created_seq"),
                )
            })
        }
    };

    let Some((
        jkind,
        pmsg,
        perased,
        state_raw,
        lowner,
        lepoch,
        luntil,
        att_raw,
        comp_raw,
        tot_opt,
        art_json,
        cseq_raw,
    )) = raw
    else {
        return Ok(None);
    };

    let job = decode_content_job_row(
        job_id.as_str().to_owned(),
        jkind,
        pmsg,
        perased,
        state_raw,
        comp_raw,
        tot_opt,
        lepoch,
        art_json,
    )?;
    let attempts = u64::try_from(att_raw)
        .map_err(|_| internal_not_committed("corrupt_job_attempts", "negative attempts"))?;
    let created_seq = i64_to_space_seq(cseq_raw)?;
    Ok(Some((
        job,
        lowner,
        luntil,
        attempts,
        perased != 0,
        created_seq,
    )))
}

async fn authorize_export_notes_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    notes: &[NoteId],
) -> Result<(), PortError> {
    if crate::runtime::are_any_notes_purge_fenced_tx(tx, &space.id, notes).await? {
        return Err(DomainError::ResourceNotFound.into());
    }
    let heads = crate::domain::common::load_note_heads_batch_tx(tx, &space.id, notes).await?;
    if notes.iter().any(|note| !heads.contains_key(note)) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let mut folders = FolderAncestryCache::default();
    for head in heads.into_values() {
        if head.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        let (facts, _) = folders
            .build_resource_facts_tx(
                tx,
                space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id,
                true,
            )
            .await?;
        auth.authorize_read(&facts)?;
    }
    Ok(())
}

async fn authorize_job_payload_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    job: &ContentJob,
) -> Result<(), PortError> {
    if let ContentJobKind::Export { notes, .. } = &job.kind {
        authorize_export_notes_tx(tx, space, auth, notes).await?;
    }
    Ok(())
}

pub(crate) async fn authorize_job_replay_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    job: Option<&JobId>,
    notes: &[NoteId],
) -> Result<(), PortError> {
    authorize_job_write_on_space(auth, space)?;
    if let Some(id) = job {
        let (current, ..) = load_job_row_opt_tx(tx, &space.id, id)
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
        authorize_job_payload_tx(tx, space, auth, &current).await?;
    }
    authorize_export_notes_tx(tx, space, auth, notes).await
}

async fn create_job_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<ContentJobKind>,
) -> Result<Committed<ContentJob>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "create_job");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let payload_wire = StoredJobPayloadV1::from(&request.input);
    let payload_bytes = encode_msgpack(&payload_wire)?;
    let export_notes = match &request.input {
        ContentJobKind::Export { notes, .. } => notes.as_slice(),
        _ => &[],
    };
    let idemp = derive_command_identity_spec(&request.identity, "create_job", &payload_bytes)
        .for_job(ctx.auth(), None, export_notes);

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_job_write_on_space(&auth, &live_space.space)?;

                let mut owner_notes: Vec<NoteId> = Vec::new();
                let mut total_units: Option<u64> = None;

                if let ContentJobKind::Export { notes, .. } = &input {
                    authorize_export_notes_tx(tx, &live_space.space, &auth, notes).await?;
                    let mut seen = BTreeSet::new();
                    owner_notes.extend(notes.iter().filter(|note| seen.insert(*note)).cloned());
                    total_units = Some(notes.len() as u64);
                }

                let seq = item_ctx.alloc_next_seq()?;
                let job_id = new_job_id()?;
                let rev_id = new_revision_id()?;
                let seq_i64 = seq.get() as i64;
                let jkind_str = job_kind_to_db(&input);
                let tot_i64 = total_units.map(|u| u as i64);

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO content_jobs (
                                space_id, job_id, job_kind, payload_msgpack, payload_erased_by_purge,
                                state, lease_owner, lease_epoch, lease_until_ms, attempts,
                                completed_units, total_units, artifacts_json, result_msgpack, error_ref,
                                created_seq, updated_seq
                             ) VALUES (?, ?, ?, ?, 0, 'queued', NULL, 0, NULL, 0, 0, ?, '[]', NULL, NULL, ?, ?)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(job_id.as_str())
                        .bind(jkind_str)
                        .bind(&payload_bytes)
                        .bind(tot_i64)
                        .bind(seq_i64)
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_create_job", err.to_string()))?;

                        for nid in &owner_notes {
                            sqlx::query(
                                "INSERT OR IGNORE INTO payload_owners (
                                    space_id, payload_kind, payload_id, note_id
                                 ) VALUES (?, 'content_job', ?, ?)",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(job_id.as_str())
                            .bind(nid.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("sqlite_job_payload_owner", err.to_string())
                            })?;
                        }
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO content_jobs (
                                space_id, job_id, job_kind, payload_msgpack, payload_erased_by_purge,
                                state, lease_owner, lease_epoch, lease_until_ms, attempts,
                                completed_units, total_units, artifacts_json, result_msgpack, error_ref,
                                created_seq, updated_seq
                             ) VALUES ($1, $2, $3, $4, 0, 'queued', NULL, 0, NULL, 0, 0, $5, '[]', NULL, NULL, $6, $6)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(job_id.as_str())
                        .bind(jkind_str)
                        .bind(&payload_bytes)
                        .bind(tot_i64)
                        .bind(seq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_create_job", err.to_string()))?;

                        for nid in &owner_notes {
                            sqlx::query(
                                "INSERT INTO payload_owners (
                                    space_id, payload_kind, payload_id, note_id
                                 ) VALUES ($1, 'content_job', $2, $3)
                                 ON CONFLICT DO NOTHING",
                            )
                            .bind(scope.space_id.as_str())
                            .bind(job_id.as_str())
                            .bind(nid.as_str())
                            .execute(&mut **conn)
                            .await
                            .map_err(|err| {
                                internal_not_committed("pg_job_payload_owner", err.to_string())
                            })?;
                        }
                    }
                }

                let job_val = ContentJob {
                    id: job_id.clone(),
                    kind: input,
                    state: JobState::Queued,
                    completed_units: 0,
                    total_units,
                    lease: LeaseEpoch::ZERO,
                    artifacts: Vec::new(),
                };
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let full_resp = StoredCommittedJobV1 {
                    value: (&job_val).into(),
                    receipt: receipt.clone(),
                };
                let full_bytes = CanonicalStore::encode_command_outcome(&full_resp)?;

                let (detail_blob, sanitized_blob) = if !owner_notes.is_empty() {
                    let sanitized_job = ContentJob {
                        id: job_id.clone(),
                        kind: ContentJobKind::Export {
                            notes: Vec::new(),
                            encrypted: false,
                        },
                        state: JobState::Queued,
                        completed_units: 0,
                        total_units,
                        lease: LeaseEpoch::ZERO,
                        artifacts: Vec::new(),
                    };
                    let san_resp = StoredCommittedJobV1 {
                        value: (&sanitized_job).into(),
                        receipt,
                    };
                    (
                        Some(full_bytes.clone()),
                        CanonicalStore::encode_command_outcome(&san_resp)?,
                    )
                } else {
                    (None, full_bytes.clone())
                };

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope,
                    range,
                    "create_job",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "create_job".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "job".to_owned(),
                        entity_id: job_id.as_str().to_owned(),
                        op_kind: "create".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: detail_blob,
                    receipt_sanitized_blob: sanitized_blob,
                    receipt_owner_note_ids: owner_notes,
                    response_bytes: full_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedJobV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

pub(crate) async fn read_visible_job_tx(
    tx: &mut BackendConn<'_>,
    space: &Space,
    auth: &EngineAuthContext,
    job: &JobId,
) -> Result<ContentJob, PortError> {
    authorize_job_read_on_space(auth, space)?;

    let Some((found, ..)) = load_job_row_opt_tx(tx, &space.id, job).await? else {
        return Err(DomainError::ResourceNotFound.into());
    };
    authorize_job_payload_tx(tx, space, auth, &found).await?;
    Ok(found)
}

async fn get_job_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    job: JobId,
) -> Result<ContentJob, PortError> {
    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope.space_id).await?;
                srec.scope.check(&scope)?;
                read_visible_job_tx(tx, &srec.space, &auth, &job).await
            })
        })
        .await
}

fn canonicalize_job_states(states: &[JobState]) -> Vec<JobState> {
    let mut order = Vec::new();
    for candidate in [
        JobState::Queued,
        JobState::Running,
        JobState::Succeeded,
        JobState::Failed,
        JobState::Cancelled,
    ] {
        if states.contains(&candidate) {
            order.push(candidate);
        }
    }
    order
}

fn compute_job_query_fingerprint(scope: &HistoryScope, states: &[JobState]) -> ContentDigest {
    let mut h = blake3::Hasher::new();
    h.update(b"notarium-job-query-v1:");
    h.update(scope.space_id.as_str().as_bytes());
    h.update(&[0]);
    h.update(scope.incarnation.as_bytes());
    h.update(&[0]);
    for s in states {
        h.update(job_state_to_db(*s).as_bytes());
        h.update(b",");
    }
    ContentDigest::from_bytes(*h.finalize().as_bytes())
}

async fn list_jobs_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: ReadRequest<JobQuery, JobId>,
) -> Result<CursorPage<ContentJob, JobId>, PortError> {
    let scope_in = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let inner = std::sync::Arc::clone(&store.inner);

    store
        .with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let job_reads = &inner.job_reads;
                let srec = load_space_record(tx, &scope_in.space_id).await?;
                srec.scope.check(&scope_in)?;
                authorize_job_read_on_space(&auth, &srec.space)?;

                let (effective_read_id, base_cut, fingerprint, states, limit, after_key_opt) =
                    match request {
                        ReadRequest::Open { query, causal } => {
                            match &causal {
                                CausalBasis::Exact(receipts) => {
                                    for r in receipts.for_scope(&srec.scope)? {
                                        if r.seq() > srec.last_seq {
                                            return Err(DomainError::validation(
                                                ValidationReason::InvalidCutoff,
                                            )
                                            .into());
                                        }
                                    }
                                }
                                CausalBasis::Await(watermarks) => {
                                    if watermarks.required(&srec.scope)? > srec.last_seq {
                                        return Err(DomainError::validation(
                                            ValidationReason::NotReady,
                                        )
                                        .into());
                                    }
                                }
                            }
                            let norm_states = canonicalize_job_states(&query.states);
                            let fp = compute_job_query_fingerprint(&srec.scope, &norm_states);
                            let read_id = new_effective_read_id()?;
                            (
                                read_id,
                                srec.last_seq,
                                fp,
                                norm_states,
                                query.limit,
                                None::<(i64, String)>,
                            )
                        }
                        ReadRequest::Continue { cursor } => {
                            srec.scope.check(&cursor.scope)?;
                            if cursor.version != 1 {
                                return Err(DomainError::validation(
                                    ValidationReason::CursorScopeMismatch,
                                )
                                .into());
                            }
                            let Some(retained) = job_reads.get(&cursor.effective_read) else {
                                return Err(
                                    DomainError::validation(ValidationReason::CursorStale).into()
                                );
                            };
                            if retained.principal != *auth.principal() {
                                return Err(DomainError::validation(
                                    ValidationReason::CursorScopeMismatch,
                                )
                                .into());
                            }
                            let eff = EffectiveRead {
                                id: retained.id.clone(),
                                cut: SnapshotCut {
                                    scope: retained.scope.clone(),
                                    generation: ProjectionGeneration::ZERO,
                                    canonical_seq: retained.base_cut,
                                    projected_seq: retained.base_cut,
                                },
                                fingerprint: retained.fingerprint,
                                exact_receipts: ReceiptSet::default(),
                                overlay: Vec::new(),
                            };
                            cursor.check(&eff)?;
                            if retained.base_cut != srec.last_seq
                                || retained.progress_digest
                                    != job_progress_digest(
                                        tx,
                                        &srec.scope.space_id,
                                        &retained.states,
                                    )
                                    .await?
                            {
                                return Err(
                                    DomainError::validation(ValidationReason::CursorStale).into()
                                );
                            }
                            if cursor.last.cells.len() != 1 {
                                return Err(DomainError::validation(
                                    ValidationReason::CursorScopeMismatch,
                                )
                                .into());
                            }
                            let SortCell::Value(ScalarValue::Number(num)) = &cursor.last.cells[0]
                            else {
                                return Err(DomainError::validation(
                                    ValidationReason::CursorScopeMismatch,
                                )
                                .into());
                            };
                            let last_seq_i64: i64 = num.as_json().as_i64().ok_or_else(|| {
                                DomainError::validation(ValidationReason::CursorScopeMismatch)
                            })?;
                            (
                                retained.id,
                                retained.base_cut,
                                retained.fingerprint,
                                retained.states,
                                retained.limit,
                                Some((last_seq_i64, cursor.last.entity_id.as_str().to_owned())),
                            )
                        }
                    };

                let fetch_limit = i64::from(limit.get()) + 1;
                let base_cut_i64 = base_cut.get() as i64;
                let page_cap = usize::from(limit.get());
                let mut items = Vec::with_capacity(page_cap);
                let mut scan_after = after_key_opt.clone();
                let mut last_seq_for_cursor = 0;
                // Read ahead to the next visible job; hidden exports must not become cursor keys.
                let has_more = 'pages: loop {
                    let rows = query_jobs_page_tx(
                        tx,
                        &srec.scope.space_id,
                        base_cut_i64,
                        &states,
                        scan_after.as_ref(),
                        fetch_limit,
                    )
                    .await?;
                    let exhausted = rows.len() < fetch_limit as usize;
                    for (seq, job) in rows {
                        scan_after = Some((seq, job.id.as_str().to_owned()));
                        match authorize_job_payload_tx(tx, &srec.space, &auth, &job).await {
                            Ok(()) => {}
                            Err(PortError::Domain(DomainError::ResourceNotFound)) => continue,
                            Err(err) => return Err(err),
                        }
                        if items.len() == page_cap {
                            break 'pages true;
                        }
                        last_seq_for_cursor = seq;
                        items.push(job);
                    }
                    if exhausted {
                        break false;
                    }
                };

                let next = if has_more {
                    let last_job = items.last().expect("non-empty page when has_more");
                    if after_key_opt.is_none() {
                        job_reads.register(RetainedJobRead {
                            id: effective_read_id.clone(),
                            scope: srec.scope.clone(),
                            principal: auth.principal().clone(),
                            fingerprint,
                            base_cut,
                            progress_digest: job_progress_digest(tx, &srec.scope.space_id, &states)
                                .await?,
                            states,
                            limit,
                            created_at: Instant::now(),
                        });
                    }
                    let seq_num = ExactNumber::from(last_seq_for_cursor);
                    Some(KeysetCursor {
                        version: 1,
                        scope: srec.scope.clone(),
                        fingerprint,
                        effective_read: effective_read_id,
                        generation: ProjectionGeneration::ZERO,
                        base_cut,
                        last: SortTuple {
                            cells: vec![SortCell::Value(ScalarValue::Number(seq_num))],
                            entity_id: last_job.id.clone(),
                        },
                    })
                } else {
                    None
                };

                Ok(CursorPage {
                    items,
                    next,
                    scope: srec.scope,
                    canonical_seq: base_cut,
                    projected_seq: base_cut,
                    incomplete: false,
                    diagnostics: Vec::new(),
                })
            })
        })
        .await
}

/// Heartbeats can change the visible progress of a running job without a SpaceSeq.
async fn job_progress_digest(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    states: &[JobState],
) -> Result<Option<ContentDigest>, PortError> {
    if !states.is_empty() && !states.contains(&JobState::Running) {
        return Ok(None);
    }
    use futures_util::TryStreamExt;
    type Progress = (String, i64, Option<i64>);
    let mut rows = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as::<_, Progress>(
            "SELECT job_id, completed_units, total_units FROM content_jobs
             WHERE space_id = ? AND state = 'running' ORDER BY job_id",
        )
        .bind(space.as_str())
        .fetch(&mut **conn),
        BackendConn::Postgres(conn) => sqlx::query_as::<_, Progress>(
            "SELECT job_id, completed_units, total_units FROM content_jobs
             WHERE space_id = $1 AND state = 'running' ORDER BY job_id",
        )
        .bind(space.as_str())
        .fetch(&mut **conn),
    };
    let mut hash = blake3::Hasher::new();
    while let Some((id, done, total)) = rows
        .try_next()
        .await
        .map_err(|err| crate::runtime::pg_read_error("job_progress_digest", err))?
    {
        hash.update(id.as_bytes());
        hash.update(&done.to_be_bytes());
        hash.update(&total.unwrap_or(-1).to_be_bytes());
    }
    Ok(Some(ContentDigest::from_bytes(*hash.finalize().as_bytes())))
}

async fn query_jobs_page_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    base_cut_i64: i64,
    states: &[JobState],
    after_key: Option<&(i64, String)>,
    fetch_limit: i64,
) -> Result<Vec<(i64, ContentJob)>, PortError> {
    let allow_all = states.is_empty();
    let s0 = states
        .first()
        .map(|s| job_state_to_db(*s))
        .unwrap_or("__none__");
    let s1 = states
        .get(1)
        .map(|s| job_state_to_db(*s))
        .unwrap_or("__none__");
    let s2 = states
        .get(2)
        .map(|s| job_state_to_db(*s))
        .unwrap_or("__none__");
    let s3 = states
        .get(3)
        .map(|s| job_state_to_db(*s))
        .unwrap_or("__none__");
    let s4 = states
        .get(4)
        .map(|s| job_state_to_db(*s))
        .unwrap_or("__none__");

    let (has_after, after_seq, after_id) = match after_key {
        Some((seq, id)) => (1i64, *seq, id.as_str()),
        None => (0i64, i64::MAX, ""),
    };

    #[allow(clippy::type_complexity)]
    let raw_rows: Vec<(
        String,
        String,
        Option<Vec<u8>>,
        i64,
        String,
        i64,
        Option<i64>,
        i64,
        String,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT job_id, job_kind, payload_msgpack, payload_erased_by_purge,
                        state, completed_units, total_units, lease_epoch, artifacts_json, created_seq
                 FROM content_jobs
                 WHERE space_id = ?
                   AND created_seq <= ?
                   AND (? = 1 OR state IN (?, ?, ?, ?, ?))
                   AND (? = 0 OR created_seq < ? OR (created_seq = ? AND job_id > ?))
                 ORDER BY created_seq DESC, job_id ASC
                 LIMIT ?",
            )
            .bind(space_id.as_str())
            .bind(base_cut_i64)
            .bind(i64::from(u8::from(allow_all)))
            .bind(s0)
            .bind(s1)
            .bind(s2)
            .bind(s3)
            .bind(s4)
            .bind(has_after)
            .bind(after_seq)
            .bind(after_seq)
            .bind(after_id)
            .bind(fetch_limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_list_jobs", err.to_string()))?;

            rows.into_iter()
                .map(|r| {
                    (
                        r.get("job_id"),
                        r.get("job_kind"),
                        r.get("payload_msgpack"),
                        r.get("payload_erased_by_purge"),
                        r.get("state"),
                        r.get("completed_units"),
                        r.get("total_units"),
                        r.get("lease_epoch"),
                        r.get("artifacts_json"),
                        r.get("created_seq"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT job_id, job_kind, payload_msgpack, payload_erased_by_purge::BIGINT AS pe,
                        state, completed_units, total_units, lease_epoch, artifacts_json, created_seq
                 FROM content_jobs
                 WHERE space_id = $1
                   AND created_seq <= $2
                   AND ($3 = 1 OR state IN ($4, $5, $6, $7, $8))
                   AND ($9 = 0 OR created_seq < $10 OR (created_seq = $10 AND job_id > $11))
                 ORDER BY created_seq DESC, job_id ASC
                 LIMIT $12",
            )
            .bind(space_id.as_str())
            .bind(base_cut_i64)
            .bind(i64::from(u8::from(allow_all)))
            .bind(s0)
            .bind(s1)
            .bind(s2)
            .bind(s3)
            .bind(s4)
            .bind(has_after)
            .bind(after_seq)
            .bind(after_id)
            .bind(fetch_limit)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_list_jobs", err))?;

            rows.into_iter()
                .map(|r| {
                    (
                        r.get("job_id"),
                        r.get("job_kind"),
                        r.get("payload_msgpack"),
                        r.get("pe"),
                        r.get("state"),
                        r.get("completed_units"),
                        r.get("total_units"),
                        r.get("lease_epoch"),
                        r.get("artifacts_json"),
                        r.get("created_seq"),
                    )
                })
                .collect()
        }
    };

    let mut out = Vec::with_capacity(raw_rows.len());
    for (jid, jk, pmsg, pe, st, comp, tot, le, art, cseq) in raw_rows {
        let job = decode_content_job_row(jid, jk, pmsg, pe, st, comp, tot, le, art)?;
        out.push((cseq, job));
    }
    Ok(out)
}

async fn load_job_owner_notes_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    job_id: &JobId,
) -> Result<Vec<NoteId>, PortError> {
    let raw: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT note_id FROM payload_owners
                 WHERE space_id = ? AND payload_kind = 'content_job' AND payload_id = ?",
            )
            .bind(space_id.as_str())
            .bind(job_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_job_owners", err.to_string()))?;
            rows.into_iter().map(|r| r.get("note_id")).collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT note_id FROM payload_owners
                 WHERE space_id = $1 AND payload_kind = 'content_job' AND payload_id = $2",
            )
            .bind(space_id.as_str())
            .bind(job_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_job_owners", err.to_string()))?;
            rows.into_iter().map(|r| r.get("note_id")).collect()
        }
    };
    let mut notes = Vec::with_capacity(raw.len());
    for s in raw {
        if let Ok(nid) = NoteId::parse(&s) {
            notes.push(nid);
        }
    }
    Ok(notes)
}

async fn cancel_job_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<CancelJob>,
) -> Result<Committed<ContentJob>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "cancel_job");
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!(
        "job={};expected_lease={}",
        request.input.job.as_str(),
        request.input.expected_lease.get()
    );
    let idemp = derive_command_identity_spec(&request.identity, "cancel_job", fp.as_bytes())
        .for_job(ctx.auth(), Some(&request.input.job), &[]);

    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let auth = ctx.auth().clone();
    let input = request.input;

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let live_space = load_space_record(tx, &scope.space_id).await?;
                authorize_job_write_on_space(&auth, &live_space.space)?;

                let Some((mut cur_job, ..)) =
                    load_job_row_opt_tx(tx, &scope.space_id, &input.job).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };

                if let ContentJobKind::Export { notes, .. } = &cur_job.kind {
                    authorize_export_notes_tx(tx, &live_space.space, &auth, notes).await?;
                }

                if cur_job.lease != input.expected_lease {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                if !matches!(cur_job.state, JobState::Queued | JobState::Running) {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }

                let new_lease = cur_job.lease.checked_next()?;
                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;
                let seq_i64 = seq.get() as i64;
                let lease_i64 = new_lease.get() as i64;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = 'cancelled',
                                 lease_owner = NULL,
                                 lease_until_ms = NULL,
                                 lease_epoch = ?,
                                 updated_seq = ?
                             WHERE space_id = ? AND job_id = ?",
                        )
                        .bind(lease_i64)
                        .bind(seq_i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.job.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_cancel_job", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = 'cancelled',
                                 lease_owner = NULL,
                                 lease_until_ms = NULL,
                                 lease_epoch = $1,
                                 updated_seq = $2
                             WHERE space_id = $3 AND job_id = $4",
                        )
                        .bind(lease_i64)
                        .bind(seq_i64)
                        .bind(scope.space_id.as_str())
                        .bind(input.job.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_cancel_job", err.to_string()))?;
                    }
                }

                cur_job.state = JobState::Cancelled;
                cur_job.lease = new_lease;

                let owner_notes = load_job_owner_notes_tx(tx, &scope.space_id, &input.job).await?;
                let receipt = MutationReceiptToken::new(scope.clone(), seq)?;
                let full_resp = StoredCommittedJobV1 {
                    value: (&cur_job).into(),
                    receipt: receipt.clone(),
                };
                let full_bytes = CanonicalStore::encode_command_outcome(&full_resp)?;
                let (detail_blob, sanitized_blob) = if !owner_notes.is_empty() {
                    let mut san_job = cur_job.clone();
                    if matches!(san_job.kind, ContentJobKind::Export { .. }) {
                        san_job.kind = ContentJobKind::Export {
                            notes: Vec::new(),
                            encrypted: false,
                        };
                        san_job.artifacts.clear();
                    }
                    let san_resp = StoredCommittedJobV1 {
                        value: (&san_job).into(),
                        receipt,
                    };
                    (
                        Some(full_bytes.clone()),
                        CanonicalStore::encode_command_outcome(&san_resp)?,
                    )
                } else {
                    (None, full_bytes.clone())
                };

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope,
                    range,
                    "cancel_job",
                    EffectBodyV1::AwaitProjection {
                        reason: StoredAwaitReasonV1::UnknownEffect,
                    },
                    Vec::new(),
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "cancel_job".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "job".to_owned(),
                        entity_id: input.job.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: detail_blob,
                    receipt_sanitized_blob: sanitized_blob,
                    receipt_owner_note_ids: owner_notes,
                    response_bytes: full_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedJobV1 = deadline.submit(store, &ctx.budget, intent).await?;
    Ok(stored.into_committed())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredClaimedJobV1 {
    job: StoredContentJobV1,
    lease_owner: String,
    lease_until_ms: i64,
    attempts: u64,
    payload_erased_by_purge: bool,
}

async fn claim_next_job_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    scope: &HistoryScope,
    worker_id: &str,
    lease_duration: Duration,
) -> Result<Option<ClaimedContentJob>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "claim_next_job");
    if worker_id.trim().is_empty() || lease_duration.is_zero() {
        return Err(DomainError::validation(ValidationReason::InvalidRange).into());
    }
    let now_check = now_unix_ms()?;
    let scope_read = scope.clone();

    // Quick read precheck so empty queues do not allocate sequence numbers or write transactions.
    let candidate_opt: Option<JobId> = deadline.prepare(budget, || store
        .with_read_tx_budget(Some(budget), |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_read.space_id).await?;
                srec.scope.check(&scope_read)?;
                let raw_opt: Option<String> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT job_id FROM content_jobs
                         WHERE space_id = ?
                           AND (state = 'queued' OR (state = 'running' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?))
                         ORDER BY created_seq ASC, job_id ASC
                         LIMIT 1",
                    )
                    .bind(scope_read.space_id.as_str())
                    .bind(now_check)
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_probe_claim_job", err.to_string()))?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT job_id FROM content_jobs
                         WHERE space_id = $1
                           AND (state = 'queued' OR (state = 'running' AND lease_until_ms IS NOT NULL AND lease_until_ms <= $2))
                         ORDER BY created_seq ASC, job_id ASC
                         LIMIT 1",
                    )
                    .bind(scope_read.space_id.as_str())
                    .bind(now_check)
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_probe_claim_job", err))?,
                };
                match raw_opt {
                    Some(s) => Ok(Some(JobId::parse(&s).map_err(|_| {
                        internal_not_committed("corrupt_claim_job_id", "invalid JobId")
                    })?)),
                    None => Ok(None),
                }
            })
        }))
        .await?;

    if candidate_opt.is_none() {
        return Ok(None);
    }

    let space_rec = deadline
        .prepare(budget, || {
            store.read_space_fast_or_pool(&scope.space_id, Some(budget))
        })
        .await?;
    space_rec.scope.check(scope)?;
    let scope_cl = space_rec.scope.clone();
    let worker_owned = worker_id.to_owned();
    let dur_ms = i64::try_from(lease_duration.as_millis().max(1)).unwrap_or(60_000);

    let intent = PreparedWriteIntent {
        scope: scope_cl.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: None,
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let now_ms = now_unix_ms()?;
                let next_id_opt: Option<String> = match tx {
                    BackendConn::Sqlite(conn) => sqlx::query_scalar(
                        "SELECT job_id FROM content_jobs
                         WHERE space_id = ?
                           AND (state = 'queued' OR (state = 'running' AND lease_until_ms IS NOT NULL AND lease_until_ms <= ?))
                         ORDER BY created_seq ASC, job_id ASC
                         LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(now_ms)
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_select_claim_job", err.to_string()))?,
                    BackendConn::Postgres(conn) => sqlx::query_scalar(
                        "SELECT job_id FROM content_jobs
                         WHERE space_id = $1
                           AND (state = 'queued' OR (state = 'running' AND lease_until_ms IS NOT NULL AND lease_until_ms <= $2))
                         ORDER BY created_seq ASC, job_id ASC
                         LIMIT 1
                         FOR UPDATE",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(now_ms)
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_select_claim_job", err.to_string()))?,
                };

                let Some(jid_raw) = next_id_opt else {
                    return Err(DomainError::validation(ValidationReason::NotReady).into());
                };
                let jid = JobId::parse(&jid_raw)
                    .map_err(|_| internal_not_committed("corrupt_claim_id", "invalid JobId"))?;
                let (mut job, _, _, prev_attempts, erased, _) =
                    load_job_row_opt_tx(tx, &scope_cl.space_id, &jid)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;

                let new_lease = job.lease.checked_next()?;
                let new_attempts = prev_attempts.saturating_add(1);
                let lease_until_ms = now_ms.saturating_add(dur_ms);
                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = 'running',
                                 lease_owner = ?,
                                 lease_epoch = ?,
                                 lease_until_ms = ?,
                                 attempts = ?,
                                 updated_seq = ?
                             WHERE space_id = ? AND job_id = ?",
                        )
                        .bind(&worker_owned)
                        .bind(new_lease.get() as i64)
                        .bind(lease_until_ms)
                        .bind(new_attempts as i64)
                        .bind(seq.get() as i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_claim_job", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = 'running',
                                 lease_owner = $1,
                                 lease_epoch = $2,
                                 lease_until_ms = $3,
                                 attempts = $4,
                                 updated_seq = $5
                             WHERE space_id = $6 AND job_id = $7",
                        )
                        .bind(&worker_owned)
                        .bind(new_lease.get() as i64)
                        .bind(lease_until_ms)
                        .bind(i32::try_from(new_attempts).unwrap_or(i32::MAX))
                        .bind(seq.get() as i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_claim_job", err.to_string()))?;
                    }
                }

                job.state = JobState::Running;
                job.lease = new_lease;

                let wire = StoredClaimedJobV1 {
                    job: (&job).into(),
                    lease_owner: worker_owned,
                    lease_until_ms,
                    attempts: new_attempts,
                    payload_erased_by_purge: erased,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&wire)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "claim_job".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "job".to_owned(),
                        entity_id: jid.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    match deadline
        .submit::<StoredClaimedJobV1>(store, budget, intent)
        .await
    {
        Ok(claimed) => Ok(Some(ClaimedContentJob {
            job: claimed.job.into(),
            lease_owner: claimed.lease_owner,
            lease_until_ms: claimed.lease_until_ms,
            attempts: claimed.attempts,
            payload_erased_by_purge: claimed.payload_erased_by_purge,
        })),
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::NotReady =>
        {
            Ok(None)
        }
        Err(other) => Err(other),
    }
}

#[allow(clippy::too_many_arguments)]
async fn heartbeat_job_lease_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    scope: &HistoryScope,
    job_id: &JobId,
    worker_id: &str,
    expected_lease: LeaseEpoch,
    lease_duration: Duration,
    completed_units: u64,
    total_units: Option<u64>,
) -> Result<ContentJob, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "heartbeat_job_lease");
    let scope_cl = scope.clone();
    let jid = job_id.clone();
    let worker_owned = worker_id.to_owned();
    let dur_ms = i64::try_from(lease_duration.as_millis().max(1)).unwrap_or(60_000);

    let inner = std::sync::Arc::clone(&store.inner);
    store
        .with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                lock_peer_space(tx, &inner, &scope_cl).await?;

                let Some((mut cur_job, cur_owner, ..)) =
                    load_job_row_opt_tx(tx, &scope_cl.space_id, &jid).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                if cur_job.state != JobState::Running {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if cur_job.lease != expected_lease || cur_owner.as_deref() != Some(&worker_owned) {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }

                let now_ms = now_unix_ms()?;
                let new_until = now_ms.saturating_add(dur_ms);
                let comp_i64 = completed_units as i64;
                let tot_i64 = total_units.map(|u| u as i64);

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET lease_until_ms = ?, completed_units = ?, total_units = ?
                             WHERE space_id = ? AND job_id = ? AND lease_epoch = ?",
                        )
                        .bind(new_until)
                        .bind(comp_i64)
                        .bind(tot_i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .bind(expected_lease.get() as i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_heartbeat_job", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET lease_until_ms = $1, completed_units = $2, total_units = $3
                             WHERE space_id = $4 AND job_id = $5 AND lease_epoch = $6",
                        )
                        .bind(new_until)
                        .bind(comp_i64)
                        .bind(tot_i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .bind(expected_lease.get() as i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_heartbeat_job", err.to_string())
                        })?;
                    }
                }

                cur_job.completed_units = completed_units;
                cur_job.total_units = total_units;
                Ok(cur_job)
            })
        })
        .await
}

async fn complete_job_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    scope: &HistoryScope,
    job_id: &JobId,
    worker_id: &str,
    expected_lease: LeaseEpoch,
    outcome: JobCompletionOutcome,
) -> Result<Committed<ContentJob>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "complete_job");
    let space_rec = deadline
        .prepare(budget, || {
            store.read_space_fast_or_pool(&scope.space_id, Some(budget))
        })
        .await?;
    space_rec.scope.check(scope)?;

    let scope_cl = space_rec.scope.clone();
    let jid = job_id.clone();
    let worker_owned = worker_id.to_owned();

    let intent = PreparedWriteIntent {
        scope: scope_cl.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: None,
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let Some((mut cur_job, cur_owner, _, _, erased, _)) =
                    load_job_row_opt_tx(tx, &scope_cl.space_id, &jid).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                if cur_job.state != JobState::Running {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if cur_job.lease != expected_lease || cur_owner.as_deref() != Some(&worker_owned) {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }

                let new_lease = cur_job.lease.checked_next()?;
                let seq = item_ctx.alloc_next_seq()?;
                let rev_id = new_revision_id()?;

                let (new_state, comp_u64, tot_opt, final_artifacts, res_msgpack, err_ref) =
                    match outcome {
                        JobCompletionOutcome::Succeeded {
                            completed_units,
                            total_units,
                            artifacts,
                            result_msgpack,
                        } => {
                            let eff_art = if erased { Vec::new() } else { artifacts };
                            let eff_res = if erased { None } else { result_msgpack };
                            (
                                JobState::Succeeded,
                                completed_units,
                                total_units,
                                eff_art,
                                eff_res,
                                None::<ContentDigest>,
                            )
                        }
                        JobCompletionOutcome::Failed {
                            completed_units,
                            total_units,
                            error_ref,
                        } => (
                            JobState::Failed,
                            completed_units,
                            total_units,
                            Vec::new(),
                            None,
                            Some(error_ref),
                        ),
                    };

                let art_json = serde_json::to_string(&final_artifacts).map_err(|err| {
                    internal_not_committed("encode_job_artifacts", err.to_string())
                })?;
                let state_str = job_state_to_db(new_state);
                let err_slice = err_ref.as_ref().map(|d| d.as_bytes().as_slice());

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = ?,
                                 lease_owner = NULL,
                                 lease_until_ms = NULL,
                                 lease_epoch = ?,
                                 completed_units = ?,
                                 total_units = ?,
                                 artifacts_json = ?,
                                 result_msgpack = ?,
                                 error_ref = ?,
                                 updated_seq = ?
                             WHERE space_id = ? AND job_id = ?",
                        )
                        .bind(state_str)
                        .bind(new_lease.get() as i64)
                        .bind(comp_u64 as i64)
                        .bind(tot_opt.map(|u| u as i64))
                        .bind(&art_json)
                        .bind(res_msgpack.as_deref())
                        .bind(err_slice)
                        .bind(seq.get() as i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_complete_job", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE content_jobs
                             SET state = $1,
                                 lease_owner = NULL,
                                 lease_until_ms = NULL,
                                 lease_epoch = $2,
                                 completed_units = $3,
                                 total_units = $4,
                                 artifacts_json = $5,
                                 result_msgpack = $6,
                                 error_ref = $7,
                                 updated_seq = $8
                             WHERE space_id = $9 AND job_id = $10",
                        )
                        .bind(state_str)
                        .bind(new_lease.get() as i64)
                        .bind(comp_u64 as i64)
                        .bind(tot_opt.map(|u| u as i64))
                        .bind(&art_json)
                        .bind(res_msgpack.as_deref())
                        .bind(err_slice)
                        .bind(seq.get() as i64)
                        .bind(scope_cl.space_id.as_str())
                        .bind(jid.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_complete_job", err.to_string())
                        })?;
                    }
                }

                cur_job.state = new_state;
                cur_job.lease = new_lease;
                cur_job.completed_units = comp_u64;
                cur_job.total_units = tot_opt;
                cur_job.artifacts = final_artifacts;

                let receipt = MutationReceiptToken::new(scope_cl, seq)?;
                let stored = StoredCommittedJobV1 {
                    value: (&cur_job).into(),
                    receipt,
                };
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored)?;
                let cmd_id = new_prefixed_hex_id("cmd_")?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "complete_job".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "job".to_owned(),
                        entity_id: jid.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id,
                        lifecycle: Lifecycle::Active,
                        doc_class: None,
                    }],
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCommittedJobV1 = deadline.submit(store, budget, intent).await?;
    Ok(stored.into_committed())
}

async fn load_collab_session_opt_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Option<CollabSessionRecord>, PortError> {
    #[allow(clippy::type_complexity)]
    let raw: Option<(
        i64,
        i64,
        String,
        Option<Vec<u8>>,
        Option<Vec<u8>>,
        String,
        Option<String>,
        i64,
        i64,
        i64,
        i64,
    )> = match tx {
        BackendConn::Sqlite(conn) => {
            let r = sqlx::query(
                "SELECT lease_epoch, lineage_epoch, carrier_rev_id, yrs_snapshot_blob,
                        yrs_snapshot_blake3, room_state, owner_id, updated_seq,
                        COALESCE(snapshot_lease_epoch, 0) AS snapshot_lease_epoch,
                        COALESCE(snapshot_update_seq, 0) AS snapshot_update_seq,
                        COALESCE(carrier_dirty, 0) AS carrier_dirty
                 FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
                 WHERE space_id = ? AND note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_collab_sess", err.to_string()))?;
            r.map(|row| {
                (
                    row.get("lease_epoch"),
                    row.get("lineage_epoch"),
                    row.get("carrier_rev_id"),
                    row.get("yrs_snapshot_blob"),
                    row.get("yrs_snapshot_blake3"),
                    row.get("room_state"),
                    row.get("owner_id"),
                    row.get("updated_seq"),
                    row.get("snapshot_lease_epoch"),
                    row.get("snapshot_update_seq"),
                    row.get("carrier_dirty"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let r = sqlx::query(
                "SELECT lease_epoch, lineage_epoch, carrier_rev_id, yrs_snapshot_blob,
                        yrs_snapshot_blake3, room_state, owner_id, updated_seq,
                        COALESCE(snapshot_lease_epoch, 0) AS snapshot_lease_epoch,
                        COALESCE(snapshot_update_seq, 0) AS snapshot_update_seq,
                        COALESCE(carrier_dirty, 0) AS carrier_dirty
                 FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id)
                 WHERE space_id = $1 AND note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_collab_sess", err))?;
            r.map(|row| {
                (
                    row.get("lease_epoch"),
                    row.get("lineage_epoch"),
                    row.get("carrier_rev_id"),
                    row.get("yrs_snapshot_blob"),
                    row.get("yrs_snapshot_blake3"),
                    row.get("room_state"),
                    row.get("owner_id"),
                    row.get("updated_seq"),
                    row.get("snapshot_lease_epoch"),
                    row.get("snapshot_update_seq"),
                    row.get("carrier_dirty"),
                )
            })
        }
    };

    let Some((
        le_raw,
        li_raw,
        crev_raw,
        yrs_blob,
        yrs_hash,
        rstate_raw,
        owner_opt,
        useq_raw,
        covered_lease,
        covered_seq,
        dirty,
    )) = raw
    else {
        return Ok(None);
    };
    let lease_epoch = LeaseEpoch::new(
        u64::try_from(le_raw)
            .map_err(|_| internal_not_committed("corrupt_collab_le", "negative lease_epoch"))?,
    )?;
    let lineage_epoch = LineageEpoch::new(
        u64::try_from(li_raw)
            .map_err(|_| internal_not_committed("corrupt_collab_li", "negative lineage_epoch"))?,
    )?;
    let carrier_rev_id = RevisionId::parse(&crev_raw)
        .map_err(|_| internal_not_committed("corrupt_collab_crev", "invalid carrier_rev_id"))?;
    let yrs_snapshot_digest = match yrs_hash {
        Some(b) => {
            let arr: [u8; 32] = b.try_into().map_err(|_| {
                internal_not_committed("corrupt_collab_digest", "yrs_snapshot_blake3 != 32B")
            })?;
            Some(ContentDigest::from_bytes(arr))
        }
        None => None,
    };
    let room_state = CollabRoomState::from_db(&rstate_raw)?;
    let updated_seq = i64_to_space_seq(useq_raw)?;

    let snapshot_coverage = if covered_lease == 0 {
        None
    } else {
        Some((LeaseEpoch::new(covered_lease as u64)?, covered_seq as u64))
    };

    Ok(Some(CollabSessionRecord {
        note: note_id.clone(),
        lease_epoch,
        lineage_epoch,
        carrier_rev_id,
        yrs_snapshot_blob: yrs_blob,
        yrs_snapshot_digest,
        snapshot_coverage,
        carrier_dirty: dirty != 0,
        room_state,
        owner_id: owner_opt,
        updated_seq,
    }))
}

async fn read_collab_session_impl(
    store: &CanonicalStore,
    budget: Option<&CallBudget>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<Option<CollabSessionSnapshot>, PortError> {
    let scope_cl = scope.clone();
    let nid = note.clone();

    store
        .with_read_tx_budget(budget, |tx| {
            Box::pin(async move {
                let srec = load_space_record(tx, &scope_cl.space_id).await?;
                srec.scope.check(&scope_cl)?;
                if is_note_purge_fenced_tx(tx, &scope_cl.space_id, nid.as_str()).await? {
                    return Ok(None);
                }
                load_collab_snapshot_tx(tx, &scope_cl, &nid).await
            })
        })
        .await
}

async fn load_collab_snapshot_tx(
    tx: &mut BackendConn<'_>,
    scope_cl: &HistoryScope,
    nid: &NoteId,
) -> Result<Option<CollabSessionSnapshot>, PortError> {
    let Some(session) = load_collab_session_opt_tx(tx, &scope_cl.space_id, nid).await? else {
        return Ok(None);
    };
    let raw_updates: Vec<(i64, i64, Vec<u8>, i64)> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT lease_epoch, update_seq, update_bytes, created_at_ms
                             FROM collab_update_log
                             WHERE space_id = ? AND note_id = ?
                             ORDER BY lease_epoch ASC, update_seq ASC",
            )
            .bind(scope_cl.space_id.as_str())
            .bind(nid.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_collab_updates", err.to_string()))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get("lease_epoch"),
                        r.get("update_seq"),
                        r.get("update_bytes"),
                        r.get("created_at_ms"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT lease_epoch, update_seq, update_bytes, created_at_ms
                             FROM collab_update_log
                             WHERE space_id = $1 AND note_id = $2
                             ORDER BY lease_epoch ASC, update_seq ASC",
            )
            .bind(scope_cl.space_id.as_str())
            .bind(nid.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_collab_updates", err))?;
            rows.into_iter()
                .map(|r| {
                    (
                        r.get("lease_epoch"),
                        r.get("update_seq"),
                        r.get("update_bytes"),
                        r.get("created_at_ms"),
                    )
                })
                .collect()
        }
    };

    let mut updates = Vec::with_capacity(raw_updates.len());
    for (le, useq, bytes, ts_ms) in raw_updates {
        let lease_epoch =
            LeaseEpoch::new(u64::try_from(le).map_err(|_| {
                internal_not_committed("corrupt_upd_lease", "negative lease_epoch")
            })?)?;
        let update_seq = u64::try_from(useq)
            .map_err(|_| internal_not_committed("corrupt_upd_seq", "negative update_seq"))?;
        updates.push(CollabUpdateEntry {
            lease_epoch,
            update_seq,
            update_bytes: bytes,
            created_at_ms: ts_ms,
        });
    }

    Ok(Some(CollabSessionSnapshot { session, updates }))
}

/// Serialize auxiliary writes with the batch writer and with other database clients.
async fn lock_peer_space(
    tx: &mut BackendConn<'_>,
    inner: &CanonicalInner,
    scope: &HistoryScope,
) -> Result<SpaceRecord, PortError> {
    let space = load_space_record_for_update_opt(tx, &scope.space_id)
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    space.scope.check(scope)?;
    inner.check_writer_epoch(&scope.space_id, space.active_epoch)?;
    Ok(space)
}

async fn open_collab_session_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    spec: OpenCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "open_collab_session");
    if spec.owner_id.trim().is_empty() {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }

    let inner = std::sync::Arc::clone(&store.inner);
    let room_store = store.clone();
    let timing = Some((budget, deadline));
    #[cfg(feature = "test-support")]
    let faults = store.writer_faults()?;
    store
        .with_auxiliary_command(timing, move |transition| {
            #[cfg(feature = "test-support")]
            if faults.drop_room_open_response_once.swap(false, std::sync::atomic::Ordering::SeqCst) {
                // COMMIT succeeded. Dropping the unpublished transition keeps
                // its fence held until the durable outcome has been resolved.
                drop(transition);
                return Err(crate::codec::unknown_commit_non_idempotent(
                    "room_open_response_lost", "injected loss of a room open response",
                ));
            }
            RoomTransition::confirmed(transition)
        }, move |tx| {
            let spec_cl = spec;
            Box::pin(async move {
                let srec = lock_peer_space(tx, &inner, &spec_cl.scope).await?;
                let fence_guard = inner.room_fences.lock_for_write(&spec_cl.scope, &spec_cl.note)?;
                if srec.space.lifecycle != SpaceLifecycle::Active
                    || is_note_purge_fenced_tx(tx, &srec.scope.space_id, spec_cl.note.as_str()).await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let head = load_note_head_row_tx(tx, &srec.scope.space_id, &spec_cl.note).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if head.doc_class == DocClass::EncryptedNote {
                    return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
                }
                if head.doc_class != DocClass::UserDoc {
                    return Err(DomainError::validation(ValidationReason::ClassMismatch).into());
                }
                if head.head_rev_id != spec_cl.expected_carrier_rev {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }

                let existing =
                    load_collab_session_opt_tx(tx, &srec.scope.space_id, &spec_cl.note).await?;
                let (base_lease, lineage, preserved_snapshot, preserved_digest, coverage, dirty) = match existing {
                    None => {
                        if let Some(exp_le) = spec_cl.expected_lease
                            && exp_le != LeaseEpoch::ZERO
                        {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidAuthority).into()
                            );
                        }
                        if let Some(exp_li) = spec_cl.expected_lineage
                            && exp_li != LineageEpoch::ZERO
                        {
                            return Err(
                                DomainError::validation(ValidationReason::SourceMismatch).into()
                            );
                        }
                        (LeaseEpoch::ZERO, LineageEpoch::ZERO, None, None, None, false)
                    }
                    Some(cur) => {
                        match cur.room_state {
                            CollabRoomState::Active => {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidState,
                                )
                                .into());
                            }
                            CollabRoomState::Fenced if !spec_cl.allow_fenced_recovery => {
                                return Err(unavailable_retryable(
                                    "collab_session_fenced",
                                    "collab session is fenced awaiting explicit recovery",
                                    Duration::from_millis(50),
                                ));
                            }
                            CollabRoomState::Closed | CollabRoomState::Fenced => {}
                        }
                        if let Some(exp_le) = spec_cl.expected_lease
                            && exp_le != cur.lease_epoch
                        {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidAuthority).into()
                            );
                        }
                        if let Some(exp_li) = spec_cl.expected_lineage
                            && exp_li != cur.lineage_epoch
                        {
                            return Err(
                                DomainError::validation(ValidationReason::SourceMismatch).into()
                            );
                        }
                        (
                            cur.lease_epoch,
                            cur.lineage_epoch,
                            cur.yrs_snapshot_blob,
                            cur.yrs_snapshot_digest,
                            cur.snapshot_coverage,
                            cur.carrier_dirty,
                        )
                    }
                };

                let new_lease = base_lease.max(fence_guard.epoch()).checked_next()?;
                let installs_snapshot = spec_cl.initial_yrs_snapshot.is_some() && preserved_snapshot.is_none();
                if let (Some(current), Some(initial)) = (&preserved_snapshot, &spec_cl.initial_yrs_snapshot)
                    && current != initial
                {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }
                let (yrs_blob, yrs_digest) = match spec_cl.initial_yrs_snapshot {
                    Some(bytes) => {
                        let d = ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes());
                        (Some(bytes), Some(d))
                    }
                    None => (preserved_snapshot, preserved_digest),
                };
                let updated_seq = if srec.last_seq == SpaceSeq::ZERO {
                    SpaceSeq::new(1)?
                } else {
                    srec.last_seq
                };
                let useq_i64 = updated_seq.get() as i64;
                let digest_slice = yrs_digest.as_ref().map(|d| d.as_bytes().as_slice());

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO collab_sessions (
                                space_id, note_id, lease_epoch, lineage_epoch, carrier_rev_id,
                                yrs_snapshot_blob, yrs_snapshot_blake3, room_state, owner_id, updated_seq
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                             ON CONFLICT (space_id, note_id) DO UPDATE SET
                                lease_epoch = excluded.lease_epoch,
                                lineage_epoch = excluded.lineage_epoch,
                                carrier_rev_id = excluded.carrier_rev_id,
                                yrs_snapshot_blob = excluded.yrs_snapshot_blob,
                                yrs_snapshot_blake3 = excluded.yrs_snapshot_blake3,
                                room_state = 'active',
                                owner_id = excluded.owner_id,
                                updated_seq = excluded.updated_seq",
                        )
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec_cl.note.as_str())
                        .bind(new_lease.get() as i64)
                        .bind(lineage.get() as i64)
                        .bind(head.head_rev_id.as_str())
                        .bind(yrs_blob.as_deref())
                        .bind(digest_slice)
                        .bind(&spec_cl.owner_id)
                        .bind(useq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("sqlite_open_collab", err.to_string()))?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO collab_sessions (
                                space_id, note_id, lease_epoch, lineage_epoch, carrier_rev_id,
                                yrs_snapshot_blob, yrs_snapshot_blake3, room_state, owner_id, updated_seq
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9)
                             ON CONFLICT (space_id, note_id) DO UPDATE SET
                                lease_epoch = EXCLUDED.lease_epoch,
                                lineage_epoch = EXCLUDED.lineage_epoch,
                                carrier_rev_id = EXCLUDED.carrier_rev_id,
                                yrs_snapshot_blob = EXCLUDED.yrs_snapshot_blob,
                                yrs_snapshot_blake3 = EXCLUDED.yrs_snapshot_blake3,
                                room_state = 'active',
                                owner_id = EXCLUDED.owner_id,
                                updated_seq = EXCLUDED.updated_seq",
                        )
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec_cl.note.as_str())
                        .bind(new_lease.get() as i64)
                        .bind(lineage.get() as i64)
                        .bind(head.head_rev_id.as_str())
                        .bind(yrs_blob.as_deref())
                        .bind(digest_slice)
                        .bind(&spec_cl.owner_id)
                        .bind(useq_i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_open_collab", err.to_string()))?;
                    }
                }

                if installs_snapshot {
                    write_collab_checkpoint_state_tx(tx, &spec_cl.scope.space_id, &spec_cl.note, coverage, true).await?;
                }
                let record = CollabSessionRecord {
                    note: spec_cl.note,
                    lease_epoch: new_lease,
                    lineage_epoch: lineage,
                    carrier_rev_id: head.head_rev_id,
                    yrs_snapshot_blob: yrs_blob,
                    yrs_snapshot_digest: yrs_digest,
                    snapshot_coverage: coverage,
                    carrier_dirty: dirty || installs_snapshot,
                    room_state: CollabRoomState::Active,
                    owner_id: Some(spec_cl.owner_id),
                    updated_seq,
                };
                RoomTransition::prepare(room_store, &spec_cl.scope, fence_guard, record)
            })
        })
        .await
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct StoredCollabSessionV1 {
    note: NoteId,
    lease_epoch: LeaseEpoch,
    lineage_epoch: LineageEpoch,
    carrier_rev_id: RevisionId,
    yrs_snapshot_blob: Option<Vec<u8>>,
    yrs_snapshot_digest: Option<ContentDigest>,
    room_state: String,
    owner_id: Option<String>,
    updated_seq: SpaceSeq,
    #[serde(default)]
    snapshot_coverage: Option<(LeaseEpoch, u64)>,
    #[serde(default)]
    carrier_dirty: bool,
}

impl From<&CollabSessionRecord> for StoredCollabSessionV1 {
    fn from(r: &CollabSessionRecord) -> Self {
        Self {
            note: r.note.clone(),
            lease_epoch: r.lease_epoch,
            lineage_epoch: r.lineage_epoch,
            carrier_rev_id: r.carrier_rev_id.clone(),
            yrs_snapshot_blob: r.yrs_snapshot_blob.clone(),
            yrs_snapshot_digest: r.yrs_snapshot_digest,
            room_state: r.room_state.as_db().to_owned(),
            owner_id: r.owner_id.clone(),
            updated_seq: r.updated_seq,
            snapshot_coverage: r.snapshot_coverage,
            carrier_dirty: r.carrier_dirty,
        }
    }
}

impl TryFrom<StoredCollabSessionV1> for CollabSessionRecord {
    type Error = PortError;
    fn try_from(w: StoredCollabSessionV1) -> Result<Self, Self::Error> {
        Ok(Self {
            note: w.note,
            lease_epoch: w.lease_epoch,
            lineage_epoch: w.lineage_epoch,
            carrier_rev_id: w.carrier_rev_id,
            yrs_snapshot_blob: w.yrs_snapshot_blob,
            yrs_snapshot_digest: w.yrs_snapshot_digest,
            room_state: CollabRoomState::from_db(&w.room_state)?,
            owner_id: w.owner_id,
            updated_seq: w.updated_seq,
            snapshot_coverage: w.snapshot_coverage,
            carrier_dirty: w.carrier_dirty,
        })
    }
}

async fn write_collab_checkpoint_state_tx(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    note: &NoteId,
    coverage: Option<(LeaseEpoch, u64)>,
    dirty: bool,
) -> Result<(), PortError> {
    let (lease, seq) = coverage.unwrap_or((LeaseEpoch::ZERO, 0));
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "INSERT INTO collab_checkpoints (space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
             VALUES (?, ?, ?, ?, ?) ON CONFLICT(space_id, note_id) DO UPDATE SET
             snapshot_lease_epoch = excluded.snapshot_lease_epoch, snapshot_update_seq = excluded.snapshot_update_seq,
             carrier_dirty = excluded.carrier_dirty",
        )
            .bind(space.as_str())
            .bind(note.as_str())
            .bind(lease.get() as i64)
            .bind(seq as i64)
            .bind(i64::from(dirty))
            .execute(&mut **conn)
            .await
            .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(
            "INSERT INTO collab_checkpoints (space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT(space_id, note_id) DO UPDATE SET
             snapshot_lease_epoch = excluded.snapshot_lease_epoch, snapshot_update_seq = excluded.snapshot_update_seq,
             carrier_dirty = excluded.carrier_dirty",
        )
            .bind(space.as_str())
            .bind(note.as_str())
            .bind(lease.get() as i64)
            .bind(seq as i64)
            .bind(i64::from(dirty))
            .execute(&mut **conn)
            .await
            .map(|_| ()),
    }
        .map_err(|err| internal_not_committed("write_collab_checkpoint", err.to_string()))
}

async fn advance_collab_snapshot_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cur: &mut CollabSessionRecord,
    snapshot: Option<&[u8]>,
    through: Option<u64>,
    settling: bool,
    replace_at_same_prefix: bool,
) -> Result<(), PortError> {
    let changed = snapshot.is_some_and(|s| cur.yrs_snapshot_blob.as_deref() != Some(s));
    let mut coverage = cur.snapshot_coverage;
    if let Some(through) = through {
        let next = (cur.lease_epoch, through);
        if coverage
            .is_some_and(|old| next < old || (next == old && changed && !replace_at_same_prefix))
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        // Only acknowledged updates in this lease can advance its watermark. Zero
        // covers prior leases after recovery, before the first update of this lease.
        let acknowledged: i64 = match tx {
            BackendConn::Sqlite(conn) => sqlx::query_scalar(
                "SELECT COALESCE(MAX(update_seq), 0) FROM collab_update_log WHERE space_id = ? AND note_id = ? AND lease_epoch = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(cur.note.as_str())
            .bind(cur.lease_epoch.get() as i64)
            .fetch_one(&mut **conn)
            .await,
            BackendConn::Postgres(conn) => sqlx::query_scalar(
                "SELECT COALESCE(MAX(update_seq), 0) FROM collab_update_log WHERE space_id = $1 AND note_id = $2 AND lease_epoch = $3",
            )
            .bind(scope.space_id.as_str())
            .bind(cur.note.as_str())
            .bind(cur.lease_epoch.get() as i64)
            .fetch_one(&mut **conn)
            .await,
        }
        .map_err(|err| internal_not_committed("collab_accepted_prefix", err.to_string()))?;
        let already_covered = coverage
            .filter(|(lease, _)| *lease == cur.lease_epoch)
            .map_or(0, |(_, seq)| seq);
        if through > already_covered.max(acknowledged as u64) {
            return Err(DomainError::validation(ValidationReason::InvalidRange).into());
        }
        if Some(next) != coverage {
            compact_collab_prefix(tx, scope, &cur.note, cur.lease_epoch, through).await?;
        }
        coverage = Some(next);
    } else if changed && cur.yrs_snapshot_blob.is_some() && !replace_at_same_prefix {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    let mut dirty = cur.carrier_dirty || changed;
    if settling && snapshot.is_some() {
        dirty = has_uncompacted_updates_tx(tx, scope, &cur.note).await?;
    }
    if dirty != cur.carrier_dirty || coverage != cur.snapshot_coverage {
        write_collab_checkpoint_state_tx(tx, &scope.space_id, &cur.note, coverage, dirty).await?;
    }
    cur.carrier_dirty = dirty;
    cur.snapshot_coverage = coverage;
    Ok(())
}

async fn has_uncompacted_updates_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
) -> Result<bool, PortError> {
    const SQL: &str =
        "SELECT EXISTS(SELECT 1 FROM collab_update_log WHERE space_id = $1 AND note_id = $2)";
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_one(&mut **conn)
                .await
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar(SQL)
                .bind(scope.space_id.as_str())
                .bind(note.as_str())
                .fetch_one(&mut **conn)
                .await
        }
    }
    .map_err(|err| internal_not_committed("collab_pending_updates", err.to_string()))
}

async fn verify_unchanged_carrier_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    session: &CollabSessionRecord,
    digest: Option<ContentDigest>,
) -> Result<bool, PortError> {
    let Some(digest) = digest else {
        return Ok(false);
    };
    let head = load_note_head_row_tx(tx, &scope.space_id, &session.note).await?;
    if head.lifecycle != Lifecycle::Active
        || head.doc_class != DocClass::UserDoc
        || head.head_rev_id != session.carrier_rev_id
        || head.content_digest != Some(digest)
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(true)
}

async fn compact_collab_prefix(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    note: &NoteId,
    lease: LeaseEpoch,
    through: u64,
) -> Result<(), PortError> {
    let through = i64::try_from(through)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidRange))?;
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "DELETE FROM collab_update_log WHERE space_id = ? AND note_id = ?
             AND (lease_epoch < ? OR (lease_epoch = ? AND update_seq <= ?))",
        )
        .bind(scope.space_id.as_str())
        .bind(note.as_str())
        .bind(lease.get() as i64)
        .bind(lease.get() as i64)
        .bind(through)
        .execute(&mut **conn)
        .await
        .map(|_| ()),
        BackendConn::Postgres(conn) => sqlx::query(
            "DELETE FROM collab_update_log WHERE space_id = $1 AND note_id = $2
             AND (lease_epoch < $3 OR (lease_epoch = $3 AND update_seq <= $4))",
        )
        .bind(scope.space_id.as_str())
        .bind(note.as_str())
        .bind(lease.get() as i64)
        .bind(through)
        .execute(&mut **conn)
        .await
        .map(|_| ()),
    }
    .map_err(|err| internal_not_committed("compact_collab_log", err.to_string()))
}

async fn checkpoint_collab_session_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    mut spec: CheckpointCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let deadline =
        crate::domain::common::CommandDeadline::start(budget, "checkpoint_collab_session");
    if let Some(settlement) = spec.carrier_settlement.take() {
        if spec.unchanged_carrier_digest.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        return settle_and_update_collab_session(
            store,
            budget,
            deadline,
            spec.scope,
            spec.note,
            Some(spec.owner_id),
            spec.expected_lease,
            spec.expected_lineage,
            Some(spec.yrs_snapshot),
            spec.compacted_through_update_seq,
            settlement,
            false,
        )
        .await;
    }
    checkpoint_collab_snapshot_impl(store, budget, deadline, spec).await
}

async fn checkpoint_collab_snapshot_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    deadline: crate::domain::common::CommandDeadline,
    spec: CheckpointCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let inner = std::sync::Arc::clone(&store.inner);
    store
        .with_auxiliary_command(Some((budget, deadline)), Ok, move |tx| {
            Box::pin(async move {
                let srec = lock_peer_space(tx, &inner, &spec.scope).await?;
                if is_note_purge_fenced_tx(tx, &srec.scope.space_id, spec.note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let Some(mut cur) =
                    load_collab_session_opt_tx(tx, &srec.scope.space_id, &spec.note).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                if cur.room_state != CollabRoomState::Active {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if cur.lease_epoch != spec.expected_lease
                    || cur.owner_id.as_deref() != Some(spec.owner_id.as_str())
                {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                if cur.lineage_epoch != spec.expected_lineage {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }

                let yrs_digest =
                    ContentDigest::from_bytes(*blake3::hash(&spec.yrs_snapshot).as_bytes());
                let settling = verify_unchanged_carrier_tx(
                    tx,
                    &spec.scope,
                    &cur,
                    spec.unchanged_carrier_digest,
                )
                .await?;
                advance_collab_snapshot_tx(
                    tx,
                    &spec.scope,
                    &mut cur,
                    Some(&spec.yrs_snapshot),
                    spec.compacted_through_update_seq,
                    settling,
                    false,
                )
                .await?;

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE collab_sessions
                             SET yrs_snapshot_blob = ?, yrs_snapshot_blake3 = ?
                             WHERE space_id = ? AND note_id = ? AND lease_epoch = ?",
                        )
                        .bind(&spec.yrs_snapshot)
                        .bind(yrs_digest.as_bytes().as_slice())
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec.note.as_str())
                        .bind(spec.expected_lease.get() as i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_ckpt_collab", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE collab_sessions
                             SET yrs_snapshot_blob = $1, yrs_snapshot_blake3 = $2
                             WHERE space_id = $3 AND note_id = $4 AND lease_epoch = $5",
                        )
                        .bind(&spec.yrs_snapshot)
                        .bind(yrs_digest.as_bytes().as_slice())
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec.note.as_str())
                        .bind(spec.expected_lease.get() as i64)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| internal_not_committed("pg_ckpt_collab", err.to_string()))?;
                    }
                }

                cur.yrs_snapshot_blob = Some(spec.yrs_snapshot);
                cur.yrs_snapshot_digest = Some(yrs_digest);
                Ok(cur)
            })
        })
        .await
}

async fn close_collab_session_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    mut spec: CloseCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "close_collab_session");
    if spec.final_yrs_snapshot.is_none()
        && (spec.compacted_through_update_seq.is_some() || spec.unchanged_carrier_digest.is_some())
    {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if let Some(settlement) = spec.carrier_settlement.take() {
        if spec.unchanged_carrier_digest.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        return settle_and_update_collab_session(
            store,
            budget,
            deadline,
            spec.scope,
            spec.note,
            spec.owner_id,
            spec.expected_lease,
            spec.expected_lineage,
            spec.final_yrs_snapshot,
            spec.compacted_through_update_seq,
            settlement,
            true,
        )
        .await;
    }
    close_collab_snapshot_impl(store, budget, deadline, spec).await
}

async fn close_collab_snapshot_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    deadline: crate::domain::common::CommandDeadline,
    spec: CloseCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let inner = std::sync::Arc::clone(&store.inner);
    let room_store = store.clone();
    let timing = Some((budget, deadline));
    store
        .with_auxiliary_command(timing, RoomTransition::confirmed, move |tx| {
            let spec_cl = spec;
            Box::pin(async move {
                let srec = lock_peer_space(tx, &inner, &spec_cl.scope).await?;
                if is_note_purge_fenced_tx(tx, &srec.scope.space_id, spec_cl.note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let fence_guard = inner
                    .room_fences
                    .lock_for_write(&spec_cl.scope, &spec_cl.note)?;

                let Some(mut cur) =
                    load_collab_session_opt_tx(tx, &srec.scope.space_id, &spec_cl.note).await?
                else {
                    return Err(DomainError::ResourceNotFound.into());
                };
                if cur.room_state == CollabRoomState::Closed {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                if cur.lease_epoch != spec_cl.expected_lease {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                if cur.room_state == CollabRoomState::Active && cur.owner_id != spec_cl.owner_id {
                    return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
                }
                if cur.lineage_epoch != spec_cl.expected_lineage {
                    return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
                }

                let settling = verify_unchanged_carrier_tx(
                    tx,
                    &spec_cl.scope,
                    &cur,
                    spec_cl.unchanged_carrier_digest,
                )
                .await?;
                advance_collab_snapshot_tx(
                    tx,
                    &spec_cl.scope,
                    &mut cur,
                    spec_cl.final_yrs_snapshot.as_deref(),
                    spec_cl.compacted_through_update_seq,
                    settling,
                    false,
                )
                .await?;
                let new_lease = cur.lease_epoch.max(fence_guard.epoch()).checked_next()?;
                let (yrs_blob, yrs_digest) = match spec_cl.final_yrs_snapshot {
                    Some(bytes) => {
                        let d = ContentDigest::from_bytes(*blake3::hash(&bytes).as_bytes());
                        (Some(bytes), Some(d))
                    }
                    None => (cur.yrs_snapshot_blob, cur.yrs_snapshot_digest),
                };
                let digest_slice = yrs_digest.as_ref().map(|d| d.as_bytes().as_slice());

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE collab_sessions
                             SET room_state = 'closed',
                                 owner_id = NULL,
                                 lease_epoch = ?,
                                 yrs_snapshot_blob = ?,
                                 yrs_snapshot_blake3 = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(new_lease.get() as i64)
                        .bind(yrs_blob.as_deref())
                        .bind(digest_slice)
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec_cl.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_close_collab", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE collab_sessions
                             SET room_state = 'closed',
                                 owner_id = NULL,
                                 lease_epoch = $1,
                                 yrs_snapshot_blob = $2,
                                 yrs_snapshot_blake3 = $3
                             WHERE space_id = $4 AND note_id = $5",
                        )
                        .bind(new_lease.get() as i64)
                        .bind(yrs_blob.as_deref())
                        .bind(digest_slice)
                        .bind(srec.scope.space_id.as_str())
                        .bind(spec_cl.note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_close_collab", err.to_string())
                        })?;
                    }
                }

                cur.room_state = CollabRoomState::Closed;
                cur.owner_id = None;
                cur.lease_epoch = new_lease;
                cur.yrs_snapshot_blob = yrs_blob;
                cur.yrs_snapshot_digest = yrs_digest;
                RoomTransition::prepare(room_store, &spec_cl.scope, fence_guard, cur)
            })
        })
        .await
}

async fn fence_collab_session_impl(
    store: &CanonicalStore,
    budget: &CallBudget,
    spec: FenceCollabSession,
) -> Result<CollabSessionRecord, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(budget, "fence_collab_session");
    let room_store = store.clone();
    store
        .with_auxiliary_command(
            Some((budget, deadline)),
            RoomTransition::confirmed,
            move |tx| {
                Box::pin(async move {
                    let space = lock_peer_space(tx, &room_store.inner, &spec.scope).await?;
                    let guard = room_store
                        .inner
                        .room_fences
                        .lock_for_write(&spec.scope, &spec.note)?;
                    let mut room =
                        load_collab_session_opt_tx(tx, &space.scope.space_id, &spec.note)
                            .await?
                            .ok_or(DomainError::ResourceNotFound)?;
                    validate_settlement_room(
                        &room,
                        &room.carrier_rev_id,
                        Some(&spec.owner_id),
                        spec.expected_lease,
                        spec.expected_lineage,
                        false,
                    )?;
                    let new_lease = room.lease_epoch.max(guard.epoch()).checked_next()?;
                    const SQL: &str = "UPDATE collab_sessions
                    SET room_state = 'fenced', owner_id = NULL, lease_epoch = $1
                    WHERE space_id = $2 AND note_id = $3 AND lease_epoch = $4
                        AND lineage_epoch = $5 AND room_state = 'active' AND owner_id = $6
                    RETURNING lease_epoch";
                    let lease: Option<i64> = match tx {
                        BackendConn::Sqlite(conn) => {
                            sqlx::query_scalar(SQL)
                                .bind(new_lease.get() as i64)
                                .bind(spec.scope.space_id.as_str())
                                .bind(spec.note.as_str())
                                .bind(spec.expected_lease.get() as i64)
                                .bind(spec.expected_lineage.get() as i64)
                                .bind(&spec.owner_id)
                                .fetch_optional(&mut **conn)
                                .await
                        }
                        BackendConn::Postgres(conn) => {
                            sqlx::query_scalar(SQL)
                                .bind(new_lease.get() as i64)
                                .bind(spec.scope.space_id.as_str())
                                .bind(spec.note.as_str())
                                .bind(spec.expected_lease.get() as i64)
                                .bind(spec.expected_lineage.get() as i64)
                                .bind(&spec.owner_id)
                                .fetch_optional(&mut **conn)
                                .await
                        }
                    }
                    .map_err(|error| {
                        internal_not_committed("fence_collab_room", error.to_string())
                    })?;
                    if lease.is_none() {
                        return Err(
                            DomainError::validation(ValidationReason::InvalidAuthority).into()
                        );
                    }
                    room.lease_epoch = new_lease;
                    room.room_state = CollabRoomState::Fenced;
                    room.owner_id = None;
                    RoomTransition::prepare(room_store, &spec.scope, guard, room)
                })
            },
        )
        .await
}

fn validate_settlement_room(
    room: &CollabSessionRecord,
    carrier: &RevisionId,
    owner: Option<&str>,
    lease: LeaseEpoch,
    lineage: LineageEpoch,
    closing: bool,
) -> Result<(), PortError> {
    match room.room_state {
        CollabRoomState::Active if room.owner_id.as_deref() != owner => {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        CollabRoomState::Active => {}
        CollabRoomState::Fenced if closing => {}
        _ => return Err(DomainError::validation(ValidationReason::InvalidState).into()),
    }
    if room.lease_epoch != lease {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if room.lineage_epoch != lineage || &room.carrier_rev_id != carrier {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

impl CollabSettlementActor {
    fn authorize_resource(&self, facts: &ResourceFacts) -> Result<(), PortError> {
        match self {
            Self::Writer(auth) => {
                auth.authorize_direct_write(facts, facts)?;
            }
            Self::Recovery { authority } => {
                authority.require(ServicePurpose::CollabRecovery)?;
                if facts.class != DocClass::UserDoc
                    || facts.space.lifecycle != SpaceLifecycle::Active
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
            }
        }
        Ok(())
    }

    async fn authorize_pending(
        &self,
        tx: &mut BackendConn<'_>,
        scope: &HistoryScope,
        room: &CollabSessionRecord,
    ) -> Result<(), PortError> {
        if matches!(self, Self::Recovery { .. })
            && !room.carrier_dirty
            && !has_uncompacted_updates_tx(tx, scope, &room.note).await?
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        Ok(())
    }

    fn principal<'a>(&'a self, head: &'a NoteHeadRow) -> &'a PrincipalId {
        match self {
            Self::Writer(auth) => auth.principal(),
            Self::Recovery { .. } => &head.last_actor_id,
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn settle_and_update_collab_session(
    store: &CanonicalStore,
    budget: &CallBudget,
    deadline: crate::domain::common::CommandDeadline,
    scope: HistoryScope,
    note: NoteId,
    expected_owner: Option<String>,
    expected_lease: LeaseEpoch,
    expected_lineage: LineageEpoch,
    yrs_snapshot: Option<Vec<u8>>,
    compacted_through: Option<u64>,
    settlement: CollabCarrierSettlement,
    close_room: bool,
) -> Result<CollabSessionRecord, PortError> {
    deadline
        .prepare(budget, || store.ensure_blob_backend_ready())
        .await?;
    let transition = RoomCarrierTransition {
        expected_owner,
        expected_lease,
        expected_lineage,
        yrs_snapshot,
        compacted_through,
        close_room,
        client_command: false,
        replace_at_same_prefix: false,
    };
    let (space_rec, base_head) = deadline
        .prepare(budget, || {
            transition.check_before_staging_for_actor(
                store,
                budget,
                &scope,
                &note,
                settlement.actor.clone(),
                None,
            )
        })
        .await?;

    if base_head.doc_class == DocClass::EncryptedNote {
        return Err(DomainError::UnsafePlaintextOutsideAgeFence.into());
    }
    let digest = base_head.content_digest.ok_or_else(|| {
        internal_not_committed(
            "settlement_missing_digest",
            "active note lacks content_blake3",
        )
    })?;
    let bytes = deadline
        .prepare(budget, || {
            store.read_verified_blob(&space_rec.scope, digest)
        })
        .await?;
    let previous = std::str::from_utf8(&bytes).map_err(|_| {
        internal_not_committed(
            "corrupt_note_utf8",
            "canonical note carrier is not valid UTF-8",
        )
    })?;
    if previous == settlement.carrier {
        if close_room {
            return close_collab_snapshot_impl(
                store,
                budget,
                deadline,
                CloseCollabSession {
                    scope,
                    note,
                    owner_id: transition.expected_owner,
                    expected_lease,
                    expected_lineage,
                    final_yrs_snapshot: transition.yrs_snapshot,
                    compacted_through_update_seq: compacted_through,
                    carrier_settlement: None,
                    unchanged_carrier_digest: Some(digest),
                },
            )
            .await;
        }
        let owner_id = transition
            .expected_owner
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidAuthority))?;
        let yrs_snapshot = transition
            .yrs_snapshot
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
        return checkpoint_collab_snapshot_impl(
            store,
            budget,
            deadline,
            CheckpointCollabSession {
                scope,
                note,
                owner_id,
                expected_lease,
                expected_lineage,
                yrs_snapshot,
                compacted_through_update_seq: compacted_through,
                carrier_settlement: None,
                unchanged_carrier_digest: Some(digest),
            },
        )
        .await;
    }
    let header = enforce_room_frontmatter_unchanged_with_header(
        previous,
        &settlement.carrier,
        base_head.doc_class,
    )?;
    let info = analyze_and_prepare_carrier_opt_preparsed(
        &settlement.carrier,
        base_head.doc_class,
        &note,
        &base_head.slug,
        store.blob_codec(),
        header,
    )?;
    let ticket = deadline
        .prepare(budget, || {
            store.stage_blob_for_batch(
                &space_rec.scope,
                space_rec.active_epoch,
                &info.prepared_blob,
            )
        })
        .await?;
    let staged_bytes = ticket.compressed_size;
    let room_store = store.clone();
    let scope_cl = space_rec.scope.clone();

    let intent = PreparedWriteIntent {
        scope: space_rec.scope.clone(),
        active_epoch: space_rec.active_epoch,
        idempotency: None,
        source_note_ids: vec![note.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                let head = load_note_head_row_tx(tx, &scope_cl.space_id, &note).await?;
                if head.lifecycle != Lifecycle::Active {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let (facts, anc) = build_resource_facts_tx(
                    tx,
                    &item_ctx.space,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    true,
                )
                .await?;
                settlement.actor.authorize_resource(&facts)?;
                if head.head_rev_id != base_head.head_rev_id {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                let room = load_collab_session_opt_tx(tx, &scope_cl.space_id, &note)
                    .await?
                    .ok_or(DomainError::ResourceNotFound)?;
                validate_settlement_room(
                    &room,
                    &base_head.head_rev_id,
                    transition.expected_owner.as_deref(),
                    transition.expected_lease,
                    transition.expected_lineage,
                    transition.close_room,
                )?;
                settlement
                    .actor
                    .authorize_pending(tx, &scope_cl, &room)
                    .await?;
                let actor_id = settlement.actor.principal(&head).clone();

                let seq = item_ctx.alloc_next_seq()?;
                let new_rev = new_revision_id()?;
                let now_ts = now_utc_timestamp()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);
                let seq_i64 = seq.get() as i64;
                let digest = info.prepared_blob.digest;

                item_ctx.record_staged_ticket(ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: note.as_str().to_owned(),
                        owner_rev_id: new_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    seq,
                )
                .await?;

                let class_str = doc_class_to_db(head.doc_class);
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = ?, title_fold = ?, doc_class = ?, head_rev_id = ?,
                                 content_blake3 = ?, byte_size = ?, updated_seq = ?,
                                 updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                             WHERE space_id = ? AND note_id = ?",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(class_str)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(actor_id.as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_settle_collab_head", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE note_heads
                             SET title = $1, title_fold = $2, doc_class = $3, head_rev_id = $4,
                                 content_blake3 = $5, byte_size = $6, updated_seq = $7,
                                 updated_at_sec = $8, updated_at_nsec = $9, last_actor_id = $10
                             WHERE space_id = $11 AND note_id = $12",
                        )
                        .bind(&info.title)
                        .bind(&info.title_fold)
                        .bind(class_str)
                        .bind(new_rev.as_str())
                        .bind(digest.as_bytes().as_slice())
                        .bind(info.byte_size as i64)
                        .bind(seq_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(actor_id.as_str())
                        .bind(scope_cl.space_id.as_str())
                        .bind(note.as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_settle_collab_head", err.to_string())
                        })?;
                    }
                }

                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let eval_fields = evaluate_fields_with_schema(
                    info.raw_fields.as_ref(),
                    info.diagnostics.first(),
                    current_schema.as_ref().map(|s| &s.fields),
                );
                let changed_fields =
                    changed_revision_fields_tx(tx, &scope_cl, &head.head_rev_id, &eval_fields)
                        .await?;
                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        note_id: note.clone(),
                        parent_folder_id: head.parent_folder_id.clone(),
                        is_root_child: anc.is_root_child,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: info.title,
                        doc_class: head.doc_class,
                        ability_id: head.ability_id,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: head.visibility_mask,
                        byte_size: info.byte_size,
                        content_digest: Some(digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: info.raw_fields,
                        evaluated_fields: eval_fields,
                        diagnostics: info.diagnostics,
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope_cl,
                    &new_rev,
                    "note",
                    note.as_str(),
                    seq,
                    seq,
                    Some(&head.head_rev_id),
                    None,
                    Some(digest),
                    &meta,
                    &actor_id,
                    None,
                    now_ts,
                )
                .await?;

                let out_rec = transition
                    .commit_revision(
                        tx,
                        item_ctx,
                        &room_store,
                        &note,
                        &base_head.head_rev_id,
                        &new_rev,
                        seq,
                    )
                    .await?;
                let stored_wire = StoredCollabSessionV1::from(&out_rec);
                let resp_bytes = CanonicalStore::encode_command_outcome(&stored_wire)?;

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = CommandSeqRange::new(seq, seq)?;
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope_cl,
                    range,
                    "collab_settlement",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: note.clone(),
                            revision: new_rev.clone(),
                            rank_version: note_rank_version_digest(&new_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: head.doc_class,
                            changed_fields,
                        }],
                    },
                    vec![note.clone()],
                )?;

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "collab_settlement".to_owned(),
                    events: vec![BatchEventDraft {
                        space_seq: seq,
                        entity_type: "note".to_owned(),
                        entity_id: note.as_str().to_owned(),
                        op_kind: "edit".to_owned(),
                        rev_id: new_rev,
                        lifecycle: Lifecycle::Active,
                        doc_class: Some(head.doc_class),
                    }],
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: resp_bytes.clone(),
                    receipt_owner_note_ids: vec![note],
                    response_bytes: resp_bytes,
                })
            })
        }),
    };

    let stored: StoredCollabSessionV1 = deadline.submit(store, budget, intent).await?;
    stored.try_into()
}

/// Updates the collaborative state in the transaction that owns the carrier revision.
pub(crate) struct RoomCarrierTransition {
    expected_owner: Option<String>,
    expected_lease: LeaseEpoch,
    expected_lineage: LineageEpoch,
    yrs_snapshot: Option<Vec<u8>>,
    compacted_through: Option<u64>,
    close_room: bool,
    client_command: bool,
    replace_at_same_prefix: bool,
}

impl RoomCarrierTransition {
    /// A room-owned command can add CRDT changes in the same transaction as
    /// its canonical revision while preserving the accepted peer WAL prefix.
    pub(crate) fn for_room_command(
        owner_id: String,
        expected_lease: LeaseEpoch,
        expected_lineage: LineageEpoch,
        yrs_snapshot: Vec<u8>,
        compacted_through: Option<u64>,
    ) -> Self {
        Self {
            expected_owner: Some(owner_id),
            expected_lease,
            expected_lineage,
            yrs_snapshot: Some(yrs_snapshot),
            compacted_through,
            close_room: false,
            client_command: true,
            replace_at_same_prefix: true,
        }
    }

    pub(crate) async fn check_before_staging(
        &self,
        store: &CanonicalStore,
        budget: &CallBudget,
        scope: &HistoryScope,
        note: &NoteId,
        auth: &EngineAuthContext,
        base: Option<&RevisionId>,
    ) -> Result<(SpaceRecord, crate::domain::common::NoteHeadRow), PortError> {
        self.check_before_staging_for_actor(
            store,
            budget,
            scope,
            note,
            CollabSettlementActor::writer(auth.clone()),
            base,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn check_before_staging_for_actor(
        &self,
        store: &CanonicalStore,
        budget: &CallBudget,
        scope: &HistoryScope,
        note: &NoteId,
        actor: CollabSettlementActor,
        base: Option<&RevisionId>,
    ) -> Result<(SpaceRecord, NoteHeadRow), PortError> {
        if self.yrs_snapshot.is_none() && self.compacted_through.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let scope = scope.clone();
        let note = note.clone();
        let base = base.cloned();
        let owner = self.expected_owner.clone();
        let lease = self.expected_lease;
        let lineage = self.expected_lineage;
        let allow_fenced = self.close_room && !self.client_command;
        let needs_empty_snapshot = self.client_command && self.yrs_snapshot.is_none();
        store
            .with_read_tx_budget(Some(budget), |tx| {
                Box::pin(async move {
                    let srec = load_space_record(tx, &scope.space_id).await?;
                    srec.scope.check(&scope)?;
                    let head = load_note_head_row_tx(tx, &scope.space_id, &note).await?;
                    if head.lifecycle != Lifecycle::Active
                        || is_note_purge_fenced_tx(tx, &scope.space_id, note.as_str()).await?
                    {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    let (facts, _) = build_resource_facts_tx(
                        tx,
                        &srec.space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        true,
                    )
                    .await?;
                    actor.authorize_resource(&facts)?;
                    if base.is_some_and(|expected| head.head_rev_id != expected) {
                        return Err(DomainError::RevisionConflict {
                            current: head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }
                    let room = load_collab_session_opt_tx(tx, &scope.space_id, &note)
                        .await?
                        .ok_or(DomainError::ResourceNotFound)?;
                    validate_settlement_room(
                        &room,
                        &head.head_rev_id,
                        owner.as_deref(),
                        lease,
                        lineage,
                        allow_fenced,
                    )?;
                    actor.authorize_pending(tx, &scope, &room).await?;
                    if needs_empty_snapshot
                        && (room.yrs_snapshot_blob.is_some() || room.carrier_dirty)
                    {
                        return Err(DomainError::validation(ValidationReason::InvalidState).into());
                    }
                    Ok((srec, head))
                })
            })
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn commit_revision(
        self,
        tx: &mut BackendConn<'_>,
        item_ctx: &mut crate::writer::ItemExecCtx,
        store: &CanonicalStore,
        note: &NoteId,
        base_revision: &RevisionId,
        new_rev: &RevisionId,
        seq: SpaceSeq,
    ) -> Result<CollabSessionRecord, PortError> {
        let Self {
            expected_owner,
            expected_lease,
            expected_lineage,
            yrs_snapshot,
            compacted_through,
            close_room,
            client_command,
            replace_at_same_prefix,
        } = self;
        if yrs_snapshot.is_none() && compacted_through.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let scope_cl = item_ctx.scope.clone();
        let seq_i64 = seq.get() as i64;
        let fence_guard = if close_room {
            Some(store.inner.room_fences.lock_for_write(&scope_cl, note)?)
        } else {
            None
        };

        let Some(mut cur) = load_collab_session_opt_tx(tx, &scope_cl.space_id, note).await? else {
            return Err(DomainError::ResourceNotFound.into());
        };
        validate_settlement_room(
            &cur,
            base_revision,
            expected_owner.as_deref(),
            expected_lease,
            expected_lineage,
            close_room && !client_command,
        )?;

        if client_command && yrs_snapshot.is_none() && cur.yrs_snapshot_blob.is_some() {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let recovering_fenced = cur.room_state == CollabRoomState::Fenced;
        advance_collab_snapshot_tx(
            tx,
            &scope_cl,
            &mut cur,
            yrs_snapshot.as_deref(),
            compacted_through,
            true,
            replace_at_same_prefix,
        )
        .await?;
        if client_command && cur.carrier_dirty {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
        let new_lease = if let Some(guard) = &fence_guard {
            cur.lease_epoch.max(guard.epoch()).checked_next()?
        } else {
            cur.lease_epoch
        };
        let new_state = if close_room {
            CollabRoomState::Closed
        } else {
            CollabRoomState::Active
        };
        let new_owner = if close_room { None } else { cur.owner_id };
        let (final_yrs, final_yrs_digest) = match yrs_snapshot {
            Some(b) => {
                let d = ContentDigest::from_bytes(*blake3::hash(&b).as_bytes());
                (Some(b), Some(d))
            }
            None => (cur.yrs_snapshot_blob, cur.yrs_snapshot_digest),
        };
        let digest_slice = final_yrs_digest.as_ref().map(|d| d.as_bytes().as_slice());

        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE collab_sessions
                     SET lease_epoch = ?,
                         carrier_rev_id = ?,
                         yrs_snapshot_blob = ?,
                         yrs_snapshot_blake3 = ?,
                         room_state = ?,
                         owner_id = ?,
                         updated_seq = ?
                     WHERE space_id = ? AND note_id = ?",
                )
                .bind(new_lease.get() as i64)
                .bind(new_rev.as_str())
                .bind(final_yrs.as_deref())
                .bind(digest_slice)
                .bind(new_state.as_db())
                .bind(new_owner.as_deref())
                .bind(seq_i64)
                .bind(scope_cl.space_id.as_str())
                .bind(note.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_settle_collab_sess", err.to_string())
                })?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE collab_sessions
                     SET lease_epoch = $1,
                         carrier_rev_id = $2,
                         yrs_snapshot_blob = $3,
                         yrs_snapshot_blake3 = $4,
                         room_state = $5,
                         owner_id = $6,
                         updated_seq = $7
                     WHERE space_id = $8 AND note_id = $9",
                )
                .bind(new_lease.get() as i64)
                .bind(new_rev.as_str())
                .bind(final_yrs.as_deref())
                .bind(digest_slice)
                .bind(new_state.as_db())
                .bind(new_owner.as_deref())
                .bind(seq_i64)
                .bind(scope_cl.space_id.as_str())
                .bind(note.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_settle_collab_sess", err.to_string()))?;
            }
        }

        let out_rec = CollabSessionRecord {
            note: note.clone(),
            lease_epoch: new_lease,
            lineage_epoch: cur.lineage_epoch,
            carrier_rev_id: new_rev.clone(),
            yrs_snapshot_blob: final_yrs,
            yrs_snapshot_digest: final_yrs_digest,
            snapshot_coverage: cur.snapshot_coverage,
            carrier_dirty: cur.carrier_dirty,
            room_state: new_state,
            owner_id: new_owner,
            updated_seq: seq,
        };
        if let Some(guard) = fence_guard {
            let mut transition = RoomTransition::new(store.clone(), &scope_cl, guard, &out_rec)?;
            if recovering_fenced && base_revision != new_rev {
                transition.record_recovery(base_revision.clone(), new_rev.clone());
            }
            item_ctx.on_commit(move || transition.publish());
        }
        Ok(out_rec)
    }
}

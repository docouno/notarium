use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        CommandKey, ContentDigest, FolderId, LeaseEpoch, NoteId, PrincipalId, RevisionId, SpaceId,
        SpaceSeq,
    },
    model::{HistoryScope, Lifecycle},
    ports::{CallBudget, CanonicalEffectAdmission, ConfirmedChatStep, RevocationLease},
};
use serde::{Serialize, de::DeserializeOwned};
use sqlx::Row;
use tokio::{
    sync::{Mutex, Notify, OwnedRwLockWriteGuard, RwLock, mpsc, oneshot},
    task::JoinHandle,
};

use crate::{
    BoxFuture,
    blobs::{PendingDirSyncs, StagedBlobTicket},
    codec::{
        cancelled_not_committed, deadline_not_committed, doc_class_to_db, internal_not_committed,
        lifecycle_to_db, now_unix_ms, unavailable_retryable, unknown_commit_non_idempotent,
        unknown_commit_outcome,
    },
    config::WriterConfig,
    runtime::{
        CanonicalInner, SpaceRecord, SqlDriverState, are_any_notes_purge_fenced_tx,
        load_space_record_for_update_opt,
    },
    sql_exec::{BackendConn, PgTransactionLease, WriteTransaction},
};

pub(crate) mod fingerprint;
pub(crate) mod replay;

#[derive(Clone, Debug)]
pub struct CommandIdentitySpec {
    pub actor: PrincipalId,
    pub command_key: CommandKey,
    pub command_hash: ContentDigest,
    fingerprint_proof: Option<Arc<fingerprint::CommandProof>>,
    pub(crate) require_receipt_detail: bool,
    pub(crate) authority: Option<Arc<replay::ReplayAuthority>>,
}
impl CommandIdentitySpec {
    pub fn new(actor: PrincipalId, command_key: CommandKey, command_hash: ContentDigest) -> Self {
        Self {
            actor,
            command_key,
            command_hash,
            authority: None,
            fingerprint_proof: None,
            require_receipt_detail: false,
        }
    }
    pub(crate) fn has_confirmed_chat_step(&self) -> bool {
        self.confirmed_chat_step().is_some()
    }

    pub(crate) fn confirmed_chat_step(&self) -> Option<&Arc<ConfirmedChatStep>> {
        match self.fingerprint_proof.as_deref() {
            Some(fingerprint::CommandProof::Confirmed { step, .. }) => Some(step),
            _ => None,
        }
    }

    pub(crate) fn requires_standard_writer(&self) -> bool {
        self.has_confirmed_chat_step() || self.canonical_effect().is_some()
    }

    pub(crate) fn canonical_effect(&self) -> Option<&CanonicalEffectAdmission> {
        self.authority.as_deref()?.canonical_effect.as_ref()
    }

    async fn begin_canonical_effect(&self) -> Result<Option<Box<dyn RevocationLease>>, PortError> {
        if let Some(effect) = self.canonical_effect() {
            return effect.begin().await.map(Some);
        }
        Ok(None)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SemanticCutMismatchKind {
    CursorStale,
    CurrentHeadConflict,
}

#[derive(Clone, Debug)]
pub struct BatchEventDraft {
    pub space_seq: SpaceSeq,
    pub entity_type: String,
    pub entity_id: String,
    pub op_kind: String,
    pub rev_id: RevisionId,
    pub lifecycle: Lifecycle,
    pub doc_class: Option<DocClass>,
}

#[derive(Clone, Debug)]
pub struct ChangePayloadDraft {
    pub payload_id: String,
    pub codec: String,
    pub effect_msgpack: Vec<u8>,
    pub owner_note_ids: Vec<NoteId>,
}

#[derive(Debug)]
pub struct ItemCommitArtifacts {
    pub command_id: String,
    pub command_kind: String,
    pub events: Vec<BatchEventDraft>,
    pub change_payload: Option<ChangePayloadDraft>,
    pub receipt_detail_blob: Option<Vec<u8>>,
    pub receipt_sanitized_blob: Vec<u8>,
    pub receipt_owner_note_ids: Vec<NoteId>,
    pub response_bytes: Vec<u8>,
}

pub(crate) enum CommitAction {
    Confirmed(Box<dyn FnOnce() + Send>),
    ConfirmedOrUnknown(Box<dyn FnOnce() + Send>),
}

impl CommitAction {
    pub(crate) fn settle(self, confirmed: bool) {
        match self {
            Self::Confirmed(action) if confirmed => action(),
            Self::ConfirmedOrUnknown(action) => action(),
            Self::Confirmed(_) => {}
        }
    }
}

impl ItemCommitArtifacts {
    pub(crate) fn unsequenced(response_bytes: Vec<u8>) -> Self {
        Self {
            command_id: String::new(),
            command_kind: String::new(),
            events: Vec::new(),
            change_payload: None,
            receipt_detail_blob: None,
            receipt_sanitized_blob: Vec::new(),
            receipt_owner_note_ids: Vec::new(),
            response_bytes,
        }
    }
}

pub struct ItemExecCtx {
    pub scope: HistoryScope,
    pub space: notarium_core::auth::Space,
    pub active_epoch: LeaseEpoch,
    pub root_folder_id: FolderId,
    effective_cut_before: SpaceSeq,
    current_seq: SpaceSeq,
    allocated_count: u64,
    receipt_status: &'static str,
    pending_dir_syncs: PendingDirSyncs,
    retained_tickets: Vec<StagedBlobTicket>,
    retained_guards: Vec<Box<dyn Send>>,
    after_commit: Option<CommitAction>,
}

impl ItemExecCtx {
    pub fn effective_cut_before(&self) -> SpaceSeq {
        self.effective_cut_before
    }

    pub fn current_seq(&self) -> SpaceSeq {
        self.current_seq
    }

    pub fn allocated_count(&self) -> u64 {
        self.allocated_count
    }

    /// Marks this command's initial `command_receipts` row as `'pending_purge'` during Step 1 of D2 Purge/MintAndPurge.
    pub(crate) fn mark_receipt_pending_purge(&mut self) {
        self.receipt_status = "pending_purge";
    }

    /// Validates up front that allocating `count` contiguous sequences will not overflow `SpaceSeq::MAX`,
    /// returning `(first_seq, last_seq)` (`visibility_seq = last_seq`).
    pub fn preview_seq_range(&self, count: u64) -> Result<(SpaceSeq, SpaceSeq), PortError> {
        if count == 0 {
            return Err(internal_not_committed(
                "zero_seq_allocation",
                "atomic command must allocate at least 1 SpaceSeq",
            ));
        }
        let first = self.current_seq.checked_next()?;
        let last_raw = self
            .current_seq
            .get()
            .checked_add(count)
            .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
        let last = SpaceSeq::new(last_raw)?;
        Ok((first, last))
    }

    pub fn alloc_next_seq(&mut self) -> Result<SpaceSeq, PortError> {
        let next = self.current_seq.checked_next()?;
        self.current_seq = next;
        self.allocated_count += 1;
        Ok(next)
    }

    /// Retains a Phase-1 `StagedBlobTicket` (and its local shared digest guard) through outer SQL commit/rollback
    /// and merges its directory `fsync` targets into the coalesced batch set.
    pub fn record_staged_ticket(&mut self, ticket: StagedBlobTicket) {
        self.pending_dir_syncs.merge(&ticket.local_pending_dirs);
        self.retained_tickets.push(ticket);
    }

    /// Retains a runtime lock guard (such as `OwnedMutexGuard<RoomFenceState>`) until AFTER
    /// the outer SQL batch transaction commits or rolls back.
    pub fn retain_until_batch_commit<G: Send + 'static>(&mut self, guard: G) {
        self.retained_guards.push(Box::new(guard));
    }

    pub(crate) fn on_commit(&mut self, action: impl FnOnce() + Send + 'static) {
        self.after_commit = Some(CommitAction::Confirmed(Box::new(action)));
    }

    pub(crate) fn new_for_batch(
        scope: HistoryScope,
        space: notarium_core::auth::Space,
        active_epoch: LeaseEpoch,
        root_folder_id: FolderId,
        current_effective_cut: SpaceSeq,
    ) -> Self {
        Self {
            scope,
            space,
            active_epoch,
            root_folder_id,
            effective_cut_before: current_effective_cut,
            current_seq: current_effective_cut,
            allocated_count: 0,
            receipt_status: "completed",
            pending_dir_syncs: PendingDirSyncs::default(),
            retained_tickets: Vec::new(),
            retained_guards: Vec::new(),
            after_commit: None,
        }
    }

    pub(crate) fn on_commit_or_unknown(&mut self, action: impl FnOnce() + Send + 'static) {
        self.after_commit = Some(CommitAction::ConfirmedOrUnknown(Box::new(action)));
    }

    pub(crate) fn take_after_commit(&mut self) -> Option<CommitAction> {
        self.after_commit.take()
    }

    pub(crate) fn into_batch_parts(
        self,
    ) -> (
        &'static str,
        PendingDirSyncs,
        Vec<StagedBlobTicket>,
        Vec<Box<dyn Send>>,
    ) {
        debug_assert!(
            self.after_commit.is_none(),
            "native post-commit actions must be transferred to the batch"
        );
        (
            self.receipt_status,
            self.pending_dir_syncs,
            self.retained_tickets,
            self.retained_guards,
        )
    }
}

pub type ItemExecuteFn = Box<
    dyn for<'a> FnOnce(
            &'a mut BackendConn<'_>,
            &'a mut ItemExecCtx,
        ) -> BoxFuture<'a, Result<ItemCommitArtifacts, PortError>>
        + Send,
>;

pub(crate) enum PgSingleFastAttempt {
    Handled(BatchExecOutcome),
    FallbackToStandard,
}

pub(crate) type PgSingleItemFastFn = Box<
    dyn for<'a> FnOnce(
            &'a crate::CanonicalStore,
            &'a mut sqlx::PgConnection,
            WriterConfig,
            &'a WriterFaultState,
        ) -> BoxFuture<'a, PgSingleFastAttempt>
        + Send,
>;

pub struct PreparedWriteIntent {
    pub scope: HistoryScope,
    pub active_epoch: LeaseEpoch,
    pub idempotency: Option<CommandIdentitySpec>,
    pub source_note_ids: Vec<NoteId>,
    pub staged_bytes: u64,
    pub required_semantic_cut: Option<(SpaceSeq, SemanticCutMismatchKind)>,
    pub execute: ItemExecuteFn,
}

struct BatchWriteIntent {
    prepared: PreparedWriteIntent,
    room_wal: Option<RoomWalMode>,
    canonical_effect: Option<CanonicalEffectAdmission>,
}

struct RoomWalMode {
    /// PostgreSQL uses the expected writer lease. SQLite already owns the data root.
    check_space_lease: bool,
    replay_safe: bool,
}

impl From<PreparedWriteIntent> for BatchWriteIntent {
    fn from(prepared: PreparedWriteIntent) -> Self {
        Self {
            prepared,
            room_wal: None,
            canonical_effect: None,
        }
    }
}

impl BatchWriteIntent {
    fn canonical_effect(&self) -> Option<&CanonicalEffectAdmission> {
        self.canonical_effect.as_ref().or_else(|| {
            self.prepared
                .idempotency
                .as_ref()
                .and_then(CommandIdentitySpec::canonical_effect)
        })
    }

    fn expected_epoch(&self) -> Option<LeaseEpoch> {
        match &self.room_wal {
            Some(mode) if !mode.check_space_lease => None,
            _ => Some(self.prepared.active_epoch),
        }
    }

    fn replay_safe(&self) -> bool {
        self.prepared.idempotency.is_some()
            || self.room_wal.as_ref().is_some_and(|mode| mode.replay_safe)
    }
}

type BatchGroupReply = Result<(Vec<Result<Vec<u8>, PortError>>, SpaceSeq), PortError>;

enum QueuedWriteEntry {
    Single {
        intent: BatchWriteIntent,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        pg_fast_plan: Option<PgSingleItemFastFn>,
        reservation: QueueReservation,
        reply_tx: oneshot::Sender<Result<Vec<u8>, PortError>>,
    },
    RoomWal {
        intent: BatchWriteIntent,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        reservation: QueueReservation,
        reply_tx: oneshot::Sender<Result<Vec<u8>, PortError>>,
    },
    Group {
        space_id: SpaceId,
        intents: Vec<PreparedWriteIntent>,
        reservation: QueueReservation,
        reply_tx: oneshot::Sender<BatchGroupReply>,
    },
}

/// Deterministic fault hooks for storage tests.
#[derive(Default)]
pub struct WriterFaultState {
    pub drop_commit_response_once: AtomicBool,
    #[cfg(feature = "test-support")]
    pub rollback_commit_response_once: AtomicBool,
    #[cfg(feature = "test-support")]
    pub drop_room_open_response_once: AtomicBool,
    #[cfg(feature = "test-support")]
    pub room_wal_admission_pause_once: std::sync::Mutex<Option<RoomWalAdmissionPause>>,
    #[cfg(feature = "test-support")]
    pub guarded_admission_pause_once: std::sync::Mutex<Option<TestPauseGate>>,
    #[cfg(feature = "test-support")]
    pub planned_observation_pause_once: std::sync::Mutex<Option<PlannedObservationPause>>,
    pub pre_commit_space_delays: Mutex<HashMap<SpaceId, Duration>>,
}

#[cfg(feature = "test-support")]
pub struct TestPauseGate {
    pub entered: oneshot::Sender<()>,
    pub release: oneshot::Receiver<()>,
}

#[cfg(feature = "test-support")]
pub type RoomWalAdmissionPause = TestPauseGate;

#[cfg(feature = "test-support")]
pub type PlannedObservationPause = TestPauseGate;

/// Holds the authors' live registrations while invoking the synchronous enqueue.
pub type RoomWalAdmission<'a> = dyn Fn(&mut dyn FnMut()) -> Result<(), PortError> + Sync + 'a;

/// Opt-in Phase-2 batch commit latency recorder (`(duration_ns, logical_items)`).
#[derive(Default)]
pub struct BatchCommitTelemetry {
    enabled: AtomicBool,
    samples: std::sync::Mutex<Vec<(u64, u32)>>,
}

impl BatchCommitTelemetry {
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::SeqCst);
        if enabled {
            let mut guard = self.samples.lock().unwrap_or_else(|p| p.into_inner());
            guard.clear();
        }
    }

    pub fn take_samples(&self) -> Vec<(u64, u32)> {
        let mut guard = self.samples.lock().unwrap_or_else(|p| p.into_inner());
        std::mem::take(&mut *guard)
    }

    fn record(&self, duration_ns: u64, items: u32) {
        if self.enabled.load(Ordering::Relaxed) {
            let mut guard = self.samples.lock().unwrap_or_else(|p| p.into_inner());
            guard.push((duration_ns, items));
        }
    }
}

struct StagedByteLimiter {
    max_bytes: u64,
    in_flight: AtomicU64,
    notify: Notify,
}

struct QueueReservation {
    _bytes: StagedByteReservation,
    _space: Option<crate::runtime::disclosure::SpaceMutation>,
}

struct StagedByteReservation {
    limiter: Arc<StagedByteLimiter>,
    bytes: u64,
}

impl Drop for StagedByteReservation {
    fn drop(&mut self) {
        if self.bytes != 0 {
            self.limiter
                .in_flight
                .fetch_sub(self.bytes, Ordering::Release);
            self.limiter.notify.notify_waiters();
        }
    }
}

impl StagedByteLimiter {
    fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes: max_bytes.max(1024),
            in_flight: AtomicU64::new(0),
            notify: Notify::new(),
        }
    }

    async fn acquire(
        self: &Arc<Self>,
        bytes: u64,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
    ) -> Result<StagedByteReservation, PortError> {
        if bytes > self.max_bytes {
            return Err(unavailable_retryable(
                "writer_staged_bytes_exceeds_max",
                format!(
                    "prepared command staged bytes ({bytes}) exceed max_staged_bytes ({})",
                    self.max_bytes
                ),
                Duration::from_millis(50),
            ));
        }

        loop {
            if budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "writer_cancelled_before_admission",
                    "write cancelled while waiting for staged byte budget",
                ));
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let cur = self.in_flight.load(Ordering::Acquire);
            if bytes <= self.max_bytes.saturating_sub(cur) {
                if self
                    .in_flight
                    .compare_exchange_weak(cur, cur + bytes, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    return Ok(StagedByteReservation {
                        limiter: Arc::clone(self),
                        bytes,
                    });
                }
                continue;
            }

            if tokio::time::Instant::now() >= deadline {
                return Err(deadline_not_committed(
                    "writer_byte_backpressure_deadline",
                    "write deadline exceeded waiting for staged byte budget",
                ));
            }
            tokio::select! {
                _ = budget.cancellation.cancelled() => continue,
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    return Err(deadline_not_committed(
                        "writer_byte_backpressure_deadline",
                        "write deadline exceeded waiting for staged byte budget",
                    ));
                }
            }
        }
    }
}

/// Guard holding all Phase-2 writer commits paused at a clean transaction boundary
/// (used by D1 SQLite WAL `RESTART`/`TRUNCATE` reset and `<1 ms` paired backup pause).
pub struct WriterSafePointGuard {
    _guard: OwnedRwLockWriteGuard<()>,
}

#[derive(Default)]
pub(crate) struct ActiveWriteOpTracker {
    active_ops: AtomicUsize,
    in_phase2_items: AtomicUsize,
    notify: Notify,
    phase1_drained_notify: Notify,
}

pub(crate) struct ActiveWriteOpGuard {
    tracker: Arc<ActiveWriteOpTracker>,
    weight: usize,
    pg_space: Option<(SpaceId, Arc<PgSpaces>)>,
}

impl Drop for ActiveWriteOpGuard {
    fn drop(&mut self) {
        if self.weight > 0 {
            let previous = self
                .tracker
                .active_ops
                .fetch_sub(self.weight, Ordering::AcqRel);
            if previous == self.weight
                && let Some((space_id, spaces)) = &self.pg_space
            {
                let mut map = spaces.lock().expect("pg spaces");
                if map.get(space_id).is_some_and(|s| {
                    s.queue.is_none() && s.tracker.active_ops.load(Ordering::Acquire) == 0
                }) {
                    map.remove(space_id);
                }
            }
            self.tracker.notify.notify_waiters();
        }
    }
}

enum CoordinatorMode {
    Sqlite {
        tx: std::sync::Mutex<Option<mpsc::Sender<QueuedWriteEntry>>>,
        worker: Mutex<Option<JoinHandle<()>>>,
        tracker: Arc<ActiveWriteOpTracker>,
    },
    Postgres {
        spaces: Arc<PgSpaces>,
    },
}

type PgSpaces = std::sync::Mutex<HashMap<SpaceId, PgSpace>>;

#[derive(Default)]
struct PgSpace {
    tracker: Arc<ActiveWriteOpTracker>,
    queue: Option<SpaceQueueHandle>,
}

struct SpaceQueueHandle {
    tx: mpsc::Sender<QueuedWriteEntry>,
    worker: JoinHandle<()>,
}

pub struct WriteCoordinator {
    cfg: WriterConfig,
    accepting: AtomicBool,
    byte_limiter: Arc<StagedByteLimiter>,
    commit_gate: Arc<RwLock<()>>,
    faults: Arc<WriterFaultState>,
    batch_telemetry: Arc<BatchCommitTelemetry>,
    mode: CoordinatorMode,
}

struct WriterWait<'a> {
    budget: &'a CallBudget,
    deadline: tokio::time::Instant,
    room_wal_admission: Option<&'a RoomWalAdmission<'a>>,
}

impl<'a> WriterWait<'a> {
    fn from_budget(budget: &'a CallBudget) -> Self {
        Self {
            budget,
            deadline: crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining),
            room_wal_admission: None,
        }
    }

    #[cfg(feature = "test-support")]
    async fn pause_admission(&self, pause: TestPauseGate) -> Result<(), PortError> {
        let abandoned = || {
            cancelled_not_committed(
                "writer_admission_pause_abandoned",
                "writer admission pause was abandoned before enqueue",
            )
        };
        pause.entered.send(()).map_err(|_| abandoned())?;
        tokio::select! {
            biased;
            _ = self.budget.cancellation.cancelled() => Err(abandoned()),
            _ = tokio::time::sleep_until(self.deadline) => Err(deadline_not_committed(
                "writer_admission_pause_deadline", "writer admission pause expired before enqueue",
            )),
            result = pause.release => result.map_err(|_| abandoned()),
        }
    }

    async fn acknowledgement<T>(&self, reply: oneshot::Receiver<T>) -> Option<T> {
        // The actor owns the admitted work, even after the caller stops waiting.
        tokio::select! {
            biased;
            result = reply => result.ok(),
            _ = self.budget.cancellation.cancelled() => None,
            _ = tokio::time::sleep_until(self.deadline) => None,
        }
    }
}

impl WriteCoordinator {
    pub(crate) fn start(inner: &Arc<CanonicalInner>) -> Arc<Self> {
        let cfg = inner.config.writer;
        let byte_limiter = Arc::new(StagedByteLimiter::new(cfg.max_staged_bytes));
        let commit_gate = Arc::new(RwLock::new(()));
        let faults = Arc::new(WriterFaultState::default());
        let batch_telemetry = Arc::new(BatchCommitTelemetry::default());

        let mode = match &inner.sql {
            SqlDriverState::Sqlite { .. } => {
                let (tx, rx) = mpsc::channel(cfg.mailbox_capacity.max(1));
                let tracker = Arc::new(ActiveWriteOpTracker::default());
                let tracker_cl = Arc::clone(&tracker);
                let inner_weak = Arc::downgrade(inner);
                let gate_cl = Arc::clone(&commit_gate);
                let faults_cl = Arc::clone(&faults);
                let telem_cl = Arc::clone(&batch_telemetry);
                let worker = inner.backup_executor.spawn(async move {
                    run_batch_worker_loop(
                        inner_weak, rx, cfg, gate_cl, faults_cl, telem_cl, tracker_cl, None,
                    )
                    .await;
                });
                CoordinatorMode::Sqlite {
                    tx: std::sync::Mutex::new(Some(tx)),
                    worker: Mutex::new(Some(worker)),
                    tracker,
                }
            }
            SqlDriverState::Postgres { .. } => CoordinatorMode::Postgres {
                spaces: Arc::default(),
            },
        };

        Arc::new(Self {
            cfg,
            accepting: AtomicBool::new(true),
            byte_limiter,
            commit_gate,
            faults,
            batch_telemetry,
            mode,
        })
    }

    pub(crate) fn enter_write_op(&self, space_id: &SpaceId, weight: usize) -> ActiveWriteOpGuard {
        let w = weight.max(1);
        let (tracker, pg_space) = match &self.mode {
            CoordinatorMode::Sqlite { tracker, .. } => {
                tracker.active_ops.fetch_add(w, Ordering::AcqRel);
                (Arc::clone(tracker), None)
            }
            CoordinatorMode::Postgres { spaces } => {
                let mut map = spaces.lock().expect("pg spaces");
                let state = map.entry(space_id.clone()).or_default();
                state.tracker.active_ops.fetch_add(w, Ordering::AcqRel);
                (
                    Arc::clone(&state.tracker),
                    Some((space_id.clone(), Arc::clone(spaces))),
                )
            }
        };
        ActiveWriteOpGuard {
            tracker,
            weight: w,
            pg_space,
        }
    }

    pub fn faults(&self) -> &Arc<WriterFaultState> {
        &self.faults
    }

    pub(crate) fn has_active_sqlite_ops(&self) -> bool {
        self.active_sqlite_ops_count() > 0
    }

    pub(crate) fn active_sqlite_ops_count(&self) -> usize {
        match &self.mode {
            CoordinatorMode::Sqlite { tracker, .. } => tracker.active_ops.load(Ordering::Relaxed),
            CoordinatorMode::Postgres { .. } => 0,
        }
    }

    pub(crate) async fn yield_during_sqlite_phase1_burst(&self, budget: &CallBudget) {
        let CoordinatorMode::Sqlite { tracker, .. } = &self.mode else {
            return;
        };
        if tracker.active_ops.load(Ordering::Acquire) < 8
            || tracker.in_phase2_items.load(Ordering::Acquire) > 0
        {
            return;
        }
        let notified = tracker.phase1_drained_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if tracker.active_ops.load(Ordering::Acquire) < 8
            || tracker.in_phase2_items.load(Ordering::Acquire) > 0
        {
            return;
        }
        let cap = budget.remaining.min(Duration::from_millis(4));
        if cap.is_zero() {
            return;
        }
        let _ = tokio::time::timeout(cap, notified).await;
    }

    pub fn batch_telemetry(&self) -> &Arc<BatchCommitTelemetry> {
        &self.batch_telemetry
    }

    pub(crate) fn config(&self) -> WriterConfig {
        self.cfg
    }

    pub(crate) fn is_accepting(&self) -> bool {
        self.accepting.load(Ordering::SeqCst)
    }

    pub(crate) fn is_batch_telemetry_enabled(&self) -> bool {
        self.batch_telemetry.enabled.load(Ordering::Relaxed)
    }

    pub(crate) fn record_batch_telemetry(&self, duration_ns: u64, items: u32) {
        self.batch_telemetry.record(duration_ns, items);
    }

    /// Acquires an exclusive writer safe point between Phase-2 batch commits without dropping queued items.
    pub async fn acquire_safe_point(&self) -> WriterSafePointGuard {
        let guard = Arc::clone(&self.commit_gate).write_owned().await;
        WriterSafePointGuard { _guard: guard }
    }

    pub(crate) fn try_acquire_commit_read_guard(
        &self,
    ) -> Option<tokio::sync::OwnedRwLockReadGuard<()>> {
        self.commit_gate.clone().try_read_owned().ok()
    }

    /// Acquires a shared commit-gate read guard for auxiliary SQL writes that must pause during safe points.
    pub(crate) async fn acquire_commit_read_guard(&self) -> tokio::sync::OwnedRwLockReadGuard<()> {
        self.commit_gate.clone().read_owned().await
    }

    /// Enqueues a prepared write intent into `WriteBatchActor` with bounded backpressure and cancellation semantics.
    #[cfg(test)]
    pub(crate) async fn submit_raw(
        &self,
        inner: &Arc<CanonicalInner>,
        budget: &CallBudget,
        intent: PreparedWriteIntent,
    ) -> Result<Vec<u8>, PortError> {
        self.submit_raw_opt_fast(
            inner,
            WriterWait::from_budget(budget),
            intent.into(),
            None,
            None,
            None,
        )
        .await
    }

    async fn submit_raw_opt_fast(
        &self,
        inner: &Arc<CanonicalInner>,
        wait: WriterWait<'_>,
        mut intent: BatchWriteIntent,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        pg_fast_plan: Option<PgSingleItemFastFn>,
        pretracked_guard: Option<ActiveWriteOpGuard>,
    ) -> Result<Vec<u8>, PortError> {
        let space = &intent.prepared.scope.space_id;
        if let Some(expected) = intent.expected_epoch() {
            inner.check_writer_epoch(space, expected)?;
        }
        let confirmed_step = intent
            .prepared
            .idempotency
            .as_ref()
            .is_some_and(CommandIdentitySpec::has_confirmed_chat_step);
        let guarded = intent.canonical_effect().is_some();
        let has_standalone_effect = intent.canonical_effect.is_some();
        let sqlite_fast_plan = sqlite_fast_plan.and_then(|plan| {
            if confirmed_step
                || has_standalone_effect
                || (guarded && !plan.supports_canonical_effect())
            {
                intent.prepared.execute = plan.into_async_exec();
                None
            } else {
                Some(plan)
            }
        });
        let pg_fast_plan = if confirmed_step || guarded {
            None
        } else {
            pg_fast_plan
        };
        let _active_guard = match pretracked_guard {
            Some(g) => g,
            None => self.enter_write_op(space, 1),
        };
        let (permit, reserved_bytes) = self
            .reserve_entry(
                inner,
                space,
                wait.budget,
                wait.deadline,
                intent.prepared.staged_bytes,
            )
            .await?;
        #[cfg(feature = "test-support")]
        {
            let gate = if intent.room_wal.is_some() {
                Some(&self.faults.room_wal_admission_pause_once)
            } else if guarded {
                Some(&self.faults.guarded_admission_pause_once)
            } else {
                None
            };
            let pause = gate.and_then(|g| g.lock().expect("writer admission pause mutex").take());
            if let Some(pause) = pause {
                wait.pause_admission(pause).await?;
            }
        }
        let is_idempotent = intent.replay_safe();

        let (reply_tx, reply_rx) = oneshot::channel();
        // Once sent through `permit.send(...)`, the item is admitted: caller drop/cancel NEVER aborts commit!
        let entry = if intent.room_wal.is_some() {
            debug_assert!(pg_fast_plan.is_none());
            QueuedWriteEntry::RoomWal {
                intent,
                sqlite_fast_plan,
                reservation: reserved_bytes,
                reply_tx,
            }
        } else {
            QueuedWriteEntry::Single {
                intent,
                sqlite_fast_plan,
                pg_fast_plan,
                reservation: reserved_bytes,
                reply_tx,
            }
        };
        if let Some(admit) = wait.room_wal_admission {
            let mut pending = Some((permit, entry));
            let result = admit(&mut || {
                if let Some((permit, entry)) = pending.take() {
                    permit.send(entry);
                }
            });
            // The durable writer reply owns the outcome once enqueue succeeds.
            if pending.is_some() {
                result?;
                return Err(internal_not_committed(
                    "writer_room_wal_not_enqueued",
                    "room WAL admission returned without enqueueing",
                ));
            }
        } else {
            permit.send(entry);
        }

        match wait.acknowledgement(reply_rx).await {
            Some(outcome) => outcome,
            None => {
                if is_idempotent {
                    Err(unknown_commit_outcome(
                        "writer_worker_dropped_reply",
                        "batch writer reply unavailable after admission",
                    ))
                } else {
                    Err(unknown_commit_non_idempotent(
                        "writer_worker_dropped_reply",
                        "batch writer reply unavailable after admission",
                    ))
                }
            }
        }
    }

    /// Enqueues an ordered group of prepared intents for a single Space (`AcceptBatch` / `LinkMany`)
    /// so all items execute sequentially in input order inside one outer transaction with per-item `SAVEPOINT`s.
    pub(crate) async fn submit_batch_raw(
        &self,
        inner: &Arc<CanonicalInner>,
        budget: &CallBudget,
        space_id: &SpaceId,
        intents: Vec<PreparedWriteIntent>,
    ) -> Result<(Vec<Result<Vec<u8>, PortError>>, SpaceSeq), PortError> {
        let wait = WriterWait::from_budget(budget);
        for intent in &intents {
            inner.check_writer_epoch(&intent.scope.space_id, intent.active_epoch)?;
        }
        let _active_guard = self.enter_write_op(space_id, intents.len().max(1));
        let total_staged = intents
            .iter()
            .fold(0u64, |sum, item| sum.saturating_add(item.staged_bytes));
        let (permit, reserved_bytes) = self
            .reserve_entry(inner, space_id, budget, wait.deadline, total_staged)
            .await?;
        let all_idempotent = intents.iter().all(|i| i.idempotency.is_some());
        let (reply_tx, reply_rx) = oneshot::channel();
        permit.send(QueuedWriteEntry::Group {
            space_id: space_id.clone(),
            intents,
            reservation: reserved_bytes,
            reply_tx,
        });

        match wait.acknowledgement(reply_rx).await {
            Some(outcome) => outcome,
            None => {
                if all_idempotent {
                    Err(unknown_commit_outcome(
                        "writer_worker_dropped_batch_reply",
                        "batch writer group reply unavailable after admission",
                    ))
                } else {
                    Err(unknown_commit_non_idempotent(
                        "writer_worker_dropped_batch_reply",
                        "batch writer group reply unavailable after admission",
                    ))
                }
            }
        }
    }

    async fn reserve_entry(
        &self,
        inner: &Arc<CanonicalInner>,
        space: &SpaceId,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
        bytes: u64,
    ) -> Result<(mpsc::OwnedPermit<QueuedWriteEntry>, QueueReservation), PortError> {
        if !self.accepting.load(Ordering::Acquire) || inner.shutting_down.load(Ordering::Acquire) {
            return Err(unavailable_retryable(
                "writer_shutting_down",
                "canonical writer is draining",
                Duration::from_millis(100),
            ));
        }
        // Admission precedes mailbox and byte reservations. Waiting on a pinned
        // Space must leave both available to commands for unrelated Spaces.
        let space_guard = match &inner.sql {
            SqlDriverState::Sqlite { disclosures, .. } => tokio::select! {
                biased;
                _ = budget.cancellation.cancelled() => return Err(cancelled_not_committed("writer_cancelled_pre_enqueue", "write cancelled before disclosure admission")),
                _ = tokio::time::sleep_until(deadline) => return Err(deadline_not_committed("writer_disclosure_deadline", "deadline waiting for disclosure admission")),
                guard = disclosures.mutation(space) => Some(guard),
            },
            SqlDriverState::Postgres { .. } => None,
        };
        let bytes = self.byte_limiter.acquire(bytes, budget, deadline).await?;
        let sender = self.sender_for_space(inner, space)?;
        let closed = || {
            unavailable_retryable(
                "writer_channel_closed",
                "canonical writer is closed",
                Duration::from_millis(100),
            )
        };
        let permit = match sender.try_reserve_owned() {
            Ok(permit) => permit,
            Err(mpsc::error::TrySendError::Closed(_)) => return Err(closed()),
            Err(mpsc::error::TrySendError::Full(sender)) => tokio::select! {
                result = sender.reserve_owned() => result.map_err(|_| closed())?,
                _ = budget.cancellation.cancelled() => return Err(cancelled_not_committed("writer_cancelled_pre_enqueue", "write cancelled before mailbox admission")),
                _ = tokio::time::sleep_until(deadline) => return Err(deadline_not_committed("writer_mailbox_enqueue_deadline", "deadline while waiting for mailbox admission")),
            },
        };
        if budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "writer_cancelled_pre_enqueue",
                "write cancelled before mailbox admission",
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(deadline_not_committed(
                "writer_mailbox_enqueue_deadline",
                "deadline before mailbox admission",
            ));
        }
        Ok((
            permit,
            QueueReservation {
                _bytes: bytes,
                _space: space_guard,
            },
        ))
    }

    fn sender_for_space(
        &self,
        inner: &Arc<CanonicalInner>,
        space_id: &SpaceId,
    ) -> Result<mpsc::Sender<QueuedWriteEntry>, PortError> {
        match &self.mode {
            CoordinatorMode::Sqlite { tx, .. } => {
                let guard = tx.lock().expect("sqlite writer tx mutex");
                guard.clone().ok_or_else(|| {
                    unavailable_retryable(
                        "sqlite_writer_drained",
                        "SQLite WriteBatchActor has shut down",
                        Duration::from_millis(100),
                    )
                })
            }
            CoordinatorMode::Postgres { spaces } => {
                let mut map = spaces.lock().expect("pg spaces");
                if !self.accepting.load(Ordering::SeqCst) {
                    return Err(unavailable_retryable(
                        "pg_writer_drained",
                        "PostgreSQL WriteBatchActor is shutting down",
                        Duration::from_millis(100),
                    ));
                }
                let state = map.entry(space_id.clone()).or_default();
                if let Some(existing) = &state.queue
                    && !existing.tx.is_closed()
                {
                    return Ok(existing.tx.clone());
                }
                let tracker = Arc::clone(&state.tracker);
                let registration = Some((space_id.clone(), Arc::downgrade(spaces)));
                let (tx, rx) = mpsc::channel(self.cfg.mailbox_capacity.max(1));
                let inner_weak = Arc::downgrade(inner);
                let gate_cl = Arc::clone(&self.commit_gate);
                let faults_cl = Arc::clone(&self.faults);
                let telem_cl = Arc::clone(&self.batch_telemetry);
                let cfg = self.cfg;
                let worker = inner.backup_executor.spawn(async move {
                    run_batch_worker_loop(
                        inner_weak,
                        rx,
                        cfg,
                        gate_cl,
                        faults_cl,
                        telem_cl,
                        tracker,
                        registration,
                    )
                    .await;
                });
                state.queue = Some(SpaceQueueHandle {
                    tx: tx.clone(),
                    worker,
                });
                Ok(tx)
            }
        }
    }

    /// Stops new command admission, drains and flushes all accepted items cleanly, and joins workers.
    pub async fn drain_and_shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        match &self.mode {
            CoordinatorMode::Sqlite { tx, worker, .. } => {
                let sender = tx.lock().expect("sqlite writer tx mutex").take();
                drop(sender);
                if let Some(handle) = worker.lock().await.take() {
                    let _ = handle.await;
                }
            }
            CoordinatorMode::Postgres { spaces, .. } => {
                let drained: Vec<SpaceQueueHandle> = {
                    let mut map = spaces.lock().expect("pg spaces");
                    map.drain().filter_map(|(_, v)| v.queue).collect()
                };
                let mut handles = Vec::with_capacity(drained.len());
                for SpaceQueueHandle { tx, worker } in drained {
                    drop(tx);
                    handles.push(worker);
                }
                for h in handles {
                    let _ = h.await;
                }
            }
        }
        let _ = self.commit_gate.write().await;
    }
}

impl crate::CanonicalStore {
    pub(crate) fn enter_write_op(
        &self,
        space_id: &SpaceId,
    ) -> Result<ActiveWriteOpGuard, PortError> {
        Ok(self.inner.writer()?.enter_write_op(space_id, 1))
    }

    /// Submits a typed idempotent or non-idempotent canonical mutation through `WriteBatchActor`,
    /// automatically handling MessagePack receipt serialization and replay.
    #[cfg(any(test, feature = "test-support"))]
    pub(crate) async fn submit_write_command<R>(
        &self,
        budget: &CallBudget,
        intent: PreparedWriteIntent,
    ) -> Result<R, PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        let deadline =
            crate::runtime::deadline_after(tokio::time::Instant::now(), budget.remaining);
        self.submit_write_command_until(budget, deadline, intent, None, None, None)
            .await
    }

    #[cfg(feature = "test-support")]
    pub async fn submit_fixture_write_command<R>(
        &self,
        budget: &CallBudget,
        intent: PreparedWriteIntent,
    ) -> Result<R, PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        self.submit_write_command(budget, intent).await
    }

    pub(crate) async fn submit_write_command_until<R>(
        &self,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
        intent: PreparedWriteIntent,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        pg_fast_plan: Option<PgSingleItemFastFn>,
        pretracked_guard: Option<ActiveWriteOpGuard>,
    ) -> Result<R, PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        self.submit_write_command_until_with_effect(
            budget,
            deadline,
            intent,
            None,
            sqlite_fast_plan,
            pg_fast_plan,
            pretracked_guard,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn submit_write_command_until_with_effect<R>(
        &self,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
        intent: PreparedWriteIntent,
        canonical_effect: Option<notarium_core::ports::CanonicalEffectAdmission>,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        pg_fast_plan: Option<PgSingleItemFastFn>,
        pretracked_guard: Option<ActiveWriteOpGuard>,
    ) -> Result<R, PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        let is_idempotent = intent.idempotency.is_some();
        let writer = self.inner.writer()?;
        let mut batch_intent: BatchWriteIntent = intent.into();
        batch_intent.canonical_effect = canonical_effect;
        let raw_bytes = writer
            .submit_raw_opt_fast(
                &self.inner,
                WriterWait {
                    budget,
                    deadline,
                    room_wal_admission: None,
                },
                batch_intent,
                sqlite_fast_plan,
                pg_fast_plan,
                pretracked_guard,
            )
            .await?;
        rmp_serde::from_slice(&raw_bytes).map_err(|err| {
            if is_idempotent {
                unknown_commit_outcome("decode_writer_command_outcome", err.to_string())
            } else {
                unknown_commit_non_idempotent("decode_writer_command_outcome", err.to_string())
            }
        })
    }

    pub(crate) async fn submit_room_wal(
        &self,
        budget: &CallBudget,
        deadline: tokio::time::Instant,
        mut intent: PreparedWriteIntent,
        replay_safe: bool,
        sqlite_fast_plan: Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        room_wal_admission: Option<&RoomWalAdmission<'_>>,
    ) -> Result<u64, PortError> {
        let check_space_lease = matches!(&self.inner.sql, SqlDriverState::Postgres { .. });
        if check_space_lease {
            intent.active_epoch = self.inner.writer_epoch(&intent.scope.space_id)?;
        }
        let raw = self
            .inner
            .writer()?
            .submit_raw_opt_fast(
                &self.inner,
                WriterWait {
                    budget,
                    deadline,
                    room_wal_admission,
                },
                BatchWriteIntent {
                    prepared: intent,
                    room_wal: Some(RoomWalMode {
                        check_space_lease,
                        replay_safe,
                    }),
                    canonical_effect: None,
                },
                sqlite_fast_plan,
                None,
                None,
            )
            .await?;
        rmp_serde::from_slice(&raw).map_err(|error| {
            if replay_safe {
                unknown_commit_outcome("decode_room_wal_outcome", error.to_string())
            } else {
                unknown_commit_non_idempotent("decode_room_wal_outcome", error.to_string())
            }
        })
    }

    /// Submits an ordered group of item intents for a single Space (`AcceptBatch` / `LinkMany`)
    /// so all items run in input order with per-item `SAVEPOINT`s inside one outer transaction.
    pub(crate) async fn submit_write_batch<R>(
        &self,
        budget: &CallBudget,
        space_id: &SpaceId,
        intents: Vec<PreparedWriteIntent>,
    ) -> Result<(Vec<Result<R, PortError>>, SpaceSeq), PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        let writer = self.inner.writer()?;
        let (raw_items, effective_cut) = writer
            .submit_batch_raw(&self.inner, budget, space_id, intents)
            .await?;
        let mut decoded = Vec::with_capacity(raw_items.len());
        for raw_res in raw_items {
            match raw_res {
                Ok(bytes) => {
                    let val = rmp_serde::from_slice(&bytes).map_err(|err| {
                        unknown_commit_outcome("decode_writer_batch_item_outcome", err.to_string())
                    })?;
                    decoded.push(Ok(val));
                }
                Err(err) => decoded.push(Err(err)),
            }
        }
        Ok((decoded, effective_cut))
    }

    /// Helper to encode a typed command response into both `receipt_response_blob` and `response_bytes`.
    pub fn encode_command_outcome<R: Serialize>(outcome: &R) -> Result<Vec<u8>, PortError> {
        rmp_serde::to_vec_named(outcome)
            .map_err(|err| internal_not_committed("encode_writer_command_outcome", err.to_string()))
    }

    #[cfg(feature = "test-support")]
    pub fn writer_faults(&self) -> Result<Arc<WriterFaultState>, PortError> {
        Ok(Arc::clone(self.inner.writer()?.faults()))
    }

    #[cfg(feature = "test-support")]
    pub fn retained_pg_writer_spaces_for_test(&self) -> Result<usize, PortError> {
        let CoordinatorMode::Postgres { spaces } = &self.inner.writer()?.mode else {
            return Ok(0);
        };
        Ok(spaces.lock().expect("pg spaces").len())
    }

    #[cfg(feature = "test-support")]
    pub fn has_active_sqlite_writes_for_test(&self) -> Result<bool, PortError> {
        Ok(self.inner.writer()?.has_active_sqlite_ops())
    }

    #[cfg(feature = "test-support")]
    pub async fn acquire_writer_safe_point(&self) -> Result<WriterSafePointGuard, PortError> {
        self.inner.writer_safe_point().await
    }

    /// Enables or resets opt-in Phase-2 batch commit latency collection (`(duration_ns, logical_items)`).
    pub fn set_writer_batch_telemetry(&self, enabled: bool) -> Result<(), PortError> {
        self.inner.writer()?.batch_telemetry().set_enabled(enabled);
        Ok(())
    }

    /// Drains collected Phase-2 batch commit samples (`(duration_ns, logical_items)`).
    pub fn take_writer_batch_samples(&self) -> Result<Vec<(u64, u32)>, PortError> {
        Ok(self.inner.writer()?.batch_telemetry().take_samples())
    }
}

fn entry_logical_len(entry: &QueuedWriteEntry) -> usize {
    match entry {
        QueuedWriteEntry::Single { .. } | QueuedWriteEntry::RoomWal { .. } => 1,
        QueuedWriteEntry::Group { intents, .. } => intents.len().max(1),
    }
}

fn reject_queued_entry(entry: QueuedWriteEntry, err: PortError) {
    match entry {
        QueuedWriteEntry::Single { reply_tx, .. } | QueuedWriteEntry::RoomWal { reply_tx, .. } => {
            let _ = reply_tx.send(Err(err));
        }
        QueuedWriteEntry::Group { reply_tx, .. } => {
            let _ = reply_tx.send(Err(err));
        }
    }
}

fn compute_pipelined_batch_target(active_ops: usize, max_items: usize) -> usize {
    active_ops.clamp(1, max_items)
}

#[allow(clippy::too_many_arguments)]
async fn run_batch_worker_loop(
    inner_weak: std::sync::Weak<CanonicalInner>,
    mut rx: mpsc::Receiver<QueuedWriteEntry>,
    cfg: WriterConfig,
    commit_gate: Arc<RwLock<()>>,
    faults: Arc<WriterFaultState>,
    batch_telemetry: Arc<BatchCommitTelemetry>,
    tracker: Arc<ActiveWriteOpTracker>,
    pg_space: Option<(SpaceId, std::sync::Weak<PgSpaces>)>,
) {
    let max_items = cfg.max_batch_items.max(1);
    let flush_window = cfg.batch_flush_window;

    loop {
        let next = if let Some((id, registry)) = &pg_space {
            match tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
                Ok(entry) => entry,
                Err(_) => {
                    let Some(spaces) = registry.upgrade() else {
                        break;
                    };
                    let mut map = spaces.lock().expect("pg spaces");
                    // Admission clones the sender under this mutex. No sender or pending item
                    // may be stranded by retiring the worker.
                    if let Some(state) = map.get_mut(id)
                        && rx.is_empty()
                        && state
                            .queue
                            .as_ref()
                            .is_some_and(|q| q.tx.strong_count() == 1)
                    {
                        state.queue.take();
                        if state.tracker.active_ops.load(Ordering::Acquire) == 0 {
                            map.remove(id);
                        }
                        break;
                    }
                    continue;
                }
            }
        } else {
            rx.recv().await
        };
        let Some(first) = next else {
            break;
        };

        let mut item_count = entry_logical_len(&first);
        let mut batch = Vec::with_capacity(max_items.min(64));
        batch.push(first);

        let initial_target =
            compute_pipelined_batch_target(tracker.active_ops.load(Ordering::Acquire), max_items);

        // Drain up to `initial_target` so high-concurrency writer cohorts naturally split into
        // two double-buffered platoons (zero idle gap between Phase 2 and Phase 1!).
        while item_count < initial_target {
            match rx.try_recv() {
                Ok(entry) => {
                    item_count += entry_logical_len(&entry);
                    batch.push(entry);
                }
                Err(_) => break,
            }
        }

        if item_count < initial_target && !flush_window.is_zero() {
            let deadline =
                crate::runtime::deadline_after(tokio::time::Instant::now(), flush_window);
            while item_count < max_items {
                let notified = tracker.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();

                let active_target = compute_pipelined_batch_target(
                    tracker.active_ops.load(Ordering::Acquire),
                    max_items,
                );
                while item_count < active_target {
                    match rx.try_recv() {
                        Ok(entry) => {
                            item_count += entry_logical_len(&entry);
                            batch.push(entry);
                        }
                        Err(_) => break,
                    }
                }
                if item_count >= active_target {
                    break;
                }

                tokio::select! {
                    biased;
                    maybe_entry = rx.recv() => {
                        match maybe_entry {
                            Some(entry) => {
                                item_count += entry_logical_len(&entry);
                                batch.push(entry);
                            }
                            None => break,
                        }
                    }
                    _ = notified => {}
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
        }

        let Some(inner) = inner_weak.upgrade() else {
            for entry in batch {
                reject_queued_entry(
                    entry,
                    unavailable_retryable(
                        "canonical_runtime_dropped",
                        "canonical runtime dropped before batch execution",
                        Duration::from_millis(100),
                    ),
                );
            }
            break;
        };

        // Respect safe-point pauses (WAL reset / paired backup) cleanly between batches!
        let _commit_read_guard = match commit_gate.try_read() {
            Ok(g) => g,
            Err(_) => {
                let _waiting = inner.yield_pg_writer();
                commit_gate.read().await
            }
        };
        let record_telem = batch_telemetry.enabled.load(Ordering::Relaxed);
        let phase2_start = record_telem.then(std::time::Instant::now);
        let logical_items_u32 = u32::try_from(item_count).unwrap_or(u32::MAX);
        tracker.in_phase2_items.store(item_count, Ordering::Release);
        tracker.phase1_drained_notify.notify_waiters();
        flush_single_batch(&inner, batch, cfg, &faults).await;
        tracker.in_phase2_items.store(0, Ordering::Release);
        if let Some(t0) = phase2_start {
            let dur_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
            batch_telemetry.record(dur_ns, logical_items_u32);
        }
        drop(_commit_read_guard);
        if rx.is_empty() {
            tokio::task::yield_now().await;
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) enum SpaceBatchEntry {
    Missing,
    Loaded {
        record: Box<SpaceRecord>,
        persisted_initial_seq: SpaceSeq,
        effective_cut: SpaceSeq,
        max_purge_seq: Option<SpaceSeq>,
        targets: crate::changes::CommittedTargetAcc,
        changes: crate::projection_fence::VisibilityChanges,
    },
}

pub(crate) enum ItemOutcomeSlot {
    Succeeded {
        response_bytes: Vec<u8>,
        has_idempotency: bool,
    },
    Failed(PortError),
}

enum ReplyTarget {
    Single {
        reply_tx: oneshot::Sender<Result<Vec<u8>, PortError>>,
    },
    Group {
        space_id: SpaceId,
        count: usize,
        all_idempotent: bool,
        reply_tx: oneshot::Sender<BatchGroupReply>,
    },
}

async fn flush_single_batch(
    inner: &Arc<CanonicalInner>,
    batch: Vec<QueuedWriteEntry>,
    cfg: WriterConfig,
    faults: &WriterFaultState,
) {
    let store = crate::CanonicalStore {
        inner: Arc::clone(inner),
    };

    let mut visibility_spaces = Vec::with_capacity(batch.len());
    for entry in &batch {
        match entry {
            QueuedWriteEntry::Single { intent, .. } => {
                visibility_spaces.push(intent.prepared.scope.space_id.clone());
            }
            QueuedWriteEntry::RoomWal { intent, .. } => {
                visibility_spaces.push(intent.prepared.scope.space_id.clone());
            }
            QueuedWriteEntry::Group {
                space_id, intents, ..
            } => {
                visibility_spaces.push(space_id.clone());
                visibility_spaces
                    .extend(intents.iter().map(|intent| intent.scope.space_id.clone()));
            }
        }
    }
    let mut visibility = match inner
        .live_visibility
        .try_for_write(visibility_spaces.clone())
    {
        Some(v) => v,
        None => {
            let _waiting = inner.yield_pg_writer();
            inner.live_visibility.for_write(visibility_spaces).await
        }
    };

    let mut reserved_list = Vec::with_capacity(batch.len());
    let mut reply_targets = Vec::with_capacity(batch.len());
    let mut group_spaces = Vec::new();
    type UnpackedBatchItem = (
        BatchWriteIntent,
        Option<Box<dyn crate::sqlite_fast::SqliteSyncItemPlan>>,
        Option<PgSingleItemFastFn>,
    );
    let mut items: Vec<UnpackedBatchItem> = Vec::with_capacity(batch.len());

    // Mailbox admission can precede a local owner drain. This guard keeps the
    // execution-time lease check ordered with revocation through SQL commit.
    for entry in batch {
        match entry {
            QueuedWriteEntry::Single {
                intent,
                sqlite_fast_plan,
                pg_fast_plan,
                reservation,
                reply_tx,
            } => {
                if let Err(error) = inner.check_writer_epoch(
                    &intent.prepared.scope.space_id,
                    intent.prepared.active_epoch,
                ) {
                    let _ = reply_tx.send(Err(error));
                    continue;
                }
                reserved_list.push(reservation);
                reply_targets.push(ReplyTarget::Single { reply_tx });
                items.push((intent, sqlite_fast_plan, pg_fast_plan));
            }
            QueuedWriteEntry::RoomWal {
                intent,
                sqlite_fast_plan,
                reservation,
                reply_tx,
            } => {
                if let Some(expected) = intent.expected_epoch()
                    && let Err(error) =
                        inner.check_writer_epoch(&intent.prepared.scope.space_id, expected)
                {
                    let _ = reply_tx.send(Err(error));
                    continue;
                }
                reserved_list.push(reservation);
                reply_targets.push(ReplyTarget::Single { reply_tx });
                items.push((intent, sqlite_fast_plan, None));
            }
            QueuedWriteEntry::Group {
                space_id,
                intents: group_intents,
                reservation,
                reply_tx,
            } => {
                if let Err(error) = group_intents.iter().try_for_each(|intent| {
                    inner.check_writer_epoch(&intent.scope.space_id, intent.active_epoch)
                }) {
                    let _ = reply_tx.send(Err(error));
                    continue;
                }
                let count = group_intents.len();
                let all_idempotent = group_intents.iter().all(|it| it.idempotency.is_some());
                reserved_list.push(reservation);
                group_spaces.push(space_id.clone());
                reply_targets.push(ReplyTarget::Group {
                    space_id,
                    count,
                    all_idempotent,
                    reply_tx,
                });
                items.extend(group_intents.into_iter().map(|it| (it.into(), None, None)));
            }
        }
    }

    if reply_targets.is_empty() {
        return;
    }
    visibility.committing();
    let mut clean_pg_connection = None;
    let mut exec_result = match &inner.sql {
        SqlDriverState::Sqlite { writer, .. } => {
            #[cfg(feature = "test-support")]
            let rollback_fault_armed = faults.rollback_commit_response_once.load(Ordering::Acquire);
            #[cfg(not(feature = "test-support"))]
            let rollback_fault_armed = false;
            // The native guarded rollback owns one transaction. Preserve the ordinary
            // per-item admission and rollback protocol in a mixed batch.
            let standalone_or_unguarded = items.len() == 1
                || items
                    .iter()
                    .all(|(intent, _, _)| intent.canonical_effect().is_none());
            let can_fast = group_spaces.is_empty()
                && standalone_or_unguarded
                && !rollback_fault_armed
                && items.iter().all(|(_, fp, _)| fp.is_some())
                && faults.pre_commit_space_delays.lock().await.is_empty();
            let mut guard = writer.lock().await;
            match guard.as_mut() {
                Some(pair) => {
                    if let Err(err) = store
                        .inner
                        .drain_pending_sqlite_commit_if_needed(pair)
                        .await
                    {
                        BatchExecOutcome::AbortedBeforeCommit(err)
                    } else if can_fast {
                        let sq_items = items
                            .into_iter()
                            .map(|(it, fp, _)| (it.prepared, fp))
                            .collect();
                        crate::sqlite_fast::execute_sqlite_fast_batch(
                            &store, pair, sq_items, cfg, faults,
                        )
                        .await
                    } else {
                        let intents = items
                            .into_iter()
                            .map(|(mut intent, fp_opt, _)| {
                                if let Some(fp) = fp_opt {
                                    intent.prepared.execute = fp.into_async_exec();
                                }
                                intent
                            })
                            .collect();
                        let mut backend = BackendConn::Sqlite(&mut pair.sqlx_conn);
                        execute_batch_on_conn(
                            &store,
                            &mut backend,
                            intents,
                            &group_spaces,
                            cfg,
                            faults,
                        )
                        .await
                    }
                }
                None => BatchExecOutcome::AbortedBeforeCommit(unavailable_retryable(
                    "sqlite_writer_closed",
                    "SQLite writer connection closed",
                    Duration::from_millis(100),
                )),
            }
        }
        SqlDriverState::Postgres { pool, .. } => {
            let can_pg_fast = group_spaces.is_empty()
                && items.len() == 1
                && items[0].2.is_some()
                && faults.pre_commit_space_delays.lock().await.is_empty();
            let conn_res = match pool.take_idle_writer() {
                Some(c) => Ok(c),
                None => pool.acquire().await,
            };
            match conn_res {
                Ok(mut pooled) => {
                    let mut lease = PgTransactionLease::new(&mut pooled);
                    let conn = lease.conn();
                    let out = if can_pg_fast {
                        let (mut intent, fp_opt, pg_fast_opt) = items.pop().expect("len == 1");
                        if let Some(fp) = fp_opt {
                            intent.prepared.execute = fp.into_async_exec();
                        }
                        let pg_fast = pg_fast_opt.expect("is_some");
                        match pg_fast(&store, conn, cfg, faults).await {
                            PgSingleFastAttempt::Handled(out) => out,
                            PgSingleFastAttempt::FallbackToStandard => {
                                let mut backend = BackendConn::Postgres(conn);
                                execute_batch_on_conn(
                                    &store,
                                    &mut backend,
                                    vec![intent],
                                    &group_spaces,
                                    cfg,
                                    faults,
                                )
                                .await
                            }
                        }
                    } else {
                        let intents = items
                            .into_iter()
                            .map(|(mut intent, fp_opt, _)| {
                                if let Some(fp) = fp_opt {
                                    intent.prepared.execute = fp.into_async_exec();
                                }
                                intent
                            })
                            .collect();
                        let mut backend = BackendConn::Postgres(conn);
                        execute_batch_on_conn(
                            &store,
                            &mut backend,
                            intents,
                            &group_spaces,
                            cfg,
                            faults,
                        )
                        .await
                    };
                    if matches!(
                        out,
                        BatchExecOutcome::Committed {
                            conn_clean: true,
                            ..
                        }
                    ) {
                        lease.complete();
                        clean_pg_connection = Some(pooled);
                    }
                    out
                }
                Err(err) => BatchExecOutcome::AbortedBeforeCommit(unavailable_retryable(
                    "pg_acquire_batch_conn",
                    err.to_string(),
                    Duration::from_millis(50),
                )),
            }
        }
    };

    match &exec_result {
        BatchExecOutcome::Committed {
            visibility_windows, ..
        } => {
            if visibility.needs_storage_read(&store, visibility_windows) {
                // Release any retained writer socket before visibility refreshes
                // so concurrent per-Space workers cannot exhaust the PG pool.
                drop(clean_pg_connection.take());
            }
            if let Err(error) = visibility.published(&store, visibility_windows).await {
                let BatchExecOutcome::Committed { slots, .. } = exec_result else {
                    unreachable!("checking a committed batch");
                };
                exec_result = BatchExecOutcome::UnknownCommit {
                    slots,
                    diag_reason: format!("projection erasure pending: {error:?}"),
                };
            }
        }
        BatchExecOutcome::AbortedBeforeCommit(_) => visibility.aborted(),
        BatchExecOutcome::UnknownCommit { .. } => visibility.invalidate(),
    }
    drop(reserved_list);

    match exec_result {
        BatchExecOutcome::Committed {
            slots,
            space_effective_cuts,
            ..
        } => {
            if let Some(connection) = clean_pg_connection
                && let SqlDriverState::Postgres { pool, .. } = &inner.sql
            {
                pool.park_writer(connection);
            }
            let mut slot_iter = slots.into_iter();
            for target in reply_targets {
                match target {
                    ReplyTarget::Single { reply_tx } => {
                        if let Some(slot) = slot_iter.next() {
                            let res = match slot {
                                ItemOutcomeSlot::Succeeded { response_bytes, .. } => {
                                    Ok(response_bytes)
                                }
                                ItemOutcomeSlot::Failed(err) => Err(err),
                            };
                            let _ = reply_tx.send(res);
                        }
                    }
                    ReplyTarget::Group {
                        space_id,
                        count,
                        reply_tx,
                        ..
                    } => {
                        match space_effective_cuts.get(&space_id).copied() {
                            Some(cut) => {
                                let mut group_res = Vec::with_capacity(count);
                                for _ in 0..count {
                                    if let Some(slot) = slot_iter.next() {
                                        let res = match slot {
                                            ItemOutcomeSlot::Succeeded {
                                                response_bytes, ..
                                            } => Ok(response_bytes),
                                            ItemOutcomeSlot::Failed(err) => Err(err),
                                        };
                                        group_res.push(res);
                                    }
                                }
                                let _ = reply_tx.send(Ok((group_res, cut)));
                            }
                            None => {
                                // Space does not exist! Drain group slots and fail closed.
                                for _ in 0..count {
                                    let _ = slot_iter.next();
                                }
                                let _ = reply_tx.send(Err(DomainError::ResourceNotFound.into()));
                            }
                        }
                    }
                }
            }
        }
        BatchExecOutcome::UnknownCommit { slots, diag_reason } => {
            let mut slot_iter = slots.into_iter();
            for target in reply_targets {
                match target {
                    ReplyTarget::Single { reply_tx } => {
                        if let Some(slot) = slot_iter.next() {
                            let res = match slot {
                                ItemOutcomeSlot::Succeeded {
                                    has_idempotency, ..
                                } => {
                                    if has_idempotency {
                                        Err(unknown_commit_outcome(
                                            "batch_commit_unknown",
                                            &diag_reason,
                                        ))
                                    } else {
                                        Err(unknown_commit_non_idempotent(
                                            "batch_commit_unknown_non_idemp",
                                            &diag_reason,
                                        ))
                                    }
                                }
                                ItemOutcomeSlot::Failed(err) => Err(err),
                            };
                            let _ = reply_tx.send(res);
                        }
                    }
                    ReplyTarget::Group {
                        count,
                        all_idempotent,
                        reply_tx,
                        ..
                    } => {
                        let mut any_succeeded = false;
                        for _ in 0..count {
                            if let Some(ItemOutcomeSlot::Succeeded { .. }) = slot_iter.next() {
                                any_succeeded = true;
                            }
                        }
                        if !any_succeeded {
                            // Zero items succeeded in the group -> zero durable effects!
                            let _ = reply_tx.send(Err(unavailable_retryable(
                                "batch_commit_aborted_zero_group_effects",
                                &diag_reason,
                                Duration::from_millis(25),
                            )));
                        } else if all_idempotent {
                            let _ = reply_tx.send(Err(unknown_commit_outcome(
                                "batch_commit_unknown",
                                &diag_reason,
                            )));
                        } else {
                            let _ = reply_tx.send(Err(unknown_commit_non_idempotent(
                                "batch_commit_unknown_non_idemp",
                                &diag_reason,
                            )));
                        }
                    }
                }
            }
        }
        BatchExecOutcome::AbortedBeforeCommit(err) => {
            for target in reply_targets {
                match target {
                    ReplyTarget::Single { reply_tx } => {
                        let _ = reply_tx.send(Err(err.clone()));
                    }
                    ReplyTarget::Group { reply_tx, .. } => {
                        let _ = reply_tx.send(Err(err.clone()));
                    }
                }
            }
        }
    }
}

pub(crate) enum BatchExecOutcome {
    Committed {
        slots: Vec<ItemOutcomeSlot>,
        space_effective_cuts: BTreeMap<SpaceId, SpaceSeq>,
        conn_clean: bool,
        visibility_windows: Vec<crate::projection_fence::VisibilityWindow>,
    },
    UnknownCommit {
        slots: Vec<ItemOutcomeSlot>,
        diag_reason: String,
    },
    AbortedBeforeCommit(PortError),
}

pub(crate) fn visibility_windows(
    _store: &crate::CanonicalStore,
    states: &BTreeMap<SpaceId, SpaceBatchEntry>,
) -> Vec<crate::projection_fence::VisibilityWindow> {
    states
        .values()
        .filter_map(|entry| match entry {
            SpaceBatchEntry::Loaded {
                record,
                persisted_initial_seq,
                effective_cut,
                changes,
                ..
            } => Some(crate::projection_fence::VisibilityWindow {
                scope: record.scope.clone(),
                after: *persisted_initial_seq,
                through: *effective_cut,
                changes: if persisted_initial_seq < effective_cut {
                    *changes
                } else {
                    crate::projection_fence::VisibilityChanges::default()
                },
            }),
            _ => None,
        })
        .collect()
}

async fn execute_batch_on_conn(
    store: &crate::CanonicalStore,
    tx: &mut BackendConn<'_>,
    intents: Vec<BatchWriteIntent>,
    group_spaces: &[SpaceId],
    cfg: WriterConfig,
    faults: &WriterFaultState,
) -> BatchExecOutcome {
    let is_sqlite = matches!(tx, BackendConn::Sqlite(_));
    let mut transaction = match WriteTransaction::begin(tx).await {
        Ok(transaction) => transaction,
        Err(err) => return BatchExecOutcome::AbortedBeforeCommit(err),
    };
    let tx = &mut transaction.conn();

    let mut space_states: BTreeMap<SpaceId, SpaceBatchEntry> = BTreeMap::new();
    let mut batch_dir_syncs = PendingDirSyncs::default();
    let mut after_commit = Vec::new();
    // Retain all StagedBlobTickets and runtime lock guards until AFTER outer COMMIT/ROLLBACK!
    let mut batch_retained_tickets: Vec<StagedBlobTicket> = Vec::new();
    let mut batch_retained_guards: Vec<Box<dyn Send>> = Vec::new();
    let mut active_effects: Vec<(usize, Box<dyn RevocationLease>)> = Vec::new();
    let mut slots: Vec<ItemOutcomeSlot> = Vec::with_capacity(intents.len());

    let committed_at_ms = match now_unix_ms() {
        Ok(ms) => ms,
        Err(err) => {
            transaction.rollback().await;
            return BatchExecOutcome::AbortedBeforeCommit(err);
        }
    };
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);

    // Take all PostgreSQL Space locks for guarded batches before any effect
    // can hold up a concurrent Control revocation.
    let all_spaces;
    let initial_spaces = if store.is_postgres()
        && intents
            .iter()
            .any(|intent| intent.canonical_effect().is_some())
    {
        all_spaces = intents
            .iter()
            .map(|intent| intent.prepared.scope.space_id.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        all_spaces.as_slice()
    } else {
        group_spaces
    };
    for gspace in initial_spaces {
        if !space_states.contains_key(gspace) {
            match lock_and_load_space_outer_tx(tx, gspace).await {
                Ok(Some(rec)) => {
                    let init_seq = rec.last_seq;
                    space_states.insert(
                        gspace.clone(),
                        SpaceBatchEntry::Loaded {
                            record: Box::new(rec),
                            persisted_initial_seq: init_seq,
                            effective_cut: init_seq,
                            max_purge_seq: None,
                            targets: crate::changes::CommittedTargetAcc::default(),
                            changes: crate::projection_fence::VisibilityChanges::default(),
                        },
                    );
                }
                Ok(None) => {
                    space_states.insert(gspace.clone(), SpaceBatchEntry::Missing);
                }
                Err(err) => {
                    transaction.rollback().await;
                    return BatchExecOutcome::AbortedBeforeCommit(err);
                }
            }
        }
    }

    let wal_only = !intents.is_empty() && intents.iter().all(|it| it.room_wal.is_some());
    let use_savepoints = intents.len() > 1;
    let mut slot_spaces: Vec<SpaceId> = Vec::with_capacity(intents.len());
    let mut first_mutating_slot: BTreeMap<SpaceId, usize> = BTreeMap::new();

    for (idx, intent) in intents.into_iter().enumerate() {
        let space_id = intent.prepared.scope.space_id.clone();
        slot_spaces.push(space_id.clone());

        // Lock Space row OUTSIDE item savepoint on first encounter in this batch so a rolled-back
        // item savepoint on PostgreSQL never drops the batch's `SELECT ... FOR UPDATE` row lock!
        if !space_states.contains_key(&space_id) {
            match lock_and_load_space_outer_tx(tx, &space_id).await {
                Ok(Some(rec)) => {
                    let init_seq = rec.last_seq;
                    space_states.insert(
                        space_id.clone(),
                        SpaceBatchEntry::Loaded {
                            record: Box::new(rec),
                            persisted_initial_seq: init_seq,
                            effective_cut: init_seq,
                            max_purge_seq: None,
                            targets: crate::changes::CommittedTargetAcc::default(),
                            changes: crate::projection_fence::VisibilityChanges::default(),
                        },
                    );
                }
                Ok(None) => {
                    space_states.insert(space_id.clone(), SpaceBatchEntry::Missing);
                }
                Err(err) => {
                    transaction.rollback().await;
                    return BatchExecOutcome::AbortedBeforeCommit(err);
                }
            }
        }

        if use_savepoints && let Err(err) = tx.savepoint(idx).await {
            transaction.rollback().await;
            return BatchExecOutcome::AbortedBeforeCommit(err);
        }

        let has_idemp = intent.replay_safe();
        let mut active_effect = None;
        let item_res = execute_single_item_in_savepoint(
            tx,
            space_states.get(&space_id).expect("space entry populated"),
            intent,
            committed_at_ms,
            expires_at_ms,
            &mut active_effect,
        )
        .await;

        match item_res {
            Ok(SingleItemSuccess {
                response_bytes,
                new_effective_cut,
                item_purge_seq,
                committed_events,
                item_changes,
                dir_syncs,
                retained_tickets,
                retained_guards,
                after_commit: item_after_commit,
            }) => {
                if use_savepoints && let Err(err) = tx.release_savepoint(idx).await {
                    transaction.rollback().await;
                    return BatchExecOutcome::AbortedBeforeCommit(err);
                }
                if let Some(SpaceBatchEntry::Loaded {
                    effective_cut,
                    max_purge_seq,
                    targets,
                    changes,
                    ..
                }) = space_states.get_mut(&space_id)
                {
                    *effective_cut = new_effective_cut;
                    if let Some(pseq) = item_purge_seq {
                        *max_purge_seq = Some(max_purge_seq.map_or(pseq, |prev| prev.max(pseq)));
                    }
                    targets.record_events(&committed_events);
                    changes.merge(item_changes);
                }
                batch_dir_syncs.merge(&dir_syncs);
                batch_retained_tickets.extend(retained_tickets);
                batch_retained_guards.extend(retained_guards);
                if let Some(effect) = active_effect {
                    active_effects.push((slots.len(), effect));
                }
                first_mutating_slot
                    .entry(space_id.clone())
                    .or_insert(slots.len());
                after_commit.extend(item_after_commit);
                slots.push(ItemOutcomeSlot::Succeeded {
                    response_bytes,
                    has_idempotency: has_idemp,
                });
            }
            Err(item_err) => {
                if !use_savepoints {
                    let conn_clean = transaction.rollback().await;
                    drop(active_effects);
                    let mut space_effective_cuts = BTreeMap::new();
                    for (sid, entry) in &space_states {
                        if let SpaceBatchEntry::Loaded { effective_cut, .. } = entry {
                            space_effective_cuts.insert(sid.clone(), *effective_cut);
                        }
                    }
                    return BatchExecOutcome::Committed {
                        slots: vec![ItemOutcomeSlot::Failed(item_err)],
                        space_effective_cuts,
                        conn_clean,
                        visibility_windows: visibility_windows(store, &space_states),
                    };
                }
                // Rollback ONLY this item's savepoint; virtual `effective_cut` stays unchanged!
                if let Err(rb_err) = tx.rollback_to_savepoint(idx).await {
                    transaction.rollback().await;
                    return BatchExecOutcome::AbortedBeforeCommit(rb_err);
                }
                slots.push(ItemOutcomeSlot::Failed(item_err));
            }
        }
    }

    #[cfg(feature = "test-support")]
    if faults
        .rollback_commit_response_once
        .swap(false, Ordering::SeqCst)
    {
        transaction.rollback().await;
        return BatchExecOutcome::UnknownCommit {
            slots,
            diag_reason: "fault_injected_commit_rollback".to_owned(),
        };
    }
    // Optional test-only per-Space pre-commit delay (proves Space B progresses while Space A is slow,
    // and allows deterministic epoch takeover right before Space A's coalesced `spaces.last_seq` bump).
    for space_id in space_states.keys() {
        let delay_opt = {
            let map = faults.pre_commit_space_delays.lock().await;
            map.get(space_id).copied()
        };
        if let Some(delay) = delay_opt {
            tokio::time::sleep(delay).await;
        }
    }

    // Coalesced per-Space `spaces.last_seq` bump checking `history_incarnation`, `active_epoch`, and `last_seq`.
    for entry in space_states.values() {
        if let SpaceBatchEntry::Loaded {
            record,
            persisted_initial_seq,
            effective_cut,
            ..
        } = entry
            && *effective_cut > *persisted_initial_seq
        {
            let delta = effective_cut.get() - persisted_initial_seq.get();
            if let Err(bump_err) = bump_space_seq_exact_tx(
                tx,
                &record.scope,
                record.active_epoch,
                delta,
                *persisted_initial_seq,
            )
            .await
            {
                // Epoch fence or concurrent modification invalidated the Space batch: rollback ALL mutations!
                transaction.rollback().await;
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                return BatchExecOutcome::AbortedBeforeCommit(bump_err);
            }
        }
    }

    let collect_revoked =
        |effects: &[(usize, Box<dyn RevocationLease>)]| -> Vec<(usize, PortError)> {
            effects
                .iter()
                .filter_map(|(slot_idx, effect)| effect.check().err().map(|err| (*slot_idx, err)))
                .collect()
        };

    // Fail fast before publishing local CAS payloads into live `blobs/` if any
    // guarded slot was already revoked during SQL execution.
    let pre_publish_revoked = collect_revoked(&active_effects);
    let mut newly_published = Vec::new();
    if pre_publish_revoked.is_empty() {
        // Coalesced Wave A: flush blob data durability (`fdatasync` / `F_FULLFSYNC`) + atomic `rename`
        // for all batch-staged local CAS temp files BEFORE directory `fsync` and SQL `COMMIT`!
        match store
            .publish_deferred_local_tickets_async(&batch_retained_tickets, &mut newly_published)
            .await
        {
            Ok(extra_dirs) => {
                batch_dir_syncs.merge(&extra_dirs);
            }
            Err(pub_err) => {
                transaction.rollback().await;
                drop(active_effects);
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                store
                    .cleanup_unretained_local_files_async(newly_published)
                    .await;
                return BatchExecOutcome::AbortedBeforeCommit(pub_err);
            }
        }

        // Coalesced Wave B: local CAS directory fsync BEFORE SQL COMMIT!
        if let Err(sync_err) = store.flush_pending_local_dirs_async(&batch_dir_syncs).await {
            transaction.rollback().await;
            drop(active_effects);
            drop(batch_retained_tickets);
            drop(batch_retained_guards);
            store
                .cleanup_unretained_local_files_async(newly_published)
                .await;
            return BatchExecOutcome::AbortedBeforeCommit(sync_err);
        }
    }

    let revoked_effects = if pre_publish_revoked.is_empty() {
        collect_revoked(&active_effects)
    } else {
        pre_publish_revoked
    };
    if !revoked_effects.is_empty() {
        let conn_clean = transaction.rollback().await;
        drop(active_effects);
        drop(batch_retained_tickets);
        drop(batch_retained_guards);
        store
            .cleanup_unretained_local_files_async(newly_published)
            .await;
        if slots.len() == 1 {
            return BatchExecOutcome::AbortedBeforeCommit(
                revoked_effects.into_iter().next().unwrap().1,
            );
        }
        let mut revoked_by_slot: BTreeMap<usize, PortError> = revoked_effects.into_iter().collect();
        for (slot_idx, slot) in slots.iter_mut().enumerate() {
            if let Some(err) = revoked_by_slot.remove(&slot_idx) {
                *slot = ItemOutcomeSlot::Failed(err);
            } else if matches!(slot, ItemOutcomeSlot::Succeeded { .. })
                || first_mutating_slot
                    .get(&slot_spaces[slot_idx])
                    .is_some_and(|&first| first < slot_idx)
            {
                *slot = ItemOutcomeSlot::Failed(unavailable_retryable(
                    "batch_peer_revoked",
                    "peer write in batch was revoked before commit",
                    Duration::from_millis(10),
                ));
            }
        }
        let mut space_effective_cuts = BTreeMap::new();
        for (sid, entry) in &mut space_states {
            if let SpaceBatchEntry::Loaded {
                persisted_initial_seq,
                effective_cut,
                ..
            } = entry
            {
                *effective_cut = *persisted_initial_seq;
                space_effective_cuts.insert(sid.clone(), *effective_cut);
            }
        }
        return BatchExecOutcome::Committed {
            slots,
            space_effective_cuts,
            conn_clean,
            visibility_windows: visibility_windows(store, &space_states),
        };
    }
    // Commit outer SQL transaction bracketed by SQLite's seqlock commit
    // generation (even->odd before COMMIT, odd->even strictly after COMMIT and
    // BEFORE releasing fence guards or publishing broadcasts) so linearizable
    // generation caches never observe pre-commit authorization.
    let commit_seq = is_sqlite.then(|| {
        if wal_only {
            crate::runtime::SqliteCommitSeqGuard::begin_wal_only(&store.inner)
        } else {
            crate::runtime::SqliteCommitSeqGuard::begin(&store.inner)
        }
    });
    let commit_res = transaction.commit().await;
    if let Some(seq) = commit_seq {
        store.inner.latch_sqlite_aux_tables_populated();
        seq.finish();
    }
    drop(active_effects);
    match commit_res {
        Ok(()) => {
            for action in after_commit {
                action.settle(true);
            }
            if let Some(wal) = store.inner.wal_coord.get() {
                wal.note_writer_commit();
            }
            drop(batch_retained_tickets);
            drop(batch_retained_guards);
            let mut space_effective_cuts = BTreeMap::new();
            // Publish broadcast hints strictly AFTER confirmed SQL durability!
            for (sid, entry) in &space_states {
                if let SpaceBatchEntry::Loaded {
                    record,
                    persisted_initial_seq,
                    effective_cut,
                    max_purge_seq,
                    targets,
                    ..
                } = entry
                {
                    space_effective_cuts.insert(sid.clone(), *effective_cut);
                    if *effective_cut > *persisted_initial_seq {
                        if let Some(pseq) = max_purge_seq {
                            store.inner.broadcast_hub.publish(
                                crate::changes::BroadcastSignal::Purged {
                                    scope: record.scope.clone(),
                                    purged_through_seq: *pseq,
                                    current_safe_cut: *effective_cut,
                                },
                            );
                        }
                        store.inner.broadcast_hub.publish(
                            crate::changes::BroadcastSignal::Committed {
                                scope: record.scope.clone(),
                                new_last_seq: *effective_cut,
                                targets: targets.to_targets(),
                            },
                        );
                    }
                }
            }
            if faults
                .drop_commit_response_once
                .swap(false, Ordering::SeqCst)
            {
                return BatchExecOutcome::UnknownCommit {
                    slots,
                    diag_reason: "fault_injected_commit_response_loss".to_owned(),
                };
            }
            BatchExecOutcome::Committed {
                slots,
                space_effective_cuts,
                conn_clean: true,
                visibility_windows: visibility_windows(store, &space_states),
            }
        }
        Err(commit_err) => {
            for action in after_commit {
                action.settle(false);
            }
            drop(batch_retained_tickets);
            drop(batch_retained_guards);
            store
                .cleanup_unretained_local_files_async(newly_published)
                .await;
            BatchExecOutcome::UnknownCommit {
                slots,
                diag_reason: format!("{commit_err:?}"),
            }
        }
    }
}

struct SingleItemSuccess {
    response_bytes: Vec<u8>,
    new_effective_cut: SpaceSeq,
    item_purge_seq: Option<SpaceSeq>,
    committed_events: Vec<BatchEventDraft>,
    item_changes: crate::projection_fence::VisibilityChanges,
    dir_syncs: PendingDirSyncs,
    retained_tickets: Vec<StagedBlobTicket>,
    retained_guards: Vec<Box<dyn Send>>,
    after_commit: Option<CommitAction>,
}

async fn execute_single_item_in_savepoint(
    tx: &mut BackendConn<'_>,
    space_entry: &SpaceBatchEntry,
    intent: BatchWriteIntent,
    committed_at_ms: i64,
    expires_at_ms: i64,
    active_effect: &mut Option<Box<dyn RevocationLease>>,
) -> Result<SingleItemSuccess, PortError> {
    let (space_rec, current_effective_cut) = match space_entry {
        SpaceBatchEntry::Missing => return Err(DomainError::ResourceNotFound.into()),
        SpaceBatchEntry::Loaded {
            record,
            effective_cut,
            ..
        } => (record, *effective_cut),
    };

    // 1. HistoryIncarnation + LeaseEpoch authority check BEFORE receipt lookup and head CAS!
    let expected_active_epoch = intent.expected_epoch();
    let BatchWriteIntent {
        prepared: intent,
        room_wal,
        canonical_effect,
    } = intent;
    space_rec.scope.check(&intent.scope)?;
    if expected_active_epoch.is_some_and(|epoch| epoch != space_rec.active_epoch) {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    let effective_epoch = space_rec.active_epoch;

    if let Some(idemp) = &intent.idempotency {
        *active_effect = idemp.begin_canonical_effect().await?;
        if active_effect.is_none()
            && let Some(effect) = &canonical_effect
        {
            *active_effect = Some(effect.begin().await?);
        }
        idemp
            .authorize_confirmed_chat_step(tx, &intent.scope, true)
            .await?;
    } else if let Some(effect) = &canonical_effect {
        *active_effect = Some(effect.begin().await?);
    }

    // 2. Idempotent command receipt lookup (`command_receipts`) BEFORE purge fence and stale head CAS
    //    so idempotent retries of Purge / MintAndPurge replay their sanitized receipt rather than ResourceNotFound!
    if let Some(idemp) = &intent.idempotency
        && let Some(existing) = lookup_active_command_receipt_tx(tx, &intent.scope, idemp).await?
    {
        if existing.command_hash != intent.idempotency.as_ref().unwrap().command_hash {
            return Err(DomainError::IdempotencyKeyReused.into());
        }
        return match existing.status.as_str() {
            "completed" => Ok(SingleItemSuccess {
                response_bytes: existing.response_blob,
                // Replay consumes ZERO new sequence numbers!
                new_effective_cut: current_effective_cut,
                item_purge_seq: None,
                committed_events: Vec::new(),
                dir_syncs: PendingDirSyncs::default(),
                retained_tickets: Vec::new(),
                retained_guards: Vec::new(),
                after_commit: None,
                item_changes: crate::projection_fence::VisibilityChanges::default(),
            }),
            _ => Err(unavailable_retryable(
                "command_receipt_pending",
                "idempotent command is currently pending crash recovery",
                Duration::from_millis(25),
            )),
        };
    }

    // 3. Purge fence check on all declared source note identities.
    if are_any_notes_purge_fenced_tx(tx, &intent.scope.space_id, &intent.source_note_ids).await? {
        return Err(DomainError::ResourceNotFound.into());
    }

    // 4. Intra-batch semantic snapshot cut check against `current_effective_cut` (NOT stale pre-batch `last_seq`!).
    if let Some((expected_cut, mismatch_kind)) = intent.required_semantic_cut
        && expected_cut != current_effective_cut
    {
        return match mismatch_kind {
            SemanticCutMismatchKind::CursorStale => {
                Err(DomainError::validation(ValidationReason::CursorStale).into())
            }
            SemanticCutMismatchKind::CurrentHeadConflict => {
                Err(DomainError::validation(ValidationReason::CursorStale).into())
            }
        };
    }

    // 5. Execute item domain mutation inside savepoint!
    let mut item_ctx = ItemExecCtx {
        scope: intent.scope.clone(),
        space: space_rec.space.clone(),
        active_epoch: effective_epoch,
        root_folder_id: space_rec.root_folder_id.clone(),
        effective_cut_before: current_effective_cut,
        current_seq: current_effective_cut,
        allocated_count: 0,
        receipt_status: "completed",
        pending_dir_syncs: PendingDirSyncs::default(),
        retained_tickets: Vec::new(),
        retained_guards: Vec::new(),
        after_commit: None,
    };

    let artifacts = (intent.execute)(tx, &mut item_ctx).await?;

    if room_wal.is_some() {
        if item_ctx.allocated_count != 0
            || !artifacts.events.is_empty()
            || artifacts.change_payload.is_some()
            || intent.idempotency.is_some()
        {
            return Err(internal_not_committed(
                "writer_unsequenced_item_effects",
                "room WAL item cannot allocate sequence numbers or publish change events",
            ));
        }
        return Ok(SingleItemSuccess {
            response_bytes: artifacts.response_bytes,
            new_effective_cut: current_effective_cut,
            item_purge_seq: None,
            committed_events: Vec::new(),
            item_changes: Default::default(),
            dir_syncs: item_ctx.pending_dir_syncs,
            retained_tickets: item_ctx.retained_tickets,
            retained_guards: item_ctx.retained_guards,
            after_commit: item_ctx.after_commit,
        });
    }

    if item_ctx.allocated_count == 0 || artifacts.events.is_empty() {
        return Err(internal_not_committed(
            "writer_item_zero_events",
            "successful mutation item must allocate >= 1 SpaceSeq and emit >= 1 event",
        ));
    }

    let first_seq = SpaceSeq::new(current_effective_cut.get() + 1)?;
    let last_seq = item_ctx.current_seq;

    // Verify event sequences cover `[first_seq..=last_seq]` in strictly ascending contiguous order.
    if artifacts.events.len() as u64 != item_ctx.allocated_count {
        return Err(internal_not_committed(
            "writer_event_count_mismatch",
            format!(
                "allocated {} SpaceSeq values but emitted {} events",
                item_ctx.allocated_count,
                artifacts.events.len()
            ),
        ));
    }
    for (offset, ev) in artifacts.events.iter().enumerate() {
        let expected_s = current_effective_cut.get() + 1 + (offset as u64);
        if ev.space_seq.get() != expected_s {
            return Err(internal_not_committed(
                "writer_event_seq_noncontiguous",
                format!(
                    "expected event seq {expected_s}, got {}",
                    ev.space_seq.get()
                ),
            ));
        }
    }

    // 6. Persist `change_payloads` (if any), `change_commands`, `change_log`, and `command_receipts`.
    let payload_id_opt = artifacts
        .change_payload
        .as_ref()
        .map(|p| p.payload_id.as_str());

    persist_payloads_command_events_and_receipt_tx(
        tx,
        &intent.scope,
        artifacts.change_payload.as_ref(),
        &artifacts.command_id,
        &artifacts.command_kind,
        first_seq,
        last_seq,
        payload_id_opt,
        &artifacts.events,
        committed_at_ms,
        intent.idempotency.as_ref(),
        item_ctx.receipt_status,
        artifacts.receipt_detail_blob.as_deref(),
        &artifacts.receipt_sanitized_blob,
        &artifacts.receipt_owner_note_ids,
        expires_at_ms,
    )
    .await?;

    let item_purge_seq = artifacts
        .events
        .iter()
        .filter(|ev| ev.op_kind == "purge")
        .map(|ev| ev.space_seq)
        .max();
    let item_changes = crate::projection_fence::VisibilityChanges::from_events(&artifacts.events);

    Ok(SingleItemSuccess {
        response_bytes: artifacts.response_bytes,
        new_effective_cut: last_seq,
        item_purge_seq,
        committed_events: artifacts.events,
        item_changes,
        dir_syncs: item_ctx.pending_dir_syncs,
        retained_tickets: item_ctx.retained_tickets,
        retained_guards: item_ctx.retained_guards,
        after_commit: item_ctx.after_commit,
    })
}

async fn lock_and_load_space_outer_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<Option<SpaceRecord>, PortError> {
    load_space_record_for_update_opt(tx, space_id).await
}

pub(crate) struct StoredReceiptRow {
    pub command_hash: ContentDigest,
    pub status: String,
    pub response_blob: Vec<u8>,
}

type RawReceiptRow = (Vec<u8>, String, Option<String>, Vec<u8>, i64);

pub(crate) async fn lookup_command_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<Option<StoredReceiptRow>, PortError> {
    let active = idemp.begin_canonical_effect().await?;
    let receipt = lookup_active_command_receipt_tx(tx, scope, idemp).await?;
    if let Some(active) = active {
        active.check()?;
    }
    Ok(receipt)
}

async fn lookup_active_command_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<Option<StoredReceiptRow>, PortError> {
    let raw: Option<RawReceiptRow> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT command_hash, status, response_payload_id, sanitized_envelope_msgpack, canonical_seq
                 FROM command_receipts
                 WHERE space_id = ? AND history_incarnation = ? AND actor_id = ? AND idempotency_key = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_lookup_receipt", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("command_hash"),
                    r.get("status"),
                    r.get("response_payload_id"),
                    r.get("sanitized_envelope_msgpack"),
                    r.get("canonical_seq"),
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT command_hash, status, response_payload_id, sanitized_envelope_msgpack, canonical_seq
                 FROM command_receipts
                 WHERE space_id = $1 AND history_incarnation = $2 AND actor_id = $3 AND idempotency_key = $4",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_lookup_receipt", err))?;
            row.map(|r| {
                (
                    r.get("command_hash"),
                    r.get("status"),
                    r.get("response_payload_id"),
                    r.get("sanitized_envelope_msgpack"),
                    r.get("canonical_seq"),
                )
            })
        }
    };

    let Some((hash_bytes, status, resp_payload_id, sanitized_blob, canonical_seq)) = raw else {
        return Ok(None);
    };
    idemp.authorize_replay(tx, scope).await?;
    let arr: [u8; 32] = hash_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_receipt_hash", "command_hash != 32B"))?;

    let hash = if idemp
        .matches_receipt_hash(tx, scope, canonical_seq, &arr)
        .await?
    {
        idemp.command_hash
    } else {
        ContentDigest::from_bytes(arr)
    };
    let require_detail = idemp.require_receipt_detail && idemp.command_hash == hash;
    let effective_blob = if let Some(pid) = resp_payload_id {
        let detail_opt: Option<(i32, Option<Vec<u8>>)> = match tx {
            BackendConn::Sqlite(conn) => {
                let r = sqlx::query(
                    "SELECT erased_by_purge, effect_msgpack FROM change_payloads
                     WHERE space_id = ? AND payload_id = ?",
                )
                .bind(scope.space_id.as_str())
                .bind(&pid)
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_lookup_rcpt_pay", err.to_string()))?;
                r.map(|row| {
                    (
                        row.get::<i64, _>("erased_by_purge") as i32,
                        row.get("effect_msgpack"),
                    )
                })
            }
            BackendConn::Postgres(conn) => {
                let r = sqlx::query(
                    "SELECT erased_by_purge, effect_msgpack FROM change_payloads
                     WHERE space_id = $1 AND payload_id = $2",
                )
                .bind(scope.space_id.as_str())
                .bind(&pid)
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_lookup_rcpt_pay", err))?;
                r.map(|row| (row.get("erased_by_purge"), row.get("effect_msgpack")))
            }
        };
        match detail_opt {
            Some((0, Some(detail))) => detail,
            _ if require_detail => return Err(DomainError::ResourceNotFound.into()),
            _ => sanitized_blob,
        }
    } else if require_detail {
        return Err(DomainError::ResourceNotFound.into());
    } else {
        sanitized_blob
    };

    let receipt = StoredReceiptRow {
        command_hash: if idemp.matches_legacy_detail(&arr, &effective_blob) {
            hash
        } else {
            ContentDigest::from_bytes(arr)
        },
        status,
        response_blob: effective_blob,
    };
    idemp
        .authorize_rollback_disclosures(tx, scope, &receipt)
        .await?;
    Ok(Some(receipt))
}

#[allow(clippy::too_many_arguments)]
async fn persist_payloads_command_events_and_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cp_opt: Option<&ChangePayloadDraft>,
    command_id: &str,
    command_kind: &str,
    first_seq: SpaceSeq,
    last_seq: SpaceSeq,
    payload_id_opt: Option<&str>,
    events: &[BatchEventDraft],
    committed_at_ms: i64,
    idemp_opt: Option<&CommandIdentitySpec>,
    receipt_status: &str,
    receipt_detail_blob: Option<&[u8]>,
    receipt_sanitized_blob: &[u8],
    receipt_owner_note_ids: &[NoteId],
    expires_at_ms: i64,
) -> Result<(), PortError> {
    let seq_i64 = last_seq.get() as i64;
    let rcpt_meta = idemp_opt.map(|idemp| {
        let owner_key = format!("{}:{}", idemp.actor.as_str(), idemp.command_key.as_str());
        let resp_pid = receipt_detail_blob.map(|_| format!("rcpt_pay:{owner_key}"));
        (idemp, owner_key, resp_pid)
    });

    let mut payloads: Vec<(&str, &str, &[u8])> = Vec::with_capacity(2);
    if let Some(cp) = cp_opt {
        payloads.push((&cp.payload_id, &cp.codec, &cp.effect_msgpack));
    }
    if let (Some((_, _, Some(rpid))), Some(detail)) = (&rcpt_meta, receipt_detail_blob) {
        payloads.push((rpid.as_str(), "receipt_detail_v1", detail));
    }

    let mut all_owners: Vec<(&str, &str, &str)> = Vec::new();
    if let Some(cp) = cp_opt {
        for nid in &cp.owner_note_ids {
            all_owners.push(("change_payload", cp.payload_id.as_str(), nid.as_str()));
        }
    }
    if let Some((_, ref owner_key, Some(_))) = rcpt_meta {
        for nid in receipt_owner_note_ids {
            all_owners.push(("command_receipt", owner_key.as_str(), nid.as_str()));
        }
    }
    all_owners.sort_unstable_by_key(|&(pkind, pid, nid)| (nid, pkind, pid));
    all_owners.dedup();

    // On PostgreSQL, none of `change_payloads`, `change_commands`, `change_log`,
    // `command_receipts`, or `payload_owners` have cross-table foreign keys (each only
    // references `spaces(space_id)`). Persist all 5 tables in 1 single Data-Modifying CTE!
    if let BackendConn::Postgres(conn) = tx {
        let first_i64 = first_seq.get() as i64;
        let pay_pids: Vec<&str> = payloads.iter().map(|(pid, _, _)| *pid).collect();
        let pay_codecs: Vec<&str> = payloads.iter().map(|(_, c, _)| *c).collect();
        let pay_blobs: Vec<&[u8]> = payloads.iter().map(|(_, _, b)| *b).collect();

        let mut ev_seqs: Vec<i64> = Vec::with_capacity(events.len());
        let mut ev_etypes: Vec<&str> = Vec::with_capacity(events.len());
        let mut ev_eids: Vec<&str> = Vec::with_capacity(events.len());
        let mut ev_op_kinds: Vec<&str> = Vec::with_capacity(events.len());
        let mut ev_rev_ids: Vec<&str> = Vec::with_capacity(events.len());
        let mut ev_lcs: Vec<&str> = Vec::with_capacity(events.len());
        let mut ev_dclasses: Vec<Option<&str>> = Vec::with_capacity(events.len());
        for ev in events {
            ev_seqs.push(ev.space_seq.get() as i64);
            ev_etypes.push(&ev.entity_type);
            ev_eids.push(&ev.entity_id);
            ev_op_kinds.push(&ev.op_kind);
            ev_rev_ids.push(ev.rev_id.as_str());
            ev_lcs.push(lifecycle_to_db(ev.lifecycle));
            ev_dclasses.push(ev.doc_class.map(doc_class_to_db));
        }

        let zero_hash = [0u8; 32];
        let (has_rcpt, rcpt_actor, rcpt_key, rcpt_hash, rcpt_resp_pid) = match &rcpt_meta {
            Some((idemp, _, resp_pid)) => (
                true,
                idemp.actor.as_str(),
                idemp.command_key.as_str(),
                idemp.command_hash.as_bytes().as_slice(),
                resp_pid.as_deref(),
            ),
            None => (false, "", "", zero_hash.as_slice(), None),
        };

        let own_pkinds: Vec<&str> = all_owners.iter().map(|(k, _, _)| *k).collect();
        let own_pids: Vec<&str> = all_owners.iter().map(|(_, p, _)| *p).collect();
        let own_nids: Vec<&str> = all_owners.iter().map(|(_, _, n)| *n).collect();

        sqlx::query(
            "WITH ins_pay AS (
                INSERT INTO change_payloads (
                    space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq
                )
                SELECT $1, u.pid, u.codec, 0, u.blob, $5
                FROM UNNEST($7::TEXT[], $8::TEXT[], $9::BYTEA[]) AS u(pid, codec, blob)
            ),
            ins_cmd AS (
                INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                )
                VALUES ($1, $2, $3, $4, $5, $10, $11, $6)
            ),
            ins_log AS (
                INSERT INTO change_log (
                    space_id, space_seq, history_incarnation, command_id,
                    command_first_seq, command_last_seq, entity_type, entity_id,
                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                )
                SELECT
                    $1, u.seq, $2, $3,
                    $4, $5, u.etype, u.eid,
                    u.op_kind, u.rev_id, u.lc, u.dclass, $11, $6
                FROM UNNEST(
                    $12::BIGINT[], $13::TEXT[], $14::TEXT[], $15::TEXT[],
                    $16::TEXT[], $17::TEXT[], $18::TEXT[]
                ) AS u(seq, etype, eid, op_kind, rev_id, lc, dclass)
            ),
            ins_rcpt AS (
                INSERT INTO command_receipts (
                    space_id, history_incarnation, actor_id, idempotency_key, command_hash,
                    status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
                    canonical_seq, expires_at_ms
                )
                SELECT $1, $2, $20, $21, $22, $23, 1, $24, $25, $5, $26
                WHERE $19::BOOLEAN
            )
            INSERT INTO payload_owners (space_id, payload_kind, payload_id, note_id)
            SELECT $1, u.pkind, u.pid, u.nid
            FROM UNNEST($27::TEXT[], $28::TEXT[], $29::TEXT[]) AS u(pkind, pid, nid)",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(command_id)
        .bind(first_i64)
        .bind(seq_i64)
        .bind(committed_at_ms)
        .bind(pay_pids)
        .bind(pay_codecs)
        .bind(pay_blobs)
        .bind(command_kind)
        .bind(payload_id_opt)
        .bind(ev_seqs)
        .bind(ev_etypes)
        .bind(ev_eids)
        .bind(ev_op_kinds)
        .bind(ev_rev_ids)
        .bind(ev_lcs)
        .bind(ev_dclasses)
        .bind(has_rcpt)
        .bind(rcpt_actor)
        .bind(rcpt_key)
        .bind(rcpt_hash)
        .bind(receipt_status)
        .bind(rcpt_resp_pid)
        .bind(receipt_sanitized_blob)
        .bind(expires_at_ms)
        .bind(own_pkinds)
        .bind(own_pids)
        .bind(own_nids)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_persist_cmd_cte", err.to_string()))?;

        return Ok(());
    }

    if !payloads.is_empty()
        && let BackendConn::Sqlite(conn) = tx
    {
        let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
            "INSERT INTO change_payloads (space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq) ",
        );
        qb.push_values(&payloads, |mut b, (pid, codec, blob)| {
            b.push_bind(scope.space_id.as_str())
                .push_bind(*pid)
                .push_bind(*codec)
                .push_bind(0_i64)
                .push_bind(*blob)
                .push_bind(seq_i64);
        });
        qb.build().execute(&mut **conn).await.map_err(|err| {
            internal_not_committed("sqlite_insert_change_payloads", err.to_string())
        })?;
    }

    // 2. Insert `change_commands` + `change_log`.
    insert_change_command_and_events_tx(
        tx,
        scope,
        command_id,
        command_kind,
        first_seq,
        last_seq,
        payload_id_opt,
        events,
        committed_at_ms,
    )
    .await?;

    // 3. Insert `command_receipts` (if idempotent).
    if let (Some((idemp, _, resp_payload_id)), BackendConn::Sqlite(conn)) = (&rcpt_meta, &mut *tx) {
        sqlx::query(
            "INSERT INTO command_receipts (
                space_id, history_incarnation, actor_id, idempotency_key, command_hash,
                status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
                canonical_seq, expires_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
        )
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(idemp.actor.as_str())
        .bind(idemp.command_key.as_str())
        .bind(idemp.command_hash.as_bytes().as_slice())
        .bind(receipt_status)
        .bind(resp_payload_id)
        .bind(receipt_sanitized_blob)
        .bind(seq_i64)
        .bind(expires_at_ms)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_insert_receipt", err.to_string()))?;
    }

    // 4. Coalesce ALL `payload_owners` rows (`change_payload` + `rcpt_pay` + `command_receipt`) into 1 batch!
    if !all_owners.is_empty()
        && let BackendConn::Sqlite(conn) = tx
    {
        for chunk in all_owners.chunks(200) {
            let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "INSERT OR IGNORE INTO payload_owners (space_id, payload_kind, payload_id, note_id) ",
            );
            qb.push_values(chunk, |mut b, (pkind, pid, nid)| {
                b.push_bind(scope.space_id.as_str())
                    .push_bind(*pkind)
                    .push_bind(*pid)
                    .push_bind(*nid);
            });
            qb.build().execute(&mut **conn).await.map_err(|err| {
                internal_not_committed("sqlite_batch_insert_owners", err.to_string())
            })?;
        }
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_change_command_and_events_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    command_id: &str,
    command_kind: &str,
    first_seq: SpaceSeq,
    last_seq: SpaceSeq,
    payload_id: Option<&str>,
    events: &[BatchEventDraft],
    committed_at_ms: i64,
) -> Result<(), PortError> {
    let first_i64 = first_seq.get() as i64;
    let last_i64 = last_seq.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(first_i64)
            .bind(last_i64)
            .bind(command_kind)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_batch_insert_cmd", err.to_string()))?;

            for chunk in events.chunks(60) {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "INSERT INTO change_log (
                        space_id, space_seq, history_incarnation, command_id,
                        command_first_seq, command_last_seq, entity_type, entity_id,
                        op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                    ) ",
                );
                qb.push_values(chunk, |mut b, ev| {
                    b.push_bind(scope.space_id.as_str())
                        .push_bind(ev.space_seq.get() as i64)
                        .push_bind(scope.incarnation.as_bytes().as_slice())
                        .push_bind(command_id)
                        .push_bind(first_i64)
                        .push_bind(last_i64)
                        .push_bind(&ev.entity_type)
                        .push_bind(&ev.entity_id)
                        .push_bind(&ev.op_kind)
                        .push_bind(ev.rev_id.as_str())
                        .push_bind(lifecycle_to_db(ev.lifecycle))
                        .push_bind(ev.doc_class.map(doc_class_to_db))
                        .push_bind(payload_id)
                        .push_bind(committed_at_ms);
                });
                qb.build().execute(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_batch_insert_ev", err.to_string())
                })?;
            }
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(first_i64)
            .bind(last_i64)
            .bind(command_kind)
            .bind(payload_id)
            .bind(committed_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_batch_insert_cmd", err.to_string()))?;

            let mut seqs: Vec<i64> = Vec::with_capacity(events.len());
            let mut etypes: Vec<&str> = Vec::with_capacity(events.len());
            let mut eids: Vec<&str> = Vec::with_capacity(events.len());
            let mut op_kinds: Vec<&str> = Vec::with_capacity(events.len());
            let mut rev_ids: Vec<&str> = Vec::with_capacity(events.len());
            let mut lcs: Vec<&str> = Vec::with_capacity(events.len());
            let mut dclasses: Vec<Option<&str>> = Vec::with_capacity(events.len());

            for ev in events {
                seqs.push(ev.space_seq.get() as i64);
                etypes.push(&ev.entity_type);
                eids.push(&ev.entity_id);
                op_kinds.push(&ev.op_kind);
                rev_ids.push(ev.rev_id.as_str());
                lcs.push(lifecycle_to_db(ev.lifecycle));
                dclasses.push(ev.doc_class.map(doc_class_to_db));
            }

            sqlx::query(
                "INSERT INTO change_log (
                    space_id, space_seq, history_incarnation, command_id,
                    command_first_seq, command_last_seq, entity_type, entity_id,
                    op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                )
                SELECT
                    $1, u.seq, $2, $3,
                    $4, $5, u.etype, u.eid,
                    u.op_kind, u.rev_id, u.lc, u.dclass, $6, $7
                FROM UNNEST(
                    $8::BIGINT[], $9::TEXT[], $10::TEXT[], $11::TEXT[],
                    $12::TEXT[], $13::TEXT[], $14::TEXT[]
                ) AS u(seq, etype, eid, op_kind, rev_id, lc, dclass)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(command_id)
            .bind(first_i64)
            .bind(last_i64)
            .bind(payload_id)
            .bind(committed_at_ms)
            .bind(seqs)
            .bind(etypes)
            .bind(eids)
            .bind(op_kinds)
            .bind(rev_ids)
            .bind(lcs)
            .bind(dclasses)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_batch_insert_ev", err.to_string()))?;
        }
    }
    Ok(())
}

async fn bump_space_seq_exact_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    delta: u64,
    expected_before: SpaceSeq,
) -> Result<SpaceSeq, PortError> {
    if delta == 0 {
        return Ok(expected_before);
    }
    let next_u64 = expected_before
        .get()
        .checked_add(delta)
        .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
    let new_last = SpaceSeq::new(next_u64)?;
    let delta_i64 = i64::try_from(delta)
        .map_err(|_| DomainError::validation(ValidationReason::SequenceOverflow))?;
    let epoch_i64 = active_epoch.get() as i64;
    let before_i64 = expected_before.get() as i64;
    let max_allowed_before = (SpaceSeq::MAX.get() - delta) as i64;

    let affected = match tx {
        BackendConn::Sqlite(conn) => sqlx::query(
            "UPDATE spaces
             SET last_seq = last_seq + ?
             WHERE space_id = ? AND history_incarnation = ? AND active_epoch = ?
               AND last_seq = ? AND last_seq <= ?",
        )
        .bind(delta_i64)
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(epoch_i64)
        .bind(before_i64)
        .bind(max_allowed_before)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_batch_bump_seq", err.to_string()))?
        .rows_affected(),
        BackendConn::Postgres(conn) => sqlx::query(
            "UPDATE spaces
             SET last_seq = last_seq + $1
             WHERE space_id = $2 AND history_incarnation = $3 AND active_epoch = $4
               AND last_seq = $5 AND last_seq <= $6",
        )
        .bind(delta_i64)
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(epoch_i64)
        .bind(before_i64)
        .bind(max_allowed_before)
        .execute(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_batch_bump_seq", err.to_string()))?
        .rows_affected(),
    };

    if affected != 1 {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(new_last)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CanonicalConfig, CanonicalRuntime, CanonicalStore};
    use notarium_core::{
        epoch::DataRoot,
        ids::{HistoryIncarnation, InstallationId, RequestId},
        ports::Cancellation,
    };

    #[tokio::test]
    async fn abandoned_admission_and_auxiliary_transactions_release_their_resources() {
        let root =
            std::env::temp_dir().join(crate::codec::new_prefixed_hex_id("writer-test-").unwrap());
        std::fs::create_dir_all(&root).unwrap();
        let mut config = CanonicalConfig::local_default(
            InstallationId::from_bytes([1; 16]),
            DataRoot::new(&root),
        );
        config.writer.mailbox_capacity = 1;
        config.writer.max_staged_bytes = 1024;
        let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
        let writer = store.inner.writer().unwrap();
        let scope = HistoryScope {
            space_id: SpaceId::from_bytes([2; 16]),
            incarnation: HistoryIncarnation::from_bytes([3; 16]),
        };
        let budget = CallBudget {
            request: RequestId::from_bytes([4; 16]),
            remaining: Duration::from_secs(5),
            cancellation: Cancellation::default(),
        };
        let occupied = writer
            .sender_for_space(&store.inner, &scope.space_id)
            .unwrap()
            .reserve_owned()
            .await
            .unwrap();
        let intent = || PreparedWriteIntent {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::ZERO,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 1024,
            required_semantic_cut: None,
            execute: Box::new(|_, _| Box::pin(async { panic!("unadmitted item executed") })),
        };
        {
            let mut single = Box::pin(writer.submit_raw(&store.inner, &budget, intent()));
            assert!(futures_util::poll!(&mut single).is_pending());
            assert_eq!(writer.byte_limiter.in_flight.load(Ordering::Acquire), 1024);
        }
        assert_eq!(writer.byte_limiter.in_flight.load(Ordering::Acquire), 0);
        {
            let mut group = Box::pin(writer.submit_batch_raw(
                &store.inner,
                &budget,
                &scope.space_id,
                vec![intent()],
            ));
            assert!(futures_util::poll!(&mut group).is_pending());
            assert_eq!(writer.byte_limiter.in_flight.load(Ordering::Acquire), 1024);
        }
        assert_eq!(writer.byte_limiter.in_flight.load(Ordering::Acquire), 0);
        drop(occupied);

        async fn setup(store: &CanonicalStore) -> Result<(), PortError> {
            store.with_write_tx(|tx| Box::pin(async move {
                let BackendConn::Sqlite(conn) = tx else { unreachable!() };
                sqlx::raw_sql("CREATE TEMP TABLE parent (id INTEGER PRIMARY KEY);
                    CREATE TEMP TABLE child (id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)")
                    .execute(&mut **conn).await.unwrap();
                Ok(())
            })).await
        }
        setup(&store).await.unwrap();
        let (sent, ack) = oneshot::channel();
        let partial = store.with_write_tx(|tx| {
            Box::pin(async move {
                let BackendConn::Sqlite(conn) = tx else {
                    unreachable!()
                };
                sqlx::query("INSERT INTO parent VALUES (1)")
                    .execute(&mut **conn)
                    .await
                    .unwrap();
                sent.send(()).unwrap();
                std::future::pending::<Result<(), PortError>>().await
            })
        });
        {
            tokio::pin!(partial);
            tokio::select! { _ = ack => {}, _ = &mut partial => panic!("partial write completed") }
        }
        let failed = store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    let BackendConn::Sqlite(conn) = tx else {
                        unreachable!()
                    };
                    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM parent")
                        .fetch_one(&mut **conn)
                        .await
                        .unwrap();
                    assert_eq!(
                        count, 0,
                        "cancelled operation must roll back before the next writer"
                    );
                    sqlx::query("INSERT INTO child VALUES (7)")
                        .execute(&mut **conn)
                        .await
                        .unwrap();
                    Ok(())
                })
            })
            .await;
        assert!(failed.is_err(), "deferred foreign key must fail at commit");
        store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    let BackendConn::Sqlite(conn) = tx else {
                        unreachable!()
                    };
                    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM child")
                        .fetch_one(&mut **conn)
                        .await
                        .unwrap();
                    assert_eq!(count, 0);
                    Ok(())
                })
            })
            .await
            .unwrap();
        drop(store);
        runtime.shutdown().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn coalesced_batch_peer_revocation_rewrites_later_same_space_dirty_failures() {
        use notarium_core::{
            auth::{
                AuthenticatedCredential, EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman,
            },
            ids::{AuthSessionId, GrantId, PrincipalId},
            model::PathTarget,
            ports::{
                AccountContext, CallBudget, Cancellation, CanonicalEffectRegistration, PortFuture,
                RevocationLease, SpaceContext,
            },
        };
        use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

        struct ToggleLease(Arc<AtomicBool>);
        impl RevocationLease for ToggleLease {
            fn check(&self) -> Result<(), PortError> {
                if self.0.load(AtomicOrdering::SeqCst) {
                    Err(DomainError::AccessDenied.into())
                } else {
                    Ok(())
                }
            }
        }
        struct ToggleReg(Arc<AtomicBool>);
        impl CanonicalEffectRegistration for ToggleReg {
            fn check(&self) -> Result<(), PortError> {
                if self.0.load(AtomicOrdering::SeqCst) {
                    Err(DomainError::AccessDenied.into())
                } else {
                    Ok(())
                }
            }
            fn restrict_until(&self, _deadline: std::time::Instant) -> Result<(), PortError> {
                self.check()
            }
            fn begin(self: Arc<Self>) -> PortFuture<'static, Box<dyn RevocationLease>> {
                let flag = Arc::clone(&self.0);
                Box::pin(async move { Ok(Box::new(ToggleLease(flag)) as Box<dyn RevocationLease>) })
            }
        }

        let mut id = [0u8; 16];
        getrandom::fill(&mut id).unwrap();
        let root =
            std::env::temp_dir().join(format!("notarium-writer-peer-revoke-{}", hex::encode(id)));
        let cfg =
            CanonicalConfig::local_default(InstallationId::from_bytes(id), DataRoot::new(&root));
        let (store, runtime) = CanonicalRuntime::open(cfg).await.unwrap();
        let space_id = SpaceId::from_bytes([0xE1; 16]);
        let owner = PrincipalId::from_bytes([0xE2; 16]);
        let epoch = LeaseEpoch::new(1).unwrap();
        let rec = store
            .create_space(crate::CreateSpaceSpec {
                space_id: space_id.clone(),
                incarnation: HistoryIncarnation::from_bytes([0xE3; 16]),
                root_folder_id: FolderId::from_bytes([0xE4; 16]),
                slug: "peer-revoke".into(),
                kind: notarium_core::auth::SpaceKind::Shared,
                owner: owner.clone(),
                active_epoch: epoch,
                initial_last_seq: SpaceSeq::ZERO,
                created_at: None,
            })
            .await
            .unwrap();
        store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    let BackendConn::Sqlite(conn) = tx else {
                        unreachable!()
                    };
                    sqlx::query("CREATE TABLE batch_probe (v INTEGER NOT NULL)")
                        .execute(&mut **conn)
                        .await
                        .unwrap();
                    Ok(())
                })
            })
            .await
            .unwrap();

        let revoked = Arc::new(AtomicBool::new(false));
        let auth = EngineAuthContext::for_human(
            VerifiedHuman::attest(
                owner,
                GrantId::from_bytes([0xE5; 16]),
                BTreeMap::from([(
                    space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                )]),
                false,
            )
            .with_credential(AuthenticatedCredential::Session(
                AuthSessionId::from_bytes([0xE9; 16]),
            )),
        );
        let budget = CallBudget {
            request: RequestId::from_bytes([0xE6; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(5),
        };
        let account = AccountContext::new(auth.clone(), budget.clone());
        let fenced = SpaceContext::new(auth, rec.scope.clone(), budget)
            .unwrap()
            .with_canonical_effect(&account, Arc::new(ToggleReg(Arc::clone(&revoked))))
            .unwrap();
        let effect = fenced.canonical_effect().cloned();

        let phantom_rev = RevisionId::from_bytes([0xE7; 16]);
        let slot0 = BatchWriteIntent::from(PreparedWriteIntent {
            scope: rec.scope.clone(),
            active_epoch: epoch,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(|_tx, _ctx| {
                Box::pin(async move {
                    Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: SpaceId::from_bytes([0xE1; 16]),
                            parent: None,
                            component: "already-taken".into(),
                        },
                    }
                    .into())
                })
            }),
        });
        let staged_payload =
            crate::blobs::PreparedBlobSource::prepare(b"revoked-blob-payload", store.blob_codec())
                .unwrap();
        let staged_digest = staged_payload.digest;
        let staged_ticket = store
            .stage_blob_for_batch(&rec.scope, epoch, &staged_payload)
            .await
            .unwrap();
        let slot1 = BatchWriteIntent {
            prepared: PreparedWriteIntent {
                scope: rec.scope.clone(),
                active_epoch: epoch,
                idempotency: None,
                source_note_ids: Vec::new(),
                staged_bytes: staged_payload.raw_size,
                required_semantic_cut: None,
                execute: Box::new(move |tx, item_ctx| {
                    Box::pin(async move {
                        let BackendConn::Sqlite(conn) = tx else {
                            unreachable!()
                        };
                        sqlx::query("INSERT INTO batch_probe(v) VALUES (42)")
                            .execute(&mut **conn)
                            .await
                            .unwrap();
                        item_ctx.record_staged_ticket(staged_ticket);
                        let seq = item_ctx.alloc_next_seq()?;
                        Ok(ItemCommitArtifacts {
                            command_id: "cmd_peer_revoke".into(),
                            command_kind: "test_peer_revoke".into(),
                            events: vec![BatchEventDraft {
                                space_seq: seq,
                                entity_type: "note".into(),
                                entity_id: NoteId::from_bytes([0xE8; 16]).to_string(),
                                op_kind: "edit".into(),
                                rev_id: RevisionId::from_bytes([0xE8; 16]),
                                lifecycle: Lifecycle::Active,
                                doc_class: Some(DocClass::UserDoc),
                            }],
                            change_payload: None,
                            receipt_detail_blob: None,
                            receipt_sanitized_blob: Vec::new(),
                            receipt_owner_note_ids: Vec::new(),
                            response_bytes: vec![1],
                        })
                    })
                }),
            },
            room_wal: None,
            canonical_effect: effect,
        };
        let revoked_flip = Arc::clone(&revoked);
        let slot2 = BatchWriteIntent::from(PreparedWriteIntent {
            scope: rec.scope.clone(),
            active_epoch: epoch,
            idempotency: None,
            source_note_ids: Vec::new(),
            staged_bytes: 0,
            required_semantic_cut: None,
            execute: Box::new(move |tx, _ctx| {
                Box::pin(async move {
                    let BackendConn::Sqlite(conn) = tx else {
                        unreachable!()
                    };
                    let seen: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM batch_probe")
                        .fetch_one(&mut **conn)
                        .await
                        .unwrap();
                    assert_eq!(seen, 1, "slot 2 observes slot 1's uncommitted write");
                    revoked_flip.store(true, AtomicOrdering::SeqCst);
                    Err(DomainError::RevisionConflict {
                        current: phantom_rev,
                        lineage: None,
                    }
                    .into())
                })
            }),
        });

        let outcome = {
            let mut guard = match &store.inner.sql {
                SqlDriverState::Sqlite { writer, .. } => writer.lock().await,
                SqlDriverState::Postgres { .. } => unreachable!(),
            };
            let pair = guard.as_mut().expect("open sqlite writer");
            let mut backend = BackendConn::Sqlite(&mut pair.sqlx_conn);
            execute_batch_on_conn(
                &store,
                &mut backend,
                vec![slot0, slot1, slot2],
                &[],
                WriterConfig::default(),
                &WriterFaultState::default(),
            )
            .await
        };

        let BatchExecOutcome::Committed { slots, .. } = outcome else {
            panic!("expected Committed outcome carrying per-slot peer revocation errors");
        };
        assert_eq!(slots.len(), 3);
        assert!(
            matches!(
                &slots[0],
                ItemOutcomeSlot::Failed(PortError::Domain(DomainError::PathConflict { .. }))
            ),
            "slot 0 failed before any uncommitted mutation and must retain its genuine DomainError"
        );
        assert!(
            matches!(
                &slots[1],
                ItemOutcomeSlot::Failed(PortError::Domain(DomainError::AccessDenied))
            ),
            "revoked slot 1 must receive its revocation error"
        );
        assert!(
            matches!(
                &slots[2],
                ItemOutcomeSlot::Failed(PortError::Unavailable(_))
            ),
            "slot 2 observed slot 1's rolled-back write and must be rewritten to retryable Unavailable instead of phantom RevisionConflict"
        );
        let persisted: i64 = store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    let BackendConn::Sqlite(conn) = tx else {
                        unreachable!()
                    };
                    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM batch_probe")
                        .fetch_one(&mut **conn)
                        .await
                        .unwrap())
                })
            })
            .await
            .unwrap();
        assert_eq!(persisted, 0, "rolled-back batch must persist zero rows");
        let leaked_blob_path = DataRoot::new(&root).blob(&space_id, staged_digest);
        assert!(
            !leaked_blob_path.exists(),
            "revoked batch must not leave uncatalogued local CAS file at {}",
            leaked_blob_path.display()
        );

        // Synchronized orphan cleanup MUST NEVER delete a local CAS `.zst` file once a
        // concurrent writer has committed a live catalog/reference row for that digest.
        let live_payload =
            crate::blobs::PreparedBlobSource::prepare(b"revoked-blob-payload", store.blob_codec())
                .unwrap();
        let live_digest = live_payload.digest;
        let live_ticket = store
            .stage_blob_for_batch(&rec.scope, epoch, &live_payload)
            .await
            .unwrap();
        let live_claim = crate::blobs::BlobReferenceClaim {
            ticket: live_ticket.clone(),
            owner_kind: crate::blobs::BlobOwnerKind::NoteRevision,
            owner_id: "note-live-cas-guard".to_owned(),
            owner_rev_id: "rev-live-cas-guard".to_owned(),
            resource_key: "note-live-cas-guard".to_owned(),
        };
        let scope_live = rec.scope.clone();
        store
            .with_write_tx(|tx| {
                Box::pin(async move {
                    crate::blobs::activate_and_bind_blob_ref_tx(
                        tx,
                        &scope_live,
                        epoch,
                        &live_claim,
                        SpaceSeq::new(1).unwrap(),
                    )
                    .await
                })
            })
            .await
            .unwrap();
        let mut live_published = Vec::new();
        let live_dirs = store
            .publish_deferred_local_tickets_async(
                std::slice::from_ref(&live_ticket),
                &mut live_published,
            )
            .await
            .unwrap();
        store
            .flush_pending_local_dirs_async(&live_dirs)
            .await
            .unwrap();
        drop(live_ticket);
        assert!(
            leaked_blob_path.exists(),
            "committed live blob must exist at {}",
            leaked_blob_path.display()
        );
        store
            .cleanup_unretained_local_files_async(vec![(space_id.clone(), live_digest)])
            .await;
        assert!(
            leaked_blob_path.exists(),
            "cleanup_unretained_local_files_async must preserve live committed local CAS blob at {}",
            leaked_blob_path.display()
        );

        drop(store);
        runtime.shutdown().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
}

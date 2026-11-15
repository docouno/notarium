use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
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
    ports::CallBudget,
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
        CanonicalInner, SpaceRecord, SqlDriverState, is_note_purge_fenced_tx, load_space_record,
    },
    sql_exec::BackendConn,
};

#[derive(Clone, Debug)]
pub struct CommandIdentitySpec {
    pub actor: PrincipalId,
    pub command_key: CommandKey,
    pub command_hash: ContentDigest,
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

pub struct ItemExecCtx {
    pub scope: HistoryScope,
    pub active_epoch: LeaseEpoch,
    pub root_folder_id: FolderId,
    effective_cut_before: SpaceSeq,
    current_seq: SpaceSeq,
    allocated_count: u64,
    pending_dir_syncs: PendingDirSyncs,
    retained_tickets: Vec<StagedBlobTicket>,
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
}

pub type ItemExecuteFn = Box<
    dyn for<'a> FnOnce(
            &'a mut BackendConn<'_>,
            &'a mut ItemExecCtx,
        ) -> BoxFuture<'a, Result<ItemCommitArtifacts, PortError>>
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

struct QueuedWriteItem {
    intent: PreparedWriteIntent,
    staged_bytes_reserved: u64,
    reply_tx: oneshot::Sender<Result<Vec<u8>, PortError>>,
}

/// Deterministic fault hooks used only by L3/L5 adversarial tests; zero overhead in production.
#[derive(Default)]
pub struct WriterFaultState {
    pub drop_commit_response_once: AtomicBool,
    pub pre_commit_space_delays: Mutex<HashMap<SpaceId, Duration>>,
}

struct StagedByteLimiter {
    max_bytes: u64,
    in_flight: AtomicU64,
    notify: Notify,
}

impl StagedByteLimiter {
    fn new(max_bytes: u64) -> Self {
        Self {
            max_bytes: max_bytes.max(1024),
            in_flight: AtomicU64::new(0),
            notify: Notify::new(),
        }
    }

    async fn acquire(&self, bytes: u64, budget: &CallBudget) -> Result<u64, PortError> {
        if bytes == 0 {
            return Ok(0);
        }
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

        let deadline = tokio::time::Instant::now() + budget.remaining;
        loop {
            if budget.cancellation.is_cancelled() {
                return Err(cancelled_not_committed(
                    "writer_cancelled_before_admission",
                    "write cancelled while waiting for staged byte budget",
                ));
            }
            let cur = self.in_flight.load(Ordering::Acquire);
            if cur.saturating_add(bytes) <= self.max_bytes {
                if self
                    .in_flight
                    .compare_exchange_weak(cur, cur + bytes, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    return Ok(bytes);
                }
                continue;
            }

            let notified = self.notify.notified();
            if tokio::time::Instant::now() >= deadline {
                return Err(deadline_not_committed(
                    "writer_byte_backpressure_deadline",
                    "write deadline exceeded waiting for staged byte budget",
                ));
            }
            tokio::select! {
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

    fn release(&self, bytes: u64) {
        if bytes > 0 {
            self.in_flight.fetch_sub(bytes, Ordering::Release);
            self.notify.notify_waiters();
        }
    }
}

/// Guard holding all Phase-2 writer commits paused at a clean transaction boundary
/// (used by D1 SQLite WAL `RESTART`/`TRUNCATE` reset and `<1 ms` paired backup pause).
pub struct WriterSafePointGuard {
    _guard: OwnedRwLockWriteGuard<()>,
}

enum CoordinatorMode {
    Sqlite {
        tx: Mutex<Option<mpsc::Sender<QueuedWriteItem>>>,
        worker: Mutex<Option<JoinHandle<()>>>,
    },
    Postgres {
        spaces: Mutex<HashMap<SpaceId, SpaceQueueHandle>>,
    },
}

struct SpaceQueueHandle {
    tx: mpsc::Sender<QueuedWriteItem>,
    worker: JoinHandle<()>,
}

pub struct WriteCoordinator {
    cfg: WriterConfig,
    accepting: AtomicBool,
    byte_limiter: Arc<StagedByteLimiter>,
    commit_gate: Arc<RwLock<()>>,
    faults: Arc<WriterFaultState>,
    mode: CoordinatorMode,
}

impl WriteCoordinator {
    pub(crate) fn start(inner: &Arc<CanonicalInner>) -> Arc<Self> {
        let cfg = inner.config.writer;
        let byte_limiter = Arc::new(StagedByteLimiter::new(cfg.max_staged_bytes));
        let commit_gate = Arc::new(RwLock::new(()));
        let faults = Arc::new(WriterFaultState::default());

        let mode = match &inner.sql {
            SqlDriverState::Sqlite { .. } => {
                let (tx, rx) = mpsc::channel(cfg.mailbox_capacity.max(1));
                let inner_weak = Arc::downgrade(inner);
                let limiter_cl = Arc::clone(&byte_limiter);
                let gate_cl = Arc::clone(&commit_gate);
                let faults_cl = Arc::clone(&faults);
                let worker = tokio::spawn(async move {
                    run_batch_worker_loop(inner_weak, rx, cfg, limiter_cl, gate_cl, faults_cl)
                        .await;
                });
                CoordinatorMode::Sqlite {
                    tx: Mutex::new(Some(tx)),
                    worker: Mutex::new(Some(worker)),
                }
            }
            SqlDriverState::Postgres { .. } => CoordinatorMode::Postgres {
                spaces: Mutex::new(HashMap::new()),
            },
        };

        Arc::new(Self {
            cfg,
            accepting: AtomicBool::new(true),
            byte_limiter,
            commit_gate,
            faults,
            mode,
        })
    }

    pub fn faults(&self) -> &Arc<WriterFaultState> {
        &self.faults
    }

    /// Acquires an exclusive writer safe point between Phase-2 batch commits without dropping queued items.
    pub async fn acquire_safe_point(&self) -> WriterSafePointGuard {
        let guard = Arc::clone(&self.commit_gate).write_owned().await;
        WriterSafePointGuard { _guard: guard }
    }

    /// Enqueues a prepared write intent into `WriteBatchActor` with bounded backpressure and cancellation semantics.
    pub(crate) async fn submit_raw(
        &self,
        inner: &Arc<CanonicalInner>,
        budget: &CallBudget,
        intent: PreparedWriteIntent,
    ) -> Result<Vec<u8>, PortError> {
        // Pre-admission checks: cancellation or expired deadline BEFORE admission => NotCommitted!
        if budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "writer_cancelled_pre_enqueue",
                "write cancelled prior to mailbox admission",
            ));
        }
        if budget.remaining.is_zero() {
            return Err(deadline_not_committed(
                "writer_deadline_zero_pre_enqueue",
                "write call budget expired prior to mailbox admission",
            ));
        }
        if !self.accepting.load(Ordering::SeqCst) || inner.shutting_down.load(Ordering::SeqCst) {
            return Err(unavailable_retryable(
                "writer_shutting_down",
                "canonical WriteBatchActor is draining for shutdown",
                Duration::from_millis(100),
            ));
        }

        let reserved_bytes = self
            .byte_limiter
            .acquire(intent.staged_bytes, budget)
            .await?;

        let sender = match self.sender_for_space(inner, &intent.scope.space_id).await {
            Ok(s) => s,
            Err(err) => {
                self.byte_limiter.release(reserved_bytes);
                return Err(err);
            }
        };

        let enqueue_deadline = tokio::time::Instant::now() + budget.remaining;
        let permit = tokio::select! {
            res = sender.reserve() => match res {
                Ok(p) => p,
                Err(_) => {
                    self.byte_limiter.release(reserved_bytes);
                    return Err(unavailable_retryable(
                        "writer_channel_closed",
                        "canonical WriteBatchActor channel closed",
                        Duration::from_millis(100),
                    ));
                }
            },
            _ = tokio::time::sleep_until(enqueue_deadline) => {
                self.byte_limiter.release(reserved_bytes);
                return Err(deadline_not_committed(
                    "writer_mailbox_enqueue_deadline",
                    "write deadline exceeded waiting for mailbox slot",
                ));
            }
        };

        // Re-check cancellation one final time BEFORE handing ownership to the writer permit!
        if budget.cancellation.is_cancelled() {
            drop(permit);
            self.byte_limiter.release(reserved_bytes);
            return Err(cancelled_not_committed(
                "writer_cancelled_before_commit_handoff",
                "write cancelled prior to permit handoff",
            ));
        }

        let is_idempotent = intent.idempotency.is_some();

        let (reply_tx, reply_rx) = oneshot::channel();
        // Once sent through `permit.send(...)`, the item is admitted: caller drop/cancel NEVER aborts commit!
        permit.send(QueuedWriteItem {
            intent,
            staged_bytes_reserved: reserved_bytes,
            reply_tx,
        });

        match reply_rx.await {
            Ok(outcome) => outcome,
            Err(_) => {
                if is_idempotent {
                    Err(unknown_commit_outcome(
                        "writer_worker_dropped_reply",
                        "batch worker dropped reply channel after admission",
                    ))
                } else {
                    Err(unknown_commit_non_idempotent(
                        "writer_worker_dropped_reply",
                        "batch worker dropped reply channel after admission",
                    ))
                }
            }
        }
    }

    async fn sender_for_space(
        &self,
        inner: &Arc<CanonicalInner>,
        space_id: &SpaceId,
    ) -> Result<mpsc::Sender<QueuedWriteItem>, PortError> {
        match &self.mode {
            CoordinatorMode::Sqlite { tx, .. } => {
                let guard = tx.lock().await;
                guard.clone().ok_or_else(|| {
                    unavailable_retryable(
                        "sqlite_writer_drained",
                        "SQLite WriteBatchActor has shut down",
                        Duration::from_millis(100),
                    )
                })
            }
            CoordinatorMode::Postgres { spaces } => {
                let mut map = spaces.lock().await;
                if !self.accepting.load(Ordering::SeqCst) {
                    return Err(unavailable_retryable(
                        "pg_writer_drained",
                        "PostgreSQL WriteBatchActor is shutting down",
                        Duration::from_millis(100),
                    ));
                }
                if let Some(existing) = map.get(space_id)
                    && !existing.tx.is_closed()
                {
                    return Ok(existing.tx.clone());
                }
                let (tx, rx) = mpsc::channel(self.cfg.mailbox_capacity.max(1));
                let inner_weak = Arc::downgrade(inner);
                let limiter_cl = Arc::clone(&self.byte_limiter);
                let gate_cl = Arc::clone(&self.commit_gate);
                let faults_cl = Arc::clone(&self.faults);
                let cfg = self.cfg;
                let worker = tokio::spawn(async move {
                    run_batch_worker_loop(inner_weak, rx, cfg, limiter_cl, gate_cl, faults_cl)
                        .await;
                });
                map.insert(
                    space_id.clone(),
                    SpaceQueueHandle {
                        tx: tx.clone(),
                        worker,
                    },
                );
                Ok(tx)
            }
        }
    }

    /// Stops new command admission, drains and flushes all accepted items cleanly, and joins workers.
    pub async fn drain_and_shutdown(&self) {
        self.accepting.store(false, Ordering::SeqCst);
        match &self.mode {
            CoordinatorMode::Sqlite { tx, worker } => {
                let sender = tx.lock().await.take();
                drop(sender);
                if let Some(handle) = worker.lock().await.take() {
                    let _ = handle.await;
                }
            }
            CoordinatorMode::Postgres { spaces } => {
                let drained: Vec<SpaceQueueHandle> = {
                    let mut map = spaces.lock().await;
                    map.drain().map(|(_, v)| v).collect()
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
    }
}

impl crate::CanonicalStore {
    /// Submits a typed idempotent or non-idempotent canonical mutation through `WriteBatchActor`,
    /// automatically handling MessagePack receipt serialization and replay.
    pub async fn submit_write_command<R>(
        &self,
        budget: &CallBudget,
        intent: PreparedWriteIntent,
    ) -> Result<R, PortError>
    where
        R: Serialize + DeserializeOwned + Send + 'static,
    {
        let writer = self.inner.writer()?;
        let raw_bytes = writer.submit_raw(&self.inner, budget, intent).await?;
        rmp_serde::from_slice(&raw_bytes)
            .map_err(|err| internal_not_committed("decode_writer_command_outcome", err.to_string()))
    }

    /// Helper to encode a typed command response into both `receipt_response_blob` and `response_bytes`.
    pub fn encode_command_outcome<R: Serialize>(outcome: &R) -> Result<Vec<u8>, PortError> {
        rmp_serde::to_vec_named(outcome)
            .map_err(|err| internal_not_committed("encode_writer_command_outcome", err.to_string()))
    }

    #[doc(hidden)]
    pub fn writer_faults(&self) -> Result<Arc<WriterFaultState>, PortError> {
        Ok(Arc::clone(self.inner.writer()?.faults()))
    }

    #[doc(hidden)]
    pub async fn acquire_writer_safe_point(&self) -> Result<WriterSafePointGuard, PortError> {
        Ok(self.inner.writer()?.acquire_safe_point().await)
    }
}

async fn run_batch_worker_loop(
    inner_weak: std::sync::Weak<CanonicalInner>,
    mut rx: mpsc::Receiver<QueuedWriteItem>,
    cfg: WriterConfig,
    byte_limiter: Arc<StagedByteLimiter>,
    commit_gate: Arc<RwLock<()>>,
    faults: Arc<WriterFaultState>,
) {
    let max_items = cfg.max_batch_items.max(1);
    let flush_window = cfg.batch_flush_window;

    while let Some(first) = rx.recv().await {
        let mut batch = Vec::with_capacity(max_items.min(64));
        batch.push(first);

        // Drain any immediately queued items without waiting.
        while batch.len() < max_items {
            match rx.try_recv() {
                Ok(item) => batch.push(item),
                Err(_) => break,
            }
        }

        // Coalesce micro-batch up to `flush_window` (1.5 ms) or `max_items` (64), never stalling for min 8!
        if batch.len() < max_items && !flush_window.is_zero() {
            let deadline = tokio::time::Instant::now() + flush_window;
            while batch.len() < max_items {
                tokio::select! {
                    biased;
                    maybe_item = rx.recv() => {
                        match maybe_item {
                            Some(item) => batch.push(item),
                            None => break,
                        }
                    }
                    _ = tokio::time::sleep_until(deadline) => break,
                }
            }
        }

        let Some(inner) = inner_weak.upgrade() else {
            for item in batch {
                byte_limiter.release(item.staged_bytes_reserved);
                let _ = item.reply_tx.send(Err(unavailable_retryable(
                    "canonical_runtime_dropped",
                    "canonical runtime dropped before batch execution",
                    Duration::from_millis(100),
                )));
            }
            break;
        };

        // Respect safe-point pauses (WAL reset / paired backup) cleanly between batches!
        let _commit_read_guard = commit_gate.read().await;
        flush_single_batch(&inner, batch, cfg, &byte_limiter, &faults).await;
    }
}

#[derive(Clone, Debug)]
enum SpaceBatchEntry {
    Missing,
    Loaded {
        record: Box<SpaceRecord>,
        persisted_initial_seq: SpaceSeq,
        effective_cut: SpaceSeq,
        max_purge_seq: Option<SpaceSeq>,
    },
}

enum ItemOutcomeSlot {
    Succeeded {
        response_bytes: Vec<u8>,
        has_idempotency: bool,
    },
    Failed(PortError),
}

async fn flush_single_batch(
    inner: &Arc<CanonicalInner>,
    batch: Vec<QueuedWriteItem>,
    cfg: WriterConfig,
    byte_limiter: &StagedByteLimiter,
    faults: &WriterFaultState,
) {
    let store = crate::CanonicalStore {
        inner: Arc::clone(inner),
    };

    let mut reserved_list = Vec::with_capacity(batch.len());
    let mut reply_senders = Vec::with_capacity(batch.len());
    let mut intents = Vec::with_capacity(batch.len());

    for item in batch {
        reserved_list.push(item.staged_bytes_reserved);
        reply_senders.push(item.reply_tx);
        intents.push(item.intent);
    }

    let exec_result = match &inner.sql {
        SqlDriverState::Sqlite { writer, .. } => {
            let mut guard = writer.lock().await;
            match guard.as_mut() {
                Some(conn) => {
                    let mut backend = BackendConn::Sqlite(conn);
                    execute_batch_on_conn(&store, &mut backend, intents, cfg, faults).await
                }
                None => BatchExecOutcome::AbortedBeforeCommit(unavailable_retryable(
                    "sqlite_writer_closed",
                    "SQLite writer connection closed",
                    Duration::from_millis(100),
                )),
            }
        }
        SqlDriverState::Postgres { pool, .. } => match pool.acquire().await {
            Ok(mut pooled) => {
                let conn: &mut sqlx::PgConnection = &mut pooled;
                let mut backend = BackendConn::Postgres(conn);
                execute_batch_on_conn(&store, &mut backend, intents, cfg, faults).await
            }
            Err(err) => BatchExecOutcome::AbortedBeforeCommit(unavailable_retryable(
                "pg_acquire_batch_conn",
                err.to_string(),
                Duration::from_millis(50),
            )),
        },
    };

    for bytes in reserved_list {
        byte_limiter.release(bytes);
    }

    match exec_result {
        BatchExecOutcome::Committed(slots) => {
            for (tx, slot) in reply_senders.into_iter().zip(slots) {
                let res = match slot {
                    ItemOutcomeSlot::Succeeded { response_bytes, .. } => Ok(response_bytes),
                    ItemOutcomeSlot::Failed(err) => Err(err),
                };
                let _ = tx.send(res);
            }
        }
        BatchExecOutcome::UnknownCommit { slots, diag_reason } => {
            for (tx, slot) in reply_senders.into_iter().zip(slots) {
                let res = match slot {
                    ItemOutcomeSlot::Succeeded {
                        has_idempotency, ..
                    } => {
                        if has_idempotency {
                            Err(unknown_commit_outcome("batch_commit_unknown", &diag_reason))
                        } else {
                            Err(unknown_commit_non_idempotent(
                                "batch_commit_unknown_non_idemp",
                                &diag_reason,
                            ))
                        }
                    }
                    // Savepoints rolled back before COMMIT definitely did not commit!
                    ItemOutcomeSlot::Failed(err) => Err(err),
                };
                let _ = tx.send(res);
            }
        }
        BatchExecOutcome::AbortedBeforeCommit(err) => {
            for tx in reply_senders {
                let _ = tx.send(Err(err.clone()));
            }
        }
    }
}

enum BatchExecOutcome {
    Committed(Vec<ItemOutcomeSlot>),
    UnknownCommit {
        slots: Vec<ItemOutcomeSlot>,
        diag_reason: String,
    },
    AbortedBeforeCommit(PortError),
}

async fn execute_batch_on_conn(
    store: &crate::CanonicalStore,
    tx: &mut BackendConn<'_>,
    intents: Vec<PreparedWriteIntent>,
    cfg: WriterConfig,
    faults: &WriterFaultState,
) -> BatchExecOutcome {
    if let Err(err) = tx.begin_write().await {
        return BatchExecOutcome::AbortedBeforeCommit(err);
    }

    let mut space_states: BTreeMap<SpaceId, SpaceBatchEntry> = BTreeMap::new();
    let mut batch_dir_syncs = PendingDirSyncs::default();
    // Retain all StagedBlobTickets (and their local shared digest guards) until AFTER outer COMMIT/ROLLBACK!
    let mut batch_retained_tickets: Vec<StagedBlobTicket> = Vec::new();
    let mut slots: Vec<ItemOutcomeSlot> = Vec::with_capacity(intents.len());

    let committed_at_ms = match now_unix_ms() {
        Ok(ms) => ms,
        Err(err) => {
            tx.rollback_best_effort().await;
            return BatchExecOutcome::AbortedBeforeCommit(err);
        }
    };
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);

    for (idx, intent) in intents.into_iter().enumerate() {
        let space_id = intent.scope.space_id.clone();

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
                        },
                    );
                }
                Ok(None) => {
                    space_states.insert(space_id.clone(), SpaceBatchEntry::Missing);
                }
                Err(err) => {
                    tx.rollback_best_effort().await;
                    return BatchExecOutcome::AbortedBeforeCommit(err);
                }
            }
        }

        if let Err(err) = tx.savepoint(idx).await {
            tx.rollback_best_effort().await;
            return BatchExecOutcome::AbortedBeforeCommit(err);
        }

        let has_idemp = intent.idempotency.is_some();
        let item_res = execute_single_item_in_savepoint(
            tx,
            space_states.get(&space_id).expect("space entry populated"),
            intent,
            committed_at_ms,
            expires_at_ms,
        )
        .await;

        match item_res {
            Ok(SingleItemSuccess {
                response_bytes,
                new_effective_cut,
                item_purge_seq,
                dir_syncs,
                retained_tickets,
            }) => {
                if let Err(err) = tx.release_savepoint(idx).await {
                    tx.rollback_best_effort().await;
                    return BatchExecOutcome::AbortedBeforeCommit(err);
                }
                if let Some(SpaceBatchEntry::Loaded {
                    effective_cut,
                    max_purge_seq,
                    ..
                }) = space_states.get_mut(&space_id)
                {
                    *effective_cut = new_effective_cut;
                    if let Some(pseq) = item_purge_seq {
                        *max_purge_seq = Some(max_purge_seq.map_or(pseq, |prev| prev.max(pseq)));
                    }
                }
                batch_dir_syncs.merge(&dir_syncs);
                batch_retained_tickets.extend(retained_tickets);
                slots.push(ItemOutcomeSlot::Succeeded {
                    response_bytes,
                    has_idempotency: has_idemp,
                });
            }
            Err(item_err) => {
                // Rollback ONLY this item's savepoint; virtual `effective_cut` stays unchanged!
                if let Err(rb_err) = tx.rollback_to_savepoint(idx).await {
                    tx.rollback_best_effort().await;
                    return BatchExecOutcome::AbortedBeforeCommit(rb_err);
                }
                slots.push(ItemOutcomeSlot::Failed(item_err));
            }
        }
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
                tx.rollback_best_effort().await;
                drop(batch_retained_tickets);
                return BatchExecOutcome::AbortedBeforeCommit(bump_err);
            }
        }
    }

    // Coalesced local CAS directory fsync BEFORE SQL COMMIT!
    if let Err(sync_err) = store.flush_pending_local_dirs(&batch_dir_syncs) {
        tx.rollback_best_effort().await;
        drop(batch_retained_tickets);
        return BatchExecOutcome::AbortedBeforeCommit(sync_err);
    }

    // Commit outer SQL transaction!
    match tx.commit_write().await {
        Ok(()) => {
            drop(batch_retained_tickets);
            // Publish broadcast hints strictly AFTER confirmed SQL durability!
            for entry in space_states.values() {
                if let SpaceBatchEntry::Loaded {
                    record,
                    persisted_initial_seq,
                    effective_cut,
                    max_purge_seq,
                } = entry
                    && *effective_cut > *persisted_initial_seq
                {
                    if let Some(pseq) = max_purge_seq {
                        store.inner.broadcast_hub.publish(
                            crate::changes::BroadcastSignal::Purged {
                                scope: record.scope.clone(),
                                purged_through_seq: *pseq,
                                current_safe_cut: *effective_cut,
                            },
                        );
                    }
                    store
                        .inner
                        .broadcast_hub
                        .publish(crate::changes::BroadcastSignal::Committed {
                            scope: record.scope.clone(),
                            new_last_seq: *effective_cut,
                        });
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
            BatchExecOutcome::Committed(slots)
        }
        Err(commit_err) => {
            drop(batch_retained_tickets);
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
    dir_syncs: PendingDirSyncs,
    retained_tickets: Vec<StagedBlobTicket>,
}

async fn execute_single_item_in_savepoint(
    tx: &mut BackendConn<'_>,
    space_entry: &SpaceBatchEntry,
    intent: PreparedWriteIntent,
    committed_at_ms: i64,
    expires_at_ms: i64,
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
    space_rec.scope.check(&intent.scope)?;
    if space_rec.active_epoch != intent.active_epoch {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }

    // 2. Purge fence check on all declared source note identities.
    for note_id in &intent.source_note_ids {
        if is_note_purge_fenced_tx(tx, &intent.scope.space_id, note_id.as_str()).await? {
            return Err(DomainError::ResourceNotFound.into());
        }
    }

    // 3. Idempotent command receipt lookup (`command_receipts`) BEFORE stale head CAS!
    if let Some(idemp) = &intent.idempotency
        && let Some(existing) = lookup_command_receipt_tx(tx, &intent.scope, idemp).await?
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
                dir_syncs: PendingDirSyncs::default(),
                retained_tickets: Vec::new(),
            }),
            _ => Err(unavailable_retryable(
                "command_receipt_pending",
                "idempotent command is currently pending crash recovery",
                Duration::from_millis(25),
            )),
        };
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
        active_epoch: intent.active_epoch,
        root_folder_id: space_rec.root_folder_id.clone(),
        effective_cut_before: current_effective_cut,
        current_seq: current_effective_cut,
        allocated_count: 0,
        pending_dir_syncs: PendingDirSyncs::default(),
        retained_tickets: Vec::new(),
    };

    let artifacts = (intent.execute)(tx, &mut item_ctx).await?;

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

    if let Some(cp) = &artifacts.change_payload {
        insert_change_payload_tx(tx, &intent.scope, cp, last_seq).await?;
    }

    insert_change_command_and_events_tx(
        tx,
        &intent.scope,
        &artifacts.command_id,
        &artifacts.command_kind,
        first_seq,
        last_seq,
        payload_id_opt,
        &artifacts.events,
        committed_at_ms,
    )
    .await?;

    if let Some(idemp) = &intent.idempotency {
        insert_completed_receipt_tx(
            tx,
            &intent.scope,
            idemp,
            last_seq,
            artifacts.receipt_detail_blob.as_deref(),
            &artifacts.receipt_sanitized_blob,
            &artifacts.receipt_owner_note_ids,
            expires_at_ms,
        )
        .await?;
    }

    let item_purge_seq = artifacts
        .events
        .iter()
        .filter(|ev| ev.op_kind == "purge")
        .map(|ev| ev.space_seq)
        .max();

    Ok(SingleItemSuccess {
        response_bytes: artifacts.response_bytes,
        new_effective_cut: last_seq,
        item_purge_seq,
        dir_syncs: item_ctx.pending_dir_syncs,
        retained_tickets: item_ctx.retained_tickets,
    })
}

async fn lock_and_load_space_outer_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<Option<SpaceRecord>, PortError> {
    if let BackendConn::Postgres(conn) = tx {
        let locked: Option<i64> =
            sqlx::query_scalar("SELECT active_epoch FROM spaces WHERE space_id = $1 FOR UPDATE")
                .bind(space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_batch_lock_space", err.to_string()))?;
        if locked.is_none() {
            return Ok(None);
        }
    }
    match load_space_record(tx, space_id).await {
        Ok(rec) => Ok(Some(rec)),
        Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(None),
        Err(other) => Err(other),
    }
}

struct StoredReceiptRow {
    command_hash: ContentDigest,
    status: String,
    response_blob: Vec<u8>,
}

type RawReceiptRow = (Vec<u8>, String, Option<String>, Vec<u8>);

async fn lookup_command_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<Option<StoredReceiptRow>, PortError> {
    let raw: Option<RawReceiptRow> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT command_hash, status, response_payload_id, sanitized_envelope_msgpack
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
                )
            })
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT command_hash, status, response_payload_id, sanitized_envelope_msgpack
                 FROM command_receipts
                 WHERE space_id = $1 AND history_incarnation = $2 AND actor_id = $3 AND idempotency_key = $4",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_lookup_receipt", err.to_string()))?;
            row.map(|r| {
                (
                    r.get("command_hash"),
                    r.get("status"),
                    r.get("response_payload_id"),
                    r.get("sanitized_envelope_msgpack"),
                )
            })
        }
    };

    let Some((hash_bytes, status, resp_payload_id, sanitized_blob)) = raw else {
        return Ok(None);
    };
    let arr: [u8; 32] = hash_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_receipt_hash", "command_hash != 32B"))?;

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
                .map_err(|err| internal_not_committed("pg_lookup_rcpt_pay", err.to_string()))?;
                r.map(|row| (row.get("erased_by_purge"), row.get("effect_msgpack")))
            }
        };
        match detail_opt {
            Some((0, Some(detail))) => detail,
            _ => sanitized_blob,
        }
    } else {
        sanitized_blob
    };

    Ok(Some(StoredReceiptRow {
        command_hash: ContentDigest::from_bytes(arr),
        status,
        response_blob: effective_blob,
    }))
}

async fn insert_change_payload_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    cp: &ChangePayloadDraft,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO change_payloads (
                    space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq
                ) VALUES (?, ?, ?, 0, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(&cp.payload_id)
            .bind(&cp.codec)
            .bind(&cp.effect_msgpack)
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_insert_change_payload", err.to_string())
            })?;

            for note_id in &cp.owner_note_ids {
                sqlx::query(
                    "INSERT OR IGNORE INTO payload_owners (
                        space_id, payload_kind, payload_id, note_id
                    ) VALUES (?, 'change_payload', ?, ?)",
                )
                .bind(scope.space_id.as_str())
                .bind(&cp.payload_id)
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_insert_cp_owner", err.to_string()))?;
            }
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO change_payloads (
                    space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq
                ) VALUES ($1, $2, $3, 0, $4, $5)",
            )
            .bind(scope.space_id.as_str())
            .bind(&cp.payload_id)
            .bind(&cp.codec)
            .bind(&cp.effect_msgpack)
            .bind(seq_i64)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_change_payload", err.to_string()))?;

            for note_id in &cp.owner_note_ids {
                sqlx::query(
                    "INSERT INTO payload_owners (
                        space_id, payload_kind, payload_id, note_id
                    ) VALUES ($1, 'change_payload', $2, $3)
                    ON CONFLICT DO NOTHING",
                )
                .bind(scope.space_id.as_str())
                .bind(&cp.payload_id)
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_insert_cp_owner", err.to_string()))?;
            }
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

            for ev in events {
                let lc_str = lifecycle_to_db(ev.lifecycle);
                let dc_str = ev.doc_class.map(doc_class_to_db);
                sqlx::query(
                    "INSERT INTO change_log (
                        space_id, space_seq, history_incarnation, command_id,
                        command_first_seq, command_last_seq, entity_type, entity_id,
                        op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(scope.space_id.as_str())
                .bind(ev.space_seq.get() as i64)
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(command_id)
                .bind(first_i64)
                .bind(last_i64)
                .bind(&ev.entity_type)
                .bind(&ev.entity_id)
                .bind(&ev.op_kind)
                .bind(ev.rev_id.as_str())
                .bind(lc_str)
                .bind(dc_str)
                .bind(payload_id)
                .bind(committed_at_ms)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_batch_insert_ev", err.to_string()))?;
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

            for ev in events {
                let lc_str = lifecycle_to_db(ev.lifecycle);
                let dc_str = ev.doc_class.map(doc_class_to_db);
                sqlx::query(
                    "INSERT INTO change_log (
                        space_id, space_seq, history_incarnation, command_id,
                        command_first_seq, command_last_seq, entity_type, entity_id,
                        op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)",
                )
                .bind(scope.space_id.as_str())
                .bind(ev.space_seq.get() as i64)
                .bind(scope.incarnation.as_bytes().as_slice())
                .bind(command_id)
                .bind(first_i64)
                .bind(last_i64)
                .bind(&ev.entity_type)
                .bind(&ev.entity_id)
                .bind(&ev.op_kind)
                .bind(ev.rev_id.as_str())
                .bind(lc_str)
                .bind(dc_str)
                .bind(payload_id)
                .bind(committed_at_ms)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_batch_insert_ev", err.to_string()))?;
            }
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_completed_receipt_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
    canonical_seq: SpaceSeq,
    detail_blob: Option<&[u8]>,
    sanitized_blob: &[u8],
    owner_note_ids: &[NoteId],
    expires_at_ms: i64,
) -> Result<(), PortError> {
    let seq_i64 = canonical_seq.get() as i64;
    let receipt_owner_key = format!("{}:{}", idemp.actor.as_str(), idemp.command_key.as_str());

    let resp_payload_id = if let Some(detail) = detail_blob {
        let pid = format!("rcpt_pay:{receipt_owner_key}");
        let draft = ChangePayloadDraft {
            payload_id: pid.clone(),
            codec: "receipt_detail_v1".to_owned(),
            effect_msgpack: detail.to_vec(),
            owner_note_ids: owner_note_ids.to_vec(),
        };
        insert_change_payload_tx(tx, scope, &draft, canonical_seq).await?;
        Some(pid)
    } else {
        None
    };

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO command_receipts (
                    space_id, history_incarnation, actor_id, idempotency_key, command_hash,
                    status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
                    canonical_seq, expires_at_ms
                ) VALUES (?, ?, ?, ?, ?, 'completed', 1, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .bind(idemp.command_hash.as_bytes().as_slice())
            .bind(&resp_payload_id)
            .bind(sanitized_blob)
            .bind(seq_i64)
            .bind(expires_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_receipt", err.to_string()))?;

            for note_id in owner_note_ids {
                sqlx::query(
                    "INSERT OR IGNORE INTO payload_owners (
                        space_id, payload_kind, payload_id, note_id
                    ) VALUES (?, 'command_receipt', ?, ?)",
                )
                .bind(scope.space_id.as_str())
                .bind(&receipt_owner_key)
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_insert_rcpt_owner", err.to_string())
                })?;
            }
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO command_receipts (
                    space_id, history_incarnation, actor_id, idempotency_key, command_hash,
                    status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
                    canonical_seq, expires_at_ms
                ) VALUES ($1, $2, $3, $4, $5, 'completed', 1, $6, $7, $8, $9)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .bind(idemp.command_hash.as_bytes().as_slice())
            .bind(&resp_payload_id)
            .bind(sanitized_blob)
            .bind(seq_i64)
            .bind(expires_at_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_receipt", err.to_string()))?;

            for note_id in owner_note_ids {
                sqlx::query(
                    "INSERT INTO payload_owners (
                        space_id, payload_kind, payload_id, note_id
                    ) VALUES ($1, 'command_receipt', $2, $3)
                    ON CONFLICT DO NOTHING",
                )
                .bind(scope.space_id.as_str())
                .bind(&receipt_owner_key)
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_insert_rcpt_owner", err.to_string()))?;
            }
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

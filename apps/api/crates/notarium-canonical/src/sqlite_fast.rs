use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, LazyLock, Mutex as StdMutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::{ClassifiedDocument, DocClass},
    error::{PortError, ValidationReason},
    ids::{
        AbilityId, AgentRunId, CommandKey, ContentDigest, FolderId, HistoryIncarnation, LeaseEpoch,
        LineageEpoch, NoteId, PrincipalId, RevisionId, SpaceId, SpaceSeq,
    },
    model::{HistoryScope, Lifecycle, NoteRef, PathTarget},
    ports::{
        CallBudget, CommandSeqRange, CreateNote, GetNote, NoteRevision, NoteSnapshot,
        Preconditions, RollbackAgentRun, SpaceContext,
    },
    query::{FieldObservation, FieldSchema, FieldValue},
    receipt::{CausalBasis, CommandIdentity, MutationReceiptToken},
    value::Timestamp,
};
use rusqlite::{OptionalExtension, params, params_from_iter, types::ToSql};
use tokio::sync::Semaphore;

use crate::{
    CanonicalStore, SpaceRecord,
    blobs::{
        BlobCodecTag, BlobOwnerKind, BlobReferenceClaim, FastLocalBlobReadPlan, PendingDirSyncs,
        StagedBlobTicket, local::DeferredLocalStaging,
    },
    changes::{
        BroadcastSignal, ChangedNoteSummaryV1, EffectBodyV1, StoredAwaitReasonV1,
        build_effect_payload_draft,
    },
    codec::{
        AgentRunRevisionMetadata, MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata,
        RevisionMetadataEnvelope, RevisionMetadataPayload, cancelled_not_committed,
        deadline_not_committed, decode_msgpack_bounded, decode_timestamp_parts, doc_class_from_db,
        doc_class_to_db, encode_msgpack, encode_timestamp_parts, evaluate_fields_with_schema,
        i64_to_space_seq, internal_not_committed, lifecycle_from_db, lifecycle_to_db,
        new_prefixed_hex_id, new_revision_id, normalize_title_key, now_unix_ms, now_utc_timestamp,
        ordered_ids_batch, unavailable_retryable,
    },
    config::WriterConfig,
    dialect::sqlite::{open_rusqlite_readonly_connection, open_rusqlite_writer_connection},
    domain::{
        RoomFenceTable,
        common::{
            CurrentSpaceSchema, FolderAncestryFacts, MAX_FOLDER_DEPTH, NoteHeadRow,
            NoteRoomDirectWriteState, StoredCommittedNoteRevV1, StoredCommittedRollbackV1,
            extract_agent_run_from_auth, note_rank_version_digest,
        },
        notes::{
            EvaluatedFields, PreparedCarrierInfo, build_carrier_replacement_intent,
            build_create_note_intent, changed_note_fields, revision_fields,
        },
        rollback::{
            CandidateAction, build_rollback_direct_single_tx_exec,
            rollback_fallback_board_present_err,
        },
    },
    runtime::{FolderHeadRow, SqlDriverState},
    wal::SqliteWalCoordinator,
    writer::{
        BatchEventDraft, BatchExecOutcome, ChangePayloadDraft, CommandIdentitySpec,
        ItemCommitArtifacts, ItemExecCtx, ItemExecuteFn, ItemOutcomeSlot, PreparedWriteIntent,
        SemanticCutMismatchKind, SpaceBatchEntry, StoredReceiptRow, WriterFaultState,
    },
};

pub(crate) struct SqliteWriterPair {
    pub sqlx_conn: sqlx::SqliteConnection,
    pub rusqlite_conn: Option<rusqlite::Connection>,
    pub db_path: PathBuf,
}

pub(crate) struct SqliteFastReadPool {
    db_path: PathBuf,
    sem: Arc<Semaphore>,
    writer_active_read_sem: Arc<Semaphore>,
    conns: Arc<StdMutex<Vec<rusqlite::Connection>>>,
}

struct OuterReadCancelGuard {
    cancel_flag: Arc<AtomicBool>,
    interrupt: rusqlite::InterruptHandle,
    completed: bool,
}

impl Drop for OuterReadCancelGuard {
    fn drop(&mut self) {
        if !self.completed {
            self.cancel_flag.store(true, Ordering::SeqCst);
            self.interrupt.interrupt();
        }
    }
}

impl SqliteFastReadPool {
    pub fn new(db_path: PathBuf, initial: Vec<rusqlite::Connection>) -> Self {
        let cap = initial.len().max(1);
        Self {
            db_path,
            sem: Arc::new(Semaphore::new(cap)),
            writer_active_read_sem: Arc::new(Semaphore::new(1)),
            conns: Arc::new(StdMutex::new(initial)),
        }
    }

    pub async fn close_all(&self) {
        let drained: Vec<rusqlite::Connection> = {
            let mut guard = self.conns.lock().expect("fast read pool mutex");
            std::mem::take(&mut *guard)
        };
        if !drained.is_empty() {
            let _ = tokio::task::spawn_blocking(move || {
                for conn in drained {
                    let _ = conn.close();
                }
            })
            .await;
        }
    }

    pub async fn with_read_conn<F, T>(
        &self,
        wal: &Arc<SqliteWalCoordinator>,
        budget: Option<&CallBudget>,
        op: F,
    ) -> Result<T, PortError>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T, PortError> + Send + 'static,
        T: Send + 'static,
    {
        self.with_read_conn_and_post(wal, budget, false, op, Ok)
            .await
    }

    pub async fn with_read_conn_and_post<F, P, T, U>(
        &self,
        wal: &Arc<SqliteWalCoordinator>,
        budget: Option<&CallBudget>,
        force_blocking: bool,
        op: F,
        post_after_release: P,
    ) -> Result<U, PortError>
    where
        F: FnOnce(&rusqlite::Connection) -> Result<T, PortError> + Send + 'static,
        P: FnOnce(T) -> Result<U, PortError> + Send + 'static,
        T: Send + 'static,
        U: Send + 'static,
    {
        let (mut gate_guard, caller_deadline_tokio, _gate_tx_deadline_std) =
            wal.acquire_reader_gate_slot(budget).await?;

        let permit = match Arc::clone(&self.sem).try_acquire_owned() {
            Ok(p) => p,
            Err(tokio::sync::TryAcquireError::Closed) => {
                return Err(unavailable_retryable(
                    "sqlite_fast_pool_closed",
                    "SQLite fast read pool closed",
                    Duration::from_millis(50),
                ));
            }
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                tokio::select! {
                    res = Arc::clone(&self.sem).acquire_owned() => match res {
                        Ok(p) => p,
                        Err(_) => {
                            return Err(unavailable_retryable(
                                "sqlite_fast_pool_closed",
                                "SQLite fast read pool closed",
                                Duration::from_millis(50),
                            ));
                        }
                    },
                    _ = tokio::time::sleep_until(caller_deadline_tokio) => {
                        gate_guard.mark_timeout();
                        return Err(deadline_not_committed(
                            "sqlite_fast_pool_acquire_deadline",
                            "read deadline exceeded waiting for fast SQLite reader slot",
                        ));
                    }
                }
            }
        };

        if budget.is_some_and(|b| b.cancellation.is_cancelled()) {
            return Err(cancelled_not_committed(
                "sqlite_read_cancelled_post_acquire",
                "read cancelled after fast pool checkout",
            ));
        }

        let conn_opt = {
            let mut guard = self.conns.lock().expect("fast read pool mutex");
            guard.pop()
        };
        let conn = match conn_opt {
            Some(c) => c,
            None => open_rusqlite_readonly_connection(&self.db_path)?,
        };

        // Start the `< 250 ms` snapshot hold timer right before `BEGIN DEFERRED`,
        // bounded by the caller's remaining request budget.
        let now_tokio = tokio::time::Instant::now();
        let remaining_after_acquire = caller_deadline_tokio.saturating_duration_since(now_tokio);
        if remaining_after_acquire.is_zero() {
            if conn.is_autocommit() {
                self.conns.lock().expect("fast read pool mutex").push(conn);
            }
            drop(permit);
            gate_guard.mark_timeout();
            return Err(deadline_not_committed(
                "sqlite_read_budget_exhausted",
                "read budget exhausted after fast pool acquire",
            ));
        }
        let effective_tx_budget = remaining_after_acquire.min(wal.read_deadline());
        let tx_deadline_std = Instant::now() + effective_tx_budget;
        let tx_deadline_tokio = now_tokio + effective_tx_budget;

        let is_multi_thread = tokio::runtime::Handle::try_current()
            .is_ok_and(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);

        if is_multi_thread && !force_blocking {
            let caller_cancel = budget.map(|b| b.cancellation.clone());
            let caller_cancel_check = caller_cancel.clone();
            let cancel_flag = AtomicBool::new(false);

            let res: Result<T, PortError> = (|| {
                conn.progress_handler(
                    1024,
                    Some(move || {
                        caller_cancel.as_ref().is_some_and(|c| c.is_cancelled())
                            || Instant::now() >= tx_deadline_std
                    }),
                )
                .map_err(|err| {
                    internal_not_committed("sqlite_progress_handler", err.to_string())
                })?;

                conn.prepare_cached("BEGIN DEFERRED")
                    .and_then(|mut s| s.execute([]))
                    .map_err(|err| {
                        record_rusqlite_busy(wal, &err);
                        map_rusqlite_read_err(
                            err,
                            "sqlite_fast_begin_read",
                            &cancel_flag,
                            caller_cancel_check.as_ref(),
                            tx_deadline_std,
                        )
                    })?;
                let val = op(&conn)?;
                conn.prepare_cached("COMMIT")
                    .and_then(|mut s| s.execute([]))
                    .map_err(|err| {
                        record_rusqlite_busy(wal, &err);
                        map_rusqlite_read_err(
                            err,
                            "sqlite_fast_commit_read",
                            &cancel_flag,
                            caller_cancel_check.as_ref(),
                            tx_deadline_std,
                        )
                    })?;
                Ok(val)
            })();

            let _ = conn.progress_handler(0, None::<fn() -> bool>);

            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            if conn.is_autocommit() {
                self.conns.lock().expect("fast read pool mutex").push(conn);
            } else {
                let _ = conn.close();
                if let Ok(fresh) = open_rusqlite_readonly_connection(&self.db_path) {
                    self.conns.lock().expect("fast read pool mutex").push(fresh);
                }
            }
            drop(permit);

            return match res {
                Ok(val) => {
                    gate_guard.finish_cleanly();
                    post_after_release(val)
                }
                Err(err) => {
                    if Instant::now() >= tx_deadline_std
                        && !caller_cancel_check
                            .as_ref()
                            .is_some_and(|c| c.is_cancelled())
                    {
                        gate_guard.mark_timeout();
                    }
                    drop(gate_guard);
                    Err(err)
                }
            };
        }

        let interrupt = conn.get_interrupt_handle();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let mut outer_guard = OuterReadCancelGuard {
            cancel_flag: Arc::clone(&cancel_flag),
            interrupt,
            completed: false,
        };

        let caller_cancel = budget.map(|b| b.cancellation.clone());
        let cancel_for_handler = Arc::clone(&cancel_flag);
        let cancel_for_check = Arc::clone(&cancel_flag);
        let caller_cancel_check = caller_cancel.clone();
        let conns_arc = Arc::clone(&self.conns);
        let db_path = self.db_path.clone();
        let wal_cl = Arc::clone(wal);

        let mut handle = tokio::task::spawn_blocking(move || {
            let res: Result<T, PortError> = (|| {
                conn.progress_handler(
                    256,
                    Some(move || {
                        cancel_for_handler.load(Ordering::Relaxed)
                            || caller_cancel.as_ref().is_some_and(|c| c.is_cancelled())
                            || Instant::now() >= tx_deadline_std
                    }),
                )
                .map_err(|err| {
                    internal_not_committed("sqlite_progress_handler", err.to_string())
                })?;

                conn.execute_batch("BEGIN DEFERRED").map_err(|err| {
                    record_rusqlite_busy(&wal_cl, &err);
                    map_rusqlite_read_err(
                        err,
                        "sqlite_fast_begin_read",
                        &cancel_for_check,
                        caller_cancel_check.as_ref(),
                        tx_deadline_std,
                    )
                })?;
                let val = op(&conn)?;
                conn.execute_batch("COMMIT").map_err(|err| {
                    record_rusqlite_busy(&wal_cl, &err);
                    map_rusqlite_read_err(
                        err,
                        "sqlite_fast_commit_read",
                        &cancel_for_check,
                        caller_cancel_check.as_ref(),
                        tx_deadline_std,
                    )
                })?;
                Ok(val)
            })();

            let _ = conn.progress_handler(0, None::<fn() -> bool>);

            if !conn.is_autocommit() {
                let _ = conn.execute_batch("ROLLBACK");
            }
            if conn.is_autocommit() {
                conns_arc.lock().expect("fast read pool mutex").push(conn);
            } else {
                let _ = conn.close();
                if let Ok(fresh) = open_rusqlite_readonly_connection(&db_path) {
                    conns_arc.lock().expect("fast read pool mutex").push(fresh);
                }
            }
            drop(permit);

            match res {
                Ok(val) => {
                    gate_guard.finish_cleanly();
                    post_after_release(val)
                }
                Err(err) => {
                    if Instant::now() >= tx_deadline_std
                        && !cancel_for_check.load(Ordering::Relaxed)
                        && !caller_cancel_check
                            .as_ref()
                            .is_some_and(|c| c.is_cancelled())
                    {
                        gate_guard.mark_timeout();
                    }
                    drop(gate_guard);
                    Err(err)
                }
            }
        });

        tokio::select! {
            join_res = &mut handle => {
                outer_guard.completed = true;
                join_res.map_err(|err| internal_not_committed("sqlite_fast_read_join", err.to_string()))?
            }
            _ = tokio::time::sleep_until(tx_deadline_tokio) => {
                // `outer_guard` Drop interrupts `conn`; `handle` rolls back and drops `gate_guard` cleanly.
                Err(deadline_not_committed(
                    "sqlite_read_interrupted_deadline",
                    "ordinary SQLite read interrupted at deadline",
                ))
            }
        }
    }
}

fn record_rusqlite_busy(wal: &SqliteWalCoordinator, err: &rusqlite::Error) {
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = err
        && matches!(
            ffi_err.code,
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
        )
    {
        wal.record_busy_if_any("SQLITE_BUSY");
        return;
    }
    wal.record_busy_if_any(&err.to_string());
}

fn map_rusqlite_read_err(
    err: rusqlite::Error,
    stage: &'static str,
    cancel_flag: &AtomicBool,
    caller_cancel: Option<&notarium_core::ports::Cancellation>,
    tx_deadline_std: Instant,
) -> PortError {
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = &err
        && ffi_err.code == rusqlite::ErrorCode::OperationInterrupted
    {
        if cancel_flag.load(Ordering::Relaxed) || caller_cancel.is_some_and(|c| c.is_cancelled()) {
            return cancelled_not_committed(
                "sqlite_read_cancelled",
                "ordinary SQLite read cancelled",
            );
        }
        return deadline_not_committed(
            "sqlite_read_interrupted_deadline",
            "ordinary SQLite read interrupted at deadline",
        );
    }
    if Instant::now() >= tx_deadline_std {
        return deadline_not_committed(
            "sqlite_read_interrupted_deadline",
            "ordinary SQLite read interrupted at deadline",
        );
    }
    internal_not_committed(stage, err.to_string())
}

#[allow(clippy::large_enum_variant)]
pub(crate) enum EditPhase1Read {
    Replayed(StoredCommittedNoteRevV1),
    Proceed {
        space_rec: SpaceRecord,
        base_head: NoteHeadRow,
        base_anc: Option<FolderAncestryFacts>,
        base_digest: ContentDigest,
        preloaded_base_carrier: Option<String>,
        fast_local_read: Option<FastLocalBlobReadPlan>,
        phase1_receipt_checked_gen: Option<u64>,
    },
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn edit_note_phase1_sqlite_local(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note_id: &NoteId,
    preconditions: &Preconditions,
    expected_base_hash: ContentDigest,
    idemp: &CommandIdentitySpec,
) -> Result<EditPhase1Read, PortError> {
    store.ensure_open()?;
    let SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql else {
        return Err(internal_not_committed(
            "sqlite_fast_wrong_driver",
            "expected Sqlite driver",
        ));
    };
    let wal = store.inner.wal_coord.get().ok_or_else(|| {
        internal_not_committed(
            "sqlite_wal_coord_missing",
            "SqliteWalCoordinator not initialized",
        )
    })?;
    let local_store = store.local_store_arc().ok_or_else(|| {
        internal_not_committed("sqlite_fast_missing_local_cas", "expected LocalBlobStore")
    })?;

    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let nid = note_id.clone();
    let prec = preconditions.clone();
    let idemp_cl = idemp.clone();
    let wal_for_err = Arc::clone(wal);
    let writer_gen_before = store.inner.sqlite_writer_commit_gen.load(Ordering::Acquire);
    let has_any_purge_fences = store
        .inner
        .sqlite_has_any_purge_fences
        .load(Ordering::Acquire);
    let has_any_collab_sessions = store
        .inner
        .sqlite_has_any_collab_sessions
        .load(Ordering::Acquire);

    fast_read_pool
        .with_read_conn(wal, Some(&ctx.budget), move |conn| {
            let srec = load_space_record_rusqlite_Read(conn, &scope.space_id, &wal_for_err)?;
            srec.scope.check(&scope)?;

            if let Some(existing) = lookup_command_receipt_rusqlite(conn, &scope, &idemp_cl)? {
                if existing.command_hash != idemp_cl.command_hash {
                    return Err(DomainError::IdempotencyKeyReused.into());
                }
                if existing.status == "completed" {
                    let decoded: StoredCommittedNoteRevV1 =
                        rmp_serde::from_slice(&existing.response_blob).map_err(|err| {
                            internal_not_committed("decode_replayed_receipt", err.to_string())
                        })?;
                    return Ok(EditPhase1Read::Replayed(decoded));
                }
                return Err(unavailable_retryable(
                    "command_receipt_pending",
                    "idempotent command is currently pending crash recovery",
                    Duration::from_millis(25),
                ));
            }

            if has_any_purge_fences
                && is_note_purge_fenced_rusqlite(conn, &scope.space_id, nid.as_str())?
            {
                return Err(DomainError::ResourceNotFound.into());
            }
            let head = load_note_head_row_rusqlite(conn, &scope.space_id, &nid)?;
            if head.lifecycle != Lifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }
            if let Some(expected_rev) = &prec.revision
                && *expected_rev != head.head_rev_id
            {
                return Err(DomainError::RevisionConflict {
                    current: head.head_rev_id,
                    lineage: None,
                }
                .into());
            }
            if has_any_collab_sessions || prec.lease.is_some() || prec.lineage.is_some() {
                check_collab_preconditions_rusqlite(conn, &scope.space_id, &nid, &prec)?;
            }
            let (facts, anc) = build_resource_facts_rusqlite(
                conn,
                &srec.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                true,
            )?;
            auth.authorize_direct_write(&facts, &facts)?;

            let base_digest = head.content_digest.ok_or_else(|| {
                internal_not_committed(
                    "active_note_missing_digest",
                    "active note lacks content_blake3",
                )
            })?;
            if base_digest != expected_base_hash {
                return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
            }

            let fast_local_read = if let Some(guard) =
                local_store.try_acquire_shared_guard(&srec.scope.space_id, base_digest)
            {
                Some(FastLocalBlobReadPlan::new(
                    Arc::clone(&local_store),
                    srec.scope.space_id.clone(),
                    base_digest,
                    head.byte_size,
                    guard,
                ))
            } else {
                None
            };

            Ok(EditPhase1Read::Proceed {
                space_rec: srec,
                base_head: head,
                base_anc: Some(anc),
                base_digest,
                preloaded_base_carrier: None,
                fast_local_read,
                phase1_receipt_checked_gen: Some(writer_gen_before),
            })
        })
        .await
}

pub(crate) async fn get_note_sqlite_local_fast(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: GetNote,
) -> Result<NoteSnapshot, PortError> {
    store.ensure_open()?;
    let SqlDriverState::Sqlite { fast_read_pool, .. } = &store.inner.sql else {
        return Err(internal_not_committed(
            "sqlite_fast_wrong_driver",
            "expected Sqlite driver",
        ));
    };
    let wal = store.inner.wal_coord.get().ok_or_else(|| {
        internal_not_committed(
            "sqlite_wal_coord_missing",
            "SqliteWalCoordinator not initialized",
        )
    })?;
    let local_store = store.local_store_arc().ok_or_else(|| {
        internal_not_committed("sqlite_fast_missing_local_cas", "expected LocalBlobStore")
    })?;

    // When `WriteBatchActor` has active write operations in flight, bound concurrent CPU/IO-heavy
    // external `get_note` snapshots (SQLite + Zstd + BLAKE3) via FIFO `writer_active_read_sem`
    // so hundreds of concurrent reader tasks never starve the single-threaded SQLite writer or Phase-1!
    let writer_active = store
        .inner
        .writer_coord
        .get()
        .is_some_and(|w| w.has_active_sqlite_ops());
    let _active_read_permit = if writer_active {
        if ctx.budget.cancellation.is_cancelled() {
            return Err(cancelled_not_committed(
                "sqlite_read_cancelled_pre_acquire",
                "ordinary SQLite read cancelled before acquire",
            ));
        }
        if ctx.budget.remaining.is_zero() {
            return Err(deadline_not_committed(
                "sqlite_read_zero_budget",
                "ordinary SQLite read budget expired",
            ));
        }
        let permit = match Arc::clone(&fast_read_pool.writer_active_read_sem).try_acquire_owned() {
            Ok(p) => Some(p),
            Err(tokio::sync::TryAcquireError::Closed) => None,
            Err(tokio::sync::TryAcquireError::NoPermits) => {
                let eff_deadline = tokio::time::Instant::now() + ctx.budget.remaining;
                tokio::select! {
                    res = Arc::clone(&fast_read_pool.writer_active_read_sem).acquire_owned() => res.ok(),
                    _ = tokio::time::sleep_until(eff_deadline) => {
                        return Err(deadline_not_committed(
                            "sqlite_read_lane_deadline",
                            "ordinary SQLite read exceeded deadline waiting for active read lane",
                        ));
                    }
                }
            }
        };
        if let Some(w) = store.inner.writer_coord.get() {
            w.yield_during_sqlite_phase1_burst(&ctx.budget).await;
        }
        permit
    } else {
        None
    };

    let scope = ctx.scope().clone();
    let auth = ctx.auth().clone();
    let req_note = request.note.clone();
    let req_rev_opt = request.revision.clone();
    let causal = request.causal.clone();
    let wal_for_err = Arc::clone(wal);
    let has_any_purge_fences = store
        .inner
        .sqlite_has_any_purge_fences
        .load(Ordering::Acquire);
    let has_any_space_schemas = store
        .inner
        .sqlite_has_any_space_schemas
        .load(Ordering::Acquire);

    let (
        rev_id,
        initial_facts,
        lifecycle,
        digest,
        parent_opt,
        byte_size,
        fields,
        diagnostics,
        eager_raw_bytes,
        deferred_plan,
    ) = fast_read_pool
        .with_read_conn_and_post(
            wal,
            Some(&ctx.budget),
            false,
            move |conn| {
            let space_rec = load_space_record_rusqlite_Read(conn, &scope.space_id, &wal_for_err)?;
            space_rec.scope.check(&scope)?;
            if space_rec.space.lifecycle != SpaceLifecycle::Active {
                return Err(DomainError::ResourceNotFound.into());
            }

            let required_seq = match &causal {
                CausalBasis::Exact(receipts) => {
                    let mut max_s = SpaceSeq::ZERO;
                    for r in receipts.for_scope(&scope)? {
                        let s = r.seq();
                        if s > SpaceSeq::ZERO {
                            if s > space_rec.last_seq {
                                return Err(
                                    DomainError::validation(ValidationReason::InvalidCutoff).into()
                                );
                            }
                            let mut cstmt = conn
                                .prepare_cached(
                                    "SELECT 1 FROM change_commands
                                     WHERE space_id = ?1 AND history_incarnation = ?2 AND last_seq = ?3
                                     LIMIT 1",
                                )
                                .map_err(|err| {
                                    internal_not_committed("sqlite_check_cutoff", err.to_string())
                                })?;
                            let found: Option<i64> = cstmt
                                .query_row(
                                    params![
                                        scope.space_id.as_str(),
                                        scope.incarnation.as_bytes().as_slice(),
                                        s.get() as i64,
                                    ],
                                    |row| row.get(0),
                                )
                                .optional()
                                .map_err(|err| {
                                    map_interrupt_or_internal(err, "sqlite_check_cutoff")
                                })?;
                            if found.is_none() {
                                return Err(
                                    DomainError::validation(ValidationReason::InvalidCutoff).into()
                                );
                            }
                        }
                        max_s = max_s.max(s);
                    }
                    max_s
                }
                CausalBasis::Await(wm) => {
                    let s = wm.required(&scope)?;
                    if s > space_rec.last_seq {
                        return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
                    }
                    s
                }
            };
            if required_seq > space_rec.last_seq {
                return Err(DomainError::validation(ValidationReason::InvalidCutoff).into());
            }

            if has_any_purge_fences
                && is_note_purge_fenced_rusqlite(conn, &scope.space_id, req_note.as_str())?
            {
                return Err(DomainError::ResourceNotFound.into());
            }

            let live_head = load_note_head_row_rusqlite(conn, &scope.space_id, &req_note)?;
            if live_head.lifecycle == Lifecycle::Purged {
                return Err(DomainError::ResourceNotFound.into());
            }

            let (live_facts, _) = build_resource_facts_rusqlite(
                conn,
                &space_rec.space,
                &live_head.parent_folder_id,
                live_head.doc_class,
                live_head.ability_id.clone(),
                false,
            )?;
            auth.authorize_read(&live_facts)?;

            let target_rev_id = req_rev_opt.unwrap_or_else(|| live_head.head_rev_id.clone());
            let raw_meta: Option<Vec<u8>> = {
                let mut rstmt = conn
                    .prepare_cached(
                        "SELECT metadata_msgpack FROM revisions
                         WHERE space_id = ?1 AND rev_id = ?2 AND entity_type = 'note' AND entity_key = ?3",
                    )
                    .map_err(|err| {
                        internal_not_committed("sqlite_get_note_rev", err.to_string())
                    })?;
                rstmt
                    .query_row(
                        params![
                            scope.space_id.as_str(),
                            target_rev_id.as_str(),
                            req_note.as_str(),
                        ],
                        |row| row.get(0),
                    )
                    .optional()
                    .map_err(|err| map_interrupt_or_internal(err, "sqlite_get_note_rev"))?
            };
            let Some(raw_meta) = raw_meta else {
                return Err(DomainError::ResourceNotFound.into());
            };
            let env = RevisionMetadataEnvelope::decode(&raw_meta)?;
            let RevisionMetadataPayload::Note(nm) = env.payload else {
                return Err(internal_not_committed(
                    "corrupt_note_rev_payload",
                    "expected Note metadata payload",
                ));
            };
            if nm.lifecycle == Lifecycle::Purged {
                return Err(DomainError::ResourceNotFound.into());
            }
            let digest = nm.content_digest.ok_or_else(|| {
                internal_not_committed("note_rev_missing_digest", "note revision lacks digest")
            })?;
            let parent_opt = (nm.parent_folder_id != space_rec.root_folder_id).then_some(nm.parent_folder_id);
            let effective_lc = if target_rev_id == live_head.head_rev_id {
                live_head.lifecycle
            } else {
                nm.lifecycle
            };

            let fields: BTreeMap<String, FieldObservation<FieldValue>> =
                if live_head.doc_class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else if target_rev_id == live_head.head_rev_id {
                    let cur_schema = if has_any_space_schemas {
                        load_current_space_schema_rusqlite(conn, &scope.space_id)?
                    } else {
                        None
                    };
                    if cur_schema.as_ref().map(|s| &s.schema_revision)
                        == nm.schema_revision.as_ref()
                    {
                        nm.evaluated_fields
                    } else {
                        evaluate_fields_with_schema(
                            nm.raw_fields.as_ref(),
                            nm.diagnostics.first(),
                            cur_schema.as_ref().map(|s| &s.fields),
                        )
                    }
                } else {
                    nm.evaluated_fields
                };

            let fast_local_read = if let Some(guard) =
                local_store.try_acquire_shared_guard(&scope.space_id, digest)
            {
                let raw_size = load_active_blob_raw_size_rusqlite(conn, &scope.space_id, digest)?;
                Some(FastLocalBlobReadPlan::new(
                    Arc::clone(&local_store),
                    scope.space_id.clone(),
                    digest,
                    raw_size,
                    guard,
                ))
            } else {
                None
            };

                Ok((
                    target_rev_id,
                    live_facts,
                    effective_lc,
                    digest,
                    parent_opt,
                    nm.byte_size,
                    fields,
                    nm.diagnostics,
                    fast_local_read,
                ))
            },
            move |(
                rev_id,
                live_facts,
                lifecycle,
                digest,
                parent_opt,
                byte_size,
                fields,
                diagnostics,
                fast_local_read,
            )| {
                let (eager_raw, deferred) = match fast_local_read {
                    Some(plan) if byte_size <= 64 * 1024 => (Some(plan.read_verified()?), None),
                    other => (None, other),
                };
                Ok((
                    rev_id,
                    live_facts,
                    lifecycle,
                    digest,
                    parent_opt,
                    byte_size,
                    fields,
                    diagnostics,
                    eager_raw,
                    deferred,
                ))
            },
        )
        .await?;

    let raw_bytes = match (eager_raw_bytes, deferred_plan) {
        (Some(bytes), _) => bytes,
        (None, Some(plan)) => plan.read_verified_async().await?,
        (None, None) => store.read_verified_blob(ctx.scope(), digest).await?,
    };
    let content = String::from_utf8(raw_bytes)
        .map_err(|_| internal_not_committed("get_note_utf8", "note carrier is not valid UTF-8"))?;

    let live_facts = crate::domain::notes::recheck_note_read(store, &ctx, &request.note).await?;
    if live_facts.class != initial_facts.class {
        return Err(DomainError::ResourceNotFound.into());
    }

    let document = ClassifiedDocument::from_canonical(
        NoteRef {
            space_id: ctx.scope().space_id.clone(),
            note_id: request.note,
        },
        rev_id,
        live_facts,
        lifecycle,
        content,
        digest,
    )?;

    if writer_active {
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
    }
    drop(_active_read_permit);

    Ok(NoteSnapshot {
        document,
        parent: parent_opt,
        byte_size,
        fields,
        diagnostics,
    })
}

pub(crate) enum FastItemExecError {
    PreWrite(PortError),
    PostWrite(PortError),
}

#[derive(Default)]
pub(crate) struct FastBatchSqlCache {
    current_writer_gen: u64,
    folder_ancestry: HashMap<(SpaceId, FolderId, bool), FolderAncestryFacts>,
    space_schemas: HashMap<SpaceId, Option<Arc<CurrentSpaceSchema>>>,
    space_has_purge_fences: HashMap<SpaceId, bool>,
    space_has_collab_sessions: HashMap<SpaceId, bool>,
    in_batch_receipts:
        HashMap<(SpaceId, HistoryIncarnation, PrincipalId, CommandKey), StoredReceiptRow>,
    in_batch_modified_notes: HashSet<(SpaceId, NoteId)>,
    in_batch_new_blobs: HashMap<(SpaceId, ContentDigest), (usize, String)>,
}

#[derive(Clone, Copy)]
struct SqlBlob16([u8; 16]);

impl ToSql for SqlBlob16 {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::Borrowed(
            rusqlite::types::ValueRef::Blob(&self.0),
        ))
    }
}

#[derive(Clone, Copy)]
struct SqlBlob32([u8; 32]);

impl ToSql for SqlBlob32 {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        Ok(rusqlite::types::ToSqlOutput::Borrowed(
            rusqlite::types::ValueRef::Blob(&self.0),
        ))
    }
}

struct DeferredRevisionRow {
    space_id: String,
    incarnation: SqlBlob16,
    rev_id: String,
    entity_type: &'static str,
    entity_key: String,
    space_seq: i64,
    visibility_seq: i64,
    parent_rev_id: Option<String>,
    restored_from_rev_id: Option<String>,
    content_blake3: Option<SqlBlob32>,
    metadata_msgpack: Vec<u8>,
    actor_id: String,
    agent_run_id: Option<String>,
    sec: i64,
    nsec: i32,
}

struct DeferredChangePayloadRow {
    space_id: String,
    payload_id: String,
    codec: String,
    effect_msgpack: Vec<u8>,
    created_seq: i64,
}

struct DeferredPayloadOwnerRow {
    space_id: String,
    payload_kind: &'static str,
    payload_id: String,
    note_id: String,
}

struct DeferredChangeCommandRow {
    space_id: String,
    incarnation: SqlBlob16,
    command_id: String,
    first_seq: i64,
    last_seq: i64,
    command_kind: String,
    payload_id: Option<String>,
    committed_at_ms: i64,
}

struct DeferredChangeLogRow {
    space_id: String,
    space_seq: i64,
    incarnation: SqlBlob16,
    command_id: String,
    command_first_seq: i64,
    command_last_seq: i64,
    entity_type: String,
    entity_id: String,
    op_kind: String,
    rev_id: String,
    lifecycle_state: &'static str,
    doc_class: Option<&'static str>,
    payload_id: Option<String>,
    committed_at_ms: i64,
}

struct DeferredCommandReceiptRow {
    space_id: String,
    incarnation: SqlBlob16,
    actor_id: String,
    idempotency_key: String,
    command_hash: SqlBlob32,
    status: &'static str,
    response_payload_id: Option<String>,
    sanitized_blob: Vec<u8>,
    canonical_seq: i64,
    expires_at_ms: i64,
}

struct DeferredBlobCatalogRow {
    space_id: String,
    content_blake3: SqlBlob32,
    raw_size: i64,
    compressed_size: i64,
    ref_count: i64,
    publication_id: String,
    now_ms: i64,
}

struct DeferredBlobPubRow {
    space_id: String,
    publication_id: String,
    content_blake3: SqlBlob32,
    owner_epoch: i64,
    raw_size: i64,
    compressed_size: i64,
    now_ms: i64,
}

struct DeferredBlobRefRow {
    space_id: String,
    owner_kind: &'static str,
    owner_id: String,
    owner_rev_id: String,
    resource_key: String,
    content_blake3: SqlBlob32,
    publication_id: String,
    created_seq: i64,
}

#[derive(Default)]
pub(crate) struct DeferredAppendRows {
    blob_catalog: Vec<DeferredBlobCatalogRow>,
    blob_publications: Vec<DeferredBlobPubRow>,
    blob_references: Vec<DeferredBlobRefRow>,
    revisions: Vec<DeferredRevisionRow>,
    change_payloads: Vec<DeferredChangePayloadRow>,
    payload_owners: Vec<DeferredPayloadOwnerRow>,
    change_commands: Vec<DeferredChangeCommandRow>,
    change_log: Vec<DeferredChangeLogRow>,
    command_receipts: Vec<DeferredCommandReceiptRow>,
}

const APPEND_CHUNK_SIZES: [usize; 4] = [25, 10, 4, 1];

fn build_multi_insert_templates(prefix: &str, row_tpl: &str) -> [String; 4] {
    APPEND_CHUNK_SIZES.map(|n| {
        let mut sql = String::with_capacity(prefix.len() + n * (row_tpl.len() + 2));
        sql.push_str(prefix);
        for i in 0..n {
            if i > 0 {
                sql.push_str(", ");
            }
            sql.push_str(row_tpl);
        }
        sql
    })
}

static BLOB_CATALOG_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO blob_catalog (
            space_id, content_blake3, raw_size, compressed_size, ref_count,
            current_publication_id, admission_state, blob_state, touched_at_ms
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, 'open', 'active', ?)",
    )
});

static BLOB_PUBLICATIONS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO blob_publications (
            space_id, publication_id, content_blake3, owner_epoch, codec,
            state, manifest_sealed, part_count, raw_size, compressed_size,
            created_at_ms, updated_at_ms
         ) VALUES ",
        "(?, ?, ?, ?, 'local_zstd_v1', 'active', 1, 1, ?, ?, ?, ?)",
    )
});

static BLOB_REFERENCES_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT OR IGNORE INTO blob_references (
            space_id, owner_kind, owner_id, owner_rev_id, resource_key,
            content_blake3, publication_id, created_seq
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, ?, ?)",
    )
});

static REVISIONS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO revisions (
            space_id, history_incarnation, rev_id, entity_type, entity_key,
            space_seq, visibility_seq, parent_rev_id, their_rev_id,
            restored_from_rev_id, content_blake3, metadata_msgpack,
            patch_meta_json, actor_id, session_id, agent_run_id,
            quarantine_reason, created_at_sec, created_at_nsec
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)",
    )
});

static CHANGE_PAYLOADS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO change_payloads (
            space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq
         ) VALUES ",
        "(?, ?, ?, 0, ?, ?)",
    )
});

static PAYLOAD_OWNERS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT OR IGNORE INTO payload_owners (
            space_id, payload_kind, payload_id, note_id
         ) VALUES ",
        "(?, ?, ?, ?)",
    )
});

static CHANGE_COMMANDS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO change_commands (
            space_id, history_incarnation, command_id, first_seq, last_seq,
            command_kind, payload_id, committed_at_ms
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, ?, ?)",
    )
});

static CHANGE_LOG_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO change_log (
            space_id, space_seq, history_incarnation, command_id,
            command_first_seq, command_last_seq, entity_type, entity_id,
            op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
});

static COMMAND_RECEIPTS_MULTI_SQL: LazyLock<[String; 4]> = LazyLock::new(|| {
    build_multi_insert_templates(
        "INSERT INTO command_receipts (
            space_id, history_incarnation, actor_id, idempotency_key, command_hash,
            status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
            canonical_seq, expires_at_ms
         ) VALUES ",
        "(?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)",
    )
});

fn flush_chunked_rows<T, F>(
    conn: &rusqlite::Connection,
    rows: &[T],
    templates: &[String; 4],
    cols_per_row: usize,
    err_code: &'static str,
    mut push_row: F,
) -> Result<(), PortError>
where
    F: for<'a> FnMut(&'a T, &mut Vec<&'a dyn ToSql>),
{
    if rows.is_empty() {
        return Ok(());
    }
    let mut params_buf: Vec<&dyn ToSql> = Vec::with_capacity(APPEND_CHUNK_SIZES[0] * cols_per_row);
    let mut idx = 0;
    while idx < rows.len() {
        let rem = rows.len() - idx;
        let (tier_idx, chunk_len) = APPEND_CHUNK_SIZES
            .iter()
            .enumerate()
            .find(|(_, sz)| **sz <= rem)
            .map(|(ti, sz)| (ti, *sz))
            .unwrap_or((3, 1));
        let chunk = &rows[idx..idx + chunk_len];
        params_buf.clear();
        for row in chunk {
            push_row(row, &mut params_buf);
        }
        let mut stmt = conn
            .prepare_cached(&templates[tier_idx])
            .map_err(|err| internal_not_committed(err_code, err.to_string()))?;
        stmt.execute(params_from_iter(params_buf.iter().copied()))
            .map_err(|err| internal_not_committed(err_code, err.to_string()))?;
        idx += chunk_len;
    }
    Ok(())
}

impl DeferredAppendRows {
    fn flush(mut self, conn: &rusqlite::Connection) -> Result<(), PortError> {
        self.blob_catalog.sort_unstable_by(|a, b| {
            (&a.space_id, &a.content_blake3.0).cmp(&(&b.space_id, &b.content_blake3.0))
        });
        self.blob_publications.sort_unstable_by(|a, b| {
            (&a.space_id, &a.publication_id).cmp(&(&b.space_id, &b.publication_id))
        });
        self.revisions
            .sort_unstable_by(|a, b| (&a.space_id, &a.rev_id).cmp(&(&b.space_id, &b.rev_id)));
        self.change_payloads.sort_unstable_by(|a, b| {
            (&a.space_id, &a.payload_id).cmp(&(&b.space_id, &b.payload_id))
        });
        self.change_commands.sort_unstable_by(|a, b| {
            (&a.space_id, &a.incarnation.0, &a.command_id).cmp(&(
                &b.space_id,
                &b.incarnation.0,
                &b.command_id,
            ))
        });
        self.payload_owners.sort_unstable_by(|a, b| {
            (&a.space_id, a.payload_kind, &a.payload_id, &a.note_id).cmp(&(
                &b.space_id,
                b.payload_kind,
                &b.payload_id,
                &b.note_id,
            ))
        });
        self.command_receipts.sort_unstable_by(|a, b| {
            (
                &a.space_id,
                &a.incarnation.0,
                &a.actor_id,
                &a.idempotency_key,
            )
                .cmp(&(
                    &b.space_id,
                    &b.incarnation.0,
                    &b.actor_id,
                    &b.idempotency_key,
                ))
        });
        self.blob_references.sort_unstable_by(|a, b| {
            (
                &a.space_id,
                a.owner_kind,
                &a.owner_rev_id,
                &a.owner_id,
                &a.resource_key,
            )
                .cmp(&(
                    &b.space_id,
                    b.owner_kind,
                    &b.owner_rev_id,
                    &b.owner_id,
                    &b.resource_key,
                ))
        });

        flush_chunked_rows(
            conn,
            &self.blob_catalog,
            &BLOB_CATALOG_MULTI_SQL,
            7,
            "sqlite_multi_insert_blob_catalog",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.content_blake3);
                out.push(&r.raw_size);
                out.push(&r.compressed_size);
                out.push(&r.ref_count);
                out.push(&r.publication_id);
                out.push(&r.now_ms);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.blob_publications,
            &BLOB_PUBLICATIONS_MULTI_SQL,
            8,
            "sqlite_multi_insert_blob_pubs",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.publication_id);
                out.push(&r.content_blake3);
                out.push(&r.owner_epoch);
                out.push(&r.raw_size);
                out.push(&r.compressed_size);
                out.push(&r.now_ms);
                out.push(&r.now_ms);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.blob_references,
            &BLOB_REFERENCES_MULTI_SQL,
            8,
            "sqlite_multi_insert_blob_refs",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.owner_kind);
                out.push(&r.owner_id);
                out.push(&r.owner_rev_id);
                out.push(&r.resource_key);
                out.push(&r.content_blake3);
                out.push(&r.publication_id);
                out.push(&r.created_seq);
            },
        )?;
        flush_chunked_rows(
            conn,
            &self.revisions,
            &REVISIONS_MULTI_SQL,
            15,
            "sqlite_multi_insert_revisions",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.incarnation);
                out.push(&r.rev_id);
                out.push(&r.entity_type);
                out.push(&r.entity_key);
                out.push(&r.space_seq);
                out.push(&r.visibility_seq);
                out.push(&r.parent_rev_id);
                out.push(&r.restored_from_rev_id);
                out.push(&r.content_blake3);
                out.push(&r.metadata_msgpack);
                out.push(&r.actor_id);
                out.push(&r.agent_run_id);
                out.push(&r.sec);
                out.push(&r.nsec);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.change_payloads,
            &CHANGE_PAYLOADS_MULTI_SQL,
            5,
            "sqlite_multi_insert_change_payloads",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.payload_id);
                out.push(&r.codec);
                out.push(&r.effect_msgpack);
                out.push(&r.created_seq);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.payload_owners,
            &PAYLOAD_OWNERS_MULTI_SQL,
            4,
            "sqlite_multi_insert_payload_owners",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.payload_kind);
                out.push(&r.payload_id);
                out.push(&r.note_id);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.change_commands,
            &CHANGE_COMMANDS_MULTI_SQL,
            8,
            "sqlite_multi_insert_change_commands",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.incarnation);
                out.push(&r.command_id);
                out.push(&r.first_seq);
                out.push(&r.last_seq);
                out.push(&r.command_kind);
                out.push(&r.payload_id);
                out.push(&r.committed_at_ms);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.change_log,
            &CHANGE_LOG_MULTI_SQL,
            14,
            "sqlite_multi_insert_change_log",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.space_seq);
                out.push(&r.incarnation);
                out.push(&r.command_id);
                out.push(&r.command_first_seq);
                out.push(&r.command_last_seq);
                out.push(&r.entity_type);
                out.push(&r.entity_id);
                out.push(&r.op_kind);
                out.push(&r.rev_id);
                out.push(&r.lifecycle_state);
                out.push(&r.doc_class);
                out.push(&r.payload_id);
                out.push(&r.committed_at_ms);
            },
        )?;

        flush_chunked_rows(
            conn,
            &self.command_receipts,
            &COMMAND_RECEIPTS_MULTI_SQL,
            10,
            "sqlite_multi_insert_command_receipts",
            |r, out| {
                out.push(&r.space_id);
                out.push(&r.incarnation);
                out.push(&r.actor_id);
                out.push(&r.idempotency_key);
                out.push(&r.command_hash);
                out.push(&r.status);
                out.push(&r.response_payload_id);
                out.push(&r.sanitized_blob);
                out.push(&r.canonical_seq);
                out.push(&r.expires_at_ms);
            },
        )?;

        Ok(())
    }
}

pub(crate) trait SqliteSyncItemPlan: Send {
    fn take_deferred_local_staging(&self) -> Option<DeferredLocalStaging>;

    fn phase1_receipt_checked_at_gen(&self) -> Option<u64> {
        None
    }

    fn requires_savepoint_isolation(&self) -> bool {
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_sqlite_sync(
        &self,
        conn: &rusqlite::Connection,
        ctx: &mut ItemExecCtx,
        cache: &mut FastBatchSqlCache,
        batch_now_ts: Timestamp,
        batch_now_ms: i64,
        defer_append: Option<&mut DeferredAppendRows>,
    ) -> Result<ItemCommitArtifacts, FastItemExecError>;

    fn into_async_exec(self: Box<Self>) -> ItemExecuteFn;
}

struct FastIntentMeta {
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    idempotency: Option<CommandIdentitySpec>,
    source_note_ids: Vec<NoteId>,
    required_semantic_cut: Option<(SpaceSeq, SemanticCutMismatchKind)>,
}

struct FastBatchPendingWaves {
    space_states: BTreeMap<SpaceId, SpaceBatchEntry>,
    batch_dir_syncs: PendingDirSyncs,
    batch_retained_tickets: Vec<StagedBlobTicket>,
    batch_retained_guards: Vec<Box<dyn Send>>,
    slots: Vec<ItemOutcomeSlot>,
}

enum FastSqlStageResult {
    AbortedBeforeCommit(PortError),
    CommittedDirectly {
        space_states: BTreeMap<SpaceId, SpaceBatchEntry>,
        slots: Vec<ItemOutcomeSlot>,
        wal_frames: Option<u64>,
    },
    UnknownDirectCommit {
        slots: Vec<ItemOutcomeSlot>,
        diag_reason: String,
    },
    NeedsLocalWaves(FastBatchPendingWaves),
}

enum EarlyWaveApproval {
    ApproveAll,
    RetainedOnly(HashSet<(String, ContentDigest)>),
    Abort,
}

enum LocalCasWaveOutcome {
    Completed {
        synced_dirs: PendingDirSyncs,
        newly_published: Vec<(SpaceId, ContentDigest)>,
    },
    Aborted,
}

pub(crate) async fn execute_sqlite_fast_batch(
    store: &CanonicalStore,
    pair: &mut SqliteWriterPair,
    items: Vec<(PreparedWriteIntent, Option<Box<dyn SqliteSyncItemPlan>>)>,
    cfg: WriterConfig,
    faults: &WriterFaultState,
) -> BatchExecOutcome {
    let rconn = match pair.rusqlite_conn.take() {
        Some(c) => c,
        None => match open_rusqlite_writer_connection(&pair.db_path) {
            Ok(c) => c,
            Err(err) => return BatchExecOutcome::AbortedBeforeCommit(err),
        },
    };

    let wal_opt = store.inner.wal_coord.get().cloned();
    let mut fast_items: Vec<(FastIntentMeta, Box<dyn SqliteSyncItemPlan>)> =
        Vec::with_capacity(items.len());
    let mut extracted_stagings: Vec<DeferredLocalStaging> = Vec::with_capacity(items.len());

    for (intent, plan_opt) in items {
        let Some(plan) = plan_opt else {
            pair.rusqlite_conn = Some(rconn);
            return BatchExecOutcome::AbortedBeforeCommit(internal_not_committed(
                "sqlite_fast_missing_plan",
                "fast batch invoked with missing SqliteSyncItemPlan",
            ));
        };
        if let Some(staging) = plan.take_deferred_local_staging() {
            extracted_stagings.push(staging);
        }
        fast_items.push((
            FastIntentMeta {
                scope: intent.scope,
                active_epoch: intent.active_epoch,
                idempotency: intent.idempotency,
                source_note_ids: intent.source_note_ids,
                required_semantic_cut: intent.required_semantic_cut,
            },
            plan,
        ));
    }

    let has_external_stagings = !extracted_stagings.is_empty();
    let wal_stage1 = wal_opt.clone();
    let current_writer_gen = store.inner.sqlite_writer_commit_gen.load(Ordering::Acquire);

    let (wave_approval_tx, wave_approval_rx) = tokio::sync::oneshot::channel::<EarlyWaveApproval>();

    let stage1_fut = tokio::task::spawn_blocking(move || {
        let mut approval_tx_opt = Some(wave_approval_tx);
        let stage = run_sqlite_fast_sql_stage(
            &rconn,
            fast_items,
            cfg,
            wal_stage1.as_deref(),
            has_external_stagings,
            current_writer_gen,
            &mut approval_tx_opt,
        );
        if let Some(tx) = approval_tx_opt.take() {
            match &stage {
                FastSqlStageResult::NeedsLocalWaves(pending) => {
                    let mut retained_keys =
                        HashSet::with_capacity(pending.batch_retained_tickets.len());
                    for ticket in &pending.batch_retained_tickets {
                        if let Some(key) = &ticket.deferred_local_key {
                            retained_keys.insert(key.clone());
                        }
                    }
                    let _ = tx.send(EarlyWaveApproval::RetainedOnly(retained_keys));
                }
                _ => {
                    let _ = tx.send(EarlyWaveApproval::Abort);
                }
            }
        }
        (rconn, stage)
    });

    let local_cas_fut = async {
        if !has_external_stagings {
            return Ok::<LocalCasWaveOutcome, PortError>(LocalCasWaveOutcome::Completed {
                synced_dirs: PendingDirSyncs::default(),
                newly_published: Vec::new(),
            });
        }
        let synced_entries = store
            .prepare_and_sync_local_stagings_async(extracted_stagings)
            .await?;

        let keys_to_publish = match wave_approval_rx.await {
            Ok(EarlyWaveApproval::ApproveAll) => {
                let mut all_keys = HashSet::with_capacity(synced_entries.len());
                for entry in &synced_entries {
                    all_keys.insert((entry.space_id_str.clone(), entry.digest));
                }
                all_keys
            }
            Ok(EarlyWaveApproval::RetainedOnly(keys)) => keys,
            Ok(EarlyWaveApproval::Abort) | Err(_) => {
                drop(synced_entries);
                return Ok(LocalCasWaveOutcome::Aborted);
            }
        };

        let mut newly_published = Vec::new();
        for entry in &synced_entries {
            if entry.temp_file.is_some()
                && keys_to_publish.contains(&(entry.space_id_str.clone(), entry.digest))
            {
                newly_published.push((entry.space_id.clone(), entry.digest));
            }
        }

        let synced_dirs = store
            .rename_synced_local_entries_async(synced_entries, &keys_to_publish)
            .await?;

        store.flush_pending_local_dirs_async(&synced_dirs).await?;

        Ok(LocalCasWaveOutcome::Completed {
            synced_dirs,
            newly_published,
        })
    };

    let (stage1_join, local_cas_res) = tokio::join!(stage1_fut, local_cas_fut);

    let cleanup_all_published =
        |cas_res: Result<LocalCasWaveOutcome, PortError>| -> Vec<(SpaceId, ContentDigest)> {
            match cas_res {
                Ok(LocalCasWaveOutcome::Completed {
                    newly_published, ..
                }) => newly_published,
                _ => Vec::new(),
            }
        };

    let (mut rconn, stage1_res) = match stage1_join {
        Ok(pair_out) => pair_out,
        Err(join_err) => {
            store
                .cleanup_unretained_local_files_async(cleanup_all_published(local_cas_res))
                .await;
            if let Ok(reopened) = open_rusqlite_writer_connection(&pair.db_path) {
                pair.rusqlite_conn = Some(reopened);
            }
            return BatchExecOutcome::AbortedBeforeCommit(internal_not_committed(
                "sqlite_fast_stage1_join",
                join_err.to_string(),
            ));
        }
    };

    match stage1_res {
        FastSqlStageResult::AbortedBeforeCommit(err) => {
            store
                .cleanup_unretained_local_files_async(cleanup_all_published(local_cas_res))
                .await;
            restore_writer_rconn(pair, rconn);
            BatchExecOutcome::AbortedBeforeCommit(err)
        }
        FastSqlStageResult::UnknownDirectCommit { slots, diag_reason } => {
            store
                .cleanup_unretained_local_files_async(cleanup_all_published(local_cas_res))
                .await;
            store
                .inner
                .sqlite_writer_commit_gen
                .fetch_add(1, Ordering::Release);
            restore_writer_rconn(pair, rconn);
            BatchExecOutcome::UnknownCommit { slots, diag_reason }
        }
        FastSqlStageResult::CommittedDirectly {
            space_states,
            slots,
            wal_frames,
        } => {
            drop(local_cas_res);
            store
                .inner
                .sqlite_writer_commit_gen
                .fetch_add(1, Ordering::Release);
            if let Some(w) = wal_opt.as_deref() {
                w.note_writer_commit_with_frames(wal_frames);
            }
            restore_writer_rconn(pair, rconn);
            finalize_committed_batch(store, &space_states, slots, faults)
        }
        FastSqlStageResult::NeedsLocalWaves(pending) => {
            let mut published_for_abort_cleanup = Vec::new();
            let wave_res: Result<(), PortError> = async {
                match local_cas_res? {
                    LocalCasWaveOutcome::Completed {
                        synced_dirs,
                        newly_published,
                    } => {
                        if !newly_published.is_empty() {
                            let mut retained_keys =
                                HashSet::with_capacity(pending.batch_retained_tickets.len());
                            for ticket in &pending.batch_retained_tickets {
                                if let Some(key) = &ticket.deferred_local_key {
                                    retained_keys.insert(key.clone());
                                }
                            }
                            let mut unretained = Vec::new();
                            let mut kept = Vec::with_capacity(newly_published.len());
                            for (sp, dig) in newly_published {
                                if retained_keys.contains(&(sp.as_str().to_owned(), dig)) {
                                    kept.push((sp, dig));
                                } else {
                                    unretained.push((sp, dig));
                                }
                            }
                            published_for_abort_cleanup = kept;
                            if !unretained.is_empty() {
                                store.cleanup_unretained_local_files_async(unretained).await;
                            }
                        }
                        let unsynced = pending.batch_dir_syncs.without(&synced_dirs);
                        if !unsynced.is_empty() {
                            store.flush_pending_local_dirs_async(&unsynced).await?;
                        }
                        Ok(())
                    }
                    LocalCasWaveOutcome::Aborted => Err(internal_not_committed(
                        "sqlite_fast_local_waves_aborted",
                        "local CAS wave aborted unexpectedly before NeedsLocalWaves",
                    )),
                }
            }
            .await;

            match wave_res {
                Err(io_err) => {
                    store
                        .cleanup_unretained_local_files_async(published_for_abort_cleanup)
                        .await;
                    let rollback_join = tokio::task::spawn_blocking(move || {
                        let _ = rconn.execute_batch("ROLLBACK");
                        rconn
                    })
                    .await;
                    if let Ok(rc) = rollback_join {
                        restore_writer_rconn(pair, rc);
                    } else if let Ok(reopened) = open_rusqlite_writer_connection(&pair.db_path) {
                        pair.rusqlite_conn = Some(reopened);
                    }
                    store
                        .inner
                        .sqlite_writer_commit_gen
                        .fetch_add(1, Ordering::Release);
                    drop(pending.batch_retained_tickets);
                    drop(pending.batch_retained_guards);
                    BatchExecOutcome::AbortedBeforeCommit(io_err)
                }
                Ok(()) => {
                    let wal_stage2 = wal_opt.clone();
                    let commit_join = tokio::task::spawn_blocking(move || {
                        let _ = crate::wal::take_last_wal_commit_frames();
                        let res = rconn.execute_batch("COMMIT");
                        let frames = crate::wal::take_last_wal_commit_frames();
                        if let Err(ref err) = res
                            && let Some(w) = wal_stage2.as_deref()
                        {
                            record_rusqlite_busy(w, err);
                        }
                        (rconn, res, frames)
                    })
                    .await;

                    let (commit_res, wal_frames) = match commit_join {
                        Ok((rc, res, frames)) => {
                            rconn = rc;
                            restore_writer_rconn(pair, rconn);
                            (res.map_err(|e| format!("{e:?}")), frames)
                        }
                        Err(join_err) => {
                            if let Ok(reopened) = open_rusqlite_writer_connection(&pair.db_path) {
                                pair.rusqlite_conn = Some(reopened);
                            }
                            (Err(format!("commit join error: {join_err}")), None)
                        }
                    };

                    store
                        .inner
                        .sqlite_writer_commit_gen
                        .fetch_add(1, Ordering::Release);
                    drop(pending.batch_retained_tickets);
                    drop(pending.batch_retained_guards);

                    match commit_res {
                        Ok(()) => {
                            if let Some(w) = wal_opt.as_deref() {
                                w.note_writer_commit_with_frames(wal_frames);
                            }
                            finalize_committed_batch(
                                store,
                                &pending.space_states,
                                pending.slots,
                                faults,
                            )
                        }
                        Err(diag_reason) => BatchExecOutcome::UnknownCommit {
                            slots: pending.slots,
                            diag_reason,
                        },
                    }
                }
            }
        }
    }
}

fn restore_writer_rconn(pair: &mut SqliteWriterPair, conn: rusqlite::Connection) {
    if !conn.is_autocommit() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    if conn.is_autocommit() {
        pair.rusqlite_conn = Some(conn);
    } else {
        let _ = conn.close();
        if let Ok(fresh) = open_rusqlite_writer_connection(&pair.db_path) {
            pair.rusqlite_conn = Some(fresh);
        }
    }
}

fn finalize_committed_batch(
    store: &CanonicalStore,
    space_states: &BTreeMap<SpaceId, SpaceBatchEntry>,
    slots: Vec<ItemOutcomeSlot>,
    faults: &WriterFaultState,
) -> BatchExecOutcome {
    let mut space_effective_cuts = BTreeMap::new();
    for (sid, entry) in space_states {
        if let SpaceBatchEntry::Loaded {
            record,
            persisted_initial_seq,
            effective_cut,
            max_purge_seq,
        } = entry
        {
            space_effective_cuts.insert(sid.clone(), *effective_cut);
            if *effective_cut > *persisted_initial_seq {
                if let Some(pseq) = max_purge_seq {
                    store.inner.broadcast_hub.publish(BroadcastSignal::Purged {
                        scope: record.scope.clone(),
                        purged_through_seq: *pseq,
                        current_safe_cut: *effective_cut,
                    });
                }
                store
                    .inner
                    .broadcast_hub
                    .publish(BroadcastSignal::Committed {
                        scope: record.scope.clone(),
                        new_last_seq: *effective_cut,
                    });
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
    }
}

fn run_sqlite_fast_sql_stage(
    conn: &rusqlite::Connection,
    items: Vec<(FastIntentMeta, Box<dyn SqliteSyncItemPlan>)>,
    cfg: WriterConfig,
    wal: Option<&SqliteWalCoordinator>,
    has_external_stagings: bool,
    current_writer_gen: u64,
    approval_tx_opt: &mut Option<tokio::sync::oneshot::Sender<EarlyWaveApproval>>,
) -> FastSqlStageResult {
    if items.len() > 1 && items.iter().any(|(_, p)| p.requires_savepoint_isolation()) {
        return run_savepoint_fallback_sql_stage(
            conn,
            &items,
            cfg,
            wal,
            has_external_stagings,
            current_writer_gen,
        );
    }
    match try_run_optimistic_fast_sql_stage(
        conn,
        &items,
        cfg,
        wal,
        has_external_stagings,
        current_writer_gen,
        approval_tx_opt,
    ) {
        Ok(res) => res,
        Err(()) => {
            // Unexpected mid-write SQL error: rollback cleanly and re-execute with per-item SAVEPOINTs!
            let _ = conn.execute_batch("ROLLBACK");
            run_savepoint_fallback_sql_stage(
                conn,
                &items,
                cfg,
                wal,
                has_external_stagings,
                current_writer_gen,
            )
        }
    }
}

fn has_any_pending_blob_retirement_rusqlite(
    conn: &rusqlite::Connection,
) -> Result<bool, PortError> {
    let mut stmt = conn
        .prepare_cached("SELECT 1 FROM blob_retirements WHERE status = 'pending' LIMIT 1")
        .map_err(|err| internal_not_committed("sqlite_check_pending_retire", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row([], |r| r.get(0))
        .optional()
        .map_err(|err| internal_not_committed("sqlite_check_pending_retire", err.to_string()))?;
    Ok(found.is_some())
}

fn try_run_optimistic_fast_sql_stage(
    conn: &rusqlite::Connection,
    items: &[(FastIntentMeta, Box<dyn SqliteSyncItemPlan>)],
    cfg: WriterConfig,
    wal: Option<&SqliteWalCoordinator>,
    has_external_stagings: bool,
    current_writer_gen: u64,
    approval_tx_opt: &mut Option<tokio::sync::oneshot::Sender<EarlyWaveApproval>>,
) -> Result<FastSqlStageResult, ()> {
    if let Err(err) = conn.execute_batch("BEGIN IMMEDIATE") {
        if let Some(w) = wal {
            record_rusqlite_busy(w, &err);
        }
        return Ok(FastSqlStageResult::AbortedBeforeCommit(
            internal_not_committed("sqlite_begin_immediate", err.to_string()),
        ));
    }

    if has_external_stagings
        && let Ok(false) = has_any_pending_blob_retirement_rusqlite(conn)
        && let Some(tx) = approval_tx_opt.take()
    {
        let _ = tx.send(EarlyWaveApproval::ApproveAll);
    }

    let committed_at_ms = match now_unix_ms() {
        Ok(ms) => ms,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Ok(FastSqlStageResult::AbortedBeforeCommit(err));
        }
    };
    let batch_now_ts = match now_utc_timestamp() {
        Ok(ts) => ts,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Ok(FastSqlStageResult::AbortedBeforeCommit(err));
        }
    };
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);

    let mut space_states: BTreeMap<SpaceId, SpaceBatchEntry> = BTreeMap::new();
    let mut batch_dir_syncs = PendingDirSyncs::default();
    let mut batch_retained_tickets: Vec<StagedBlobTicket> = Vec::with_capacity(items.len());
    let mut batch_retained_guards: Vec<Box<dyn Send>> = Vec::new();
    let mut slots: Vec<ItemOutcomeSlot> = Vec::with_capacity(items.len());
    let mut cache = FastBatchSqlCache {
        current_writer_gen,
        ..FastBatchSqlCache::default()
    };
    let mut deferred_append = DeferredAppendRows {
        blob_catalog: Vec::with_capacity(items.len()),
        blob_publications: Vec::with_capacity(items.len()),
        blob_references: Vec::with_capacity(items.len()),
        revisions: Vec::with_capacity(items.len()),
        change_payloads: Vec::with_capacity(items.len()),
        payload_owners: Vec::with_capacity(items.len() * 2),
        change_commands: Vec::with_capacity(items.len()),
        change_log: Vec::with_capacity(items.len()),
        command_receipts: Vec::with_capacity(items.len()),
    };

    for (meta, plan) in items {
        let space_id = meta.scope.space_id.clone();

        if !space_states.contains_key(&space_id) {
            match load_space_record_rusqlite(conn, &space_id) {
                Ok(rec) => {
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
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                    space_states.insert(space_id.clone(), SpaceBatchEntry::Missing);
                }
                Err(err) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Ok(FastSqlStageResult::AbortedBeforeCommit(err));
                }
            }
        }

        let has_idemp = meta.idempotency.is_some();
        let item_res = execute_single_fast_item(
            conn,
            space_states.get(&space_id).expect("space entry populated"),
            meta,
            plan.as_ref(),
            &mut cache,
            batch_now_ts,
            committed_at_ms,
            expires_at_ms,
            current_writer_gen,
            Some(&mut deferred_append),
        );

        match item_res {
            Ok(FastSingleItemSuccess {
                response_bytes,
                new_effective_cut,
                item_purge_seq,
                dir_syncs,
                retained_tickets,
                retained_guards,
            }) => {
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
                batch_retained_guards.extend(retained_guards);
                slots.push(ItemOutcomeSlot::Succeeded {
                    response_bytes,
                    has_idempotency: has_idemp,
                });
            }
            Err(FastItemExecError::PreWrite(item_err)) => {
                slots.push(ItemOutcomeSlot::Failed(item_err));
            }
            Err(FastItemExecError::PostWrite(_)) => {
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                return Err(());
            }
        }
    }

    if deferred_append.flush(conn).is_err() {
        drop(batch_retained_tickets);
        drop(batch_retained_guards);
        return Err(());
    }

    Ok(finish_fast_sql_stage(
        conn,
        space_states,
        batch_dir_syncs,
        batch_retained_tickets,
        batch_retained_guards,
        slots,
        wal,
        has_external_stagings,
    ))
}

fn run_savepoint_fallback_sql_stage(
    conn: &rusqlite::Connection,
    items: &[(FastIntentMeta, Box<dyn SqliteSyncItemPlan>)],
    cfg: WriterConfig,
    wal: Option<&SqliteWalCoordinator>,
    has_external_stagings: bool,
    current_writer_gen: u64,
) -> FastSqlStageResult {
    if let Err(err) = conn.execute_batch("BEGIN IMMEDIATE") {
        if let Some(w) = wal {
            record_rusqlite_busy(w, &err);
        }
        return FastSqlStageResult::AbortedBeforeCommit(internal_not_committed(
            "sqlite_begin_immediate",
            err.to_string(),
        ));
    }

    let committed_at_ms = match now_unix_ms() {
        Ok(ms) => ms,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return FastSqlStageResult::AbortedBeforeCommit(err);
        }
    };
    let batch_now_ts = match now_utc_timestamp() {
        Ok(ts) => ts,
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            return FastSqlStageResult::AbortedBeforeCommit(err);
        }
    };
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);

    let mut space_states: BTreeMap<SpaceId, SpaceBatchEntry> = BTreeMap::new();
    let mut batch_dir_syncs = PendingDirSyncs::default();
    let mut batch_retained_tickets: Vec<StagedBlobTicket> = Vec::new();
    let mut batch_retained_guards: Vec<Box<dyn Send>> = Vec::new();
    let mut slots: Vec<ItemOutcomeSlot> = Vec::with_capacity(items.len());
    let mut cache = FastBatchSqlCache {
        current_writer_gen,
        ..FastBatchSqlCache::default()
    };

    let use_savepoint = items.len() > 1;
    for (meta, plan) in items {
        let space_id = meta.scope.space_id.clone();

        if !space_states.contains_key(&space_id) {
            match load_space_record_rusqlite(conn, &space_id) {
                Ok(rec) => {
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
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                    space_states.insert(space_id.clone(), SpaceBatchEntry::Missing);
                }
                Err(err) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return FastSqlStageResult::AbortedBeforeCommit(err);
                }
            }
        }

        if use_savepoint && let Err(err) = conn.execute_batch("SAVEPOINT sp_item") {
            if let Some(w) = wal {
                record_rusqlite_busy(w, &err);
            }
            let _ = conn.execute_batch("ROLLBACK");
            return FastSqlStageResult::AbortedBeforeCommit(internal_not_committed(
                "sqlite_savepoint",
                err.to_string(),
            ));
        }

        let has_idemp = meta.idempotency.is_some();
        let item_res = execute_single_fast_item(
            conn,
            space_states.get(&space_id).expect("space entry populated"),
            meta,
            plan.as_ref(),
            &mut cache,
            batch_now_ts,
            committed_at_ms,
            expires_at_ms,
            current_writer_gen,
            None,
        );

        match item_res {
            Ok(FastSingleItemSuccess {
                response_bytes,
                new_effective_cut,
                item_purge_seq,
                dir_syncs,
                retained_tickets,
                retained_guards,
            }) => {
                if use_savepoint && let Err(err) = conn.execute_batch("RELEASE SAVEPOINT sp_item") {
                    if let Some(w) = wal {
                        record_rusqlite_busy(w, &err);
                    }
                    let _ = conn.execute_batch("ROLLBACK");
                    return FastSqlStageResult::AbortedBeforeCommit(internal_not_committed(
                        "sqlite_release_savepoint",
                        err.to_string(),
                    ));
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
                batch_retained_guards.extend(retained_guards);
                slots.push(ItemOutcomeSlot::Succeeded {
                    response_bytes,
                    has_idempotency: has_idemp,
                });
            }
            Err(FastItemExecError::PreWrite(item_err) | FastItemExecError::PostWrite(item_err)) => {
                if use_savepoint {
                    if let Err(rb_err) = conn
                        .execute_batch("ROLLBACK TO SAVEPOINT sp_item; RELEASE SAVEPOINT sp_item")
                    {
                        if let Some(w) = wal {
                            record_rusqlite_busy(w, &rb_err);
                        }
                        let _ = conn.execute_batch("ROLLBACK");
                        return FastSqlStageResult::AbortedBeforeCommit(internal_not_committed(
                            "sqlite_rollback_savepoint",
                            rb_err.to_string(),
                        ));
                    }
                    slots.push(ItemOutcomeSlot::Failed(item_err));
                } else {
                    let _ = conn.execute_batch("ROLLBACK");
                    slots.push(ItemOutcomeSlot::Failed(item_err));
                    return FastSqlStageResult::CommittedDirectly {
                        space_states,
                        slots,
                        wal_frames: Some(0),
                    };
                }
            }
        }
    }

    finish_fast_sql_stage(
        conn,
        space_states,
        batch_dir_syncs,
        batch_retained_tickets,
        batch_retained_guards,
        slots,
        wal,
        has_external_stagings,
    )
}

#[allow(clippy::too_many_arguments)]
fn finish_fast_sql_stage(
    conn: &rusqlite::Connection,
    space_states: BTreeMap<SpaceId, SpaceBatchEntry>,
    batch_dir_syncs: PendingDirSyncs,
    batch_retained_tickets: Vec<StagedBlobTicket>,
    batch_retained_guards: Vec<Box<dyn Send>>,
    slots: Vec<ItemOutcomeSlot>,
    wal: Option<&SqliteWalCoordinator>,
    has_external_stagings: bool,
) -> FastSqlStageResult {
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
            if let Err(bump_err) = bump_space_seq_exact_rusqlite(
                conn,
                &record.scope,
                record.active_epoch,
                delta,
                *persisted_initial_seq,
            ) {
                let _ = conn.execute_batch("ROLLBACK");
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                return FastSqlStageResult::AbortedBeforeCommit(bump_err);
            }
        }
    }

    let has_deferred_publish = batch_retained_tickets
        .iter()
        .any(StagedBlobTicket::requires_local_wave_barrier);
    let has_dir_syncs = !batch_dir_syncs.is_empty();

    if !has_external_stagings && !has_deferred_publish && !has_dir_syncs {
        let _ = crate::wal::take_last_wal_commit_frames();
        match conn.execute_batch("COMMIT") {
            Ok(()) => {
                let wal_frames = crate::wal::take_last_wal_commit_frames();
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                FastSqlStageResult::CommittedDirectly {
                    space_states,
                    slots,
                    wal_frames,
                }
            }
            Err(commit_err) => {
                if let Some(w) = wal {
                    record_rusqlite_busy(w, &commit_err);
                }
                drop(batch_retained_tickets);
                drop(batch_retained_guards);
                FastSqlStageResult::UnknownDirectCommit {
                    slots,
                    diag_reason: format!("{commit_err:?}"),
                }
            }
        }
    } else {
        FastSqlStageResult::NeedsLocalWaves(FastBatchPendingWaves {
            space_states,
            batch_dir_syncs,
            batch_retained_tickets,
            batch_retained_guards,
            slots,
        })
    }
}

struct FastSingleItemSuccess {
    response_bytes: Vec<u8>,
    new_effective_cut: SpaceSeq,
    item_purge_seq: Option<SpaceSeq>,
    dir_syncs: PendingDirSyncs,
    retained_tickets: Vec<StagedBlobTicket>,
    retained_guards: Vec<Box<dyn Send>>,
}

#[allow(clippy::too_many_arguments)]
fn execute_single_fast_item(
    conn: &rusqlite::Connection,
    space_entry: &SpaceBatchEntry,
    meta: &FastIntentMeta,
    plan: &dyn SqliteSyncItemPlan,
    cache: &mut FastBatchSqlCache,
    batch_now_ts: Timestamp,
    committed_at_ms: i64,
    expires_at_ms: i64,
    current_writer_gen: u64,
    mut defer_append: Option<&mut DeferredAppendRows>,
) -> Result<FastSingleItemSuccess, FastItemExecError> {
    let (space_rec, current_effective_cut) = match space_entry {
        SpaceBatchEntry::Missing => {
            return Err(FastItemExecError::PreWrite(
                DomainError::ResourceNotFound.into(),
            ));
        }
        SpaceBatchEntry::Loaded {
            record,
            effective_cut,
            ..
        } => (record, *effective_cut),
    };

    space_rec
        .scope
        .check(&meta.scope)
        .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
    if space_rec.active_epoch != meta.active_epoch {
        return Err(FastItemExecError::PreWrite(
            DomainError::validation(ValidationReason::InvalidAuthority).into(),
        ));
    }
    let effective_epoch = meta.active_epoch;

    if let Some(idemp) = &meta.idempotency {
        let rcpt_key = (
            meta.scope.space_id.clone(),
            meta.scope.incarnation,
            idemp.actor.clone(),
            idemp.command_key.clone(),
        );
        let existing_opt = if let Some(in_batch) = cache.in_batch_receipts.get(&rcpt_key) {
            authorize_replay_rusqlite(conn, &meta.scope, idemp)
                .map_err(FastItemExecError::PreWrite)?;
            Some(StoredReceiptRow {
                command_hash: in_batch.command_hash,
                status: in_batch.status.clone(),
                response_blob: in_batch.response_blob.clone(),
            })
        } else if plan.phase1_receipt_checked_at_gen() == Some(current_writer_gen) {
            None
        } else {
            lookup_command_receipt_rusqlite(conn, &meta.scope, idemp)
                .map_err(FastItemExecError::PreWrite)?
        };
        if let Some(existing) = existing_opt {
            if existing.command_hash != idemp.command_hash {
                return Err(FastItemExecError::PreWrite(
                    DomainError::IdempotencyKeyReused.into(),
                ));
            }
            return match existing.status.as_str() {
                "completed" => Ok(FastSingleItemSuccess {
                    response_bytes: existing.response_blob,
                    new_effective_cut: current_effective_cut,
                    item_purge_seq: None,
                    dir_syncs: PendingDirSyncs::default(),
                    retained_tickets: Vec::new(),
                    retained_guards: Vec::new(),
                }),
                _ => Err(FastItemExecError::PreWrite(unavailable_retryable(
                    "command_receipt_pending",
                    "idempotent command is currently pending crash recovery",
                    Duration::from_millis(25),
                ))),
            };
        }
    }

    for note_id in &meta.source_note_ids {
        if is_note_purge_fenced_cached(conn, cache, &meta.scope.space_id, note_id.as_str())
            .map_err(FastItemExecError::PreWrite)?
        {
            return Err(FastItemExecError::PreWrite(
                DomainError::ResourceNotFound.into(),
            ));
        }
    }

    if let Some((expected_cut, _mismatch_kind)) = meta.required_semantic_cut
        && expected_cut != current_effective_cut
    {
        return Err(FastItemExecError::PreWrite(
            DomainError::validation(ValidationReason::CursorStale).into(),
        ));
    }

    let mut item_ctx = ItemExecCtx::new_for_batch(
        meta.scope.clone(),
        space_rec.space.clone(),
        effective_epoch,
        space_rec.root_folder_id.clone(),
        current_effective_cut,
    );

    let artifacts = plan.execute_sqlite_sync(
        conn,
        &mut item_ctx,
        cache,
        batch_now_ts,
        committed_at_ms,
        defer_append.as_deref_mut(),
    )?;

    let allocated_count = item_ctx.allocated_count();
    if allocated_count == 0 || artifacts.events.is_empty() {
        return Err(FastItemExecError::PostWrite(internal_not_committed(
            "writer_item_zero_events",
            "successful mutation item must allocate >= 1 SpaceSeq and emit >= 1 event",
        )));
    }

    let first_seq = SpaceSeq::new(current_effective_cut.get() + 1)
        .map_err(|e| FastItemExecError::PostWrite(e.into()))?;
    let last_seq = item_ctx.current_seq();

    if artifacts.events.len() as u64 != allocated_count {
        return Err(FastItemExecError::PostWrite(internal_not_committed(
            "writer_event_count_mismatch",
            format!(
                "allocated {} SpaceSeq values but emitted {} events",
                allocated_count,
                artifacts.events.len()
            ),
        )));
    }
    for (offset, ev) in artifacts.events.iter().enumerate() {
        let expected_s = current_effective_cut.get() + 1 + (offset as u64);
        if ev.space_seq.get() != expected_s {
            return Err(FastItemExecError::PostWrite(internal_not_committed(
                "writer_event_seq_noncontiguous",
                format!(
                    "expected event seq {expected_s}, got {}",
                    ev.space_seq.get()
                ),
            )));
        }
    }

    let (receipt_status, dir_syncs, retained_tickets, retained_guards) =
        item_ctx.into_batch_parts();

    if let Some(buf) = defer_append {
        let payload_id_opt = artifacts
            .change_payload
            .as_ref()
            .map(|p| p.payload_id.clone());

        if let Some(cp) = artifacts.change_payload {
            for note_id in &cp.owner_note_ids {
                buf.payload_owners.push(DeferredPayloadOwnerRow {
                    space_id: meta.scope.space_id.as_str().to_owned(),
                    payload_kind: "change_payload",
                    payload_id: cp.payload_id.clone(),
                    note_id: note_id.as_str().to_owned(),
                });
            }
            buf.change_payloads.push(DeferredChangePayloadRow {
                space_id: meta.scope.space_id.as_str().to_owned(),
                payload_id: cp.payload_id,
                codec: cp.codec,
                effect_msgpack: cp.effect_msgpack,
                created_seq: last_seq.get() as i64,
            });
        }

        buf.change_commands.push(DeferredChangeCommandRow {
            space_id: meta.scope.space_id.as_str().to_owned(),
            incarnation: SqlBlob16(*meta.scope.incarnation.as_bytes()),
            command_id: artifacts.command_id.clone(),
            first_seq: first_seq.get() as i64,
            last_seq: last_seq.get() as i64,
            command_kind: artifacts.command_kind,
            payload_id: payload_id_opt.clone(),
            committed_at_ms,
        });

        let item_purge_seq = artifacts
            .events
            .iter()
            .filter(|ev| ev.op_kind == "purge")
            .map(|ev| ev.space_seq)
            .max();

        for ev in artifacts.events {
            buf.change_log.push(DeferredChangeLogRow {
                space_id: meta.scope.space_id.as_str().to_owned(),
                space_seq: ev.space_seq.get() as i64,
                incarnation: SqlBlob16(*meta.scope.incarnation.as_bytes()),
                command_id: artifacts.command_id.clone(),
                command_first_seq: first_seq.get() as i64,
                command_last_seq: last_seq.get() as i64,
                entity_type: ev.entity_type,
                entity_id: ev.entity_id,
                op_kind: ev.op_kind,
                rev_id: ev.rev_id.as_str().to_owned(),
                lifecycle_state: lifecycle_to_db(ev.lifecycle),
                doc_class: ev.doc_class.map(doc_class_to_db),
                payload_id: payload_id_opt.clone(),
                committed_at_ms,
            });
        }

        if let Some(idemp) = &meta.idempotency {
            let receipt_owner_key =
                format!("{}:{}", idemp.actor.as_str(), idemp.command_key.as_str());
            let resp_payload_id = if let Some(detail) = artifacts.receipt_detail_blob {
                let pid = format!("rcpt_pay:{receipt_owner_key}");
                buf.change_payloads.push(DeferredChangePayloadRow {
                    space_id: meta.scope.space_id.as_str().to_owned(),
                    payload_id: pid.clone(),
                    codec: "receipt_detail_v1".to_owned(),
                    effect_msgpack: detail.clone(),
                    created_seq: last_seq.get() as i64,
                });
                cache.in_batch_receipts.insert(
                    (
                        meta.scope.space_id.clone(),
                        meta.scope.incarnation,
                        idemp.actor.clone(),
                        idemp.command_key.clone(),
                    ),
                    StoredReceiptRow {
                        command_hash: idemp.command_hash,
                        status: receipt_status.to_owned(),
                        response_blob: detail,
                    },
                );
                Some(pid)
            } else {
                cache.in_batch_receipts.insert(
                    (
                        meta.scope.space_id.clone(),
                        meta.scope.incarnation,
                        idemp.actor.clone(),
                        idemp.command_key.clone(),
                    ),
                    StoredReceiptRow {
                        command_hash: idemp.command_hash,
                        status: receipt_status.to_owned(),
                        response_blob: artifacts.receipt_sanitized_blob.clone(),
                    },
                );
                None
            };

            if resp_payload_id.is_some() {
                for note_id in &artifacts.receipt_owner_note_ids {
                    buf.payload_owners.push(DeferredPayloadOwnerRow {
                        space_id: meta.scope.space_id.as_str().to_owned(),
                        payload_kind: "command_receipt",
                        payload_id: receipt_owner_key.clone(),
                        note_id: note_id.as_str().to_owned(),
                    });
                }
            }

            buf.command_receipts.push(DeferredCommandReceiptRow {
                space_id: meta.scope.space_id.as_str().to_owned(),
                incarnation: SqlBlob16(*meta.scope.incarnation.as_bytes()),
                actor_id: idemp.actor.as_str().to_owned(),
                idempotency_key: idemp.command_key.as_str().to_owned(),
                command_hash: SqlBlob32(*idemp.command_hash.as_bytes()),
                status: receipt_status,
                response_payload_id: resp_payload_id,
                sanitized_blob: artifacts.receipt_sanitized_blob,
                canonical_seq: last_seq.get() as i64,
                expires_at_ms,
            });
        }

        return Ok(FastSingleItemSuccess {
            response_bytes: artifacts.response_bytes,
            new_effective_cut: last_seq,
            item_purge_seq,
            dir_syncs,
            retained_tickets,
            retained_guards,
        });
    }

    let payload_id_opt = artifacts
        .change_payload
        .as_ref()
        .map(|p| p.payload_id.as_str());

    if let Some(cp) = &artifacts.change_payload {
        insert_change_payload_rusqlite(conn, &meta.scope, cp, last_seq)
            .map_err(FastItemExecError::PostWrite)?;
    }

    insert_change_command_and_events_rusqlite(
        conn,
        &meta.scope,
        &artifacts.command_id,
        &artifacts.command_kind,
        first_seq,
        last_seq,
        payload_id_opt,
        &artifacts.events,
        committed_at_ms,
    )
    .map_err(FastItemExecError::PostWrite)?;

    if let Some(idemp) = &meta.idempotency {
        insert_receipt_rusqlite(
            conn,
            &meta.scope,
            idemp,
            receipt_status,
            last_seq,
            artifacts.receipt_detail_blob.as_deref(),
            &artifacts.receipt_sanitized_blob,
            &artifacts.receipt_owner_note_ids,
            expires_at_ms,
        )
        .map_err(FastItemExecError::PostWrite)?;
    }

    let item_purge_seq = artifacts
        .events
        .iter()
        .filter(|ev| ev.op_kind == "purge")
        .map(|ev| ev.space_seq)
        .max();

    Ok(FastSingleItemSuccess {
        response_bytes: artifacts.response_bytes,
        new_effective_cut: last_seq,
        item_purge_seq,
        dir_syncs,
        retained_tickets,
        retained_guards,
    })
}

// ============================================================================
// Fast Item Plans: CreateNote & CarrierReplacement (EditNote)
// ============================================================================

struct CreateNoteFastPlan {
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: Option<CommandIdentitySpec>,
    auth: EngineAuthContext,
    input: CreateNote,
    slug_fold: String,
    info: PreparedCarrierInfo,
    ticket: StagedBlobTicket,
    prealloc_rev_id: RevisionId,
    prealloc_cmd_id: String,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_create_note_fast_intent(
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: Option<CommandIdentitySpec>,
    auth: EngineAuthContext,
    input: CreateNote,
    slug_fold: String,
    info: PreparedCarrierInfo,
    ticket: StagedBlobTicket,
) -> Result<(PreparedWriteIntent, Box<dyn SqliteSyncItemPlan>), PortError> {
    let prealloc_rev_id = new_revision_id()?;
    let prealloc_cmd_id = new_prefixed_hex_id("cmd_")?;
    let staged_bytes = ticket.compressed_size;
    let source_note = input.note.clone();
    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp.clone(),
        source_note_ids: vec![source_note],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(|_tx, _ctx| {
            Box::pin(async {
                Err(internal_not_committed(
                    "fast_intent_placeholder_invoked",
                    "SqliteSyncItemPlan was not materialized before async fallback",
                ))
            })
        }),
    };
    let plan = Box::new(CreateNoteFastPlan {
        scope: scope.clone(),
        active_epoch,
        idemp,
        auth,
        input,
        slug_fold,
        info,
        ticket,
        prealloc_rev_id,
        prealloc_cmd_id,
    });
    Ok((intent, plan))
}

impl SqliteSyncItemPlan for CreateNoteFastPlan {
    fn take_deferred_local_staging(&self) -> Option<DeferredLocalStaging> {
        self.ticket.take_deferred_local_staging()
    }

    fn into_async_exec(self: Box<Self>) -> ItemExecuteFn {
        let me = *self;
        build_create_note_intent(
            &me.scope,
            me.active_epoch,
            me.idemp,
            me.auth,
            me.input,
            me.slug_fold,
            me.info,
            me.ticket,
        )
        .execute
    }

    fn execute_sqlite_sync(
        &self,
        conn: &rusqlite::Connection,
        item_ctx: &mut ItemExecCtx,
        cache: &mut FastBatchSqlCache,
        batch_now_ts: Timestamp,
        batch_now_ms: i64,
        mut defer_append: Option<&mut DeferredAppendRows>,
    ) -> Result<ItemCommitArtifacts, FastItemExecError> {
        let scope_cl = &self.scope;
        let auth = &self.auth;
        let input = &self.input;
        let slug_fold = &self.slug_fold;
        let info = &self.info;

        // --- 1. Read-only preconditions & pure serialization (zero SQL mutations) ---
        let parent_id = input
            .parent
            .clone()
            .unwrap_or_else(|| item_ctx.root_folder_id.clone());

        let (facts, anc) = build_resource_facts_cached(
            conn,
            cache,
            &item_ctx.space,
            &parent_id,
            input.class,
            None,
            true,
        )
        .map_err(FastItemExecError::PreWrite)?;
        auth.authorize_direct_write(&facts, &facts)
            .map_err(|e| FastItemExecError::PreWrite(e.into()))?;

        if let Some(existing) =
            load_note_head_row_opt_rusqlite(conn, &scope_cl.space_id, &input.note)
                .map_err(FastItemExecError::PreWrite)?
        {
            if existing.lifecycle == Lifecycle::Purged {
                return Err(FastItemExecError::PreWrite(
                    DomainError::ResourceNotFound.into(),
                ));
            }
            return Err(FastItemExecError::PreWrite(
                DomainError::RevisionConflict {
                    current: existing.head_rev_id,
                    lineage: None,
                }
                .into(),
            ));
        }

        if active_note_sibling_exists_rusqlite(
            conn,
            &scope_cl.space_id,
            &parent_id,
            slug_fold,
            None,
        )
        .map_err(FastItemExecError::PreWrite)?
        {
            return Err(FastItemExecError::PreWrite(
                DomainError::PathConflict {
                    target: PathTarget {
                        space_id: scope_cl.space_id.clone(),
                        parent: input.parent.clone(),
                        component: input.slug.clone(),
                    },
                }
                .into(),
            ));
        }

        let cat_open_pub = check_local_blob_catalog_open_rusqlite(conn, cache, &self.ticket)
            .map_err(FastItemExecError::PreWrite)?;
        let current_schema = load_current_space_schema_cached(conn, cache, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?;

        let seq = item_ctx
            .alloc_next_seq()
            .map_err(FastItemExecError::PreWrite)?;
        let rev_id = self.prealloc_rev_id.clone();
        let cmd_id = self.prealloc_cmd_id.clone();
        let (sec, nsec) = encode_timestamp_parts(batch_now_ts);
        let seq_i64 = seq.get() as i64;
        let digest = info.prepared_blob.digest;

        let eval_fields = if input.class == DocClass::EncryptedNote {
            BTreeMap::new()
        } else {
            evaluate_fields_with_schema(
                info.raw_fields.as_ref(),
                info.diagnostics.first(),
                current_schema.as_deref().map(|s| &s.fields),
            )
        };

        let changed_fields = changed_note_fields(&EvaluatedFields::new(), &eval_fields);
        let run_opt = extract_agent_run_from_auth(auth);
        let meta =
            RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(NoteRevisionMetadata {
                note_id: input.note.clone(),
                parent_folder_id: parent_id.clone(),
                is_root_child: anc.is_root_child,
                slug: input.slug.clone(),
                slug_fold: slug_fold.clone(),
                title: info.title.clone(),
                doc_class: input.class,
                ability_id: None,
                lifecycle: Lifecycle::Active,
                visibility_mask: 0,
                byte_size: info.byte_size,
                content_digest: Some(digest),
                schema_revision: current_schema.as_deref().map(|s| s.schema_revision.clone()),
                raw_fields: info.raw_fields.clone(),
                evaluated_fields: eval_fields,
                diagnostics: info.diagnostics.clone(),
            }))
            .encode()
            .map_err(FastItemExecError::PreWrite)?;

        let payload_id = format!("eff:{cmd_id}");
        let range =
            CommandSeqRange::new(seq, seq).map_err(|e| FastItemExecError::PreWrite(e.into()))?;
        let cp = build_effect_payload_draft(
            payload_id,
            scope_cl.clone(),
            range,
            "create_note",
            EffectBodyV1::Notes {
                notes: vec![ChangedNoteSummaryV1 {
                    note_id: input.note.clone(),
                    revision: rev_id.clone(),
                    rank_version: note_rank_version_digest(&rev_id, None),
                    lifecycle: Lifecycle::Active,
                    doc_class: input.class,
                    changed_fields,
                }],
            },
            vec![input.note.clone()],
        )
        .map_err(FastItemExecError::PreWrite)?;

        let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)
            .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
        let stored_resp = StoredCommittedNoteRevV1 {
            value: NoteRevision {
                note: input.note.clone(),
                revision: rev_id.clone(),
            },
            receipt,
        };
        let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)
            .map_err(FastItemExecError::PreWrite)?;

        // --- 2. Authoritative SQL writes ---
        cache
            .in_batch_modified_notes
            .insert((scope_cl.space_id.clone(), input.note.clone()));
        item_ctx.record_staged_ticket(self.ticket.clone());
        bind_local_blob_ref_after_open_check_rusqlite(
            conn,
            cache,
            &item_ctx.scope,
            item_ctx.active_epoch,
            &BlobReferenceClaim {
                ticket: self.ticket.clone(),
                owner_kind: BlobOwnerKind::NoteRevision,
                owner_id: input.note.as_str().to_owned(),
                owner_rev_id: rev_id.as_str().to_owned(),
                resource_key: "carrier".to_owned(),
            },
            seq,
            batch_now_ms,
            cat_open_pub,
            defer_append.as_deref_mut(),
        )
        .map_err(FastItemExecError::PostWrite)?;

        let class_str = doc_class_to_db(input.class);
        {
            let mut stmt = conn
                .prepare_cached(
                    "INSERT INTO note_heads (
                        space_id, note_id, parent_folder_id, slug, slug_fold,
                        title, title_fold, doc_class, ability_id, head_rev_id,
                        content_blake3, byte_size, lifecycle_state, visibility_mask,
                        settlement_successor_id, created_seq, updated_seq,
                        created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, 'active', 0, NULL, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_create_note_head",
                        err.to_string(),
                    ))
                })?;
            stmt.execute(params![
                scope_cl.space_id.as_str(),
                input.note.as_str(),
                parent_id.as_str(),
                &input.slug,
                slug_fold,
                &info.title,
                &info.title_fold,
                class_str,
                rev_id.as_str(),
                digest.as_bytes().as_slice(),
                info.byte_size as i64,
                seq_i64,
                seq_i64,
                sec,
                nsec,
                sec,
                nsec,
                auth.principal().as_str(),
            ])
            .map_err(|err| {
                FastItemExecError::PostWrite(internal_not_committed(
                    "sqlite_create_note_head",
                    err.to_string(),
                ))
            })?;
        }

        if let Some(buf) = defer_append {
            buf.revisions.push(DeferredRevisionRow {
                space_id: scope_cl.space_id.as_str().to_owned(),
                incarnation: SqlBlob16(*scope_cl.incarnation.as_bytes()),
                rev_id: rev_id.as_str().to_owned(),
                entity_type: "note",
                entity_key: input.note.as_str().to_owned(),
                space_seq: seq_i64,
                visibility_seq: seq_i64,
                parent_rev_id: None,
                restored_from_rev_id: None,
                content_blake3: Some(SqlBlob32(*digest.as_bytes())),
                metadata_msgpack: meta,
                actor_id: auth.principal().as_str().to_owned(),
                agent_run_id: run_opt.as_ref().map(|r| r.as_str().to_owned()),
                sec,
                nsec,
            });
            if let Some(run_id) = &run_opt {
                upsert_agent_run_head_rusqlite_deferred(
                    conn,
                    scope_cl,
                    run_id,
                    auth.principal(),
                    seq,
                    seq,
                    batch_now_ts,
                    buf,
                )
                .map_err(FastItemExecError::PostWrite)?;
            }
        } else {
            insert_revision_row_rusqlite(
                conn,
                scope_cl,
                &rev_id,
                "note",
                input.note.as_str(),
                seq,
                seq,
                None,
                None,
                Some(digest),
                &meta,
                auth.principal(),
                run_opt.as_ref(),
                batch_now_ts,
            )
            .map_err(FastItemExecError::PostWrite)?;

            if let Some(run_id) = &run_opt {
                upsert_agent_run_head_rusqlite(
                    conn,
                    scope_cl,
                    run_id,
                    auth.principal(),
                    seq,
                    seq,
                    batch_now_ts,
                )
                .map_err(FastItemExecError::PostWrite)?;
            }
        }

        Ok(ItemCommitArtifacts {
            command_id: cmd_id,
            command_kind: "create_note".to_owned(),
            events: vec![BatchEventDraft {
                space_seq: seq,
                entity_type: "note".to_owned(),
                entity_id: input.note.as_str().to_owned(),
                op_kind: "create".to_owned(),
                rev_id,
                lifecycle: Lifecycle::Active,
                doc_class: Some(input.class),
            }],
            change_payload: Some(cp),
            receipt_detail_blob: None,
            receipt_sanitized_blob: resp_bytes.clone(),
            receipt_owner_note_ids: vec![input.note.clone()],
            response_bytes: resp_bytes,
        })
    }
}

struct CarrierReplacementFastPlan {
    store: CanonicalStore,
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: Option<CommandIdentitySpec>,
    command_kind: &'static str,
    auth: EngineAuthContext,
    identity: CommandIdentity,
    preconditions: Preconditions,
    note_id: NoteId,
    expected_base_rev: RevisionId,
    explicit_slug_override: Option<(String, String)>,
    info: PreparedCarrierInfo,
    ticket: StagedBlobTicket,
    prealloc_rev_id: RevisionId,
    prealloc_cmd_id: String,
    precomputed_rank_version: ContentDigest,
    preencoded_meta_msgpack: Option<(Vec<u8>, EvaluatedFields)>,
    phase1_receipt_checked_gen: Option<u64>,
    phase1_cached: Option<(NoteHeadRow, FolderAncestryFacts)>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_carrier_replacement_fast_intent(
    store: &CanonicalStore,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: Option<CommandIdentitySpec>,
    command_kind: &'static str,
    auth: EngineAuthContext,
    identity: CommandIdentity,
    preconditions: Preconditions,
    note_id: NoteId,
    expected_base_rev: RevisionId,
    explicit_slug_override: Option<(String, String)>,
    info: PreparedCarrierInfo,
    ticket: StagedBlobTicket,
    phase1_receipt_checked_gen: Option<u64>,
    phase1_cached: Option<(NoteHeadRow, FolderAncestryFacts)>,
) -> Result<(PreparedWriteIntent, Box<dyn SqliteSyncItemPlan>), PortError> {
    let prealloc_rev_id = new_revision_id()?;
    let prealloc_cmd_id = new_prefixed_hex_id("cmd_")?;
    let precomputed_rank_version = note_rank_version_digest(&prealloc_rev_id, None);
    let preencoded_meta_msgpack = if explicit_slug_override.is_none()
        && !store
            .inner
            .sqlite_has_any_space_schemas
            .load(Ordering::Acquire)
        && let Some((cached_head, cached_anc)) = &phase1_cached
    {
        let eval_fields = if cached_head.doc_class == DocClass::EncryptedNote {
            BTreeMap::new()
        } else {
            evaluate_fields_with_schema(info.raw_fields.as_ref(), info.diagnostics.first(), None)
        };
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(NoteRevisionMetadata {
            note_id: note_id.clone(),
            parent_folder_id: cached_head.parent_folder_id.clone(),
            is_root_child: cached_anc.is_root_child,
            slug: cached_head.slug.clone(),
            slug_fold: cached_head.slug_fold.clone(),
            title: info.title.clone(),
            doc_class: cached_head.doc_class,
            ability_id: cached_head.ability_id.clone(),
            lifecycle: Lifecycle::Active,
            visibility_mask: cached_head.visibility_mask,
            byte_size: info.byte_size,
            content_digest: Some(info.prepared_blob.digest),
            schema_revision: None,
            raw_fields: info.raw_fields.clone(),
            evaluated_fields: eval_fields.clone(),
            diagnostics: info.diagnostics.clone(),
        }))
        .encode()
        .ok()
        .map(|bytes| (bytes, eval_fields))
    } else {
        None
    };
    let staged_bytes = ticket.compressed_size;
    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: idemp.clone(),
        source_note_ids: vec![note_id.clone()],
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(|_tx, _ctx| {
            Box::pin(async {
                Err(internal_not_committed(
                    "fast_intent_placeholder_invoked",
                    "SqliteSyncItemPlan was not materialized before async fallback",
                ))
            })
        }),
    };
    let plan = Box::new(CarrierReplacementFastPlan {
        store: store.clone(),
        scope: scope.clone(),
        active_epoch,
        idemp,
        command_kind,
        auth,
        identity,
        preconditions,
        note_id,
        expected_base_rev,
        explicit_slug_override,
        info,
        ticket,
        prealloc_rev_id,
        prealloc_cmd_id,
        precomputed_rank_version,
        preencoded_meta_msgpack,
        phase1_receipt_checked_gen,
        phase1_cached,
    });
    Ok((intent, plan))
}

impl SqliteSyncItemPlan for CarrierReplacementFastPlan {
    fn take_deferred_local_staging(&self) -> Option<DeferredLocalStaging> {
        self.ticket.take_deferred_local_staging()
    }

    fn phase1_receipt_checked_at_gen(&self) -> Option<u64> {
        self.phase1_receipt_checked_gen
    }

    fn into_async_exec(self: Box<Self>) -> ItemExecuteFn {
        let me = *self;
        build_carrier_replacement_intent(
            &me.store,
            &me.scope,
            me.active_epoch,
            me.idemp,
            me.command_kind,
            me.auth,
            me.identity,
            me.preconditions,
            me.note_id,
            me.expected_base_rev,
            me.explicit_slug_override,
            me.info,
            me.ticket,
            None,
        )
        .execute
    }

    fn execute_sqlite_sync(
        &self,
        conn: &rusqlite::Connection,
        item_ctx: &mut ItemExecCtx,
        cache: &mut FastBatchSqlCache,
        batch_now_ts: Timestamp,
        batch_now_ms: i64,
        mut defer_append: Option<&mut DeferredAppendRows>,
    ) -> Result<ItemCommitArtifacts, FastItemExecError> {
        let room_fences = &self.store.inner.room_fences;
        let scope_cl = &self.scope;
        let command_kind = self.command_kind;
        let auth = &self.auth;
        let preconditions = &self.preconditions;
        let note_id = &self.note_id;
        let expected_base_rev = &self.expected_base_rev;
        let explicit_slug_override = &self.explicit_slug_override;
        let info = &self.info;

        // --- 1. Read-only preconditions & pure serialization (zero SQL mutations) ---
        let has_closed_collab_session =
            check_note_room_direct_write_cached(conn, cache, room_fences, scope_cl, note_id)
                .and_then(NoteRoomDirectWriteState::require_writable)
                .map_err(FastItemExecError::PreWrite)?;

        let note_cache_key = (scope_cl.space_id.clone(), note_id.clone());
        let (used_phase1_cache, head, anc) = if self.phase1_receipt_checked_gen
            == Some(cache.current_writer_gen)
            && !cache.in_batch_modified_notes.contains(&note_cache_key)
            && let Some((cached_head, cached_anc)) = &self.phase1_cached
        {
            (true, cached_head.clone(), cached_anc.clone())
        } else {
            let head = load_note_head_row_rusqlite(conn, &scope_cl.space_id, note_id)
                .map_err(FastItemExecError::PreWrite)?;
            if head.lifecycle != Lifecycle::Active {
                return Err(FastItemExecError::PreWrite(
                    DomainError::ResourceNotFound.into(),
                ));
            }
            if &head.head_rev_id != expected_base_rev {
                return Err(FastItemExecError::PreWrite(
                    DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into(),
                ));
            }
            if let Some(prec_rev) = &preconditions.revision
                && *prec_rev != head.head_rev_id
            {
                return Err(FastItemExecError::PreWrite(
                    DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into(),
                ));
            }
            check_collab_preconditions_cached(
                conn,
                cache,
                &scope_cl.space_id,
                note_id,
                preconditions,
            )
            .map_err(FastItemExecError::PreWrite)?;

            let (facts, anc) = build_resource_facts_cached(
                conn,
                cache,
                &item_ctx.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                true,
            )
            .map_err(FastItemExecError::PreWrite)?;
            auth.authorize_direct_write(&facts, &facts)
                .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
            (false, head, anc)
        };

        let (final_slug, final_slug_fold) = match explicit_slug_override {
            Some((s, sf)) => {
                if sf != &head.slug_fold
                    && active_note_sibling_exists_rusqlite(
                        conn,
                        &scope_cl.space_id,
                        &head.parent_folder_id,
                        sf,
                        Some(note_id),
                    )
                    .map_err(FastItemExecError::PreWrite)?
                {
                    let report_parent = (head.parent_folder_id != item_ctx.root_folder_id)
                        .then_some(head.parent_folder_id.clone());
                    return Err(FastItemExecError::PreWrite(
                        DomainError::PathConflict {
                            target: PathTarget {
                                space_id: scope_cl.space_id.clone(),
                                parent: report_parent,
                                component: s.clone(),
                            },
                        }
                        .into(),
                    ));
                }
                (s.clone(), sf.clone())
            }
            None => (head.slug.clone(), head.slug_fold.clone()),
        };

        let needs_ability_slug_update = if let Some(ab_id) = &head.ability_id
            && final_slug_fold != head.slug_fold
        {
            check_ability_package_slug_conflict_rusqlite(
                conn,
                &scope_cl.space_id,
                ab_id,
                &final_slug_fold,
                &final_slug,
                (head.parent_folder_id != item_ctx.root_folder_id)
                    .then_some(head.parent_folder_id.clone()),
            )
            .map_err(FastItemExecError::PreWrite)?;
            Some(ab_id.clone())
        } else {
            None
        };

        let cat_open_pub = check_local_blob_catalog_open_rusqlite(conn, cache, &self.ticket)
            .map_err(FastItemExecError::PreWrite)?;
        let current_schema = load_current_space_schema_cached(conn, cache, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?;

        let seq = item_ctx
            .alloc_next_seq()
            .map_err(FastItemExecError::PreWrite)?;
        let new_rev = self.prealloc_rev_id.clone();
        let cmd_id = self.prealloc_cmd_id.clone();
        let (sec, nsec) = encode_timestamp_parts(batch_now_ts);
        let seq_i64 = seq.get() as i64;
        let digest = info.prepared_blob.digest;

        let run_opt = extract_agent_run_from_auth(auth);
        let slug_changed = final_slug != head.slug || final_slug_fold != head.slug_fold;
        let needs_alias = final_slug_fold != head.slug_fold || info.title_fold != head.title_fold;
        let old_parent_for_alias = head.parent_folder_id.clone();
        let old_slug_fold_for_alias = head.slug_fold.clone();
        let old_title_fold_for_alias = head.title_fold.clone();
        let prev_head_rev = head.head_rev_id.clone();
        let head_doc_class = head.doc_class;

        let (meta, evaluated) = if used_phase1_cache
            && current_schema.is_none()
            && explicit_slug_override.is_none()
            && let Some(pre_meta) = &self.preencoded_meta_msgpack
        {
            pre_meta.clone()
        } else {
            let current_schema_rev = current_schema.as_deref().map(|s| s.schema_revision.clone());
            let eval_fields = if head_doc_class == DocClass::EncryptedNote {
                BTreeMap::new()
            } else {
                evaluate_fields_with_schema(
                    info.raw_fields.as_ref(),
                    info.diagnostics.first(),
                    current_schema.as_deref().map(|s| &s.fields),
                )
            };
            let bytes =
                RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(NoteRevisionMetadata {
                    note_id: note_id.clone(),
                    parent_folder_id: head.parent_folder_id,
                    is_root_child: anc.is_root_child,
                    slug: final_slug.clone(),
                    slug_fold: final_slug_fold.clone(),
                    title: info.title.clone(),
                    doc_class: head_doc_class,
                    ability_id: head.ability_id,
                    lifecycle: Lifecycle::Active,
                    visibility_mask: head.visibility_mask,
                    byte_size: info.byte_size,
                    content_digest: Some(digest),
                    schema_revision: current_schema_rev,
                    raw_fields: info.raw_fields.clone(),
                    evaluated_fields: eval_fields.clone(),
                    diagnostics: info.diagnostics.clone(),
                }))
                .encode()
                .map_err(FastItemExecError::PreWrite)?;
            (bytes, eval_fields)
        };

        let previous = load_revision_meta_bytes_rusqlite(conn, &scope_cl.space_id, &prev_head_rev)
            .and_then(|bytes| revision_fields(&bytes))
            .map_err(FastItemExecError::PreWrite)?;
        let changed_fields = changed_note_fields(&previous, &evaluated);

        let op_kind = if explicit_slug_override.is_some() {
            "rename"
        } else {
            "edit"
        };

        let payload_id = format!("eff:{cmd_id}");
        let range =
            CommandSeqRange::new(seq, seq).map_err(|e| FastItemExecError::PreWrite(e.into()))?;
        let cp = build_effect_payload_draft(
            payload_id,
            scope_cl.clone(),
            range,
            command_kind,
            EffectBodyV1::Notes {
                notes: vec![ChangedNoteSummaryV1 {
                    note_id: note_id.clone(),
                    revision: new_rev.clone(),
                    rank_version: self.precomputed_rank_version,
                    lifecycle: Lifecycle::Active,
                    doc_class: head_doc_class,
                    changed_fields,
                }],
            },
            vec![note_id.clone()],
        )
        .map_err(FastItemExecError::PreWrite)?;

        let receipt = MutationReceiptToken::new(scope_cl.clone(), seq)
            .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
        let stored_resp = StoredCommittedNoteRevV1 {
            value: NoteRevision {
                note: note_id.clone(),
                revision: new_rev.clone(),
            },
            receipt,
        };
        let resp_bytes = CanonicalStore::encode_command_outcome(&stored_resp)
            .map_err(FastItemExecError::PreWrite)?;

        // --- 2. Authoritative SQL writes ---
        if let Some(ab_id) = &needs_ability_slug_update {
            apply_ability_package_slug_update_rusqlite(
                conn,
                &scope_cl.space_id,
                ab_id,
                &final_slug_fold,
            )
            .map_err(FastItemExecError::PostWrite)?;
        }

        cache.in_batch_modified_notes.insert(note_cache_key);
        item_ctx.record_staged_ticket(self.ticket.clone());
        bind_local_blob_ref_after_open_check_rusqlite(
            conn,
            cache,
            &item_ctx.scope,
            item_ctx.active_epoch,
            &BlobReferenceClaim {
                ticket: self.ticket.clone(),
                owner_kind: BlobOwnerKind::NoteRevision,
                owner_id: note_id.as_str().to_owned(),
                owner_rev_id: new_rev.as_str().to_owned(),
                resource_key: "carrier".to_owned(),
            },
            seq,
            batch_now_ms,
            cat_open_pub,
            defer_append.as_deref_mut(),
        )
        .map_err(FastItemExecError::PostWrite)?;

        if has_closed_collab_session {
            sync_closed_collab_session_on_direct_write_rusqlite(
                conn,
                &scope_cl.space_id,
                note_id,
                &new_rev,
                seq,
            )
            .map_err(FastItemExecError::PostWrite)?;
        }

        if slug_changed {
            let mut stmt = conn
                .prepare_cached(
                    "UPDATE note_heads
                     SET slug = ?1, slug_fold = ?2, title = ?3, title_fold = ?4,
                         head_rev_id = ?5, content_blake3 = ?6, byte_size = ?7,
                         updated_seq = ?8, updated_at_sec = ?9, updated_at_nsec = ?10, last_actor_id = ?11
                     WHERE space_id = ?12 AND note_id = ?13",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_update_note_head",
                        err.to_string(),
                    ))
                })?;
            stmt.execute(params![
                &final_slug,
                &final_slug_fold,
                &info.title,
                &info.title_fold,
                new_rev.as_str(),
                digest.as_bytes().as_slice(),
                info.byte_size as i64,
                seq_i64,
                sec,
                nsec,
                auth.principal().as_str(),
                scope_cl.space_id.as_str(),
                note_id.as_str(),
            ])
            .map_err(|err| {
                FastItemExecError::PostWrite(internal_not_committed(
                    "sqlite_update_note_head",
                    err.to_string(),
                ))
            })?;
        } else {
            let mut stmt = conn
                .prepare_cached(
                    "UPDATE note_heads
                     SET title = ?1, title_fold = ?2,
                         head_rev_id = ?3, content_blake3 = ?4, byte_size = ?5,
                         updated_seq = ?6, updated_at_sec = ?7, updated_at_nsec = ?8, last_actor_id = ?9
                     WHERE space_id = ?10 AND note_id = ?11",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_update_note_head",
                        err.to_string(),
                    ))
                })?;
            stmt.execute(params![
                &info.title,
                &info.title_fold,
                new_rev.as_str(),
                digest.as_bytes().as_slice(),
                info.byte_size as i64,
                seq_i64,
                sec,
                nsec,
                auth.principal().as_str(),
                scope_cl.space_id.as_str(),
                note_id.as_str(),
            ])
            .map_err(|err| {
                FastItemExecError::PostWrite(internal_not_committed(
                    "sqlite_update_note_head",
                    err.to_string(),
                ))
            })?;
        }

        if needs_alias {
            insert_note_alias_rusqlite(
                conn,
                &scope_cl.space_id,
                &old_parent_for_alias,
                &old_slug_fold_for_alias,
                &old_title_fold_for_alias,
                note_id,
                seq,
            )
            .map_err(FastItemExecError::PostWrite)?;
        }

        if let Some(buf) = defer_append {
            buf.revisions.push(DeferredRevisionRow {
                space_id: scope_cl.space_id.as_str().to_owned(),
                incarnation: SqlBlob16(*scope_cl.incarnation.as_bytes()),
                rev_id: new_rev.as_str().to_owned(),
                entity_type: "note",
                entity_key: note_id.as_str().to_owned(),
                space_seq: seq_i64,
                visibility_seq: seq_i64,
                parent_rev_id: Some(prev_head_rev.as_str().to_owned()),
                restored_from_rev_id: None,
                content_blake3: Some(SqlBlob32(*digest.as_bytes())),
                metadata_msgpack: meta,
                actor_id: auth.principal().as_str().to_owned(),
                agent_run_id: run_opt.as_ref().map(|r| r.as_str().to_owned()),
                sec,
                nsec,
            });
            if let Some(run_id) = &run_opt {
                upsert_agent_run_head_rusqlite_deferred(
                    conn,
                    scope_cl,
                    run_id,
                    auth.principal(),
                    seq,
                    seq,
                    batch_now_ts,
                    buf,
                )
                .map_err(FastItemExecError::PostWrite)?;
            }
        } else {
            insert_revision_row_rusqlite(
                conn,
                scope_cl,
                &new_rev,
                "note",
                note_id.as_str(),
                seq,
                seq,
                Some(&prev_head_rev),
                None,
                Some(digest),
                &meta,
                auth.principal(),
                run_opt.as_ref(),
                batch_now_ts,
            )
            .map_err(FastItemExecError::PostWrite)?;

            if let Some(run_id) = &run_opt {
                upsert_agent_run_head_rusqlite(
                    conn,
                    scope_cl,
                    run_id,
                    auth.principal(),
                    seq,
                    seq,
                    batch_now_ts,
                )
                .map_err(FastItemExecError::PostWrite)?;
            }
        }

        Ok(ItemCommitArtifacts {
            command_id: cmd_id,
            command_kind: command_kind.to_owned(),
            events: vec![BatchEventDraft {
                space_seq: seq,
                entity_type: "note".to_owned(),
                entity_id: note_id.as_str().to_owned(),
                op_kind: op_kind.to_owned(),
                rev_id: new_rev,
                lifecycle: Lifecycle::Active,
                doc_class: Some(head_doc_class),
            }],
            change_payload: Some(cp),
            receipt_detail_blob: None,
            receipt_sanitized_blob: resp_bytes.clone(),
            receipt_owner_note_ids: vec![note_id.clone()],
            response_bytes: resp_bytes,
        })
    }
}

// ============================================================================
// Synchronous `rusqlite::Connection::prepare_cached` SQL Helpers
// ============================================================================

#[allow(non_snake_case)]
fn load_space_record_rusqlite_Read(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    wal: &SqliteWalCoordinator,
) -> Result<SpaceRecord, PortError> {
    match load_space_record_rusqlite(conn, space_id) {
        Ok(rec) => Ok(rec),
        Err(err) => {
            wal.record_busy_if_any(&format!("{err:?}"));
            Err(err)
        }
    }
}

pub(crate) fn load_space_record_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
) -> Result<SpaceRecord, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT history_incarnation, root_folder_id, slug, space_kind, owner_id,
                    lifecycle_state, active_epoch, last_seq, created_at_sec, created_at_nsec
             FROM spaces WHERE space_id = ?1",
        )
        .map_err(|err| internal_not_committed("sqlite_load_space", err.to_string()))?;

    let row_opt = stmt
        .query_row(params![space_id.as_str()], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, i64>(9)? as i32,
            ))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_space"))?;

    let (
        inc_bytes,
        root_raw,
        slug,
        kind_raw,
        owner_raw,
        lc_raw,
        active_epoch_raw,
        last_seq_raw,
        sec,
        nsec,
    ) = row_opt.ok_or(DomainError::ResourceNotFound)?;

    let inc_arr: [u8; 16] = inc_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_incarnation", "incarnation not 16 bytes"))?;
    let incarnation = HistoryIncarnation::from_bytes(inc_arr);
    let root_folder_id = FolderId::parse(&root_raw)
        .map_err(|_| internal_not_committed("corrupt_root_folder", "invalid root_folder_id"))?;
    let owner = PrincipalId::parse(&owner_raw)
        .map_err(|_| internal_not_committed("corrupt_owner_id", "invalid owner_id"))?;
    let kind = match kind_raw.as_str() {
        "personal" => SpaceKind::Personal,
        "shared" => SpaceKind::Shared,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_kind",
                format!("unexpected space_kind '{other}'"),
            ));
        }
    };
    let lifecycle = match lc_raw.as_str() {
        "active" => SpaceLifecycle::Active,
        "closing" => SpaceLifecycle::Closing,
        "archived" => SpaceLifecycle::Archived,
        other => {
            return Err(internal_not_committed(
                "corrupt_space_lifecycle",
                format!("unexpected space lifecycle '{other}'"),
            ));
        }
    };
    let active_epoch = LeaseEpoch::new(
        u64::try_from(active_epoch_raw)
            .map_err(|_| internal_not_committed("corrupt_epoch", "negative active_epoch"))?,
    )?;
    let last_seq = i64_to_space_seq(last_seq_raw)?;
    let created_at = decode_timestamp_parts(sec, nsec)?;

    Ok(SpaceRecord {
        space: Space {
            id: space_id.clone(),
            lifecycle,
            kind,
        },
        scope: HistoryScope {
            space_id: space_id.clone(),
            incarnation,
        },
        root_folder_id,
        slug,
        owner,
        active_epoch,
        last_seq,
        created_at,
    })
}

pub(crate) fn map_interrupt_or_internal(err: rusqlite::Error, code: &'static str) -> PortError {
    if let rusqlite::Error::SqliteFailure(ffi_err, _) = &err
        && ffi_err.code == rusqlite::ErrorCode::OperationInterrupted
    {
        return deadline_not_committed(
            "sqlite_read_interrupted_deadline",
            "ordinary SQLite read interrupted at deadline",
        );
    }
    internal_not_committed(code, err.to_string())
}

fn authorize_replay_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<(), PortError> {
    use crate::writer::replay::{ReplayPolicy, ReplayResource, authorize_head, destination};
    let Some((auth, policy)) = idemp.authority.as_deref() else {
        return Ok(());
    };
    let srec = load_space_record_rusqlite(conn, &scope.space_id)?;
    srec.scope.check(scope)?;
    let ReplayPolicy::Documents(targets) = policy else {
        return Err(internal_not_committed(
            "unsupported_fast_replay",
            "command requires the general writer",
        ));
    };
    auth.authorize_space_write(&srec.space)?;
    for target in targets {
        let note = match target {
            ReplayResource::WriteFolder(folder) => {
                let folder = folder.as_ref().unwrap_or(&srec.root_folder_id);
                let (facts, _) = build_resource_facts_rusqlite(
                    conn,
                    &srec.space,
                    folder,
                    crate::domain::folders::choose_folder_auth_class(auth, &srec.space.id),
                    None,
                    true,
                )?;
                auth.authorize_direct_write(&facts, &facts)?;
                continue;
            }
            ReplayResource::ReadLinkFolder(folder, source) => {
                let head = load_note_head_row_rusqlite(conn, &srec.space.id, source)?;
                let (facts, _) = build_resource_facts_rusqlite(
                    conn,
                    &srec.space,
                    folder,
                    head.doc_class,
                    None,
                    true,
                )?;
                auth.authorize_read(&facts)?;
                continue;
            }
            ReplayResource::Write(note)
            | ReplayResource::Read(note)
            | ReplayResource::Create(note, ..)
            | ReplayResource::Move(note, ..) => note,
        };
        let head = load_note_head_row_opt_rusqlite(conn, &scope.space_id, note)?;
        if let Some((parent, class)) = destination(target, head.as_ref().map(|h| h.doc_class)) {
            let (facts, _) = build_resource_facts_rusqlite(
                conn,
                &srec.space,
                parent.unwrap_or(&srec.root_folder_id),
                class,
                None,
                true,
            )?;
            auth.authorize_direct_write(&facts, &facts)?;
        }
        if let Some(head) = head {
            let (facts, _) = build_resource_facts_rusqlite(
                conn,
                &srec.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id,
                true,
            )?;
            authorize_head(auth, target, &facts)?;
        } else if !matches!(target, ReplayResource::Create(..)) {
            return Err(DomainError::ResourceNotFound.into());
        }
    }
    Ok(())
}

fn lookup_command_receipt_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<Option<StoredReceiptRow>, PortError> {
    let raw_opt = {
        let mut stmt = conn
            .prepare_cached(
                "SELECT command_hash, status, response_payload_id, sanitized_envelope_msgpack
                 FROM command_receipts
                 WHERE space_id = ?1 AND history_incarnation = ?2 AND actor_id = ?3 AND idempotency_key = ?4",
            )
            .map_err(|err| internal_not_committed("sqlite_lookup_receipt", err.to_string()))?;

        stmt.query_row(
            params![
                scope.space_id.as_str(),
                scope.incarnation.as_bytes().as_slice(),
                idemp.actor.as_str(),
                idemp.command_key.as_str(),
            ],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_lookup_receipt"))?
    };

    let Some((hash_bytes, status, resp_payload_id, sanitized_blob)) = raw_opt else {
        return Ok(None);
    };
    authorize_replay_rusqlite(conn, scope, idemp)?;
    let arr: [u8; 32] = hash_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_receipt_hash", "command_hash != 32B"))?;

    let effective_blob = if let Some(pid) = resp_payload_id {
        let mut stmt = conn
            .prepare_cached(
                "SELECT erased_by_purge, effect_msgpack FROM change_payloads
                 WHERE space_id = ?1 AND payload_id = ?2",
            )
            .map_err(|err| internal_not_committed("sqlite_lookup_rcpt_pay", err.to_string()))?;
        let detail_opt = stmt
            .query_row(params![scope.space_id.as_str(), &pid], |row| {
                Ok((
                    row.get::<_, i64>(0)? as i32,
                    row.get::<_, Option<Vec<u8>>>(1)?,
                ))
            })
            .optional()
            .map_err(|err| map_interrupt_or_internal(err, "sqlite_lookup_rcpt_pay"))?;
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

fn is_note_purge_fenced_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &str,
) -> Result<bool, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT 1 FROM revision_purge_fences WHERE space_id = ?1 AND note_id = ?2 LIMIT 1",
        )
        .map_err(|err| internal_not_committed("sqlite_check_purge_fence", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row(params![space_id.as_str(), note_id], |r| r.get(0))
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_check_purge_fence"))?;
    Ok(found.is_some())
}

fn is_note_purge_fenced_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    space_id: &SpaceId,
    note_id: &str,
) -> Result<bool, PortError> {
    let has_any = if let Some(&v) = cache.space_has_purge_fences.get(space_id) {
        v
    } else {
        let mut stmt = conn
            .prepare_cached("SELECT 1 FROM revision_purge_fences WHERE space_id = ?1 LIMIT 1")
            .map_err(|err| {
                internal_not_committed("sqlite_check_space_purge_fences", err.to_string())
            })?;
        let found: Option<i64> = stmt
            .query_row(params![space_id.as_str()], |r| r.get(0))
            .optional()
            .map_err(|err| map_interrupt_or_internal(err, "sqlite_check_space_purge_fences"))?;
        let exists = found.is_some();
        cache
            .space_has_purge_fences
            .insert(space_id.clone(), exists);
        exists
    };
    if !has_any {
        return Ok(false);
    }
    is_note_purge_fenced_rusqlite(conn, space_id, note_id)
}

fn load_note_head_row_opt_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Option<NoteHeadRow>, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT parent_folder_id, slug, slug_fold, title, title_fold, doc_class,
                    ability_id, head_rev_id, content_blake3, byte_size, lifecycle_state,
                    visibility_mask, settlement_successor_id, created_seq, updated_seq,
                    created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
             FROM note_heads WHERE space_id = ?1 AND note_id = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_load_note_head", err.to_string()))?;

    let raw_opt = stmt
        .query_row(params![space_id.as_str(), note_id.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, Option<Vec<u8>>>(8)?,
                r.get::<_, i64>(9)?,
                r.get::<_, String>(10)?,
                r.get::<_, i64>(11)? as i32,
                r.get::<_, Option<String>>(12)?,
                r.get::<_, i64>(13)?,
                r.get::<_, i64>(14)?,
                r.get::<_, i64>(15)?,
                r.get::<_, i64>(16)? as i32,
                r.get::<_, i64>(17)?,
                r.get::<_, i64>(18)? as i32,
                r.get::<_, String>(19)?,
            ))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_note_head"))?;

    let Some((
        parent_raw,
        slug,
        slug_fold,
        title,
        title_fold,
        class_raw,
        ability_raw,
        head_rev_raw,
        digest_raw,
        byte_size_raw,
        lc_raw,
        visibility_mask,
        succ_raw,
        created_seq_raw,
        updated_seq_raw,
        c_sec,
        c_nsec,
        u_sec,
        u_nsec,
        actor_raw,
    )) = raw_opt
    else {
        return Ok(None);
    };

    let parent_folder_id = FolderId::parse(&parent_raw)
        .map_err(|_| internal_not_committed("corrupt_note_parent", "invalid parent_folder_id"))?;
    let doc_class = doc_class_from_db(&class_raw)?;
    let ability_id = match ability_raw {
        Some(s) => Some(
            AbilityId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_ability_id", "invalid ability_id"))?,
        ),
        None => None,
    };
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_note_rev", "invalid head_rev_id"))?;
    let content_digest = match digest_raw {
        Some(b) => {
            let arr: [u8; 32] = b.try_into().map_err(|_| {
                internal_not_committed("corrupt_note_digest", "content_blake3 != 32B")
            })?;
            Some(ContentDigest::from_bytes(arr))
        }
        None => None,
    };
    let byte_size = u64::try_from(byte_size_raw)
        .map_err(|_| internal_not_committed("corrupt_byte_size", "negative byte_size"))?;
    let lifecycle = lifecycle_from_db(&lc_raw)?;
    let settlement_successor_id = match succ_raw {
        Some(s) => Some(
            NoteId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_successor_id", "invalid successor"))?,
        ),
        None => None,
    };
    let created_seq = i64_to_space_seq(created_seq_raw)?;
    let updated_seq = i64_to_space_seq(updated_seq_raw)?;
    let created_at = decode_timestamp_parts(c_sec, c_nsec)?;
    let updated_at = decode_timestamp_parts(u_sec, u_nsec)?;
    let last_actor_id = PrincipalId::parse(&actor_raw)
        .map_err(|_| internal_not_committed("corrupt_last_actor", "invalid last_actor_id"))?;

    Ok(Some(NoteHeadRow {
        note_id: note_id.clone(),
        parent_folder_id,
        slug,
        slug_fold,
        title,
        title_fold,
        doc_class,
        ability_id,
        head_rev_id,
        content_digest,
        byte_size,
        lifecycle,
        visibility_mask,
        settlement_successor_id,
        created_seq,
        updated_seq,
        created_at,
        updated_at,
        last_actor_id,
    }))
}

fn load_note_head_row_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteHeadRow, PortError> {
    load_note_head_row_opt_rusqlite(conn, space_id, note_id)?
        .ok_or_else(|| DomainError::ResourceNotFound.into())
}

fn load_folder_head_row_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    folder_id: &FolderId,
) -> Result<FolderHeadRow, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT parent_folder_id, is_root, slug, slug_fold, display_name,
                    is_project, project_slug, project_slug_fold, description,
                    cover_note_id, write_lock_json, lifecycle_state, head_rev_id
             FROM folder_heads WHERE space_id = ?1 AND folder_id = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_load_folder", err.to_string()))?;

    let row_opt = stmt
        .query_row(params![space_id.as_str(), folder_id.as_str()], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, i64>(1)? as i32,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)? as i32,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<String>>(7)?,
                r.get::<_, Option<String>>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, String>(11)?,
                r.get::<_, String>(12)?,
            ))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_folder"))?;

    let (
        parent_raw,
        is_root_raw,
        slug,
        slug_fold,
        display_name,
        is_proj_raw,
        project_slug,
        project_slug_fold,
        description,
        cover_raw,
        write_lock_json,
        lc_raw,
        head_rev_raw,
    ) = row_opt.ok_or(DomainError::ResourceNotFound)?;

    let parent_folder_id = match parent_raw {
        Some(s) => Some(FolderId::parse(&s).map_err(|_| {
            internal_not_committed("corrupt_parent_folder", "invalid parent_folder_id")
        })?),
        None => None,
    };
    let cover_note_id =
        match cover_raw {
            Some(s) => Some(NoteId::parse(&s).map_err(|_| {
                internal_not_committed("corrupt_cover_note", "invalid cover_note_id")
            })?),
            None => None,
        };
    let head_rev_id = RevisionId::parse(&head_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_folder_rev", "invalid head_rev_id"))?;
    let lifecycle = lifecycle_from_db(&lc_raw)?;

    Ok(FolderHeadRow {
        folder_id: folder_id.clone(),
        parent_folder_id,
        is_root: is_root_raw != 0,
        slug,
        slug_fold,
        display_name,
        is_project: is_proj_raw != 0,
        project_slug,
        project_slug_fold,
        description,
        cover_note_id,
        write_locked: write_lock_json.is_some(),
        lifecycle,
        head_rev_id,
    })
}

fn load_folder_ancestry_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    folder_id: &FolderId,
    require_all_active: bool,
) -> Result<FolderAncestryFacts, PortError> {
    let mut ancestors = Vec::new();
    let mut segments_rev = Vec::new();
    let mut visited = BTreeSet::new();
    let mut write_locked = false;
    let mut current = folder_id.clone();

    for _depth in 0..=MAX_FOLDER_DEPTH {
        if !visited.insert(current.clone()) {
            return Err(internal_not_committed(
                "folder_cycle_detected",
                "corrupt cycle in folder_heads",
            ));
        }
        let row = load_folder_head_row_rusqlite(conn, space_id, &current)?;
        if require_all_active && row.lifecycle != Lifecycle::Active {
            return Err(DomainError::ResourceNotFound.into());
        }
        if row.write_locked {
            write_locked = true;
        }
        ancestors.push(row.folder_id.clone());
        if row.is_root {
            segments_rev.reverse();
            let folder_path = if segments_rev.is_empty() {
                String::new()
            } else {
                segments_rev.join("/")
            };
            let is_root_child = ancestors.len() == 1;
            return Ok(FolderAncestryFacts {
                ancestors,
                write_locked,
                is_root_child,
                folder_path,
            });
        }
        segments_rev.push(row.slug);
        current = row.parent_folder_id.ok_or_else(|| {
            internal_not_committed(
                "non_root_missing_parent",
                "non-root folder missing parent_folder_id",
            )
        })?;
    }

    Err(internal_not_committed(
        "folder_depth_exceeded",
        "folder tree exceeded MAX_FOLDER_DEPTH",
    ))
}

fn build_resource_facts_rusqlite(
    conn: &rusqlite::Connection,
    space: &Space,
    parent_folder_id: &FolderId,
    class: DocClass,
    ability_package: Option<AbilityId>,
    require_active_folders: bool,
) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
    let anc =
        load_folder_ancestry_rusqlite(conn, &space.id, parent_folder_id, require_active_folders)?;
    let facts = ResourceFacts {
        space: space.clone(),
        class,
        ancestor_folders: anc.ancestors.clone(),
        folder_write_locked: anc.write_locked,
        ability_package,
    };
    Ok((facts, anc))
}

fn build_resource_facts_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    space: &Space,
    parent_folder_id: &FolderId,
    class: DocClass,
    ability_package: Option<AbilityId>,
    require_active_folders: bool,
) -> Result<(ResourceFacts, FolderAncestryFacts), PortError> {
    let key = (
        space.id.clone(),
        parent_folder_id.clone(),
        require_active_folders,
    );
    let anc = if let Some(cached) = cache.folder_ancestry.get(&key) {
        cached.clone()
    } else {
        let loaded = load_folder_ancestry_rusqlite(
            conn,
            &space.id,
            parent_folder_id,
            require_active_folders,
        )?;
        cache.folder_ancestry.insert(key, loaded.clone());
        loaded
    };
    let facts = ResourceFacts {
        space: space.clone(),
        class,
        ancestor_folders: anc.ancestors.clone(),
        folder_write_locked: anc.write_locked,
        ability_package,
    };
    Ok((facts, anc))
}

fn space_has_any_collab_session_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    if let Some(&v) = cache.space_has_collab_sessions.get(space_id) {
        return Ok(v);
    }
    let mut stmt = conn
        .prepare_cached("SELECT 1 FROM collab_sessions WHERE space_id = ?1 LIMIT 1")
        .map_err(|err| internal_not_committed("sqlite_check_space_collab", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row(params![space_id.as_str()], |r| r.get(0))
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_check_space_collab"))?;
    let exists = found.is_some();
    cache
        .space_has_collab_sessions
        .insert(space_id.clone(), exists);
    Ok(exists)
}

fn check_collab_preconditions_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &NoteId,
    preconditions: &Preconditions,
) -> Result<(), PortError> {
    if preconditions.lease.is_none() && preconditions.lineage.is_none() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT lease_epoch, lineage_epoch FROM collab_sessions
             WHERE space_id = ?1 AND note_id = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_check_collab_prec", err.to_string()))?;
    let session_opt: Option<(i64, i64)> = stmt
        .query_row(params![space_id.as_str(), note_id.as_str()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_check_collab_prec"))?;

    let (actual_lease, actual_lineage) = match session_opt {
        Some((le, li)) => (
            LeaseEpoch::new(u64::try_from(le).unwrap_or(0))?,
            LineageEpoch::new(u64::try_from(li).unwrap_or(0))?,
        ),
        None => (LeaseEpoch::ZERO, LineageEpoch::ZERO),
    };

    if let Some(expected_lease) = preconditions.lease
        && expected_lease != actual_lease
    {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    if let Some(expected_lineage) = preconditions.lineage
        && expected_lineage != actual_lineage
    {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }
    Ok(())
}

fn check_collab_preconditions_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    space_id: &SpaceId,
    note_id: &NoteId,
    preconditions: &Preconditions,
) -> Result<(), PortError> {
    if preconditions.lease.is_none() && preconditions.lineage.is_none() {
        return Ok(());
    }
    if !space_has_any_collab_session_cached(conn, cache, space_id)? {
        if let Some(expected_lease) = preconditions.lease
            && expected_lease != LeaseEpoch::ZERO
        {
            return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
        }
        if let Some(expected_lineage) = preconditions.lineage
            && expected_lineage != LineageEpoch::ZERO
        {
            return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
        }
        return Ok(());
    }
    check_collab_preconditions_rusqlite(conn, space_id, note_id, preconditions)
}

fn check_note_room_direct_write_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    room_fences: &RoomFenceTable,
    scope: &HistoryScope,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    if room_fences.is_room_active_blocking(scope, note_id)? {
        return Ok(NoteRoomDirectWriteState::ActiveOrFenced);
    }
    if !space_has_any_collab_session_cached(conn, cache, &scope.space_id)? {
        return Ok(NoteRoomDirectWriteState::NoSessionRow);
    }
    durable_note_room_state_rusqlite(conn, &scope.space_id, note_id)
}

fn durable_note_room_state_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<NoteRoomDirectWriteState, PortError> {
    let mut stmt = conn.prepare_cached(
        "SELECT room_state, COALESCE(carrier_dirty, 0) FROM collab_sessions LEFT JOIN collab_checkpoints USING(space_id, note_id)
         WHERE space_id = ?1 AND note_id = ?2",
    ).map_err(|err| internal_not_committed("sqlite_check_room_active", err.to_string()))?;
    let row = stmt
        .query_row(params![space_id.as_str(), note_id.as_str()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_check_room_active"))?;
    Ok(NoteRoomDirectWriteState::from_row(row))
}

fn active_note_sibling_exists_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
    exclude_note_id: Option<&NoteId>,
) -> Result<bool, PortError> {
    let excl = exclude_note_id.map(NoteId::as_str).unwrap_or("");
    let mut stmt = conn
        .prepare_cached(
            "SELECT 1 FROM note_heads
             WHERE space_id = ?1 AND parent_folder_id = ?2 AND slug_fold = ?3
               AND lifecycle_state = 'active' AND note_id <> ?4
             LIMIT 1",
        )
        .map_err(|err| internal_not_committed("sqlite_note_sibling_check", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row(
            params![
                space_id.as_str(),
                parent_folder_id.as_str(),
                slug_fold,
                excl
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_note_sibling_check"))?;
    Ok(found.is_some())
}

fn check_ability_package_slug_conflict_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    ability_id: &AbilityId,
    new_slug_fold: &str,
    new_slug: &str,
    report_parent: Option<FolderId>,
) -> Result<(), PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT 1 FROM ability_packages
             WHERE space_id = ?1 AND slug_fold = ?2 AND lifecycle_state = 'active' AND ability_id <> ?3
             LIMIT 1",
        )
        .map_err(|err| internal_not_committed("sqlite_ability_rename_check", err.to_string()))?;
    let conflict: Option<i64> = stmt
        .query_row(
            params![space_id.as_str(), new_slug_fold, ability_id.as_str()],
            |r| r.get(0),
        )
        .optional()
        .map_err(|err| internal_not_committed("sqlite_ability_rename_check", err.to_string()))?;
    if conflict.is_some() {
        return Err(DomainError::PathConflict {
            target: PathTarget {
                space_id: space_id.clone(),
                parent: report_parent,
                component: new_slug.to_owned(),
            },
        }
        .into());
    }
    Ok(())
}

fn apply_ability_package_slug_update_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    ability_id: &AbilityId,
    new_slug_fold: &str,
) -> Result<(), PortError> {
    let mut upd = conn
        .prepare_cached(
            "UPDATE ability_packages SET slug_fold = ?1 WHERE space_id = ?2 AND ability_id = ?3",
        )
        .map_err(|err| internal_not_committed("sqlite_ability_rename_upd", err.to_string()))?;
    upd.execute(params![
        new_slug_fold,
        space_id.as_str(),
        ability_id.as_str()
    ])
    .map_err(|err| internal_not_committed("sqlite_ability_rename_upd", err.to_string()))?;
    Ok(())
}

fn load_active_blob_raw_size_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    digest: ContentDigest,
) -> Result<u64, PortError> {
    let row_opt = {
        let mut stmt = conn
            .prepare_cached(
                "SELECT raw_size, blob_state, current_publication_id
                 FROM blob_catalog WHERE space_id = ?1 AND content_blake3 = ?2",
            )
            .map_err(|err| internal_not_committed("sqlite_load_blob_meta", err.to_string()))?;
        stmt.query_row(
            params![space_id.as_str(), digest.as_bytes().as_slice()],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_blob_meta"))?
    };

    let Some((raw_size, state, pub_opt)) = row_opt else {
        return Err(DomainError::ResourceNotFound.into());
    };
    if state != "active" {
        return Err(DomainError::ResourceNotFound.into());
    }
    if let Some(pub_id) = &pub_opt {
        let mut pstmt = conn
            .prepare_cached(
                "SELECT state, part_count FROM blob_publications WHERE space_id = ?1 AND publication_id = ?2",
            )
            .map_err(|err| internal_not_committed("sqlite_load_pub_meta", err.to_string()))?;
        let p_opt: Option<(String, i64)> = pstmt
            .query_row(params![space_id.as_str(), pub_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()
            .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_pub_meta"))?;
        let Some((p_state, p_cnt)) = p_opt else {
            return Err(internal_not_committed(
                "corrupt_active_pub",
                "active publication missing",
            ));
        };
        if p_state != "active" {
            return Err(DomainError::ResourceNotFound.into());
        }
        let _ = u32::try_from(p_cnt)
            .map_err(|_| internal_not_committed("corrupt_part_count", "negative part_count"))?;
    }

    u64::try_from(raw_size)
        .map_err(|_| internal_not_committed("corrupt_raw_size", "negative raw_size"))
}

enum ExistingBlobCat {
    Missing,
    InBatchNew { idx: usize, pub_id: String },
    Persisted(Option<String>),
}

fn check_local_blob_catalog_open_rusqlite(
    conn: &rusqlite::Connection,
    cache: &FastBatchSqlCache,
    ticket: &StagedBlobTicket,
) -> Result<ExistingBlobCat, PortError> {
    if ticket.codec != BlobCodecTag::LocalZstdV1 {
        return Err(internal_not_committed(
            "sqlite_fast_non_local_codec",
            "expected LocalZstdV1 codec in fast SQLite writer",
        ));
    }
    if let Some((idx, pub_id)) = cache
        .in_batch_new_blobs
        .get(&(ticket.space_id.clone(), ticket.digest))
    {
        return Ok(ExistingBlobCat::InBatchNew {
            idx: *idx,
            pub_id: pub_id.clone(),
        });
    }
    let mut stmt = conn
        .prepare_cached(
            "SELECT admission_state, current_publication_id
             FROM blob_catalog WHERE space_id = ?1 AND content_blake3 = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_act_cat", err.to_string()))?;
    let cat_row: Option<(String, Option<String>)> = stmt
        .query_row(
            params![
                ticket.space_id.as_str(),
                ticket.digest.as_bytes().as_slice()
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|err| internal_not_committed("sqlite_act_cat", err.to_string()))?;

    match cat_row {
        Some((admission, pub_opt)) => {
            if admission != "open" {
                return Err(unavailable_retryable(
                    "blob_retiring_on_commit",
                    "digest entered retirement before SQL commit",
                    Duration::from_millis(25),
                ));
            }
            Ok(ExistingBlobCat::Persisted(pub_opt))
        }
        None => Ok(ExistingBlobCat::Missing),
    }
}

#[allow(clippy::too_many_arguments)]
fn bind_local_blob_ref_after_open_check_rusqlite(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    claim: &BlobReferenceClaim,
    created_seq: SpaceSeq,
    now_ms: i64,
    existing_cat: ExistingBlobCat,
    defer_append: Option<&mut DeferredAppendRows>,
) -> Result<(), PortError> {
    claim.ticket.check_authority(scope, active_epoch)?;
    let epoch_i64 = active_epoch.get() as i64;
    let space_id = &claim.ticket.space_id;
    let digest = claim.ticket.digest;

    if let Some(buf) = defer_append {
        match existing_cat {
            ExistingBlobCat::Missing => {
                let pub_id = claim.ticket.publication_id.clone();
                let cat_idx = buf.blob_catalog.len();
                cache
                    .in_batch_new_blobs
                    .insert((space_id.clone(), digest), (cat_idx, pub_id.clone()));
                buf.blob_catalog.push(DeferredBlobCatalogRow {
                    space_id: space_id.as_str().to_owned(),
                    content_blake3: SqlBlob32(*digest.as_bytes()),
                    raw_size: claim.ticket.raw_size as i64,
                    compressed_size: claim.ticket.compressed_size as i64,
                    ref_count: 1,
                    publication_id: pub_id.clone(),
                    now_ms,
                });
                buf.blob_publications.push(DeferredBlobPubRow {
                    space_id: space_id.as_str().to_owned(),
                    publication_id: pub_id.clone(),
                    content_blake3: SqlBlob32(*digest.as_bytes()),
                    owner_epoch: epoch_i64,
                    raw_size: claim.ticket.raw_size as i64,
                    compressed_size: claim.ticket.compressed_size as i64,
                    now_ms,
                });
                buf.blob_references.push(DeferredBlobRefRow {
                    space_id: space_id.as_str().to_owned(),
                    owner_kind: claim.owner_kind.as_db_str(),
                    owner_id: claim.owner_id.clone(),
                    owner_rev_id: claim.owner_rev_id.clone(),
                    resource_key: claim.resource_key.clone(),
                    content_blake3: SqlBlob32(*digest.as_bytes()),
                    publication_id: pub_id,
                    created_seq: created_seq.get() as i64,
                });
                return Ok(());
            }
            ExistingBlobCat::InBatchNew { idx, pub_id } => {
                buf.blob_catalog[idx].ref_count += 1;
                buf.blob_references.push(DeferredBlobRefRow {
                    space_id: space_id.as_str().to_owned(),
                    owner_kind: claim.owner_kind.as_db_str(),
                    owner_id: claim.owner_id.clone(),
                    owner_rev_id: claim.owner_rev_id.clone(),
                    resource_key: claim.resource_key.clone(),
                    content_blake3: SqlBlob32(*digest.as_bytes()),
                    publication_id: pub_id,
                    created_seq: created_seq.get() as i64,
                });
                return Ok(());
            }
            ExistingBlobCat::Persisted(_) => {}
        }
    }

    let mut inserted_fresh_local_active = false;
    let current_pub_opt = match existing_cat {
        ExistingBlobCat::Persisted(pub_opt) => pub_opt,
        ExistingBlobCat::InBatchNew { pub_id, .. } => Some(pub_id),
        ExistingBlobCat::Missing => {
            let pub_id = &claim.ticket.publication_id;
            let mut ins = conn
                .prepare_cached(
                    "INSERT INTO blob_catalog (
                        space_id, content_blake3, raw_size, compressed_size, ref_count,
                        current_publication_id, admission_state, blob_state, touched_at_ms
                    ) VALUES (?1, ?2, ?3, ?4, 1, ?5, 'open', 'active', ?6)",
                )
                .map_err(|err| {
                    internal_not_committed("sqlite_insert_blob_catalog_fast", err.to_string())
                })?;
            ins.execute(params![
                space_id.as_str(),
                digest.as_bytes().as_slice(),
                claim.ticket.raw_size as i64,
                claim.ticket.compressed_size as i64,
                pub_id,
                now_ms,
            ])
            .map_err(|err| {
                internal_not_committed("sqlite_insert_blob_catalog_fast", err.to_string())
            })?;
            inserted_fresh_local_active = true;
            None
        }
    };

    let effective_pub_id = if let Some(active_pub) = current_pub_opt {
        active_pub
    } else {
        let pub_id = claim.ticket.publication_id.clone();
        let mut ins_pub = conn
            .prepare_cached(
                "INSERT INTO blob_publications (
                    space_id, publication_id, content_blake3, owner_epoch, codec,
                    state, manifest_sealed, part_count, raw_size, compressed_size,
                    created_at_ms, updated_at_ms
                ) VALUES (?1, ?2, ?3, ?4, 'local_zstd_v1', 'active', 1, 1, ?5, ?6, ?7, ?8)",
            )
            .map_err(|err| internal_not_committed("sqlite_insert_local_pub", err.to_string()))?;
        ins_pub
            .execute(params![
                space_id.as_str(),
                &pub_id,
                digest.as_bytes().as_slice(),
                epoch_i64,
                claim.ticket.raw_size as i64,
                claim.ticket.compressed_size as i64,
                now_ms,
                now_ms,
            ])
            .map_err(|err| internal_not_committed("sqlite_insert_local_pub", err.to_string()))?;
        pub_id
    };

    let inserted = {
        let mut ins_ref = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO blob_references (
                    space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                    content_blake3, publication_id, created_seq
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|err| internal_not_committed("sqlite_insert_blob_ref", err.to_string()))?;
        ins_ref
            .execute(params![
                space_id.as_str(),
                claim.owner_kind.as_db_str(),
                &claim.owner_id,
                &claim.owner_rev_id,
                &claim.resource_key,
                digest.as_bytes().as_slice(),
                &effective_pub_id,
                created_seq.get() as i64,
            ])
            .map_err(|err| internal_not_committed("sqlite_insert_blob_ref", err.to_string()))?
    };

    if !inserted_fresh_local_active || inserted != 1 {
        let ref_delta = if inserted_fresh_local_active {
            (inserted as i64) - 1
        } else {
            inserted as i64
        };
        let mut upd_cat = conn
            .prepare_cached(
                "UPDATE blob_catalog
                 SET ref_count = ref_count + ?1, current_publication_id = ?2, blob_state = 'active', touched_at_ms = ?3
                 WHERE space_id = ?4 AND content_blake3 = ?5",
            )
            .map_err(|err| internal_not_committed("sqlite_update_cat_active", err.to_string()))?;
        upd_cat
            .execute(params![
                ref_delta,
                &effective_pub_id,
                now_ms,
                space_id.as_str(),
                digest.as_bytes().as_slice(),
            ])
            .map_err(|err| internal_not_committed("sqlite_update_cat_active", err.to_string()))?;
    }

    Ok(())
}

fn sync_closed_collab_session_on_direct_write_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    note_id: &NoteId,
    new_carrier_rev: &RevisionId,
    updated_seq: SpaceSeq,
) -> Result<(), PortError> {
    if !durable_note_room_state_rusqlite(conn, space_id, note_id)?.require_writable()? {
        return Ok(());
    }
    let seq_i64 = updated_seq.get() as i64;
    {
        let mut del = conn
            .prepare_cached("DELETE FROM collab_checkpoints WHERE space_id = ?1 AND note_id = ?2")
            .map_err(|err| {
                internal_not_committed("sqlite_sync_clear_collab_checkpoint", err.to_string())
            })?;
        del.execute(params![space_id.as_str(), note_id.as_str()])
            .map_err(|err| {
                internal_not_committed("sqlite_sync_clear_collab_checkpoint", err.to_string())
            })?;
    }
    let affected = {
        let mut upd = conn
            .prepare_cached(
                "UPDATE collab_sessions
                 SET lineage_epoch = lineage_epoch + 1,
                     carrier_rev_id = ?1,
                     yrs_snapshot_blob = NULL,
                     yrs_snapshot_blake3 = NULL,
                     updated_seq = ?2
                 WHERE space_id = ?3 AND note_id = ?4 AND room_state = 'closed'",
            )
            .map_err(|err| internal_not_committed("sqlite_sync_collab_lineage", err.to_string()))?;
        upd.execute(params![
            new_carrier_rev.as_str(),
            seq_i64,
            space_id.as_str(),
            note_id.as_str(),
        ])
        .map_err(|err| internal_not_committed("sqlite_sync_collab_lineage", err.to_string()))?
    };
    if affected > 0 {
        release_owner_blob_refs_rusqlite(
            conn,
            space_id,
            BlobOwnerKind::CollabSnapshot,
            note_id.as_str(),
        )?;
    }
    Ok(())
}

fn release_owner_blob_refs_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    owner_kind: BlobOwnerKind,
    owner_id: &str,
) -> Result<(), PortError> {
    let now_ms = now_unix_ms()?;
    let raw_digests: Vec<Vec<u8>> = {
        let mut list_stmt = conn
            .prepare_cached(
                "SELECT DISTINCT content_blake3 FROM blob_references
                 WHERE space_id = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            )
            .map_err(|err| internal_not_committed("sqlite_list_owner_refs", err.to_string()))?;
        let rows = list_stmt
            .query_map(
                params![space_id.as_str(), owner_kind.as_db_str(), owner_id],
                |r| r.get::<_, Vec<u8>>(0),
            )
            .map_err(|err| internal_not_committed("sqlite_list_owner_refs", err.to_string()))?;
        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(|err| {
                internal_not_committed("sqlite_list_owner_refs", err.to_string())
            })?);
        }
        out
    };
    {
        let mut del_stmt = conn
            .prepare_cached(
                "DELETE FROM blob_references WHERE space_id = ?1 AND owner_kind = ?2 AND owner_id = ?3",
            )
            .map_err(|err| internal_not_committed("sqlite_del_owner_refs", err.to_string()))?;
        del_stmt
            .execute(params![space_id.as_str(), owner_kind.as_db_str(), owner_id])
            .map_err(|err| internal_not_committed("sqlite_del_owner_refs", err.to_string()))?;
    }

    let mut unique = BTreeSet::new();
    for bytes in raw_digests {
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_ref_digest", "digest != 32 bytes"))?;
        unique.insert(ContentDigest::from_bytes(arr));
    }

    for digest in unique {
        let exact_count: i64 = {
            let mut cnt_stmt = conn
                .prepare_cached(
                    "SELECT COUNT(*) FROM blob_references WHERE space_id = ?1 AND content_blake3 = ?2",
                )
                .map_err(|err| internal_not_committed("sqlite_count_refs", err.to_string()))?;
            cnt_stmt
                .query_row(
                    params![space_id.as_str(), digest.as_bytes().as_slice()],
                    |r| r.get(0),
                )
                .map_err(|err| internal_not_committed("sqlite_count_refs", err.to_string()))?
        };
        let mut upd_stmt = conn
            .prepare_cached(
                "UPDATE blob_catalog SET ref_count = ?1, touched_at_ms = ?2
                 WHERE space_id = ?3 AND content_blake3 = ?4",
            )
            .map_err(|err| internal_not_committed("sqlite_recompute_ref", err.to_string()))?;
        upd_stmt
            .execute(params![
                exact_count,
                now_ms,
                space_id.as_str(),
                digest.as_bytes().as_slice(),
            ])
            .map_err(|err| internal_not_committed("sqlite_recompute_ref", err.to_string()))?;
    }
    Ok(())
}

fn insert_note_alias_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    old_parent_folder_id: &FolderId,
    old_slug_fold: &str,
    old_title_norm: &str,
    target_note_id: &NoteId,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let mut stmt = conn
        .prepare_cached(
            "INSERT OR IGNORE INTO note_aliases (
                space_id, old_parent_folder_id, old_slug_fold, old_title_norm, target_note_id, created_seq
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .map_err(|err| internal_not_committed("sqlite_insert_note_alias", err.to_string()))?;
    stmt.execute(params![
        space_id.as_str(),
        old_parent_folder_id.as_str(),
        old_slug_fold,
        old_title_norm,
        target_note_id.as_str(),
        created_seq.get() as i64,
    ])
    .map_err(|err| internal_not_committed("sqlite_insert_note_alias", err.to_string()))?;
    Ok(())
}

fn load_current_space_schema_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
) -> Result<Option<CurrentSpaceSchema>, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT schema_rev_id, schema_note_id, descriptor_msgpack, descriptor_fingerprint
             FROM space_field_schemas
             WHERE space_id = ?1 AND is_current = 1
             LIMIT 1",
        )
        .map_err(|err| internal_not_committed("sqlite_load_space_schema", err.to_string()))?;

    let raw_opt = stmt
        .query_row(params![space_id.as_str()], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Vec<u8>>(2)?,
                r.get::<_, Vec<u8>>(3)?,
            ))
        })
        .optional()
        .map_err(|err| internal_not_committed("sqlite_load_space_schema", err.to_string()))?;

    let Some((rev_raw, note_raw, msgpack, fp_bytes)) = raw_opt else {
        return Ok(None);
    };
    let schema_revision = RevisionId::parse(&rev_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_rev", "invalid schema_rev_id"))?;
    let schema_note_id = NoteId::parse(&note_raw)
        .map_err(|_| internal_not_committed("corrupt_schema_note", "invalid schema_note_id"))?;
    let arr: [u8; 32] = fp_bytes.try_into().map_err(|_| {
        internal_not_committed("corrupt_schema_fp", "descriptor_fingerprint != 32B")
    })?;
    let fields: BTreeMap<String, FieldSchema> =
        decode_msgpack_bounded(&msgpack, MAX_MSGPACK_DECODE_BYTES)?;

    Ok(Some(CurrentSpaceSchema {
        schema_revision,
        schema_note_id,
        descriptor_fingerprint: ContentDigest::from_bytes(arr),
        fields,
    }))
}

fn load_current_space_schema_cached(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    space_id: &SpaceId,
) -> Result<Option<Arc<CurrentSpaceSchema>>, PortError> {
    if let Some(cached) = cache.space_schemas.get(space_id) {
        return Ok(cached.clone());
    }
    let loaded = load_current_space_schema_rusqlite(conn, space_id)?.map(Arc::new);
    cache.space_schemas.insert(space_id.clone(), loaded.clone());
    Ok(loaded)
}

#[allow(clippy::too_many_arguments)]
fn upsert_agent_run_head_rusqlite_deferred(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    actor_id: &PrincipalId,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    now_ts: Timestamp,
    buf: &mut DeferredAppendRows,
) -> Result<RevisionId, PortError> {
    let run_rev = new_revision_id()?;
    let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
        AgentRunRevisionMetadata {
            run_id: run_id.clone(),
            last_seq: visibility_seq,
        },
    ))
    .encode()?;
    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let s_seq = space_seq.get() as i64;
    let last_i64 = visibility_seq.get() as i64;

    buf.revisions.push(DeferredRevisionRow {
        space_id: scope.space_id.as_str().to_owned(),
        incarnation: SqlBlob16(*scope.incarnation.as_bytes()),
        rev_id: run_rev.as_str().to_owned(),
        entity_type: "agent_run",
        entity_key: run_id.as_str().to_owned(),
        space_seq: s_seq,
        visibility_seq: last_i64,
        parent_rev_id: None,
        restored_from_rev_id: None,
        content_blake3: None,
        metadata_msgpack: meta,
        actor_id: actor_id.as_str().to_owned(),
        agent_run_id: Some(run_id.as_str().to_owned()),
        sec,
        nsec,
    });

    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO agent_run_heads (
                space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (space_id, run_id) DO UPDATE SET
                history_incarnation = excluded.history_incarnation,
                run_revision = excluded.run_revision,
                last_seq = excluded.last_seq,
                updated_at_sec = excluded.updated_at_sec,
                updated_at_nsec = excluded.updated_at_nsec",
        )
        .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
    stmt.execute(params![
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        run_id.as_str(),
        run_rev.as_str(),
        last_i64,
        sec,
        nsec,
    ])
    .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
    Ok(run_rev)
}

#[allow(clippy::too_many_arguments)]
fn insert_revision_row_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    rev_id: &RevisionId,
    entity_type: &str,
    entity_key: &str,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    parent_rev_id: Option<&RevisionId>,
    restored_from_rev_id: Option<&RevisionId>,
    content_blake3: Option<ContentDigest>,
    metadata_msgpack: &[u8],
    actor_id: &PrincipalId,
    agent_run_id: Option<&AgentRunId>,
    created_at: Timestamp,
) -> Result<(), PortError> {
    let (sec, nsec) = encode_timestamp_parts(created_at);
    let s_seq = space_seq.get() as i64;
    let v_seq = visibility_seq.get() as i64;
    let digest_slice = content_blake3.as_ref().map(|d| d.as_bytes().as_slice());

    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO revisions (
                space_id, history_incarnation, rev_id, entity_type, entity_key,
                space_seq, visibility_seq, parent_rev_id, their_rev_id,
                restored_from_rev_id, content_blake3, metadata_msgpack,
                patch_meta_json, actor_id, session_id, agent_run_id,
                quarantine_reason, created_at_sec, created_at_nsec
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, NULL, ?12, NULL, ?13, NULL, ?14, ?15)",
        )
        .map_err(|err| internal_not_committed("sqlite_insert_revision", err.to_string()))?;

    stmt.execute(params![
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        rev_id.as_str(),
        entity_type,
        entity_key,
        s_seq,
        v_seq,
        parent_rev_id.map(RevisionId::as_str),
        restored_from_rev_id.map(RevisionId::as_str),
        digest_slice,
        metadata_msgpack,
        actor_id.as_str(),
        agent_run_id.map(AgentRunId::as_str),
        sec,
        nsec,
    ])
    .map_err(|err| internal_not_committed("sqlite_insert_revision", err.to_string()))?;
    Ok(())
}

fn upsert_agent_run_head_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    actor_id: &PrincipalId,
    space_seq: SpaceSeq,
    visibility_seq: SpaceSeq,
    now_ts: Timestamp,
) -> Result<RevisionId, PortError> {
    let run_rev = new_revision_id()?;
    let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
        AgentRunRevisionMetadata {
            run_id: run_id.clone(),
            last_seq: visibility_seq,
        },
    ))
    .encode()?;
    insert_revision_row_rusqlite(
        conn,
        scope,
        &run_rev,
        "agent_run",
        run_id.as_str(),
        space_seq,
        visibility_seq,
        None,
        None,
        None,
        &meta,
        actor_id,
        Some(run_id),
        now_ts,
    )?;

    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let last_i64 = visibility_seq.get() as i64;

    let mut stmt = conn
        .prepare_cached(
            "INSERT INTO agent_run_heads (
                space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (space_id, run_id) DO UPDATE SET
                history_incarnation = excluded.history_incarnation,
                run_revision = excluded.run_revision,
                last_seq = excluded.last_seq,
                updated_at_sec = excluded.updated_at_sec,
                updated_at_nsec = excluded.updated_at_nsec",
        )
        .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
    stmt.execute(params![
        scope.space_id.as_str(),
        scope.incarnation.as_bytes().as_slice(),
        run_id.as_str(),
        run_rev.as_str(),
        last_i64,
        sec,
        nsec,
    ])
    .map_err(|err| internal_not_committed("sqlite_upsert_agent_run", err.to_string()))?;
    Ok(run_rev)
}

fn insert_change_payload_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    cp: &ChangePayloadDraft,
    created_seq: SpaceSeq,
) -> Result<(), PortError> {
    let seq_i64 = created_seq.get() as i64;
    {
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO change_payloads (
                    space_id, payload_id, codec, erased_by_purge, effect_msgpack, created_seq
                ) VALUES (?1, ?2, ?3, 0, ?4, ?5)",
            )
            .map_err(|err| {
                internal_not_committed("sqlite_insert_change_payload", err.to_string())
            })?;
        stmt.execute(params![
            scope.space_id.as_str(),
            &cp.payload_id,
            &cp.codec,
            &cp.effect_msgpack,
            seq_i64,
        ])
        .map_err(|err| internal_not_committed("sqlite_insert_change_payload", err.to_string()))?;
    }

    if !cp.owner_note_ids.is_empty() {
        let mut own_stmt = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO payload_owners (
                    space_id, payload_kind, payload_id, note_id
                ) VALUES (?1, 'change_payload', ?2, ?3)",
            )
            .map_err(|err| internal_not_committed("sqlite_insert_cp_owner", err.to_string()))?;
        for note_id in &cp.owner_note_ids {
            own_stmt
                .execute(params![
                    scope.space_id.as_str(),
                    &cp.payload_id,
                    note_id.as_str(),
                ])
                .map_err(|err| internal_not_committed("sqlite_insert_cp_owner", err.to_string()))?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_change_command_and_events_rusqlite(
    conn: &rusqlite::Connection,
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

    {
        let mut cmd_stmt = conn
            .prepare_cached(
                "INSERT INTO change_commands (
                    space_id, history_incarnation, command_id, first_seq, last_seq,
                    command_kind, payload_id, committed_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|err| internal_not_committed("sqlite_batch_insert_cmd", err.to_string()))?;
        cmd_stmt
            .execute(params![
                scope.space_id.as_str(),
                scope.incarnation.as_bytes().as_slice(),
                command_id,
                first_i64,
                last_i64,
                command_kind,
                payload_id,
                committed_at_ms,
            ])
            .map_err(|err| internal_not_committed("sqlite_batch_insert_cmd", err.to_string()))?;
    }

    let mut ev_stmt = conn
        .prepare_cached(
            "INSERT INTO change_log (
                space_id, space_seq, history_incarnation, command_id,
                command_first_seq, command_last_seq, entity_type, entity_id,
                op_kind, rev_id, lifecycle_state, doc_class, payload_id, committed_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )
        .map_err(|err| internal_not_committed("sqlite_batch_insert_ev", err.to_string()))?;

    for ev in events {
        let lc_str = lifecycle_to_db(ev.lifecycle);
        let dc_str = ev.doc_class.map(doc_class_to_db);
        ev_stmt
            .execute(params![
                scope.space_id.as_str(),
                ev.space_seq.get() as i64,
                scope.incarnation.as_bytes().as_slice(),
                command_id,
                first_i64,
                last_i64,
                &ev.entity_type,
                &ev.entity_id,
                &ev.op_kind,
                ev.rev_id.as_str(),
                lc_str,
                dc_str,
                payload_id,
                committed_at_ms,
            ])
            .map_err(|err| internal_not_committed("sqlite_batch_insert_ev", err.to_string()))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_receipt_rusqlite(
    conn: &rusqlite::Connection,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
    status: &str,
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
            owner_note_ids: Vec::new(),
        };
        insert_change_payload_rusqlite(conn, scope, &draft, canonical_seq)?;
        Some(pid)
    } else {
        None
    };

    {
        let mut stmt = conn
            .prepare_cached(
                "INSERT INTO command_receipts (
                    space_id, history_incarnation, actor_id, idempotency_key, command_hash,
                    status, envelope_version, response_payload_id, sanitized_envelope_msgpack,
                    canonical_seq, expires_at_ms
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10)",
            )
            .map_err(|err| internal_not_committed("sqlite_insert_receipt", err.to_string()))?;
        stmt.execute(params![
            scope.space_id.as_str(),
            scope.incarnation.as_bytes().as_slice(),
            idemp.actor.as_str(),
            idemp.command_key.as_str(),
            idemp.command_hash.as_bytes().as_slice(),
            status,
            &resp_payload_id,
            sanitized_blob,
            seq_i64,
            expires_at_ms,
        ])
        .map_err(|err| internal_not_committed("sqlite_insert_receipt", err.to_string()))?;
    }

    if resp_payload_id.is_some() && !owner_note_ids.is_empty() {
        let mut own_stmt = conn
            .prepare_cached(
                "INSERT OR IGNORE INTO payload_owners (
                    space_id, payload_kind, payload_id, note_id
                ) VALUES (?1, 'command_receipt', ?2, ?3)",
            )
            .map_err(|err| internal_not_committed("sqlite_insert_rcpt_owner", err.to_string()))?;
        for note_id in owner_note_ids {
            own_stmt
                .execute(params![
                    scope.space_id.as_str(),
                    &receipt_owner_key,
                    note_id.as_str(),
                ])
                .map_err(|err| {
                    internal_not_committed("sqlite_insert_rcpt_owner", err.to_string())
                })?;
        }
    }
    Ok(())
}

fn bump_space_seq_exact_rusqlite(
    conn: &rusqlite::Connection,
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

    let mut stmt = conn
        .prepare_cached(
            "UPDATE spaces
             SET last_seq = last_seq + ?1
             WHERE space_id = ?2 AND history_incarnation = ?3 AND active_epoch = ?4
               AND last_seq = ?5 AND last_seq <= ?6",
        )
        .map_err(|err| internal_not_committed("sqlite_batch_bump_seq", err.to_string()))?;
    let affected = stmt
        .execute(params![
            delta_i64,
            scope.space_id.as_str(),
            scope.incarnation.as_bytes().as_slice(),
            epoch_i64,
            before_i64,
            max_allowed_before,
        ])
        .map_err(|err| internal_not_committed("sqlite_batch_bump_seq", err.to_string()))?;

    if affected != 1 {
        return Err(DomainError::validation(ValidationReason::InvalidAuthority).into());
    }
    Ok(new_last)
}

// ============================================================================
// Note-Only `rollback_agent_run` Single-Pass Synchronous `rusqlite` Fast Path
// ============================================================================

struct RollbackDirectSqliteFastPlan {
    scope: HistoryScope,
    auth: EngineAuthContext,
    request_identity: CommandIdentity,
    input: RollbackAgentRun,
    room_fences: Arc<RoomFenceTable>,
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_rollback_direct_sqlite_fast_intent(
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: CommandIdentitySpec,
    auth: EngineAuthContext,
    request_identity: CommandIdentity,
    input: RollbackAgentRun,
    room_fences: Arc<RoomFenceTable>,
) -> (PreparedWriteIntent, Box<dyn SqliteSyncItemPlan>) {
    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(|_tx, _ctx| {
            Box::pin(async {
                Err(internal_not_committed(
                    "fast_intent_placeholder_invoked",
                    "RollbackDirectSqliteFastPlan was not materialized before async fallback",
                ))
            })
        }),
    };
    let plan = Box::new(RollbackDirectSqliteFastPlan {
        scope: scope.clone(),
        auth,
        request_identity,
        input,
        room_fences,
    });
    (intent, plan)
}

impl SqliteSyncItemPlan for RollbackDirectSqliteFastPlan {
    fn take_deferred_local_staging(&self) -> Option<DeferredLocalStaging> {
        None
    }

    fn requires_savepoint_isolation(&self) -> bool {
        true
    }

    fn into_async_exec(self: Box<Self>) -> ItemExecuteFn {
        let me = *self;
        build_rollback_direct_single_tx_exec(
            me.scope,
            me.auth,
            me.request_identity,
            me.input,
            me.room_fences,
        )
    }

    fn execute_sqlite_sync(
        &self,
        conn: &rusqlite::Connection,
        item_ctx: &mut ItemExecCtx,
        cache: &mut FastBatchSqlCache,
        batch_now_ts: Timestamp,
        batch_now_ms: i64,
        defer_append: Option<&mut DeferredAppendRows>,
    ) -> Result<ItemCommitArtifacts, FastItemExecError> {
        let scope_cl = &self.scope;
        let auth = &self.auth;
        let input = &self.input;

        // --- 1. Read-only preconditions & pure validation (zero SQL mutations) ---
        if has_any_board_moves_in_space_rusqlite(conn, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?
        {
            return Err(FastItemExecError::PreWrite(
                rollback_fallback_board_present_err(),
            ));
        }

        let mut heads_map = verify_run_and_entity_preconditions_note_only_rusqlite(
            conn,
            cache,
            scope_cl,
            &item_ctx.space,
            auth,
            input,
        )
        .map_err(FastItemExecError::PreWrite)?;

        let has_collab = space_has_any_collab_session_cached(conn, cache, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?;
        let collab_states = if has_collab {
            load_space_collab_states_rusqlite(conn, &scope_cl.space_id)
                .map_err(FastItemExecError::PreWrite)?
        } else {
            HashMap::new()
        };

        let mut skipped_manual_edits = Vec::new();
        let mut skipped_room_active = Vec::new();
        let mut candidates = BTreeMap::new();
        let mut original_metadata = HashMap::with_capacity(heads_map.len());
        // Command ends are monotonic. Within each command space_seq orders its events.
        let mut history = conn.prepare_cached(
            "WITH touched AS (
                 SELECT entity_key, MIN(space_seq) AS first_run_seq
                 FROM revisions
                 WHERE space_id = ?1 AND entity_type = 'note' AND agent_run_id = ?2
                 GROUP BY entity_key
             )
             SELECT t.entity_key, EXISTS (
                        SELECT 1 FROM revisions r
                        WHERE r.space_id = ?1 AND r.entity_type = 'note' AND r.entity_key = t.entity_key
                          AND r.visibility_seq > t.first_run_seq AND r.space_seq > t.first_run_seq
                          AND r.agent_run_id IS NOT ?2
                    ), pre.rev_id, pre.metadata_msgpack
             FROM touched t LEFT JOIN revisions pre ON pre.rowid = (
                 SELECT r.rowid FROM revisions r
                 WHERE r.space_id = ?1 AND r.entity_type = 'note' AND r.entity_key = t.entity_key
                   AND r.space_seq < t.first_run_seq
                 ORDER BY r.visibility_seq DESC, r.space_seq DESC LIMIT 1
             )
             ORDER BY t.entity_key"
        ).map_err(|err| FastItemExecError::PreWrite(internal_not_committed("sqlite_rollback_history", err.to_string())))?;
        let map_history_error = |err| {
            FastItemExecError::PreWrite(map_interrupt_or_internal(err, "sqlite_rollback_history"))
        };
        let mut rows = history
            .query(params![scope_cl.space_id.as_str(), input.run.as_str()])
            .map_err(map_history_error)?;
        while let Some(row) = rows.next().map_err(map_history_error)? {
            let key: &str = row
                .get_ref(0)
                .map_err(map_history_error)?
                .as_str()
                .map_err(|err| {
                    FastItemExecError::PreWrite(internal_not_committed(
                        "sqlite_rollback_note_id",
                        err.to_string(),
                    ))
                })?;
            let nid = NoteId::parse(key).map_err(|e| FastItemExecError::PreWrite(e.into()))?;
            let head = heads_map.remove(&nid).ok_or_else(|| {
                FastItemExecError::PreWrite(
                    DomainError::validation(ValidationReason::SourceMismatch).into(),
                )
            })?;
            if row.get::<_, bool>(1).map_err(map_history_error)? {
                skipped_manual_edits.push(nid);
                continue;
            }
            if collab_states.get(&nid) == Some(&true) {
                skipped_room_active.push(nid);
                continue;
            }
            let pre_raw: Option<String> = row.get(2).map_err(map_history_error)?;
            let Some(pre_raw) = pre_raw else {
                candidates.insert(
                    nid,
                    CandidateAction::TrashCreated {
                        current_rev: head.head_rev_id,
                        current_lifecycle: head.lifecycle,
                        doc_class: head.doc_class,
                        parent_folder_id: head.parent_folder_id,
                        slug: head.slug,
                        slug_fold: head.slug_fold,
                        title: head.title,
                        ability_id: head.ability_id,
                        visibility_mask: head.visibility_mask,
                        byte_size: head.byte_size,
                        content_digest: head.content_digest,
                    },
                );
                continue;
            };
            let pre_rev_id =
                RevisionId::parse(&pre_raw).map_err(|e| FastItemExecError::PreWrite(e.into()))?;
            let bytes: Vec<u8> = row.get(3).map_err(map_history_error)?;
            let envelope =
                RevisionMetadataEnvelope::decode(&bytes).map_err(FastItemExecError::PreWrite)?;
            let RevisionMetadataPayload::Note(pre_meta) = envelope.payload else {
                return Err(FastItemExecError::PreWrite(internal_not_committed(
                    "corrupt_note_rev_meta",
                    "expected note revision metadata",
                )));
            };
            let head_unchanged_placement = head.lifecycle == pre_meta.lifecycle
                && head.parent_folder_id == pre_meta.parent_folder_id
                && head.slug == pre_meta.slug
                && head.slug_fold == pre_meta.slug_fold;
            let needs_note_mutation = head.head_rev_id != pre_rev_id || !head_unchanged_placement;
            original_metadata.insert(nid.clone(), bytes);
            candidates.insert(
                nid,
                CandidateAction::RestorePreExisting {
                    current_rev: head.head_rev_id,
                    pre_rev_id,
                    pre_meta: Box::new(pre_meta),
                    pre_carrier: None,
                    needs_note_mutation,
                    head_unchanged_placement,
                },
            );
        }
        drop(rows);
        drop(history);

        // Lock per-note fences in ascending NoteId order before collision checks so no room can open/close
        // concurrently and any PreWrite error drops the guards without bumping fence epochs.
        let mut eligible_notes: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
        let mut locked_fences = Vec::with_capacity(candidates.len());
        for (nid, action) in candidates {
            match self
                .room_fences
                .try_lock_closed_for_rollback_blocking(scope_cl, &nid, &self.request_identity)
                .map_err(FastItemExecError::PreWrite)?
            {
                Some((guard, res)) => {
                    locked_fences.push((guard, res));
                    eligible_notes.insert(nid, action);
                }
                None => {
                    skipped_room_active.push(nid);
                }
            }
        }
        skipped_room_active.sort();

        let eligible_all_ids: BTreeSet<NoteId> = eligible_notes.keys().cloned().collect();
        let mut planned_active_slots: HashMap<(FolderId, String), NoteId> = HashMap::new();
        let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();

        for (nid, action) in &eligible_notes {
            if let CandidateAction::RestorePreExisting {
                pre_meta,
                head_unchanged_placement,
                ..
            } = action
            {
                let require_active_folder = pre_meta.lifecycle == Lifecycle::Active;
                let (after, anc) = build_resource_facts_cached(
                    conn,
                    cache,
                    &item_ctx.space,
                    &pre_meta.parent_folder_id,
                    pre_meta.doc_class,
                    pre_meta.ability_id.clone(),
                    require_active_folder,
                )
                .map_err(FastItemExecError::PreWrite)?;
                auth.authorize_direct_write(&after, &after)
                    .map_err(|err| FastItemExecError::PreWrite(err.into()))?;
                restored_ancestries.insert(nid.clone(), anc.is_root_child);

                if pre_meta.lifecycle == Lifecycle::Active {
                    let slot_key = (
                        pre_meta.parent_folder_id.clone(),
                        pre_meta.slug_fold.clone(),
                    );
                    if planned_active_slots.insert(slot_key, nid.clone()).is_some() {
                        return Err(FastItemExecError::PreWrite(
                            DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: if anc.is_root_child {
                                        None
                                    } else {
                                        Some(pre_meta.parent_folder_id.clone())
                                    },
                                    component: pre_meta.slug.clone(),
                                },
                            }
                            .into(),
                        ));
                    }
                    if !*head_unchanged_placement
                        && let Some(occ_nid) = active_occupant_note_id_rusqlite(
                            conn,
                            &scope_cl.space_id,
                            &pre_meta.parent_folder_id,
                            &pre_meta.slug_fold,
                        )
                        .map_err(FastItemExecError::PreWrite)?
                        && !eligible_all_ids.contains(&occ_nid)
                    {
                        return Err(FastItemExecError::PreWrite(
                            DomainError::PathConflict {
                                target: PathTarget {
                                    space_id: scope_cl.space_id.clone(),
                                    parent: if anc.is_root_child {
                                        None
                                    } else {
                                        Some(pre_meta.parent_folder_id.clone())
                                    },
                                    component: pre_meta.slug.clone(),
                                },
                            }
                            .into(),
                        ));
                    }
                }
            }
        }

        // Pre-verify all existing active blobs that will be bound to new trash/restore revisions.
        let mut unique_digests: Vec<ContentDigest> = Vec::with_capacity(eligible_notes.len());
        for action in eligible_notes.values() {
            match action {
                CandidateAction::TrashCreated {
                    current_lifecycle,
                    content_digest: Some(d),
                    ..
                } if *current_lifecycle != Lifecycle::Trashed => {
                    unique_digests.push(*d);
                }
                CandidateAction::RestorePreExisting {
                    needs_note_mutation: true,
                    pre_meta,
                    ..
                } => {
                    if let Some(d) = pre_meta.content_digest {
                        unique_digests.push(d);
                    }
                }
                _ => {}
            }
        }
        unique_digests.sort_unstable();
        unique_digests.dedup();

        let mut pub_by_digest: HashMap<ContentDigest, (Option<usize>, String)> =
            HashMap::with_capacity(unique_digests.len());
        if !unique_digests.is_empty() {
            let mut cat_stmt = conn
                .prepare_cached(
                    "SELECT admission_state, blob_state, current_publication_id
                     FROM blob_catalog WHERE space_id = ?1 AND content_blake3 = ?2",
                )
                .map_err(|err| {
                    FastItemExecError::PreWrite(internal_not_committed(
                        "sqlite_rebind_cat_prep",
                        err.to_string(),
                    ))
                })?;
            for d in &unique_digests {
                if let Some((idx, pub_id)) = cache
                    .in_batch_new_blobs
                    .get(&(scope_cl.space_id.clone(), *d))
                {
                    pub_by_digest.insert(*d, (Some(*idx), pub_id.clone()));
                    continue;
                }
                let row_opt: Option<(String, String, Option<String>)> = cat_stmt
                    .query_row(
                        params![scope_cl.space_id.as_str(), d.as_bytes().as_slice()],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()
                    .map_err(|err| {
                        FastItemExecError::PreWrite(internal_not_committed(
                            "sqlite_rebind_cat_row",
                            err.to_string(),
                        ))
                    })?;
                let Some((admission, blob_state, Some(pub_id))) = row_opt else {
                    return Err(FastItemExecError::PreWrite(unavailable_retryable(
                        "blob_missing_for_rebind",
                        "existing blob publication missing during metadata revision bind",
                        Duration::from_millis(25),
                    )));
                };
                if admission != "open" || blob_state != "active" {
                    return Err(FastItemExecError::PreWrite(unavailable_retryable(
                        "blob_retiring_on_rebind",
                        "existing blob entered retirement before metadata revision commit",
                        Duration::from_millis(25),
                    )));
                }
                pub_by_digest.insert(*d, (None, pub_id));
            }
        }

        let current_schema = load_current_space_schema_cached(conn, cache, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?;
        let space_has_overlays = has_any_overlays_in_space_rusqlite(conn, &scope_cl.space_id)
            .map_err(FastItemExecError::PreWrite)?;

        let mut trash_ancestries: HashMap<NoteId, bool> = HashMap::new();
        for (nid, action) in &eligible_notes {
            if let CandidateAction::TrashCreated {
                current_lifecycle,
                parent_folder_id,
                doc_class,
                ability_id,
                ..
            } = action
                && *current_lifecycle != Lifecycle::Trashed
            {
                let (_, anc) = build_resource_facts_cached(
                    conn,
                    cache,
                    &item_ctx.space,
                    parent_folder_id,
                    *doc_class,
                    ability_id.clone(),
                    false,
                )
                .map_err(FastItemExecError::PreWrite)?;
                trash_ancestries.insert(nid.clone(), anc.is_root_child);
            }
        }

        let trash_note_count = eligible_notes
            .values()
            .filter(|act| {
                matches!(
                    act,
                    CandidateAction::TrashCreated {
                        current_lifecycle,
                        ..
                    } if *current_lifecycle != Lifecycle::Trashed
                )
            })
            .count() as u64;
        let restore_note_count = eligible_notes
            .values()
            .filter(|act| {
                matches!(
                    act,
                    CandidateAction::RestorePreExisting {
                        needs_note_mutation: true,
                        ..
                    }
                )
            })
            .count() as u64;
        let total_seqs = (trash_note_count + restore_note_count).max(1);
        let (first_seq, visibility_seq) = item_ctx
            .preview_seq_range(total_seqs)
            .map_err(FastItemExecError::PreWrite)?;

        // Consume all closed-room reservations in ascending NoteId order after all PreWrite checks pass.
        for (mut guard, res) in locked_fences {
            guard
                .consume(res, &self.request_identity)
                .map_err(|e| FastItemExecError::PreWrite(e.into()))?;
            item_ctx.retain_until_batch_commit(guard);
        }

        // --- 2. Authoritative SQL writes ---
        let vis_i64 = visibility_seq.get() as i64;
        let (sec, nsec) = encode_timestamp_parts(batch_now_ts);
        let actor_str = auth.principal().as_str();
        let mut id_pool = ordered_ids_batch((total_seqs as usize) + 3)
            .map_err(FastItemExecError::PreWrite)?
            .into_iter();
        let mut next_fast_rev_id = || -> Result<RevisionId, FastItemExecError> {
            let suffix = hex::encode(id_pool.next().expect("id_pool pre-sized"));
            RevisionId::parse(&format!("rev_{suffix}"))
                .map_err(|e| FastItemExecError::PostWrite(e.into()))
        };

        let mut events = Vec::with_capacity(total_seqs as usize);
        let mut trashed_out = Vec::with_capacity(trash_note_count as usize);
        let mut restored_out = Vec::with_capacity(restore_note_count as usize);
        let mut owner_notes_for_receipt: BTreeSet<NoteId> = BTreeSet::new();
        let mut pending_blob_rebinds: Vec<(NoteId, RevisionId, ContentDigest, SpaceSeq)> =
            Vec::with_capacity(eligible_notes.len());
        struct PendingFastRev {
            rev_id: RevisionId,
            entity_key: String,
            space_seq: SpaceSeq,
            parent_rev_id: RevisionId,
            restored_from_rev_id: Option<RevisionId>,
            content_blake3: Option<ContentDigest>,
            metadata_msgpack: Vec<u8>,
        }
        let mut pending_rev_rows: Vec<PendingFastRev> = Vec::with_capacity(eligible_notes.len());

        // 2a. Trash run-created eligible notes FIRST so colliding sibling slots are freed before restore.
        {
            let mut trash_stmt = conn
                .prepare_cached(
                    "UPDATE note_heads
                     SET head_rev_id = ?1, lifecycle_state = 'trashed', updated_seq = ?2,
                         updated_at_sec = ?3, updated_at_nsec = ?4, last_actor_id = ?5
                     WHERE space_id = ?6 AND note_id = ?7",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_rb_trash_prep",
                        err.to_string(),
                    ))
                })?;

            for (nid, action) in &eligible_notes {
                let CandidateAction::TrashCreated {
                    current_rev,
                    current_lifecycle,
                    doc_class,
                    parent_folder_id,
                    slug,
                    slug_fold,
                    title,
                    ability_id,
                    visibility_mask,
                    byte_size,
                    content_digest,
                } = action
                else {
                    continue;
                };

                if space_has_overlays {
                    delete_all_target_overlays_rusqlite(conn, &scope_cl.space_id, nid)
                        .map_err(FastItemExecError::PostWrite)?;
                }
                owner_notes_for_receipt.insert(nid.clone());

                if *current_lifecycle == Lifecycle::Trashed {
                    trashed_out.push(NoteRevision {
                        note: nid.clone(),
                        revision: current_rev.clone(),
                    });
                    continue;
                }

                let tseq = item_ctx
                    .alloc_next_seq()
                    .map_err(FastItemExecError::PostWrite)?;
                let trev = next_fast_rev_id()?;
                let is_root_child = trash_ancestries.get(nid).copied().unwrap_or(false);

                trash_stmt
                    .execute(params![
                        trev.as_str(),
                        vis_i64,
                        sec,
                        nsec,
                        actor_str,
                        scope_cl.space_id.as_str(),
                        nid.as_str(),
                    ])
                    .map_err(|err| {
                        FastItemExecError::PostWrite(internal_not_committed(
                            "sqlite_rb_trash_exec",
                            err.to_string(),
                        ))
                    })?;

                cache
                    .in_batch_modified_notes
                    .insert((scope_cl.space_id.clone(), nid.clone()));

                if collab_states.contains_key(nid) {
                    sync_closed_collab_session_on_direct_write_rusqlite(
                        conn,
                        &scope_cl.space_id,
                        nid,
                        &trev,
                        visibility_seq,
                    )
                    .map_err(FastItemExecError::PostWrite)?;
                }

                if let Some(digest) = *content_digest {
                    pending_blob_rebinds.push((nid.clone(), trev.clone(), digest, tseq));
                }

                let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        note_id: nid.clone(),
                        parent_folder_id: parent_folder_id.clone(),
                        is_root_child,
                        slug: slug.clone(),
                        slug_fold: slug_fold.clone(),
                        title: title.clone(),
                        doc_class: *doc_class,
                        ability_id: ability_id.clone(),
                        lifecycle: Lifecycle::Trashed,
                        visibility_mask: *visibility_mask,
                        byte_size: *byte_size,
                        content_digest: *content_digest,
                        schema_revision: current_schema.as_ref().map(|s| s.schema_revision.clone()),
                        raw_fields: None,
                        evaluated_fields: BTreeMap::new(),
                        diagnostics: Vec::new(),
                    },
                ))
                .encode()
                .map_err(FastItemExecError::PostWrite)?;

                pending_rev_rows.push(PendingFastRev {
                    rev_id: trev.clone(),
                    entity_key: nid.as_str().to_owned(),
                    space_seq: tseq,
                    parent_rev_id: current_rev.clone(),
                    restored_from_rev_id: None,
                    content_blake3: *content_digest,
                    metadata_msgpack: meta,
                });

                events.push(BatchEventDraft {
                    space_seq: tseq,
                    entity_type: "note".to_owned(),
                    entity_id: nid.as_str().to_owned(),
                    op_kind: "trash".to_owned(),
                    rev_id: trev.clone(),
                    lifecycle: Lifecycle::Trashed,
                    doc_class: Some(*doc_class),
                });
                trashed_out.push(NoteRevision {
                    note: nid.clone(),
                    revision: trev,
                });
            }
        }

        // 2b. Restore pre-existing eligible notes (`restored_from_rev_id = Some(pre_rev_id)`).
        {
            let mut restore_full_stmt = conn
                .prepare_cached(
                    "UPDATE note_heads
                     SET parent_folder_id = ?1, slug = ?2, slug_fold = ?3, title = ?4, title_fold = ?5,
                         doc_class = ?6, ability_id = ?7, head_rev_id = ?8, content_blake3 = ?9,
                         byte_size = ?10, lifecycle_state = ?11, visibility_mask = ?12,
                         updated_seq = ?13, updated_at_sec = ?14, updated_at_nsec = ?15, last_actor_id = ?16
                     WHERE space_id = ?17 AND note_id = ?18",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_rb_restore_prep",
                        err.to_string(),
                    ))
                })?;
            let mut restore_inplace_stmt = conn
                .prepare_cached(
                    "UPDATE note_heads
                     SET title = ?1, title_fold = ?2, doc_class = ?3, ability_id = ?4,
                         head_rev_id = ?5, content_blake3 = ?6, byte_size = ?7, visibility_mask = ?8,
                         updated_seq = ?9, updated_at_sec = ?10, updated_at_nsec = ?11, last_actor_id = ?12
                     WHERE space_id = ?13 AND note_id = ?14",
                )
                .map_err(|err| {
                    FastItemExecError::PostWrite(internal_not_committed(
                        "sqlite_rb_restore_inplace_prep",
                        err.to_string(),
                    ))
                })?;

            for (nid, action) in &eligible_notes {
                let CandidateAction::RestorePreExisting {
                    current_rev,
                    pre_rev_id,
                    pre_meta,
                    needs_note_mutation,
                    head_unchanged_placement,
                    ..
                } = action
                else {
                    continue;
                };
                owner_notes_for_receipt.insert(nid.clone());

                if !*needs_note_mutation {
                    continue;
                }

                let rseq = item_ctx
                    .alloc_next_seq()
                    .map_err(FastItemExecError::PostWrite)?;
                let rrev = next_fast_rev_id()?;
                let is_root_child = restored_ancestries.get(nid).copied().unwrap_or(false);

                if let Some(digest) = pre_meta.content_digest {
                    pending_blob_rebinds.push((nid.clone(), rrev.clone(), digest, rseq));
                }

                let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
                    normalize_title_key(&pre_meta.slug)
                } else {
                    normalize_title_key(&pre_meta.title)
                };
                let digest_slice = pre_meta
                    .content_digest
                    .as_ref()
                    .map(|d| d.as_bytes().as_slice());

                if *head_unchanged_placement {
                    restore_inplace_stmt
                        .execute(params![
                            &pre_meta.title,
                            title_fold,
                            doc_class_to_db(pre_meta.doc_class),
                            pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                            rrev.as_str(),
                            digest_slice,
                            pre_meta.byte_size as i64,
                            i64::from(pre_meta.visibility_mask),
                            vis_i64,
                            sec,
                            nsec,
                            actor_str,
                            scope_cl.space_id.as_str(),
                            nid.as_str(),
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rb_restore_inplace_exec",
                                err.to_string(),
                            ))
                        })?;
                } else {
                    restore_full_stmt
                        .execute(params![
                            pre_meta.parent_folder_id.as_str(),
                            &pre_meta.slug,
                            &pre_meta.slug_fold,
                            &pre_meta.title,
                            title_fold,
                            doc_class_to_db(pre_meta.doc_class),
                            pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                            rrev.as_str(),
                            digest_slice,
                            pre_meta.byte_size as i64,
                            lifecycle_to_db(pre_meta.lifecycle),
                            i64::from(pre_meta.visibility_mask),
                            vis_i64,
                            sec,
                            nsec,
                            actor_str,
                            scope_cl.space_id.as_str(),
                            nid.as_str(),
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rb_restore_exec",
                                err.to_string(),
                            ))
                        })?;
                }

                cache
                    .in_batch_modified_notes
                    .insert((scope_cl.space_id.clone(), nid.clone()));

                if collab_states.contains_key(nid) {
                    sync_closed_collab_session_on_direct_write_rusqlite(
                        conn,
                        &scope_cl.space_id,
                        nid,
                        &rrev,
                        visibility_seq,
                    )
                    .map_err(FastItemExecError::PostWrite)?;
                }

                if space_has_overlays && pre_meta.lifecycle != Lifecycle::Active {
                    delete_all_target_overlays_rusqlite(conn, &scope_cl.space_id, nid)
                        .map_err(FastItemExecError::PostWrite)?;
                }

                let schema_revision = current_schema.as_ref().map(|s| &s.schema_revision);
                let evaluated_fields = if pre_meta.doc_class == DocClass::EncryptedNote {
                    BTreeMap::new()
                } else {
                    evaluate_fields_with_schema(
                        pre_meta.raw_fields.as_ref(),
                        pre_meta.diagnostics.first(),
                        current_schema.as_ref().map(|s| &s.fields),
                    )
                };
                let meta = if pre_meta.is_root_child == is_root_child
                    && pre_meta.schema_revision.as_ref() == schema_revision
                    && pre_meta.note_id == *nid
                    && pre_meta.evaluated_fields == evaluated_fields
                {
                    original_metadata
                        .remove(nid)
                        .expect("loaded pre-run revision")
                } else {
                    let mut restored = pre_meta.as_ref().clone();
                    restored.note_id = nid.clone();
                    restored.is_root_child = is_root_child;
                    restored.schema_revision = schema_revision.cloned();
                    restored.evaluated_fields = evaluated_fields;
                    RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(restored))
                        .encode()
                        .map_err(FastItemExecError::PostWrite)?
                };

                pending_rev_rows.push(PendingFastRev {
                    rev_id: rrev.clone(),
                    entity_key: nid.as_str().to_owned(),
                    space_seq: rseq,
                    parent_rev_id: current_rev.clone(),
                    restored_from_rev_id: Some(pre_rev_id.clone()),
                    content_blake3: pre_meta.content_digest,
                    metadata_msgpack: meta,
                });

                events.push(BatchEventDraft {
                    space_seq: rseq,
                    entity_type: "note".to_owned(),
                    entity_id: nid.as_str().to_owned(),
                    op_kind: "restore".to_owned(),
                    rev_id: rrev.clone(),
                    lifecycle: pre_meta.lifecycle,
                    doc_class: Some(pre_meta.doc_class),
                });
                restored_out.push(NoteRevision {
                    note: nid.clone(),
                    revision: rrev,
                });
            }
        }

        // 2c. Rebind existing active CAS blobs + append revision rows + bump `agent_run_heads`.
        if let Some(buf) = defer_append {
            let mut delta_persisted: HashMap<ContentDigest, i64> =
                HashMap::with_capacity(pub_by_digest.len());
            for (nid, rev_id, digest, cseq) in &pending_blob_rebinds {
                let (in_batch_idx, pub_id) =
                    pub_by_digest.get(digest).expect("verified digest present");
                if let Some(idx) = in_batch_idx {
                    buf.blob_catalog[*idx].ref_count += 1;
                } else {
                    *delta_persisted.entry(*digest).or_insert(0) += 1;
                }
                buf.blob_references.push(DeferredBlobRefRow {
                    space_id: scope_cl.space_id.as_str().to_owned(),
                    owner_kind: BlobOwnerKind::NoteRevision.as_db_str(),
                    owner_id: nid.as_str().to_owned(),
                    owner_rev_id: rev_id.as_str().to_owned(),
                    resource_key: "carrier".to_owned(),
                    content_blake3: SqlBlob32(*digest.as_bytes()),
                    publication_id: pub_id.clone(),
                    created_seq: cseq.get() as i64,
                });
            }

            if !delta_persisted.is_empty() {
                let mut upd_cat = conn
                    .prepare_cached(
                        "UPDATE blob_catalog
                         SET ref_count = ref_count + ?1, touched_at_ms = ?2
                         WHERE space_id = ?3 AND content_blake3 = ?4",
                    )
                    .map_err(|err| {
                        FastItemExecError::PostWrite(internal_not_committed(
                            "sqlite_rebind_upd_cat_prep",
                            err.to_string(),
                        ))
                    })?;
                for (digest, delta) in delta_persisted {
                    upd_cat
                        .execute(params![
                            delta,
                            batch_now_ms,
                            scope_cl.space_id.as_str(),
                            digest.as_bytes().as_slice(),
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rebind_upd_cat_exec",
                                err.to_string(),
                            ))
                        })?;
                }
            }

            for r in pending_rev_rows {
                buf.revisions.push(DeferredRevisionRow {
                    space_id: scope_cl.space_id.as_str().to_owned(),
                    incarnation: SqlBlob16(*scope_cl.incarnation.as_bytes()),
                    rev_id: r.rev_id.as_str().to_owned(),
                    entity_type: "note",
                    entity_key: r.entity_key,
                    space_seq: r.space_seq.get() as i64,
                    visibility_seq: vis_i64,
                    parent_rev_id: Some(r.parent_rev_id.as_str().to_owned()),
                    restored_from_rev_id: r.restored_from_rev_id.map(|id| id.as_str().to_owned()),
                    content_blake3: r.content_blake3.map(|d| SqlBlob32(*d.as_bytes())),
                    metadata_msgpack: r.metadata_msgpack,
                    actor_id: actor_str.to_owned(),
                    agent_run_id: None,
                    sec,
                    nsec,
                });
            }

            let new_run_rev = upsert_agent_run_head_rusqlite_deferred(
                conn,
                scope_cl,
                &input.run,
                auth.principal(),
                visibility_seq,
                visibility_seq,
                batch_now_ts,
                buf,
            )
            .map_err(FastItemExecError::PostWrite)?;

            if events.is_empty() {
                let noop_seq = item_ctx
                    .alloc_next_seq()
                    .map_err(FastItemExecError::PostWrite)?;
                events.push(BatchEventDraft {
                    space_seq: noop_seq,
                    entity_type: "folder".to_owned(),
                    entity_id: item_ctx.root_folder_id.as_str().to_owned(),
                    op_kind: "edit".to_owned(),
                    rev_id: new_run_rev,
                    lifecycle: Lifecycle::Active,
                    doc_class: None,
                });
            }
        } else {
            pending_blob_rebinds.sort_unstable_by(|a, b| {
                (a.1.as_str(), a.0.as_str()).cmp(&(b.1.as_str(), b.0.as_str()))
            });
            pending_rev_rows.sort_unstable_by(|a, b| a.rev_id.as_str().cmp(b.rev_id.as_str()));

            let mut delta_persisted: BTreeMap<[u8; 32], i64> = BTreeMap::new();
            {
                let mut ins_ref = conn
                    .prepare_cached(
                        "INSERT OR IGNORE INTO blob_references (
                            space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                            content_blake3, publication_id, created_seq
                        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )
                    .map_err(|err| {
                        FastItemExecError::PostWrite(internal_not_committed(
                            "sqlite_rebind_ins_ref_prep",
                            err.to_string(),
                        ))
                    })?;
                let owner_kind_str = BlobOwnerKind::NoteRevision.as_db_str();
                for (nid, rev_id, digest, cseq) in &pending_blob_rebinds {
                    let (_, pub_id) = pub_by_digest.get(digest).expect("verified digest present");
                    let inserted = ins_ref
                        .execute(params![
                            scope_cl.space_id.as_str(),
                            owner_kind_str,
                            nid.as_str(),
                            rev_id.as_str(),
                            "carrier",
                            digest.as_bytes().as_slice(),
                            pub_id,
                            cseq.get() as i64,
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rebind_ins_ref_exec",
                                err.to_string(),
                            ))
                        })?;
                    if inserted > 0 {
                        *delta_persisted.entry(*digest.as_bytes()).or_insert(0) += inserted as i64;
                    }
                }
            }
            if !delta_persisted.is_empty() {
                let mut upd_cat = conn
                    .prepare_cached(
                        "UPDATE blob_catalog
                         SET ref_count = ref_count + ?1, touched_at_ms = ?2
                         WHERE space_id = ?3 AND content_blake3 = ?4",
                    )
                    .map_err(|err| {
                        FastItemExecError::PostWrite(internal_not_committed(
                            "sqlite_rebind_upd_cat_prep",
                            err.to_string(),
                        ))
                    })?;
                for (digest_arr, delta) in delta_persisted {
                    upd_cat
                        .execute(params![
                            delta,
                            batch_now_ms,
                            scope_cl.space_id.as_str(),
                            digest_arr.as_slice(),
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rebind_upd_cat_exec",
                                err.to_string(),
                            ))
                        })?;
                }
            }

            {
                let mut rev_stmt = conn
                    .prepare_cached(
                        "INSERT INTO revisions (
                            space_id, history_incarnation, rev_id, entity_type, entity_key,
                            space_seq, visibility_seq, parent_rev_id, their_rev_id, restored_from_rev_id,
                            content_blake3, metadata_msgpack, patch_meta_json, actor_id, session_id,
                            agent_run_id, quarantine_reason, created_at_sec, created_at_nsec
                        ) VALUES (
                            ?1, ?2, ?3, 'note', ?4,
                            ?5, ?6, ?7, NULL, ?8,
                            ?9, ?10, NULL, ?11, NULL,
                            NULL, NULL, ?12, ?13
                        )",
                    )
                    .map_err(|err| {
                        FastItemExecError::PostWrite(internal_not_committed(
                            "sqlite_rb_ins_rev_prep",
                            err.to_string(),
                        ))
                    })?;
                let inc_slice = scope_cl.incarnation.as_bytes().as_slice();
                for r in &pending_rev_rows {
                    let restored_str = r.restored_from_rev_id.as_ref().map(RevisionId::as_str);
                    let digest_slice = r.content_blake3.as_ref().map(|d| d.as_bytes().as_slice());
                    rev_stmt
                        .execute(params![
                            scope_cl.space_id.as_str(),
                            inc_slice,
                            r.rev_id.as_str(),
                            &r.entity_key,
                            r.space_seq.get() as i64,
                            vis_i64,
                            r.parent_rev_id.as_str(),
                            restored_str,
                            digest_slice,
                            &r.metadata_msgpack,
                            actor_str,
                            sec,
                            nsec,
                        ])
                        .map_err(|err| {
                            FastItemExecError::PostWrite(internal_not_committed(
                                "sqlite_rb_ins_rev_exec",
                                err.to_string(),
                            ))
                        })?;
                }
            }

            let new_run_rev = upsert_agent_run_head_rusqlite(
                conn,
                scope_cl,
                &input.run,
                auth.principal(),
                visibility_seq,
                visibility_seq,
                batch_now_ts,
            )
            .map_err(FastItemExecError::PostWrite)?;

            if events.is_empty() {
                let noop_seq = item_ctx
                    .alloc_next_seq()
                    .map_err(FastItemExecError::PostWrite)?;
                events.push(BatchEventDraft {
                    space_seq: noop_seq,
                    entity_type: "folder".to_owned(),
                    entity_id: item_ctx.root_folder_id.as_str().to_owned(),
                    op_kind: "edit".to_owned(),
                    rev_id: new_run_rev,
                    lifecycle: Lifecycle::Active,
                    doc_class: None,
                });
            }
        }

        let owner_vec: Vec<NoteId> = owner_notes_for_receipt.into_iter().collect();
        let cmd_range = CommandSeqRange::new(first_seq, visibility_seq)
            .map_err(|e| FastItemExecError::PostWrite(e.into()))?;
        let effect_draft = build_effect_payload_draft(
            format!(
                "pay_{}",
                hex::encode(id_pool.next().expect("id_pool pre-sized"))
            ),
            scope_cl.clone(),
            cmd_range,
            "rollback_agent_run",
            EffectBodyV1::AwaitProjection {
                reason: StoredAwaitReasonV1::Bulk,
            },
            owner_vec.clone(),
        )
        .map_err(FastItemExecError::PostWrite)?;

        let receipt_token = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)
            .map_err(|e| FastItemExecError::PostWrite(e.into()))?;
        let wire = StoredCommittedRollbackV1 {
            restored: restored_out,
            trashed: trashed_out,
            restored_ranks: Vec::new(),
            skipped_manual_edits: skipped_manual_edits.clone(),
            skipped_room_active: skipped_room_active.clone(),
            receipt: receipt_token.clone(),
        };
        let resp_bytes = encode_msgpack(&wire).map_err(FastItemExecError::PostWrite)?;
        let sanitized = encode_msgpack(&StoredCommittedRollbackV1 {
            restored: Vec::new(),
            trashed: Vec::new(),
            restored_ranks: Vec::new(),
            skipped_manual_edits,
            skipped_room_active,
            receipt: receipt_token,
        })
        .map_err(FastItemExecError::PostWrite)?;

        Ok(ItemCommitArtifacts {
            command_id: format!(
                "cmd_{}",
                hex::encode(id_pool.next().expect("id_pool pre-sized"))
            ),
            command_kind: "rollback_agent_run".to_owned(),
            events,
            change_payload: Some(effect_draft),
            receipt_detail_blob: Some(resp_bytes.clone()),
            receipt_sanitized_blob: sanitized,
            receipt_owner_note_ids: owner_vec,
            response_bytes: resp_bytes,
        })
    }
}

fn verify_run_and_entity_preconditions_note_only_rusqlite(
    conn: &rusqlite::Connection,
    cache: &mut FastBatchSqlCache,
    scope: &HistoryScope,
    space: &Space,
    auth: &EngineAuthContext,
    input: &RollbackAgentRun,
) -> Result<BTreeMap<NoteId, NoteHeadRow>, PortError> {
    let run_row: Option<(Vec<u8>, String)> = {
        let mut stmt = conn
            .prepare_cached(
                "SELECT history_incarnation, run_revision FROM agent_run_heads
                 WHERE space_id = ?1 AND run_id = ?2",
            )
            .map_err(|err| internal_not_committed("sqlite_load_run_head", err.to_string()))?;
        stmt.query_row(params![scope.space_id.as_str(), input.run.as_str()], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_run_head"))?
    };

    let Some((inc_bytes, run_rev_raw)) = run_row else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let inc_arr: [u8; 16] = inc_bytes
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_run_inc", "incarnation != 16B"))?;
    let run_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(inc_arr),
    };
    scope.check(&run_scope)?;

    let actual_run_rev = RevisionId::parse(&run_rev_raw)
        .map_err(|_| internal_not_committed("corrupt_run_rev", "invalid run_revision"))?;
    if actual_run_rev != input.expected_run_revision {
        return Err(DomainError::RevisionConflict {
            current: actual_run_rev,
            lineage: None,
        }
        .into());
    }

    let mut caller_notes: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for exp in &input.expected_entities {
        if is_note_purge_fenced_cached(conn, cache, &scope.space_id, exp.note.as_str())? {
            return Err(DomainError::ResourceNotFound.into());
        }
        if caller_notes
            .insert(exp.note.clone(), exp.revision.clone())
            .is_some()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    }

    let mut touched_set: BTreeSet<NoteId> = BTreeSet::new();
    {
        let mut stmt = conn
            .prepare_cached(
                "SELECT DISTINCT entity_key FROM revisions
                 WHERE space_id = ?1 AND agent_run_id = ?2 AND agent_run_id IS NOT NULL AND entity_type = 'note'",
            )
            .map_err(|err| internal_not_committed("sqlite_run_touched_notes", err.to_string()))?;
        let rows = stmt
            .query_map(params![scope.space_id.as_str(), input.run.as_str()], |r| {
                r.get::<_, String>(0)
            })
            .map_err(|err| map_interrupt_or_internal(err, "sqlite_run_touched_notes"))?;
        for item in rows {
            let raw =
                item.map_err(|err| map_interrupt_or_internal(err, "sqlite_run_touched_notes"))?;
            let nid = NoteId::parse(&raw)
                .map_err(|_| internal_not_committed("corrupt_touched_note_id", "invalid NoteId"))?;
            touched_set.insert(nid);
        }
    }
    let caller_set: BTreeSet<NoteId> = caller_notes.keys().cloned().collect();
    if caller_set != touched_set {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }

    let mut heads_map = BTreeMap::new();
    for (nid, exp_rev) in &caller_notes {
        let head = load_note_head_row_rusqlite(conn, &scope.space_id, nid)?;
        if head.head_rev_id != *exp_rev {
            return Err(DomainError::RevisionConflict {
                current: head.head_rev_id,
                lineage: None,
            }
            .into());
        }
        let (rfacts, _) = build_resource_facts_cached(
            conn,
            cache,
            space,
            &head.parent_folder_id,
            head.doc_class,
            head.ability_id.clone(),
            false,
        )?;
        auth.authorize_direct_write(&rfacts, &rfacts)?;
        heads_map.insert(nid.clone(), head);
    }

    Ok(heads_map)
}

fn load_revision_meta_bytes_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    rev_id: &RevisionId,
) -> Result<Vec<u8>, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT metadata_msgpack FROM revisions WHERE space_id = ?1 AND rev_id = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_load_rev_meta_fast", err.to_string()))?;
    stmt.query_row(params![space_id.as_str(), rev_id.as_str()], |r| {
        r.get::<_, Vec<u8>>(0)
    })
    .map_err(|err| map_interrupt_or_internal(err, "sqlite_load_rev_meta_fast"))
}

fn load_space_collab_states_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
) -> Result<HashMap<NoteId, bool>, PortError> {
    let mut stmt = conn
        .prepare_cached("SELECT note_id, (room_state <> 'closed' OR COALESCE(carrier_dirty, 0) <> 0) AS blocked
                     FROM collab_sessions LEFT JOIN collab_checkpoints USING (space_id, note_id) WHERE space_id = ?1")
        .map_err(|err| internal_not_committed("sqlite_collab_states", err.to_string()))?;
    let rows = stmt
        .query_map(params![space_id.as_str()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, bool>(1)?))
        })
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_collab_states"))?;
    let mut out = HashMap::new();
    for item in rows {
        let (nid_raw, st) =
            item.map_err(|err| map_interrupt_or_internal(err, "sqlite_collab_states"))?;
        if let Ok(nid) = NoteId::parse(&nid_raw) {
            out.insert(nid, st);
        }
    }
    Ok(out)
}

fn has_any_board_moves_in_space_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    let mut stmt = conn
        .prepare_cached("SELECT 1 FROM board_move_history WHERE space_id = ?1 LIMIT 1")
        .map_err(|err| internal_not_committed("sqlite_has_bmh", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row(params![space_id.as_str()], |r| r.get(0))
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_has_bmh"))?;
    Ok(found.is_some())
}

fn has_any_overlays_in_space_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    let mut stmt = conn
        .prepare_cached("SELECT 1 FROM view_rank_overlays WHERE space_id = ?1 LIMIT 1")
        .map_err(|err| internal_not_committed("sqlite_has_overlays", err.to_string()))?;
    let found: Option<i64> = stmt
        .query_row(params![space_id.as_str()], |r| r.get(0))
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_has_overlays"))?;
    Ok(found.is_some())
}

fn active_occupant_note_id_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
) -> Result<Option<NoteId>, PortError> {
    let mut stmt = conn
        .prepare_cached(
            "SELECT note_id FROM note_heads
             WHERE space_id = ?1 AND parent_folder_id = ?2 AND slug_fold = ?3
               AND lifecycle_state = 'active'
             LIMIT 1",
        )
        .map_err(|err| internal_not_committed("sqlite_rb_slug_occ", err.to_string()))?;
    let raw_opt: Option<String> = stmt
        .query_row(
            params![space_id.as_str(), parent_folder_id.as_str(), slug_fold],
            |r| r.get(0),
        )
        .optional()
        .map_err(|err| map_interrupt_or_internal(err, "sqlite_rb_slug_occ"))?;
    match raw_opt {
        Some(raw) => Ok(Some(NoteId::parse(&raw).map_err(|_| {
            internal_not_committed("corrupt_occ_nid", "invalid NoteId")
        })?)),
        None => Ok(None),
    }
}

fn delete_all_target_overlays_rusqlite(
    conn: &rusqlite::Connection,
    space_id: &SpaceId,
    target_note: &NoteId,
) -> Result<(), PortError> {
    let mut stmt = conn
        .prepare_cached(
            "DELETE FROM view_rank_overlays WHERE space_id = ?1 AND target_note_id = ?2",
        )
        .map_err(|err| internal_not_committed("sqlite_rb_del_all_overlays", err.to_string()))?;
    stmt.execute(params![space_id.as_str(), target_note.as_str()])
        .map_err(|err| internal_not_committed("sqlite_rb_del_all_overlays", err.to_string()))?;
    Ok(())
}

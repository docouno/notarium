mod receipt_pointers;

use std::{
    collections::BTreeSet,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{ContentDigest, LeaseEpoch, NoteId, PrincipalId, RevisionId, SpaceId, SpaceSeq},
    model::{HistoryScope, Lifecycle, PathTarget},
    ports::{
        Committed, DeleteDisposition, DeleteNote, MintAndPurge, MintAndPurgeResult, Mutation,
        NoteRevision, SpaceContext,
    },
    receipt::MutationReceiptToken,
};
use sqlx::Row;

use crate::{
    CanonicalStore,
    blobs::{
        BlobOwnerKind, BlobReferenceClaim, RetirementReason, activate_and_bind_blob_ref_tx,
        initiate_digest_retirement_tx, release_owner_blob_refs_tx,
    },
    changes::{ChangedNoteSummaryV1, EffectBodyV1, build_effect_payload_draft},
    codec::{
        NoteRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload, doc_class_to_db,
        encode_timestamp_parts, internal_not_committed, new_prefixed_hex_id, new_revision_id,
        normalize_slug_key, normalize_title_key, now_unix_ms, now_utc_timestamp,
        unavailable_retryable, unknown_commit_outcome,
    },
    domain::common::{
        StoredCommittedMintAndPurgeV1, StoredCommittedNoteRevV1, active_note_sibling_exists_tx,
        build_resource_facts_tx, check_collab_preconditions_tx, derive_command_identity_spec,
        extract_agent_run_from_auth, is_note_room_active_tx, load_current_space_schema_tx,
        load_note_head_row_tx, note_rank_version_digest, upsert_agent_run_head_tx,
        validate_mutation_identity,
    },
    runtime::{insert_revision_row, is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, CommandIdentitySpec, ItemCommitArtifacts, PreparedWriteIntent},
};

#[derive(Clone, Debug)]
struct PendingPurgeExecution {
    purge_id: String,
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    actor_id: String,
    idempotency_key: String,
    old_note_id: NoteId,
    canonical_seq: SpaceSeq,
    retirement_ids: Vec<String>,
}

type RawLookupPendingPurgeRow = (String, Vec<u8>, String, String, Vec<u8>, i64);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetirementRecovery {
    /// The exclusive DataRoot lock was obtained before accepting any requests.
    Startup,
    Online,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum RetirementSelection {
    All,
    GcOnly,
}

pub(crate) async fn resume_pending_purges_on_startup(
    store: &CanonicalStore,
) -> Result<(), PortError> {
    // PostgreSQL writer authority is granted explicitly on takeover.
    if matches!(
        &store.inner.sql,
        crate::runtime::SqlDriverState::Postgres { .. }
    ) {
        return Ok(());
    }
    const SQL: &str = "SELECT space_id FROM pending_purges WHERE (phase < 'completed' OR phase > 'completed')
        UNION SELECT space_id FROM blob_retirements WHERE status = 'pending'
        UNION SELECT space_id FROM blob_catalog WHERE ref_count=0 AND blob_state='active' AND admission_state='open'";
    let spaces: Vec<String> = store
        .with_read_tx(|tx| {
            Box::pin(async move {
                let BackendConn::Sqlite(conn) = tx else {
                    unreachable!()
                };
                sqlx::query_scalar(SQL)
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("scan_storage_recovery", err.to_string()))
            })
        })
        .await?;
    for space in spaces {
        let space = store.read_space(&SpaceId::parse(&space)?).await?;
        store
            .resume_pending_storage_for_space(
                &space.scope,
                space.active_epoch,
                RetirementRecovery::Startup,
            )
            .await?;
    }
    Ok(())
}

impl CanonicalStore {
    pub(crate) async fn resume_pending_storage_for_space(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        recovery: RetirementRecovery,
    ) -> Result<(), PortError> {
        self.inner.check_writer_epoch(&scope.space_id, epoch)?;
        let current = scope.clone();
        let (through, has_purges) = self
            .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
                Box::pin(async move {
                    let space = crate::blobs::lock_and_check_space_tx(tx, &current, epoch).await?;
                    crate::blobs::plan_unowned_active_blobs_tx(tx, &current, epoch).await?;
                    let pending = has_incomplete_pending_purges_tx(tx, &current.space_id).await?;
                    Ok((space.last_seq, pending))
                })
            })
            .await?;
        if has_purges {
            let budget = crate::projection_fence::internal_budget();
            // Registration restarts the drain. Standalone stores can finish purge retirements.
            if self.projection_cleanup_missing(&budget).await? {
                return self
                    .resume_blob_retirements(scope, epoch, recovery, RetirementSelection::GcOnly)
                    .await;
            }
            self.drain_pending_purges(scope, epoch, through, &budget)
                .await?;
        }
        self.resume_blob_retirements(scope, epoch, recovery, RetirementSelection::All)
            .await
    }

    async fn drain_pending_purges(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        through: SpaceSeq,
        budget: &notarium_core::ports::CallBudget,
    ) -> Result<(), PortError> {
        // Completion removes each item from the phase index range. The fixed head
        // keeps concurrent commands from extending this recovery indefinitely.
        macro_rules! page {
            ($range:literal) => {
                concat!(
                    "SELECT purge_id, actor_id, idempotency_key, old_note_id, retirement_ids_json, canonical_seq
                     FROM pending_purges WHERE space_id=$1 AND phase ", $range,
                    " 'completed' AND history_incarnation=$2 AND canonical_seq<=$3
                     ORDER BY phase LIMIT 32"
                )
            };
        }
        type PurgeRow = (String, String, String, String, String, i64);
        // Each half can seek past completed rows on both PostgreSQL and SQLite.
        for query in [page!(">"), page!("<")] {
            loop {
                self.inner.check_writer_epoch(&scope.space_id, epoch)?;
                let current = scope.clone();
                let rows: Vec<PurgeRow> = self
                    .with_read_tx(|tx| {
                        Box::pin(async move {
                            let id = current.space_id.as_str();
                            let incarnation = current.incarnation.as_bytes().as_slice();
                            let head = through.get() as i64;
                            match tx {
                                BackendConn::Sqlite(conn) => {
                                    sqlx::query_as(query)
                                        .bind(id)
                                        .bind(incarnation)
                                        .bind(head)
                                        .fetch_all(&mut **conn)
                                        .await
                                }
                                BackendConn::Postgres(conn) => {
                                    sqlx::query_as(query)
                                        .bind(id)
                                        .bind(incarnation)
                                        .bind(head)
                                        .fetch_all(&mut **conn)
                                        .await
                                }
                            }
                            .map_err(|err| {
                                crate::runtime::pg_read_error("scan_pending_purges", err)
                            })
                        })
                    })
                    .await?;
                if rows.is_empty() {
                    break;
                }
                for (purge_id, actor_id, idempotency_key, old_note, retirements, seq) in rows {
                    let exec = PendingPurgeExecution {
                        purge_id,
                        actor_id,
                        idempotency_key,
                        old_note_id: NoteId::parse(&old_note)?,
                        canonical_seq: crate::codec::i64_to_space_seq(seq)?,
                        scope: scope.clone(),
                        active_epoch: epoch,
                        retirement_ids: serde_json::from_str(&retirements).map_err(|err| {
                            internal_not_committed("corrupt_purge_ret_ids", err.to_string())
                        })?,
                    };
                    self.retry_purged_note_cleanup(
                        scope,
                        exec.canonical_seq,
                        &exec.old_note_id,
                        budget,
                    )
                    .await?;
                    drive_pending_purge_steps_2_and_3(self, &exec).await?;
                }
            }
        }
        Ok(())
    }

    pub(crate) async fn resume_blob_retirements(
        &self,
        scope: &HistoryScope,
        epoch: LeaseEpoch,
        recovery: RetirementRecovery,
        selection: RetirementSelection,
    ) -> Result<(), PortError> {
        let mut after = String::new();
        let mut permanent_failure = None;
        let gc_only = selection == RetirementSelection::GcOnly;
        let online_epoch = (recovery == RetirementRecovery::Online).then_some(epoch.get() as i64);
        // The retirement owner can change when a recovery adopts it. The publication's
        // creation epoch stays immutable, including across unsuccessful recovery attempts.
        const PAGE: &str = "SELECT r.retirement_id FROM blob_retirements r
            WHERE r.space_id=$1 AND r.history_incarnation=$2 AND r.status='pending' AND r.retirement_id>$3
              AND (NOT $5 OR r.reason='gc')
              AND (CAST($4 AS BIGINT) IS NULL OR NOT EXISTS (
                SELECT 1 FROM blob_publications p WHERE p.space_id=r.space_id AND p.publication_id=r.retirement_id
                  AND p.owner_epoch >= $4))
            ORDER BY r.retirement_id LIMIT 128";
        loop {
            self.inner.check_writer_epoch(&scope.space_id, epoch)?;
            let current = scope.clone();
            let page_after = after.clone();
            let ids: Vec<String> = self
                .with_read_tx(|tx| {
                    Box::pin(async move {
                        let sid = current.space_id.as_str();
                        let inc = current.incarnation.as_bytes().as_slice();
                        match tx {
                            BackendConn::Sqlite(conn) => {
                                sqlx::query_scalar(PAGE)
                                    .bind(sid)
                                    .bind(inc)
                                    .bind(page_after)
                                    .bind(online_epoch)
                                    .bind(gc_only)
                                    .fetch_all(&mut **conn)
                                    .await
                            }
                            BackendConn::Postgres(conn) => {
                                sqlx::query_scalar(PAGE)
                                    .bind(sid)
                                    .bind(inc)
                                    .bind(page_after)
                                    .bind(online_epoch)
                                    .bind(gc_only)
                                    .fetch_all(&mut **conn)
                                    .await
                            }
                        }
                        .map_err(|err| {
                            crate::runtime::pg_read_error("scan_pending_retirements", err)
                        })
                    })
                })
                .await?;
            if ids.is_empty() {
                return permanent_failure.map_or(Ok(()), Err);
            }
            for id in ids {
                let mut attempts = self.schedule_retirements(scope, epoch, vec![id.clone()]);
                if let Err(error) = crate::blobs::retirement_worker::outcome(&mut attempts[0]).await
                    && error != crate::blobs::held_retirement()
                {
                    if !gc_only {
                        return Err(error);
                    }
                    // A retryable ID keeps its existing worker. It can wait for the
                    // filesystem or object store while the GC scan continues.
                    if crate::blobs::retirement_worker::retry_after(&error).is_none() {
                        permanent_failure.get_or_insert(error);
                    }
                }
                after = id;
            }
        }
    }

    /// Executes Step 1 (SQL erasure + `pending_purges` + `blob_retirements`) of a `Purge`
    /// mutation and stops right before Step 2/3 CAS retirement, simulating an unclean process
    /// crash immediately after the SQL commit.
    #[cfg(feature = "test-support")]
    pub async fn simulate_interrupted_purge_step1_for_test(
        &self,
        ctx: SpaceContext,
        request: Mutation<DeleteNote>,
    ) -> Result<Committed<NoteRevision>, PortError> {
        purge_note_inner(self, ctx, request, false).await
    }
}

pub(crate) async fn purge_note_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<DeleteNote>,
) -> Result<Committed<NoteRevision>, PortError> {
    purge_note_inner(store, ctx, request, true).await
}

async fn purge_note_inner(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<DeleteNote>,
    run_steps_2_and_3: bool,
) -> Result<Committed<NoteRevision>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "purge_note");
    debug_assert_eq!(request.input.disposition, DeleteDisposition::Purge);
    validate_mutation_identity(&ctx, &request.identity)?;
    deadline
        .prepare(&ctx.budget, || store.ensure_blob_backend_ready())
        .await?;

    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let fp = format!("purge_note={}", request.input.note.as_str());
    let idemp = derive_command_identity_spec(&ctx, &request.identity, "purge_note", fp.as_bytes())
        .with_preconditions(&request.preconditions, "note", request.input.note.as_str())
        .for_note(ctx.auth(), &request.input.note);

    let step1_capture: Arc<StdMutex<Option<PendingPurgeExecution>>> = Arc::new(StdMutex::new(None));
    let step1_capture_cl = Arc::clone(&step1_capture);

    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let old_note = request.input.note.clone();
    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let idemp_cl = idemp.clone();
    let room_fences = Arc::clone(&store.inner.room_fences);
    let local_store_opt = store.local_store_arc();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp.clone()),
        // Empty `source_note_ids` so `lookup_command_receipt_tx` runs first on idempotent replay!
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                if is_note_purge_fenced_tx(tx, &scope.space_id, old_note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let old_head = load_note_head_row_tx(tx, &scope.space_id, &old_note).await?;
                if old_head.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let (old_facts, _) = build_resource_facts_tx(
                    tx,
                    &live_space.space,
                    &old_head.parent_folder_id,
                    old_head.doc_class,
                    old_head.ability_id.clone(),
                    false,
                )
                .await?;
                auth.authorize_direct_write(&old_facts, &old_facts)?;

                ensure_no_active_backup_holds_for_purge_tx(tx, &scope.space_id).await?;

                if let Some(expected_rev) = &preconditions.revision
                    && *expected_rev != old_head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: old_head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope.space_id, &old_note, &preconditions)
                    .await?;

                if is_note_room_active_tx(tx, &room_fences, &scope, &old_note).await? {
                    return Err(unavailable_retryable(
                        "purge_blocked_by_active_room",
                        "cannot purge note while live collaborative room is active",
                        Duration::from_millis(50),
                    ));
                }

                let cover_folders =
                    super::folder_cover::find_cover_folders(tx, &scope.space_id, &old_note).await?;
                for cover_folder in &cover_folders {
                    super::folder_cover::authorize_cover_folder_mutation_tx(
                        tx,
                        &live_space.space,
                        &auth,
                        cover_folder,
                        false,
                    )
                    .await?;
                }
                let (_first_seq, visibility_seq) =
                    item_ctx.preview_seq_range(1 + cover_folders.len() as u64)?;
                let purge_seq = item_ctx.alloc_next_seq()?;
                let tombstone_rev = new_revision_id()?;
                let purge_id = new_prefixed_hex_id("prg_")?;
                let now_ts = now_utc_timestamp()?;
                let now_ms = now_unix_ms()?;

                let retirement_ids = execute_sql_erasure_for_old_note_tx(
                    tx,
                    &scope,
                    item_ctx.active_epoch,
                    &old_head,
                    None,
                    &tombstone_rev,
                    purge_seq,
                    &purge_id,
                    auth.principal(),
                    now_ts,
                    local_store_opt.as_deref(),
                )
                .await?;

                let run_opt = extract_agent_run_from_auth(&auth);
                let cover_events = super::folder_cover::clear_folders(
                    tx,
                    item_ctx,
                    &scope,
                    &cover_folders,
                    visibility_seq,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;
                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        purge_seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                }

                let receipt = MutationReceiptToken::new(scope.clone(), visibility_seq)?;
                let stored_resp = StoredCommittedNoteRevV1 {
                    value: NoteRevision {
                        note: old_note.clone(),
                        revision: tombstone_rev.clone(),
                    },
                    receipt,
                };
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                insert_pending_purge_row_tx(
                    tx,
                    &scope,
                    &purge_id,
                    &idemp_cl,
                    &old_note,
                    None,
                    None,
                    visibility_seq,
                    &retirement_ids,
                    &sanitized_bytes,
                    now_ms,
                )
                .await?;

                item_ctx.mark_receipt_pending_purge();
                *step1_capture_cl.lock().expect("step1 capture mutex") =
                    Some(PendingPurgeExecution {
                        purge_id,
                        scope: scope.clone(),
                        active_epoch: item_ctx.active_epoch,
                        actor_id: idemp_cl.actor.as_str().to_owned(),
                        idempotency_key: idemp_cl.command_key.as_str().to_owned(),
                        old_note_id: old_note.clone(),
                        canonical_seq: visibility_seq,
                        retirement_ids,
                    });

                let mut events = Vec::with_capacity(1 + cover_events.len());
                events.push(BatchEventDraft {
                    space_seq: purge_seq,
                    entity_type: "note".to_owned(),
                    entity_id: old_note.as_str().to_owned(),
                    op_kind: "purge".to_owned(),
                    rev_id: tombstone_rev,
                    lifecycle: Lifecycle::Purged,
                    doc_class: Some(old_head.doc_class),
                });
                events.extend(cover_events);

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "purge_note".to_owned(),
                    events,
                    change_payload: None,
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: sanitized_bytes.clone(),
                    receipt_owner_note_ids: Vec::new(),
                    response_bytes: sanitized_bytes,
                })
            })
        }),
    };

    match deadline
        .submit::<StoredCommittedNoteRevV1>(store, &ctx.budget, intent)
        .await
    {
        Ok(stored) => {
            let captured = step1_capture.lock().expect("step1 capture mutex").take();
            let replayed = captured.is_none();
            if run_steps_2_and_3 && let Some(exec) = captured {
                finish_committed_purge(store, &exec, &ctx.budget, &deadline, false).await?;
            }
            let committed = stored.into_committed();
            if replayed {
                finish_replayed_projection_cleanup(
                    store,
                    &committed.receipt,
                    &committed.value.note,
                    &ctx.budget,
                    &deadline,
                )
                .await?;
            }
            Ok(committed)
        }
        Err(PortError::Unavailable(failure))
            if failure.effect() == notarium_core::error::CommitEffect::NotCommitted =>
        {
            if let Some((pending, response)) = deadline
                .prepare(&ctx.budget, || {
                    load_pending_purge_for_idempotency(store, &space_rec.scope, &idemp)
                })
                .await?
            {
                finish_committed_purge(store, &pending, &ctx.budget, &deadline, true).await?;
                let stored: StoredCommittedNoteRevV1 =
                    rmp_serde::from_slice(&response).map_err(|err| {
                        unknown_commit_outcome("decode_resumed_purge_resp", err.to_string())
                    })?;
                return Ok(stored.into_committed());
            }
            Err(unavailable_retryable(
                "purge_submit_unavailable",
                "purge temporarily unavailable; retry same command",
                Duration::from_millis(25),
            ))
        }
        Err(other) => Err(other),
    }
}

async fn authorize_mint_placement_tx(
    tx: &mut BackendConn<'_>,
    space: &crate::SpaceRecord,
    old_head: &crate::domain::common::NoteHeadRow,
    auth: &notarium_core::auth::EngineAuthContext,
) -> Result<crate::domain::common::FolderAncestryFacts, PortError> {
    let (old_facts, _) = build_resource_facts_tx(
        tx,
        &space.space,
        &old_head.parent_folder_id,
        old_head.doc_class,
        old_head.ability_id.clone(),
        true,
    )
    .await?;
    let (new_facts, new_anc) = build_resource_facts_tx(
        tx,
        &space.space,
        &old_head.parent_folder_id,
        DocClass::EncryptedNote,
        None,
        true,
    )
    .await?;
    auth.authorize_direct_write(&old_facts, &new_facts)?;
    let cover_folders =
        super::folder_cover::find_cover_folders(tx, &space.scope.space_id, &old_head.note_id)
            .await?;
    for cover_folder in &cover_folders {
        super::folder_cover::authorize_cover_folder_mutation_tx(
            tx,
            &space.space,
            auth,
            cover_folder,
            false,
        )
        .await?;
    }

    Ok(new_anc)
}

pub(crate) async fn mint_and_purge_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<MintAndPurge>,
) -> Result<Committed<MintAndPurgeResult>, PortError> {
    let deadline = crate::domain::common::CommandDeadline::start(&ctx.budget, "mint_and_purge");
    validate_mutation_identity(&ctx, &request.identity)?;
    if request.input.old_note == request.input.new_note {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    if let Some(explicit_slug) = &request.input.new_slug {
        let _ = normalize_slug_key(explicit_slug)?;
    }
    // Validate age-armored carrier BEFORE staging or mutating anything!
    notarium_syntax::encrypted::validate(&request.input.encrypted_carrier)?;

    deadline
        .prepare(&ctx.budget, || store.ensure_blob_backend_ready())
        .await?;
    let space_rec = deadline
        .prepare(&ctx.budget, || {
            store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget))
        })
        .await?;
    space_rec.scope.check(ctx.scope())?;

    let prepared_blob = store.prepare_blob(request.input.encrypted_carrier.as_bytes())?;
    let encrypted_byte_size = request.input.encrypted_carrier.len() as u64;
    let encrypted_digest = prepared_blob.digest;

    let mut fp_hasher = blake3::Hasher::new();
    fp_hasher.update(request.input.old_note.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(request.input.expected_revision.as_str().as_bytes());
    fp_hasher.update(&[0]);
    fp_hasher.update(request.input.new_note.as_str().as_bytes());
    fp_hasher.update(&[0]);
    if let Some(ns) = &request.input.new_slug {
        fp_hasher.update(ns.as_bytes());
    }
    fp_hasher.update(&[0]);
    fp_hasher.update(encrypted_digest.as_bytes());
    let idemp = derive_command_identity_spec(
        &ctx,
        &request.identity,
        "mint_and_purge",
        fp_hasher.finalize().as_bytes(),
    )
    .with_preconditions(
        &request.preconditions,
        "note",
        request.input.old_note.as_str(),
    )
    .with_known_base(&request.input.expected_revision)
    .with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::Documents(vec![
            crate::writer::replay::ReplayResource::Write(request.input.old_note.clone()),
            crate::writer::replay::ReplayResource::Write(request.input.new_note.clone()),
        ]),
    );

    store
        .inner
        .check_writer_epoch(&space_rec.scope.space_id, space_rec.active_epoch)?;
    let preflight = ctx.clone();
    let old_note = request.input.old_note.clone();
    let new_note = request.input.new_note.clone();
    let expected_rev = request.input.expected_revision.clone();
    let check_id = idemp.clone();
    let read_existing = || {
        store.with_read_tx_budget(Some(&ctx.budget), |tx| {
            Box::pin(async move {
                let space = load_space_record(tx, &preflight.scope().space_id).await?;
                space.scope.check(preflight.scope())?;
                if let Some(receipt) =
                    crate::writer::lookup_command_receipt_tx(tx, &space.scope, &check_id).await?
                {
                    if receipt.command_hash != check_id.command_hash {
                        return Err(DomainError::IdempotencyKeyReused.into());
                    }
                    return Ok(Some(receipt));
                }
                let head = load_note_head_row_tx(tx, &space.scope.space_id, &old_note).await?;
                authorize_mint_placement_tx(tx, &space, &head, preflight.auth()).await?;
                if head.lifecycle == Lifecycle::Purged
                    || is_note_purge_fenced_tx(tx, &space.scope.space_id, old_note.as_str()).await?
                {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let collision = super::common::authorized_collision_revision_tx(
                    tx,
                    &space.space,
                    preflight.auth(),
                    &new_note,
                )
                .await?;
                if head.head_rev_id != expected_rev {
                    return Err(DomainError::RevisionConflict {
                        current: head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if let Some(current) = collision {
                    return Err(DomainError::RevisionConflict {
                        current,
                        lineage: None,
                    }
                    .into());
                }
                ensure_no_active_backup_holds_for_purge_tx(tx, &space.scope.space_id).await?;
                Ok(None)
            })
        })
    };
    let existing = deadline.prepare(&ctx.budget, read_existing).await?;
    if let Some(receipt) = existing {
        if receipt.status != "completed" {
            let (pending, _) = deadline
                .prepare(&ctx.budget, || {
                    load_pending_purge_for_idempotency(store, &space_rec.scope, &idemp)
                })
                .await
                .map_err(|err| {
                    unknown_commit_outcome("lookup_pending_mint_purge", err.to_string())
                })?
                .ok_or_else(|| {
                    unknown_commit_outcome(
                        "missing_pending_purge",
                        "unfinished receipt missing purge state",
                    )
                })?;
            finish_committed_purge(store, &pending, &ctx.budget, &deadline, true).await?;
        }
        let stored: StoredCommittedMintAndPurgeV1 = rmp_serde::from_slice(&receipt.response_blob)
            .map_err(|err| {
            unknown_commit_outcome("decode_replayed_mint_purge", err.to_string())
        })?;
        let committed = stored.into_committed();
        if receipt.status == "completed" {
            finish_replayed_projection_cleanup(
                store,
                &committed.receipt,
                &committed.value.old_note,
                &ctx.budget,
                &deadline,
            )
            .await?;
        }
        return Ok(committed);
    }
    let staged_ticket = deadline
        .prepare(&ctx.budget, || {
            store.stage_blob_for_batch(&space_rec.scope, space_rec.active_epoch, &prepared_blob)
        })
        .await?;
    let staged_bytes = staged_ticket.compressed_size;
    let step1_capture: Arc<StdMutex<Option<PendingPurgeExecution>>> = Arc::new(StdMutex::new(None));
    let step1_capture_cl = Arc::clone(&step1_capture);

    let auth = ctx.auth().clone();
    let preconditions = request.preconditions.clone();
    let input = request.input.clone();
    let scope = space_rec.scope.clone();
    let active_epoch = space_rec.active_epoch;
    let idemp_cl = idemp.clone();
    let room_fences = Arc::clone(&store.inner.room_fences);
    let local_store_opt = store.local_store_arc();

    let intent = PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp.clone()),
        source_note_ids: Vec::new(),
        staged_bytes,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                if is_note_purge_fenced_tx(tx, &scope.space_id, input.old_note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if is_note_purge_fenced_tx(tx, &scope.space_id, input.new_note.as_str()).await? {
                    return Err(DomainError::ResourceNotFound.into());
                }

                let old_head = load_note_head_row_tx(tx, &scope.space_id, &input.old_note).await?;
                if old_head.lifecycle == Lifecycle::Purged {
                    return Err(DomainError::ResourceNotFound.into());
                }
                let live_space = load_space_record(tx, &scope.space_id).await?;
                let new_anc =
                    authorize_mint_placement_tx(tx, &live_space, &old_head, &auth).await?;

                let collision = super::common::authorized_collision_revision_tx(
                    tx,
                    &live_space.space,
                    &auth,
                    &input.new_note,
                )
                .await?;
                ensure_no_active_backup_holds_for_purge_tx(tx, &scope.space_id).await?;

                if old_head.head_rev_id != input.expected_revision {
                    return Err(DomainError::RevisionConflict {
                        current: old_head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                if let Some(prec_rev) = &preconditions.revision
                    && *prec_rev != old_head.head_rev_id
                {
                    return Err(DomainError::RevisionConflict {
                        current: old_head.head_rev_id,
                        lineage: None,
                    }
                    .into());
                }
                check_collab_preconditions_tx(tx, &scope.space_id, &input.old_note, &preconditions)
                    .await?;

                // Active live room check BEFORE creating successor (`NotCommitted` retryable failure)!
                if is_note_room_active_tx(tx, &room_fences, &scope, &input.old_note).await? {
                    return Err(unavailable_retryable(
                        "mint_and_purge_blocked_by_active_room",
                        "cannot mint-and-purge note while live collaborative room is active",
                        Duration::from_millis(50),
                    ));
                }

                if let Some(current) = collision {
                    return Err(DomainError::RevisionConflict {
                        current,
                        lineage: None,
                    }
                    .into());
                }

                let succ_slug = input
                    .new_slug
                    .clone()
                    .unwrap_or_else(|| old_head.slug.clone());
                let succ_slug_fold = normalize_slug_key(&succ_slug)?;
                if succ_slug_fold == super::folder_cover::SLUG {
                    return Err(
                        DomainError::validation(ValidationReason::InvalidPathComponent).into(),
                    );
                }

                // Exclude `old_note` since it transitions to `'purged'` in this exact atomic transaction!
                if active_note_sibling_exists_tx(
                    tx,
                    &scope.space_id,
                    &old_head.parent_folder_id,
                    &succ_slug_fold,
                    Some(&input.old_note),
                )
                .await?
                {
                    let report_parent = (old_head.parent_folder_id != item_ctx.root_folder_id)
                        .then_some(old_head.parent_folder_id.clone());
                    return Err(DomainError::PathConflict {
                        target: PathTarget {
                            space_id: scope.space_id.clone(),
                            parent: report_parent,
                            component: succ_slug,
                        },
                    }
                    .into());
                }

                let cover_folders =
                    super::folder_cover::find_cover_folders(tx, &scope.space_id, &input.old_note)
                        .await?;
                // Preview contiguous SpaceSeq allocations (`purge_seq`, `create_seq`, and cleared folder covers).
                let (_first_seq, visibility_seq) =
                    item_ctx.preview_seq_range(2 + cover_folders.len() as u64)?;
                let purge_seq = item_ctx.alloc_next_seq()?;
                let create_seq = item_ctx.alloc_next_seq()?;
                let tombstone_rev = new_revision_id()?;
                let new_note_rev = new_revision_id()?;
                let purge_id = new_prefixed_hex_id("prg_")?;
                let now_ts = now_utc_timestamp()?;
                let now_ms = now_unix_ms()?;
                let (sec, nsec) = encode_timestamp_parts(now_ts);

                // 1. Activate and bind successor CAS blob FIRST so ref_count stays >= 1 before old refs release!
                item_ctx.record_staged_ticket(staged_ticket.clone());
                activate_and_bind_blob_ref_tx(
                    tx,
                    &item_ctx.scope,
                    item_ctx.active_epoch,
                    &BlobReferenceClaim {
                        ticket: staged_ticket,
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: input.new_note.as_str().to_owned(),
                        owner_rev_id: new_note_rev.as_str().to_owned(),
                        resource_key: "carrier".to_owned(),
                    },
                    create_seq,
                )
                .await?;

                // 2.Tombstone and erase `old_note` + initiate CAS retirement for resulting zero-ref digests!
                let retirement_ids = execute_sql_erasure_for_old_note_tx(
                    tx,
                    &scope,
                    item_ctx.active_epoch,
                    &old_head,
                    Some(&input.new_note),
                    &tombstone_rev,
                    purge_seq,
                    &purge_id,
                    auth.principal(),
                    now_ts,
                    local_store_opt.as_deref(),
                )
                .await?;

                // 3. Insert successor `note_heads` and `revisions` (`EncryptedNote`, zero plaintext metadata!).
                let succ_title = succ_slug.clone();
                let succ_title_fold = normalize_title_key(&succ_title);
                let create_i64 = create_seq.get() as i64;
                let vis_i64 = visibility_seq.get() as i64;
                let enc_class_str = doc_class_to_db(DocClass::EncryptedNote);

                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "INSERT INTO note_heads (
                                space_id, note_id, parent_folder_id, slug, slug_fold,
                                title, title_fold, doc_class, ability_id, head_rev_id,
                                content_blake3, byte_size, lifecycle_state, visibility_mask,
                                settlement_successor_id, created_seq, updated_seq,
                                created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'active', 0, NULL, ?, ?, ?, ?, ?, ?, ?)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.new_note.as_str())
                        .bind(old_head.parent_folder_id.as_str())
                        .bind(&succ_slug)
                        .bind(&succ_slug_fold)
                        .bind(&succ_title)
                        .bind(&succ_title_fold)
                        .bind(enc_class_str)
                        .bind(new_note_rev.as_str())
                        .bind(encrypted_digest.as_bytes().as_slice())
                        .bind(encrypted_byte_size as i64)
                        .bind(create_i64)
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_insert_minted_note", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "INSERT INTO note_heads (
                                space_id, note_id, parent_folder_id, slug, slug_fold,
                                title, title_fold, doc_class, ability_id, head_rev_id,
                                content_blake3, byte_size, lifecycle_state, visibility_mask,
                                settlement_successor_id, created_seq, updated_seq,
                                created_at_sec, created_at_nsec, updated_at_sec, updated_at_nsec, last_actor_id
                             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11, 'active', 0, NULL, $12, $13, $14, $15, $14, $15, $16)",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(input.new_note.as_str())
                        .bind(old_head.parent_folder_id.as_str())
                        .bind(&succ_slug)
                        .bind(&succ_slug_fold)
                        .bind(&succ_title)
                        .bind(&succ_title_fold)
                        .bind(enc_class_str)
                        .bind(new_note_rev.as_str())
                        .bind(encrypted_digest.as_bytes().as_slice())
                        .bind(encrypted_byte_size as i64)
                        .bind(create_i64)
                        .bind(vis_i64)
                        .bind(sec)
                        .bind(nsec)
                        .bind(auth.principal().as_str())
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_insert_minted_note", err.to_string())
                        })?;
                    }
                }

                let current_schema = load_current_space_schema_tx(tx, &scope.space_id).await?;
                let run_opt = extract_agent_run_from_auth(&auth);
                let new_meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                    NoteRevisionMetadata {
                        folder_page: false,
                        note_id: input.new_note.clone(),
                        parent_folder_id: old_head.parent_folder_id.clone(),
                        is_root_child: new_anc.is_root_child,
                        slug: succ_slug,
                        slug_fold: succ_slug_fold,
                        title: succ_title,
                        doc_class: DocClass::EncryptedNote,
                        ability_id: None,
                        lifecycle: Lifecycle::Active,
                        visibility_mask: 0,
                        byte_size: encrypted_byte_size,
                        content_digest: Some(encrypted_digest),
                        schema_revision: current_schema.map(|s| s.schema_revision),
                        raw_fields: None,
                        evaluated_fields: Default::default(),
                        diagnostics: Vec::new(),
                    },
                ))
                .encode()?;

                insert_revision_row(
                    tx,
                    &scope,
                    &new_note_rev,
                    "note",
                    input.new_note.as_str(),
                    create_seq,
                    visibility_seq,
                    None,
                    None,
                    Some(encrypted_digest),
                    &new_meta,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;

                let cover_events = super::folder_cover::clear_folders(
                    tx,
                    item_ctx,
                    &scope,
                    &cover_folders,
                    visibility_seq,
                    auth.principal(),
                    run_opt.as_ref(),
                    now_ts,
                )
                .await?;
                if let Some(run_id) = &run_opt {
                    upsert_agent_run_head_tx(
                        tx,
                        &scope,
                        run_id,
                        auth.principal(),
                        purge_seq,
                        visibility_seq,
                        now_ts,
                    )
                    .await?;
                }

                let cmd_id = new_prefixed_hex_id("cmd_")?;
                let payload_id = format!("eff:{cmd_id}");
                let range = notarium_core::ports::CommandSeqRange::new(purge_seq, visibility_seq)?;
                // Effect payload references ONLY `new_note`, never `old_note`!
                let cp = build_effect_payload_draft(
                    payload_id,
                    scope.clone(),
                    range,
                    "mint_and_purge",
                    EffectBodyV1::Notes {
                        notes: vec![ChangedNoteSummaryV1 {
                            note_id: input.new_note.clone(),
                            revision: new_note_rev.clone(),
                            rank_version: note_rank_version_digest(&new_note_rev, None),
                            lifecycle: Lifecycle::Active,
                            doc_class: DocClass::EncryptedNote,
                            changed_fields: Default::default(),
                        }],
                    },
                    vec![input.new_note.clone()],
                )?;

                let receipt = MutationReceiptToken::new(scope.clone(), visibility_seq)?;
                let stored_resp = StoredCommittedMintAndPurgeV1 {
                    old_note: input.old_note.clone(),
                    new_note: NoteRevision {
                        note: input.new_note.clone(),
                        revision: new_note_rev.clone(),
                    },
                    receipt,
                };
                let sanitized_bytes = CanonicalStore::encode_command_outcome(&stored_resp)?;

                insert_pending_purge_row_tx(
                    tx,
                    &scope,
                    &purge_id,
                    &idemp_cl,
                    &input.old_note,
                    Some(&input.new_note),
                    Some(&new_note_rev),
                    visibility_seq,
                    &retirement_ids,
                    &sanitized_bytes,
                    now_ms,
                )
                .await?;

                item_ctx.mark_receipt_pending_purge();
                *step1_capture_cl.lock().expect("step1 capture mutex") =
                    Some(PendingPurgeExecution {
                        purge_id,
                        scope: scope.clone(),
                        active_epoch: item_ctx.active_epoch,
                        actor_id: idemp_cl.actor.as_str().to_owned(),
                        idempotency_key: idemp_cl.command_key.as_str().to_owned(),
                        old_note_id: input.old_note.clone(),
                        canonical_seq: visibility_seq,
                        retirement_ids,
                    });

                let mut events = Vec::with_capacity(2 + cover_events.len());
                events.push(BatchEventDraft {
                    space_seq: purge_seq,
                    entity_type: "note".to_owned(),
                    entity_id: input.old_note.as_str().to_owned(),
                    op_kind: "purge".to_owned(),
                    rev_id: tombstone_rev,
                    lifecycle: Lifecycle::Purged,
                    doc_class: Some(old_head.doc_class),
                });
                events.push(BatchEventDraft {
                    space_seq: create_seq,
                    entity_type: "note".to_owned(),
                    entity_id: input.new_note.as_str().to_owned(),
                    op_kind: "create".to_owned(),
                    rev_id: new_note_rev,
                    lifecycle: Lifecycle::Active,
                    doc_class: Some(DocClass::EncryptedNote),
                });
                events.extend(cover_events);

                Ok(ItemCommitArtifacts {
                    command_id: cmd_id,
                    command_kind: "mint_and_purge".to_owned(),
                    events,
                    change_payload: Some(cp),
                    receipt_detail_blob: None,
                    receipt_sanitized_blob: sanitized_bytes.clone(),
                    receipt_owner_note_ids: vec![input.new_note],
                    response_bytes: sanitized_bytes,
                })
            })
        }),
    };

    match deadline
        .submit::<StoredCommittedMintAndPurgeV1>(store, &ctx.budget, intent)
        .await
    {
        Ok(stored) => {
            let captured = step1_capture.lock().expect("step1 capture mutex").take();
            let committed = stored.into_committed();
            if let Some(exec) = captured {
                finish_committed_purge(store, &exec, &ctx.budget, &deadline, false).await?;
            } else {
                finish_replayed_projection_cleanup(
                    store,
                    &committed.receipt,
                    &committed.value.old_note,
                    &ctx.budget,
                    &deadline,
                )
                .await?;
            }
            Ok(committed)
        }
        Err(PortError::Unavailable(failure))
            if failure.effect() == notarium_core::error::CommitEffect::NotCommitted =>
        {
            if let Some((pending, response)) = deadline
                .prepare(&ctx.budget, || {
                    load_pending_purge_for_idempotency(store, &space_rec.scope, &idemp)
                })
                .await?
            {
                finish_committed_purge(store, &pending, &ctx.budget, &deadline, true).await?;
                let stored: StoredCommittedMintAndPurgeV1 = rmp_serde::from_slice(&response)
                    .map_err(|err| {
                        unknown_commit_outcome("decode_resumed_mint_purge_resp", err.to_string())
                    })?;
                return Ok(stored.into_committed());
            }
            Err(unavailable_retryable(
                "mint_and_purge_unavailable",
                "mint-and-purge temporarily unavailable; retry same command",
                Duration::from_millis(25),
            ))
        }
        Err(other) => Err(other),
    }
}

// Step 1 and its durable recovery record are already committed. A retry or startup
// recovery resumes the same retirement if the caller leaves during steps 2 and 3.
async fn finish_replayed_projection_cleanup(
    store: &CanonicalStore,
    receipt: &MutationReceiptToken,
    note: &NoteId,
    budget: &notarium_core::ports::CallBudget,
    deadline: &super::common::CommandDeadline,
) -> Result<(), PortError> {
    deadline
        .wait(budget, || {
            store.retry_purged_note_cleanup(receipt.scope(), receipt.seq(), note, budget)
        })
        .await
        .map_err(|error| unknown_commit_outcome("purge_projection_cleanup", error.to_string()))?
}

async fn finish_committed_purge(
    store: &CanonicalStore,
    pending: &PendingPurgeExecution,
    budget: &notarium_core::ports::CallBudget,
    deadline: &super::common::CommandDeadline,
    recovered: bool,
) -> Result<(), PortError> {
    if recovered {
        deadline
            .wait(budget, || {
                store.retry_purged_note_cleanup(
                    &pending.scope,
                    pending.canonical_seq,
                    &pending.old_note_id,
                    budget,
                )
            })
            .await
            .map_err(|err| unknown_commit_outcome("purge_projection_cleanup", err.to_string()))??;
    }
    deadline
        .wait(budget, || drive_pending_purge_steps_2_and_3(store, pending))
        .await
        .map_err(|err| unknown_commit_outcome("purge_completion_interrupted", err.to_string()))?
}

async fn drive_pending_purge_steps_2_and_3(
    store: &CanonicalStore,
    exec: &PendingPurgeExecution,
) -> Result<(), PortError> {
    store
        .inner
        .room_fences
        .remove_note(&exec.scope.space_id, &exec.old_note_id);

    // Step 2: Drive physical CAS retirements (local unlink + dir fsync, or S3 terminal marker + versioned DELETE).
    for ret_id in &exec.retirement_ids {
        if let Err(err) = store
            .drive_retirement_to_completion(&exec.scope, exec.active_epoch, ret_id)
            .await
        {
            let _ = record_pending_purge_safe_error(
                store,
                &exec.scope,
                exec.active_epoch,
                &exec.purge_id,
                "cas_retirement_step_failed",
            )
            .await;
            return Err(unknown_commit_outcome(
                "purge_step2_cas_retirement_incomplete",
                format!("Step 1 SQL fence committed; CAS retirement incomplete: {err}"),
            ));
        }
    }

    if let Err(err) =
        mark_pending_purge_cas_retired(store, &exec.scope, exec.active_epoch, &exec.purge_id).await
    {
        return Err(unknown_commit_outcome(
            "purge_step2_mark_cas_retired_failed",
            format!("CAS retired, phase update failed: {err}"),
        ));
    }

    // Step 3: Mark `pending_purges` and `command_receipts` completed!
    if let Err(err) = mark_pending_purge_completed_tx(
        store,
        &exec.scope,
        exec.active_epoch,
        &exec.purge_id,
        &exec.actor_id,
        &exec.idempotency_key,
    )
    .await
    {
        return Err(unknown_commit_outcome(
            "purge_step3_complete_failed",
            format!("CAS retired, final completion update failed: {err}"),
        ));
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn execute_sql_erasure_for_old_note_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    active_epoch: LeaseEpoch,
    old_head: &crate::domain::common::NoteHeadRow,
    successor_note_id: Option<&NoteId>,
    tombstone_rev_id: &RevisionId,
    purge_seq: SpaceSeq,
    purge_id: &str,
    actor_id: &PrincipalId,
    now_ts: notarium_core::value::Timestamp,
    local_store: Option<&crate::blobs::local::LocalBlobStore>,
) -> Result<Vec<String>, PortError> {
    let (sec, nsec) = encode_timestamp_parts(now_ts);
    let pseq_i64 = purge_seq.get() as i64;
    let old_lc_str = crate::codec::lifecycle_to_db(old_head.lifecycle);
    let old_id_str = old_head.note_id.as_str();
    let succ_str = successor_note_id.map(NoteId::as_str);

    // 1. Permanent `revision_purge_fences` row!
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO revision_purge_fences (
                    space_id, history_incarnation, note_id, purge_seq,
                    old_identity_state, successor_note_id, created_at_sec, created_at_nsec
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(old_id_str)
            .bind(pseq_i64)
            .bind(old_lc_str)
            .bind(succ_str)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_insert_purge_fence", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO revision_purge_fences (
                    space_id, history_incarnation, note_id, purge_seq,
                    old_identity_state, successor_note_id, created_at_sec, created_at_nsec
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(old_id_str)
            .bind(pseq_i64)
            .bind(old_lc_str)
            .bind(succ_str)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_purge_fence", err.to_string()))?;
        }
    }

    // 2. Clear overlays, rank revisions, note aliases, observations, collab sessions/logs, and note revisions!
    let rank_prefix = format!("{old_id_str}:");
    let rank_suffix = format!(":{old_id_str}");
    const DELETE_ANCHORED_RANKS: [&str; 2] = [
        "DELETE FROM projection_rank_anchor_rows WHERE space_id = $1 AND target_note_id = $2",
        "DELETE FROM projection_rank_anchor_rows WHERE space_id = $1 AND view_note_id = $2",
    ];
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "DELETE FROM view_rank_overlays WHERE space_id = ? AND (target_note_id = ? OR view_note_id = ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_del_overlays", err.to_string()))?;

            for sql in DELETE_ANCHORED_RANKS {
                sqlx::query(sql)
                    .bind(scope.space_id.as_str())
                    .bind(old_id_str)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_purge_rank_anchor", err.to_string())
                    })?;
            }

            sqlx::query(
                "DELETE FROM revisions WHERE space_id = ? AND entity_type = 'rank' AND (substr(entity_key, 1, length(?2)) = ?2
                    OR substr(entity_key, length(entity_key) - length(?3) + 1) = ?3)",
            )
            .bind(scope.space_id.as_str())
            .bind(&rank_prefix)
            .bind(&rank_suffix)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_del_rank_revs", err.to_string()))?;

            sqlx::query("DELETE FROM note_aliases WHERE space_id = ? AND target_note_id = ?")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_del_aliases", err.to_string())
                })?;

            sqlx::query("DELETE FROM materialized_observations WHERE space_id = ? AND note_id = ?")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_purge_del_obs", err.to_string()))?;

            sqlx::query("DELETE FROM collab_update_log WHERE space_id = ? AND note_id = ?")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_del_collab_log", err.to_string())
                })?;

            sqlx::query("DELETE FROM collab_sessions WHERE space_id = ? AND note_id = ?")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_del_collab_sess", err.to_string())
                })?;

            sqlx::query(
                "DELETE FROM revisions WHERE space_id = ? AND entity_type = 'note' AND entity_key = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_del_revs", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "DELETE FROM view_rank_overlays WHERE space_id = $1 AND (target_note_id = $2 OR view_note_id = $2)",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_del_overlays", err.to_string()))?;

            for sql in DELETE_ANCHORED_RANKS {
                sqlx::query(sql)
                    .bind(scope.space_id.as_str())
                    .bind(old_id_str)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("pg_purge_rank_anchor", err.to_string())
                    })?;
            }

            sqlx::query(
                "DELETE FROM revisions WHERE space_id = $1 AND entity_type = 'rank' AND (left(entity_key, length($2)) = $2
                    OR right(entity_key, length($3)) = $3)",
            )
            .bind(scope.space_id.as_str())
            .bind(&rank_prefix)
            .bind(&rank_suffix)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_del_rank_revs", err.to_string()))?;

            sqlx::query("DELETE FROM note_aliases WHERE space_id = $1 AND target_note_id = $2")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_purge_del_aliases", err.to_string()))?;

            sqlx::query(
                "DELETE FROM materialized_observations WHERE space_id = $1 AND note_id = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_del_obs", err.to_string()))?;

            sqlx::query("DELETE FROM collab_update_log WHERE space_id = $1 AND note_id = $2")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_purge_del_collab_log", err.to_string())
                })?;

            sqlx::query("DELETE FROM collab_sessions WHERE space_id = $1 AND note_id = $2")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_purge_del_collab_sess", err.to_string())
                })?;

            sqlx::query(
                "DELETE FROM revisions WHERE space_id = $1 AND entity_type = 'note' AND entity_key = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_del_revs", err.to_string()))?;
        }
    }

    // 3. If `old_note` was an ability package entrypoint, tombstone `ability_packages` & release AbilityResource refs!
    let mut zero_ref_digests: BTreeSet<ContentDigest> = BTreeSet::new();
    let owned_abilities: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT ability_id FROM ability_packages WHERE space_id = ? AND entrypoint_note_id = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_find_ability", err.to_string()))?;
            rows.into_iter().map(|r| r.get("ability_id")).collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT ability_id FROM ability_packages WHERE space_id = $1 AND entrypoint_note_id = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_find_ability", err.to_string()))?;
            rows.into_iter().map(|r| r.get("ability_id")).collect()
        }
    };

    for ab_id in owned_abilities {
        let purged_slug = format!("purged-{ab_id}");
        match tx {
            BackendConn::Sqlite(conn) => {
                sqlx::query(
                    "UPDATE ability_packages
                     SET slug_fold = ?, manifest_rev_id = ?, resource_manifest_json = '{}',
                         lifecycle_state = 'purged', updated_seq = ?
                     WHERE space_id = ? AND ability_id = ?",
                )
                .bind(&purged_slug)
                .bind(tombstone_rev_id.as_str())
                .bind(pseq_i64)
                .bind(scope.space_id.as_str())
                .bind(&ab_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_tombstone_ability", err.to_string())
                })?;

                sqlx::query(
                    "DELETE FROM revisions WHERE space_id = ? AND entity_type = 'ability' AND entity_key = ?",
                )
                .bind(scope.space_id.as_str())
                .bind(&ab_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_del_ability_revs", err.to_string())
                })?;
            }
            BackendConn::Postgres(conn) => {
                sqlx::query(
                    "UPDATE ability_packages
                     SET slug_fold = $1, manifest_rev_id = $2, resource_manifest_json = '{}',
                         lifecycle_state = 'purged', updated_seq = $3
                     WHERE space_id = $4 AND ability_id = $5",
                )
                .bind(&purged_slug)
                .bind(tombstone_rev_id.as_str())
                .bind(pseq_i64)
                .bind(scope.space_id.as_str())
                .bind(&ab_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_purge_tombstone_ability", err.to_string())
                })?;

                sqlx::query(
                    "DELETE FROM revisions WHERE space_id = $1 AND entity_type = 'ability' AND entity_key = $2",
                )
                .bind(scope.space_id.as_str())
                .bind(&ab_id)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_purge_del_ability_revs", err.to_string())
                })?;
            }
        }
        let ab_zero =
            release_owner_blob_refs_tx(tx, &scope.space_id, BlobOwnerKind::AbilityResource, &ab_id)
                .await?;
        zero_ref_digests.extend(ab_zero);
    }

    // 4. Erase owned multi-note payloads via `payload_owners`!
    let owned_payloads: Vec<(String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT payload_kind, payload_id FROM payload_owners WHERE space_id = ? AND note_id = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_load_owners", err.to_string()))?;
            rows.into_iter()
                .map(|r| (r.get("payload_kind"), r.get("payload_id")))
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT payload_kind, payload_id FROM payload_owners WHERE space_id = $1 AND note_id = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_load_owners", err.to_string()))?;
            rows.into_iter()
                .map(|r| (r.get("payload_kind"), r.get("payload_id")))
                .collect()
        }
    };

    let mut erased_detail_ids = Vec::new();
    for (pkind, pid) in owned_payloads {
        match pkind.as_str() {
            "change_payload" => match tx {
                BackendConn::Sqlite(conn) => {
                    sqlx::query(
                        "UPDATE change_payloads
                         SET erased_by_purge = 1, effect_msgpack = NULL
                         WHERE space_id = ? AND payload_id = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(&pid)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_erase_cp", err.to_string()))?;
                }
                BackendConn::Postgres(conn) => {
                    sqlx::query(
                        "UPDATE change_payloads
                         SET erased_by_purge = 1, effect_msgpack = NULL
                         WHERE space_id = $1 AND payload_id = $2",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(&pid)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_erase_cp", err.to_string()))?;
                }
            },
            "command_receipt" => {
                let rcpt_pay_id = format!("rcpt_pay:{pid}");
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE change_payloads
                             SET erased_by_purge = 1, effect_msgpack = NULL
                             WHERE space_id = ? AND payload_id = ?",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(&rcpt_pay_id)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_erase_rcpt_pay", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE change_payloads
                             SET erased_by_purge = 1, effect_msgpack = NULL
                             WHERE space_id = $1 AND payload_id = $2",
                        )
                        .bind(scope.space_id.as_str())
                        .bind(&rcpt_pay_id)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_erase_rcpt_pay", err.to_string())
                        })?;
                    }
                }
                erased_detail_ids.push(rcpt_pay_id);
            }
            "content_job" => match tx {
                BackendConn::Sqlite(conn) => {
                    sqlx::query(
                        "UPDATE content_jobs
                         SET payload_msgpack = NULL, result_msgpack = NULL, payload_erased_by_purge = 1
                         WHERE space_id = ? AND job_id = ?",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(&pid)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_erase_job_pay", err.to_string()))?;
                }
                BackendConn::Postgres(conn) => {
                    sqlx::query(
                        "UPDATE content_jobs
                         SET payload_msgpack = NULL, result_msgpack = NULL, payload_erased_by_purge = 1
                         WHERE space_id = $1 AND job_id = $2",
                    )
                    .bind(scope.space_id.as_str())
                    .bind(&pid)
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_erase_job_pay", err.to_string()))?;
                }
            },
            _ => {}
        }
    }

    receipt_pointers::clear(tx, scope, &erased_detail_ids).await?;

    // Erase all board_move_history rows and payload_owners referencing `old_note`!
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "DELETE FROM board_move_history WHERE space_id = ? AND (target_note_id = ? OR view_note_id = ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_purge_del_bmh", err.to_string()))?;

            sqlx::query("DELETE FROM payload_owners WHERE space_id = ? AND note_id = ?")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_purge_del_po", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "DELETE FROM board_move_history WHERE space_id = $1 AND (target_note_id = $2 OR view_note_id = $2)",
            )
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_purge_del_bmh", err.to_string()))?;

            sqlx::query("DELETE FROM payload_owners WHERE space_id = $1 AND note_id = $2")
                .bind(scope.space_id.as_str())
                .bind(old_id_str)
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_purge_del_po", err.to_string()))?;
        }
    }

    // 5. Tombstone `note_heads` row (`content_blake3 = NULL, byte_size = 0, lifecycle_state = 'purged'`, zero plaintext!).
    let purged_slug = format!("purged-{old_id_str}");
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE note_heads
                 SET slug = ?, slug_fold = ?, title = '', title_fold = '',
                     ability_id = NULL, head_rev_id = ?, content_blake3 = NULL,
                     byte_size = 0, lifecycle_state = 'purged',
                     settlement_successor_id = ?, updated_seq = ?,
                     updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                 WHERE space_id = ? AND note_id = ?",
            )
            .bind(&purged_slug)
            .bind(&purged_slug)
            .bind(tombstone_rev_id.as_str())
            .bind(succ_str)
            .bind(pseq_i64)
            .bind(sec)
            .bind(nsec)
            .bind(actor_id.as_str())
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_tombstone_note_head", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE note_heads
                 SET slug = $1, slug_fold = $1, title = '', title_fold = '',
                     ability_id = NULL, head_rev_id = $2, content_blake3 = NULL,
                     byte_size = 0, lifecycle_state = 'purged',
                     settlement_successor_id = $3, updated_seq = $4,
                     updated_at_sec = $5, updated_at_nsec = $6, last_actor_id = $7
                 WHERE space_id = $8 AND note_id = $9",
            )
            .bind(&purged_slug)
            .bind(tombstone_rev_id.as_str())
            .bind(succ_str)
            .bind(pseq_i64)
            .bind(sec)
            .bind(nsec)
            .bind(actor_id.as_str())
            .bind(scope.space_id.as_str())
            .bind(old_id_str)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_tombstone_note_head", err.to_string()))?;
        }
    }

    // 6. Release CAS references for NoteRevision + CollabSnapshot, and seal zero-ref digests into `'retiring'`!
    let note_zero =
        release_owner_blob_refs_tx(tx, &scope.space_id, BlobOwnerKind::NoteRevision, old_id_str)
            .await?;
    zero_ref_digests.extend(note_zero);

    let collab_zero = release_owner_blob_refs_tx(
        tx,
        &scope.space_id,
        BlobOwnerKind::CollabSnapshot,
        old_id_str,
    )
    .await?;
    zero_ref_digests.extend(collab_zero);

    let mut retirement_ids = Vec::new();
    for digest in zero_ref_digests {
        if let Some(ret_id) = initiate_digest_retirement_tx(
            tx,
            scope,
            active_epoch,
            digest,
            RetirementReason::Purge,
            Some(purge_id),
            local_store,
        )
        .await?
        {
            retirement_ids.push(ret_id);
        }
    }

    Ok(retirement_ids)
}

async fn ensure_no_active_backup_holds_for_purge_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<(), PortError> {
    let hold_exists: Option<i64> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar("SELECT 1 FROM backup_holds WHERE space_id = ? LIMIT 1")
                .bind(space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_purge_check_holds", err.to_string())
                })?
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar("SELECT 1::BIGINT FROM backup_holds WHERE space_id = $1 LIMIT 1")
                .bind(space_id.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_purge_check_holds", err))?
        }
    };
    if hold_exists.is_some() {
        return Err(unavailable_retryable(
            "purge_blocked_by_backup_hold",
            "cannot initiate purge while a paired backup hold is active",
            Duration::from_millis(100),
        ));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_pending_purge_row_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    purge_id: &str,
    idemp: &CommandIdentitySpec,
    old_note: &NoteId,
    new_note: Option<&NoteId>,
    new_note_rev: Option<&RevisionId>,
    canonical_seq: SpaceSeq,
    retirement_ids: &[String],
    sanitized_response_msgpack: &[u8],
    now_ms: i64,
) -> Result<(), PortError> {
    let ret_json = serde_json::to_string(retirement_ids)
        .map_err(|err| internal_not_committed("encode_purge_ret_ids", err.to_string()))?;
    let seq_i64 = canonical_seq.get() as i64;

    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO pending_purges (
                    space_id, purge_id, history_incarnation, actor_id, idempotency_key,
                    command_hash, old_note_id, new_note_id, new_note_rev_id, canonical_seq,
                    phase, retirement_ids_json, sanitized_response_msgpack, last_safe_error,
                    created_at_ms, updated_at_ms
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sql_erased', ?, ?, NULL, ?, ?)",
            )
            .bind(scope.space_id.as_str())
            .bind(purge_id)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .bind(idemp.command_hash.as_bytes().as_slice())
            .bind(old_note.as_str())
            .bind(new_note.map(NoteId::as_str))
            .bind(new_note_rev.map(RevisionId::as_str))
            .bind(seq_i64)
            .bind(&ret_json)
            .bind(sanitized_response_msgpack)
            .bind(now_ms)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_insert_pending_purge", err.to_string())
            })?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO pending_purges (
                    space_id, purge_id, history_incarnation, actor_id, idempotency_key,
                    command_hash, old_note_id, new_note_id, new_note_rev_id, canonical_seq,
                    phase, retirement_ids_json, sanitized_response_msgpack, last_safe_error,
                    created_at_ms, updated_at_ms
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'sql_erased', $11, $12, NULL, $13, $13)",
            )
            .bind(scope.space_id.as_str())
            .bind(purge_id)
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(idemp.actor.as_str())
            .bind(idemp.command_key.as_str())
            .bind(idemp.command_hash.as_bytes().as_slice())
            .bind(old_note.as_str())
            .bind(new_note.map(NoteId::as_str))
            .bind(new_note_rev.map(RevisionId::as_str))
            .bind(seq_i64)
            .bind(&ret_json)
            .bind(sanitized_response_msgpack)
            .bind(now_ms)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_insert_pending_purge", err.to_string()))?;
        }
    }
    Ok(())
}

async fn load_pending_purge_for_idempotency(
    store: &CanonicalStore,
    scope: &HistoryScope,
    idemp: &CommandIdentitySpec,
) -> Result<Option<(PendingPurgeExecution, Vec<u8>)>, PortError> {
    let scope_cl = scope.clone();
    let idemp_cl = idemp.clone();
    let space_rec = store.read_space(&scope.space_id).await?;
    space_rec.scope.check(scope)?;

    store
        .with_read_tx(|tx| {
            Box::pin(async move {
                let raw: Option<RawLookupPendingPurgeRow> = match tx {
                    BackendConn::Sqlite(conn) => {
                        let row = sqlx::query(
                            "SELECT purge_id, command_hash, old_note_id, retirement_ids_json, sanitized_response_msgpack, canonical_seq
                             FROM pending_purges
                             WHERE space_id = ? AND history_incarnation = ? AND actor_id = ? AND idempotency_key = ?
                             ORDER BY created_at_ms DESC
                             LIMIT 1",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(idemp_cl.actor.as_str())
                        .bind(idemp_cl.command_key.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_lookup_pending_purge", err.to_string())
                        })?;
                        row.map(|r| {
                            (
                                r.get("purge_id"),
                                r.get("command_hash"),
                                r.get("old_note_id"),
                                r.get("retirement_ids_json"),
                                r.get("sanitized_response_msgpack"),
                                r.get("canonical_seq"),
                            )
                        })
                    }
                    BackendConn::Postgres(conn) => {
                        let row = sqlx::query(
                            "SELECT purge_id, command_hash, old_note_id, retirement_ids_json, sanitized_response_msgpack, canonical_seq
                             FROM pending_purges
                             WHERE space_id = $1 AND history_incarnation = $2 AND actor_id = $3 AND idempotency_key = $4
                             ORDER BY created_at_ms DESC
                             LIMIT 1",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(idemp_cl.actor.as_str())
                        .bind(idemp_cl.command_key.as_str())
                        .fetch_optional(&mut **conn)
                        .await
                        .map_err(|err| {
                            crate::runtime::pg_read_error("pg_lookup_pending_purge", err)
                        })?;
                        row.map(|r| {
                            (
                                r.get("purge_id"),
                                r.get("command_hash"),
                                r.get("old_note_id"),
                                r.get("retirement_ids_json"),
                                r.get("sanitized_response_msgpack"),
                                r.get("canonical_seq"),
                            )
                        })
                    }
                };

                let Some((purge_id, hash_bytes, old_note_raw, ret_json, resp_msgpack, seq)) = raw else {
                    return Ok(None);
                };
                idemp_cl.authorize_replay(tx, &scope_cl).await?;
                if !idemp_cl.matches_receipt_hash(tx, &scope_cl, seq, &hash_bytes).await? {
                    return Err(DomainError::IdempotencyKeyReused.into());
                }
                let old_note_id = NoteId::parse(&old_note_raw).map_err(|_| {
                    internal_not_committed("corrupt_pending_purge_note", "invalid old_note_id")
                })?;
                let retirement_ids: Vec<String> =
                    serde_json::from_str(&ret_json).map_err(|err| {
                        internal_not_committed("corrupt_pending_purge_ret", err.to_string())
                    })?;

                Ok(Some((PendingPurgeExecution {
                    purge_id,
                    scope: scope_cl,
                    active_epoch: space_rec.active_epoch,
                    actor_id: idemp_cl.actor.as_str().to_owned(),
                    idempotency_key: idemp_cl.command_key.as_str().to_owned(),
                    old_note_id,
                    canonical_seq: crate::codec::i64_to_space_seq(seq)?,
                    retirement_ids,
                }, resp_msgpack)))
            })
        })
        .await
}

async fn mark_pending_purge_cas_retired(
    store: &CanonicalStore,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    purge_id: &str,
) -> Result<(), PortError> {
    let scope_cl = scope.clone();
    let purge_cl = purge_id.to_owned();
    let now_ms = now_unix_ms()?;
    store
        .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
            Box::pin(async move {
                crate::blobs::lock_and_check_space_tx(tx, &scope_cl, epoch).await?;
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET phase = 'cas_retired', last_safe_error = NULL, updated_at_ms = ?
                             WHERE space_id = ? AND purge_id = ? AND phase = 'sql_erased'",
                        )
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_mark_cas_retired", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET phase = 'cas_retired', last_safe_error = NULL, updated_at_ms = $1
                             WHERE space_id = $2 AND purge_id = $3 AND phase = 'sql_erased'",
                        )
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_mark_cas_retired", err.to_string())
                        })?;
                    }
                }
                Ok(())
            })
        })
        .await
}

async fn mark_pending_purge_completed_tx(
    store: &CanonicalStore,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    purge_id: &str,
    actor_id: &str,
    idempotency_key: &str,
) -> Result<(), PortError> {
    let scope_cl = scope.clone();
    let purge_cl = purge_id.to_owned();
    let actor_cl = actor_id.to_owned();
    let key_cl = idempotency_key.to_owned();
    let now_ms = now_unix_ms()?;

    store
        .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
            Box::pin(async move {
                crate::blobs::lock_and_check_space_tx(tx, &scope_cl, epoch).await?;
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET phase = 'completed', last_safe_error = NULL, updated_at_ms = ?
                             WHERE space_id = ? AND purge_id = ?",
                        )
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_complete_pending_purge", err.to_string())
                        })?;

                        sqlx::query(
                            "UPDATE command_receipts
                             SET status = 'completed'
                             WHERE space_id = ? AND history_incarnation = ? AND actor_id = ? AND idempotency_key = ?",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(&actor_cl)
                        .bind(&key_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_complete_purge_receipt", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET phase = 'completed', last_safe_error = NULL, updated_at_ms = $1
                             WHERE space_id = $2 AND purge_id = $3",
                        )
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_complete_pending_purge", err.to_string())
                        })?;

                        sqlx::query(
                            "UPDATE command_receipts
                             SET status = 'completed'
                             WHERE space_id = $1 AND history_incarnation = $2 AND actor_id = $3 AND idempotency_key = $4",
                        )
                        .bind(scope_cl.space_id.as_str())
                        .bind(scope_cl.incarnation.as_bytes().as_slice())
                        .bind(&actor_cl)
                        .bind(&key_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_complete_purge_receipt", err.to_string())
                        })?;
                    }
                }
                Ok(())
            })
        })
        .await
}

async fn record_pending_purge_safe_error(
    store: &CanonicalStore,
    scope: &HistoryScope,
    epoch: LeaseEpoch,
    purge_id: &str,
    safe_error_code: &str,
) -> Result<(), PortError> {
    let scope_cl = scope.clone();
    let purge_cl = purge_id.to_owned();
    let err_cl = safe_error_code.to_owned();
    let now_ms = now_unix_ms()?;

    store
        .with_write_tx_for_space(Some(scope.space_id.clone()), |tx| {
            Box::pin(async move {
                crate::blobs::lock_and_check_space_tx(tx, &scope_cl, epoch).await?;
                match tx {
                    BackendConn::Sqlite(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET last_safe_error = ?, updated_at_ms = ?
                             WHERE space_id = ? AND purge_id = ?",
                        )
                        .bind(&err_cl)
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("sqlite_record_purge_err", err.to_string())
                        })?;
                    }
                    BackendConn::Postgres(conn) => {
                        sqlx::query(
                            "UPDATE pending_purges
                             SET last_safe_error = $1, updated_at_ms = $2
                             WHERE space_id = $3 AND purge_id = $4",
                        )
                        .bind(&err_cl)
                        .bind(now_ms)
                        .bind(scope_cl.space_id.as_str())
                        .bind(&purge_cl)
                        .execute(&mut **conn)
                        .await
                        .map_err(|err| {
                            internal_not_committed("pg_record_purge_err", err.to_string())
                        })?;
                    }
                }
                Ok(())
            })
        })
        .await
}

pub(crate) async fn has_incomplete_pending_purges_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    const PENDING: &str = concat!(
        "SELECT ",
        include_str!("purge/has_pending.sql"),
        " FROM (SELECT CAST($1 AS TEXT) AS space_id) s"
    );
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(PENDING)
            .bind(space_id.as_str())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_check_incomplete_purges", err.to_string())
            }),
        BackendConn::Postgres(conn) => sqlx::query_scalar(PENDING)
            .bind(space_id.as_str())
            .fetch_one(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_check_incomplete_purges", err.to_string())),
    }
}

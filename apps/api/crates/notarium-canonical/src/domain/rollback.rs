use std::collections::{BTreeMap, BTreeSet, HashMap};

use notarium_core::{
    DomainError,
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::{
        AgentRunId, ContentDigest, FolderId, HistoryIncarnation, NoteId, RevisionId, SpaceId,
        SpaceSeq,
    },
    model::{HistoryScope, Lifecycle, PathTarget},
    ports::{
        AssociatedBoardExpectation, ClosedRoomReservation, Committed, GroupKey, Mutation,
        NoteRevision, PlannedNoteRestoration, RestoredBoardRank, RollbackAgentRun,
        RollbackBoardFactsRequest, RollbackReservation, RollbackResult, SpaceContext, ViewRef,
    },
    receipt::MutationReceiptToken,
};
use sqlx::Row;
use tokio::time::Instant;

use crate::{
    CanonicalStore,
    blobs::{BlobOwnerKind, ExistingBlobRefItem, bind_existing_active_blob_refs_batch_tx},
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, doc_class_to_db, encode_msgpack,
        encode_timestamp_parts, evaluate_fields_with_schema, i64_to_space_seq,
        internal_not_committed, lifecycle_from_db, lifecycle_to_db, new_prefixed_hex_id,
        new_revision_id, normalize_title_key, now_unix_ms, now_utc_timestamp,
        unavailable_retryable,
    },
    domain::{
        board::{
            ExistingRankedItem, StoredSemanticPlacementV1, compute_rank_placement,
            evenly_spaced_ranks, load_overlay_row_opt_tx, load_view_overlays_tx,
            upsert_overlay_and_rank_revision_tx, verify_rank_expectation,
        },
        common::{
            FolderAncestryCache, NoteHeadRow, StoredCommittedRollbackV1,
            load_current_space_schema_tx, load_note_head_row_tx, load_note_heads_batch_tx,
            upsert_agent_run_head_tx, validate_mutation_identity,
        },
        notes::try_replay_completed_receipt,
    },
    runtime::{
        FolderHeadRow, RevisionInsertItem, insert_revision_rows_batch_tx, load_space_record,
    },
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent, SemanticCutMismatchKind},
};

mod fingerprint;
pub(crate) mod rank_removal;

const MAX_PLANNER_RETRIES: usize = 4;

#[allow(dead_code)]
#[derive(Clone, Debug)]
struct RunBoardMoveRow {
    command_end_seq: SpaceSeq,
    ordinal: i32,
    view: ViewRef,
    target_note_id: NoteId,
    before_placement_revision: Option<RevisionId>,
    before_placement: StoredSemanticPlacementV1,
}

pub(crate) fn decode_rollback_note(
    bytes: &[u8],
    note: &NoteId,
) -> Result<NoteRevisionMetadata, PortError> {
    match RevisionMetadataEnvelope::decode(bytes)?.payload {
        RevisionMetadataPayload::Note(meta) if &meta.note_id == note => Ok(meta),
        _ => Err(internal_not_committed(
            "rollback_source_metadata",
            "revision metadata does not identify the expected note",
        )),
    }
}

pub(crate) enum RollbackRevision<'a> {
    Trash,
    Restore(Option<&'a crate::domain::common::CurrentSpaceSchema>),
}

/// Lifecycle-only trash inherits the complete current carrier snapshot. A restoration
/// interprets the pre-run carrier under the schema visible at the new command cut.
pub(crate) fn encode_rollback_note(
    source: &NoteRevisionMetadata,
    original_bytes: Option<std::borrow::Cow<'_, [u8]>>,
    is_root_child: bool,
    operation: RollbackRevision<'_>,
) -> Result<Vec<u8>, PortError> {
    use std::borrow::Cow;

    let mut result = Cow::Borrowed(source);
    if source.is_root_child != is_root_child {
        result.to_mut().is_root_child = is_root_child;
    }
    match operation {
        RollbackRevision::Trash => {
            if source.lifecycle != Lifecycle::Trashed {
                result.to_mut().lifecycle = Lifecycle::Trashed;
            }
        }
        RollbackRevision::Restore(schema) => {
            let evaluated = if source.doc_class == DocClass::EncryptedNote {
                BTreeMap::new()
            } else {
                evaluate_fields_with_schema(
                    source.raw_fields.as_ref(),
                    source.diagnostics.first(),
                    schema.map(|s| &s.fields),
                )
            };
            let revision = schema.map(|s| &s.schema_revision);
            if source.schema_revision.as_ref() != revision || source.evaluated_fields != evaluated {
                let meta = result.to_mut();
                meta.schema_revision = revision.cloned();
                meta.evaluated_fields = evaluated;
            }
        }
    }
    if matches!(result, Cow::Borrowed(_))
        && let Some(bytes) = original_bytes
    {
        return Ok(bytes.into_owned());
    }
    RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(result.into_owned())).encode()
}

fn current_rollback_metadata(
    history: &[(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)],
    head: &RevisionId,
    note: &NoteId,
) -> Result<Box<NoteRevisionMetadata>, PortError> {
    let row = history.iter().find(|r| &r.0 == head).ok_or_else(|| {
        internal_not_committed("rollback_missing_head", "current note revision is missing")
    })?;
    decode_rollback_note(&row.2, note).map(Box::new)
}

#[derive(Clone, Debug)]
pub(crate) enum CandidateAction {
    TrashCreated {
        metadata: Box<NoteRevisionMetadata>,
        current_rev: RevisionId,
        current_lifecycle: Lifecycle,
        doc_class: DocClass,
        parent_folder_id: FolderId,
        slug: String,
        slug_fold: String,
        title: String,
        ability_id: Option<notarium_core::ids::AbilityId>,
        visibility_mask: i32,
        byte_size: u64,
        content_digest: Option<ContentDigest>,
    },
    RestorePreExisting {
        current_rev: RevisionId,
        pre_rev_id: RevisionId,
        pre_meta: Box<NoteRevisionMetadata>,
        pre_carrier: Option<String>,
        needs_note_mutation: bool,
        head_unchanged_placement: bool,
    },
}

#[derive(Clone, Debug)]
struct PlannedOverlayDelete {
    view: ViewRef,
    target_note: NoteId,
}

#[derive(Clone, Debug)]
struct PlannedNeighborRankUpdate {
    view: ViewRef,
    neighbor_note: NoteId,
    group: GroupKey,
    rank: String,
    is_pma: bool,
}

#[derive(Clone, Debug)]
struct PlannedTargetRankRestore {
    view: ViewRef,
    target_note: NoteId,
    group: GroupKey,
    rank: String,
    restored_placement_revision: Option<RevisionId>,
}

pub(crate) fn rollback_fallback_board_present_err() -> PortError {
    internal_not_committed(
        "rb_fallback_board_present",
        "board_move_history present; delegate to 2-phase planner",
    )
}

fn is_fallback_board_present(err: &PortError) -> bool {
    err == &rollback_fallback_board_present_err()
}

pub(crate) async fn rollback_agent_run_impl(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<RollbackAgentRun>,
) -> Result<Committed<RollbackResult>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "rollback").at;
    validate_mutation_identity(&ctx, &request.identity)?;
    crate::domain::common::require_empty_preconditions(&request.preconditions)?;
    let idemp = fingerprint::current(&request)?.with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::Documents(
            request
                .input
                .expected_entities
                .iter()
                .map(|entry| crate::writer::replay::ReplayResource::Write(entry.note.clone()))
                .chain(
                    request
                        .input
                        .associated_board_expectations
                        .iter()
                        .map(|entry| &entry.view.note)
                        .collect::<BTreeSet<_>>()
                        .into_iter()
                        .cloned()
                        .map(crate::writer::replay::ReplayResource::View),
                )
                .collect(),
        ),
    );

    let result = execute_rollback(store, &mut ctx, &request, &idemp, deadline).await;
    if !matches!(
        result,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ) {
        return result;
    }
    let Some(old_hash) = fingerprint::legacy(&request)? else {
        return result;
    };
    let mut previous = idemp;
    previous.command_hash = old_hash;
    ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
    let saved = rollback_wait(
        &ctx.budget,
        deadline,
        try_replay_completed_receipt::<StoredCommittedRollbackV1>(
            store,
            ctx.scope(),
            &previous,
            Some(&ctx.budget),
        ),
    )
    .await??;
    saved
        .map(StoredCommittedRollbackV1::into_committed)
        .ok_or_else(|| DomainError::IdempotencyKeyReused.into())
}

async fn execute_rollback(
    store: &CanonicalStore,
    ctx: &mut SpaceContext,
    request: &Mutation<RollbackAgentRun>,
    idemp: &crate::writer::CommandIdentitySpec,
    deadline: Instant,
) -> Result<Committed<RollbackResult>, PortError> {
    ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
    let no_live_or_fenced_rooms = match store.inner.collab_interceptor.get() {
        None => true,
        Some(interceptor) => {
            !interceptor.space_has_live_rooms(&ctx.scope().space_id)
                && !store
                    .inner
                    .room_fences
                    .has_any_fenced_in_space(&ctx.scope().space_id)
        }
    };
    if request.input.associated_board_expectations.is_empty() && no_live_or_fenced_rooms {
        let active_op_guard = store.enter_write_op(&ctx.scope().space_id)?;
        let writer_epoch = match &store.inner.sql {
            crate::runtime::SqlDriverState::Postgres { .. } => {
                store.inner.writer_epoch(&ctx.scope().space_id)?
            }
            crate::runtime::SqlDriverState::Sqlite { .. } => {
                rollback_wait(
                    &ctx.budget,
                    deadline,
                    store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget)),
                )
                .await??
                .active_epoch
            }
        };
        let mut try_pg_batch_plan = true;
        if matches!(
            store.inner.sql,
            crate::runtime::SqlDriverState::Postgres { .. }
        ) && let Some(outcome) = try_execute_pg_root_rollback(
            store,
            ctx,
            idemp,
            request,
            writer_epoch,
            &mut try_pg_batch_plan,
            deadline,
        )
        .await
        {
            return outcome;
        }
        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        let single_res: Result<StoredCommittedRollbackV1, PortError> = if store.is_sqlite_local() {
            let (intent, fast_plan) = crate::sqlite_fast::build_rollback_direct_sqlite_fast_intent(
                ctx.scope(),
                writer_epoch,
                idemp.clone(),
                ctx.auth().clone(),
                request.identity.clone(),
                request.input.clone(),
                store.inner.room_fences.clone(),
            );
            store
                .submit_write_command_until(
                    &ctx.budget,
                    deadline,
                    intent,
                    Some(fast_plan),
                    None,
                    Some(active_op_guard),
                )
                .await
        } else {
            let pg_fast = try_pg_batch_plan.then(|| {
                build_rollback_pg_single_item_fast(
                    ctx.scope().clone(),
                    idemp.clone(),
                    ctx.auth().clone(),
                    request.identity.clone(),
                    request.input.clone(),
                    store.inner.room_fences.clone(),
                    writer_epoch,
                )
            });
            let intent = build_rollback_direct_single_tx_intent(
                ctx.scope().clone(),
                writer_epoch,
                idemp.clone(),
                ctx.auth().clone(),
                request.identity.clone(),
                request.input.clone(),
                store.inner.room_fences.clone(),
            );
            store
                .submit_write_command_until(
                    &ctx.budget,
                    deadline,
                    intent,
                    None,
                    pg_fast,
                    Some(active_op_guard),
                )
                .await
        };

        match single_res {
            Ok(decoded) => return Ok(decoded.into_committed()),
            Err(err) if is_fallback_board_present(&err) => {
                // Space contains board move history; delegate to general 2-phase planner path.
            }
            Err(err) => return Err(err),
        }
    }

    ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
    if let Some(replayed) = rollback_wait(
        &ctx.budget,
        deadline,
        try_replay_completed_receipt::<StoredCommittedRollbackV1>(
            store,
            ctx.scope(),
            idemp,
            Some(&ctx.budget),
        ),
    )
    .await??
    {
        return Ok(replayed.into_committed());
    }

    let mut effective_input = request.input.clone();
    let mut attempt = 0;
    let mut replanned_after_recovery = false;
    while attempt < MAX_PLANNER_RETRIES {
        // Step 1 & 2: Read run head, touched set, caller expectations, and classify `skipped_manual_edits`.
        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        let ctx_read = ctx.clone();
        let input_read = effective_input.clone();
        let (space_rec, skipped_manual_edits, candidates, durable_active_rooms, run_board_moves) =
            rollback_wait(
                &ctx.budget,
                deadline,
                store.with_read_tx_budget(Some(&ctx.budget), |tx| {
                    Box::pin(
                        async move { discover_rollback_state_tx(tx, &ctx_read, &input_read).await },
                    )
                }),
            )
            .await??;

        // Load pre-run carriers from CAS ONLY when board views were moved by this run and require
        // `planned_carrier` in `RollbackBoardFactsRequest`.
        let mut candidates_with_carriers: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
        let need_board_carriers = !run_board_moves.is_empty();
        for (nid, mut action) in candidates {
            if need_board_carriers
                && let CandidateAction::RestorePreExisting {
                    ref pre_meta,
                    ref mut pre_carrier,
                    ..
                } = action
                && pre_meta.doc_class != DocClass::EncryptedNote
                && let Some(digest) = pre_meta.content_digest
            {
                let raw = rollback_wait(
                    &ctx.budget,
                    deadline,
                    store.read_verified_blob(&space_rec.scope, digest),
                )
                .await??;
                let carrier_str = String::from_utf8(raw).map_err(|_| {
                    internal_not_committed(
                        "rollback_corrupt_utf8",
                        "restored carrier invalid UTF-8",
                    )
                })?;
                *pre_carrier = Some(carrier_str);
            }
            candidates_with_carriers.insert(nid, action);
        }

        // Step 3: Deterministic room reservation in ascending `NoteId` order BEFORE `evaluate_rollback`.
        let mut skipped_room_active = Vec::new();
        let mut eligible_notes: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
        let mut eligible_reservations: BTreeMap<NoteId, ClosedRoomReservation> = BTreeMap::new();
        let mut recovered_revisions = BTreeMap::new();
        let interceptor = store.inner.collab_interceptor.get();
        let fences = &store.inner.room_fences;
        let space_id = ctx.scope().space_id.clone();

        for (nid, action) in candidates_with_carriers {
            let current = match &action {
                CandidateAction::TrashCreated { current_rev, .. }
                | CandidateAction::RestorePreExisting { current_rev, .. } => current_rev,
            };
            let was_blocked = durable_active_rooms.contains(&nid);
            if was_blocked
                && (interceptor.is_none()
                    || (!fences.is_room_fenced(&space_id, &nid)
                        && fences
                            .fenced_recovery_revision(&space_id, &nid, current)
                            .is_none()))
            {
                skipped_room_active.push(nid);
                continue;
            }
            ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
            let reservation = rollback_wait(&ctx.budget, deadline, async {
                if let Some(interceptor) = interceptor {
                    interceptor
                        .reserve_rollback(ctx.clone(), nid.clone(), request.identity.clone())
                        .await
                } else {
                    store
                        .inner
                        .room_fences
                        .reserve_rollback(ctx.scope(), &nid, request.identity.clone())
                        .await
                }
            })
            .await??;
            match reservation {
                RollbackReservation::SkippedRoomActive => {
                    skipped_room_active.push(nid);
                }
                RollbackReservation::Closed(closed_res) => {
                    if was_blocked
                        && let Some(recovered) =
                            fences.fenced_recovery_revision(&space_id, &nid, current)
                    {
                        recovered_revisions.insert(nid, recovered);
                        continue;
                    }
                    eligible_reservations.insert(nid.clone(), closed_res);
                    eligible_notes.insert(nid, action);
                }
            }
        }
        if !recovered_revisions.is_empty() {
            if replanned_after_recovery {
                return Err(unavailable_retryable(
                    "rollback_room_revision_contention",
                    "additional rooms recovered while planning the rollback",
                    std::time::Duration::from_millis(10),
                ));
            }
            // Only substitute a recovery of the exact, already-authorized revision.
            // The next discovery detects concurrent changes and counts recovered
            // human edits as foreign to the rolled-back agent run.
            for expected in &mut effective_input.expected_entities {
                if let Some(revision) = recovered_revisions.remove(&expected.note) {
                    expected.revision = revision;
                }
            }
            replanned_after_recovery = true;
            continue;
        }

        // Step 4: If eligible notes have board moves in `input.run`, evaluate rollback board facts.
        let mut affected_views_set: BTreeSet<ViewRef> = BTreeSet::new();
        for bmh in &run_board_moves {
            if eligible_notes.contains_key(&bmh.target_note_id) {
                affected_views_set.insert(bmh.view.clone());
            }
        }

        let rb_facts_opt = if !affected_views_set.is_empty() {
            let (board_authority, provider) = store.board_facts_provider()?;

            let mut planned_list = Vec::with_capacity(eligible_notes.len());
            for (nid, action) in &eligible_notes {
                match action {
                    CandidateAction::TrashCreated {
                        current_rev,
                        parent_folder_id,
                        doc_class,
                        ability_id,
                        ..
                    } => {
                        planned_list.push(PlannedNoteRestoration {
                            note: nid.clone(),
                            current_revision: current_rev.clone(),
                            restored_from_revision: None,
                            planned_lifecycle: Lifecycle::Trashed,
                            planned_parent_folder: parent_folder_id.clone(),
                            planned_class: *doc_class,
                            planned_ability: ability_id.clone(),
                            planned_header_diagnostic: None,
                            planned_carrier: None,
                            planned_fields: BTreeMap::new(),
                        });
                    }
                    CandidateAction::RestorePreExisting {
                        current_rev,
                        pre_rev_id,
                        pre_meta,
                        pre_carrier,
                        ..
                    } => {
                        let mut pfields = BTreeMap::new();
                        if let Some(ref raw_map) = pre_meta.raw_fields {
                            for (k, v) in raw_map {
                                pfields.insert(k.clone(), Some(v.clone()));
                            }
                        }
                        planned_list.push(PlannedNoteRestoration {
                            note: nid.clone(),
                            current_revision: current_rev.clone(),
                            restored_from_revision: Some(pre_rev_id.clone()),
                            planned_lifecycle: pre_meta.lifecycle,
                            planned_parent_folder: pre_meta.parent_folder_id.clone(),
                            planned_class: pre_meta.doc_class,
                            planned_ability: pre_meta.ability_id.clone(),
                            planned_header_diagnostic: pre_meta.diagnostics.first().cloned(),
                            planned_carrier: pre_carrier.clone(),
                            planned_fields: pfields,
                        });
                    }
                }
            }

            let req = RollbackBoardFactsRequest {
                cutoff: None,
                views: affected_views_set.iter().cloned().collect(),
                eligible_notes: planned_list,
            };
            ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
            let facts = match rollback_wait(
                &ctx.budget,
                deadline,
                provider.evaluate_rollback(&board_authority, ctx.clone(), req),
            )
            .await?
            {
                Ok(facts) => facts,
                Err(
                    err @ PortError::Domain(DomainError::ValidationFailed {
                        diagnostic:
                            Diagnostic {
                                reason: ValidationReason::CursorStale,
                                ..
                            },
                    }),
                ) => {
                    ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
                    if let Some(replayed) = rollback_wait(
                        &ctx.budget,
                        deadline,
                        try_replay_completed_receipt::<StoredCommittedRollbackV1>(
                            store,
                            ctx.scope(),
                            idemp,
                            Some(&ctx.budget),
                        ),
                    )
                    .await??
                    {
                        return Ok(replayed.into_committed());
                    }
                    if attempt + 1 < MAX_PLANNER_RETRIES {
                        continue;
                    }
                    return Err(err);
                }
                Err(err) => return Err(err),
            };
            facts.verify_authority(&board_authority)?;
            ctx.scope().check(facts.scope())?;
            Some(facts)
        } else {
            None
        };

        // Step 5 & 6: Submit ONE atomic write intent executing room consumption, reverse board replay,
        // created-note trashing FIRST, note restoration, overlay updates, and agent_run_heads bump.
        let required_cut = rb_facts_opt
            .as_ref()
            .map(|f| (f.cutoff(), SemanticCutMismatchKind::CursorStale));

        let mut source_note_ids: Vec<NoteId> = eligible_notes.keys().cloned().collect();
        for v in &affected_views_set {
            if !source_note_ids.contains(&v.note) {
                source_note_ids.push(v.note.clone());
            }
        }

        let intent = PreparedWriteIntent {
            scope: space_rec.scope.clone(),
            active_epoch: space_rec.active_epoch,
            idempotency: Some(idemp.clone()),
            source_note_ids,
            staged_bytes: 0,
            required_semantic_cut: required_cut,
            execute: build_rollback_execute_fn(
                space_rec.scope.clone(),
                ctx.auth().clone(),
                request.identity.clone(),
                effective_input.clone(),
                store.inner.room_fences.clone(),
                eligible_notes,
                eligible_reservations,
                skipped_manual_edits.clone(),
                skipped_room_active.clone(),
                affected_views_set,
                rb_facts_opt,
                run_board_moves.clone(),
            ),
        };

        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        match store
            .submit_write_command_until::<StoredCommittedRollbackV1>(
                &ctx.budget,
                deadline,
                intent,
                None,
                None,
                None,
            )
            .await
        {
            Ok(decoded) => {
                return Ok(decoded.into_committed());
            }
            Err(PortError::Domain(DomainError::ValidationFailed {
                diagnostic:
                    Diagnostic {
                        reason: ValidationReason::CursorStale,
                        ..
                    },
            })) if attempt + 1 < MAX_PLANNER_RETRIES => {
                attempt += 1;
                continue;
            }
            Err(err) => return Err(err),
        }
    }

    Err(unavailable_retryable(
        "rollback_planner_cut_contention",
        "rollback board facts cutoff contended across bounded retries",
        std::time::Duration::from_millis(10),
    ))
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn build_rollback_direct_single_tx_intent(
    scope: HistoryScope,
    active_epoch: notarium_core::ids::LeaseEpoch,
    idemp: crate::writer::CommandIdentitySpec,
    auth: notarium_core::auth::EngineAuthContext,
    req_id: notarium_core::receipt::CommandIdentity,
    input: RollbackAgentRun,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
) -> PreparedWriteIntent {
    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids: Vec::new(),
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: build_rollback_direct_single_tx_exec(scope, auth, req_id, input, room_fences),
    }
}

pub(crate) fn build_rollback_direct_single_tx_exec(
    scope_cl: HistoryScope,
    auth: notarium_core::auth::EngineAuthContext,
    req_id: notarium_core::receipt::CommandIdentity,
    input: RollbackAgentRun,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
) -> crate::writer::ItemExecuteFn {
    Box::new(move |tx, item_ctx| {
        Box::pin(async move {
            auth.authorize_space_write(&item_ctx.space)?;
            let mut folder_cache = FolderAncestryCache::default();
            // 1. Consolidated Space + Run + RootFolder state probe (1 single query on PostgreSQL!).
            type RollbackStateProbeTuple =
                (bool, bool, bool, bool, bool, Option<(Vec<u8>, String)>);
            let (has_bmh, has_pf, has_cs, has_ov, has_schema, run_head_opt): RollbackStateProbeTuple =
                match tx {
                BackendConn::Postgres(conn) => {
                    let r = sqlx::query(
                        "SELECT
                            EXISTS(SELECT 1 FROM board_move_history WHERE space_id = $1) AS has_bmh,
                            EXISTS(SELECT 1 FROM revision_purge_fences WHERE space_id = $1) AS has_pf,
                            EXISTS(SELECT 1 FROM collab_sessions WHERE space_id = $1) AS has_cs,
                            EXISTS(SELECT 1 FROM view_rank_overlays WHERE space_id = $1) AS has_ov,
                            EXISTS(SELECT 1 FROM space_field_schemas WHERE space_id = $1 AND is_current = 1) AS has_schema,
                            arh.history_incarnation AS run_inc,
                            arh.run_revision AS run_rev,
                            rf.folder_id AS rf_id,
                            rf.parent_folder_id AS rf_parent,
                            rf.is_root AS rf_is_root,
                            rf.slug AS rf_slug,
                            rf.slug_fold AS rf_slug_fold,
                            rf.display_name AS rf_display_name,
                            rf.is_project AS rf_is_project,
                            rf.project_slug AS rf_project_slug,
                            rf.project_slug_fold AS rf_project_slug_fold,
                            rf.description AS rf_description,
                            rf.cover_note_id AS rf_cover,
                            rf.write_lock_json AS rf_write_lock,
                            rf.lifecycle_state AS rf_lc,
                            rf.head_rev_id AS rf_head_rev
                         FROM (SELECT 1) AS probe
                         LEFT JOIN agent_run_heads arh ON arh.space_id = $1 AND arh.run_id = $2
                         LEFT JOIN folder_heads rf ON rf.space_id = $1 AND rf.folder_id = $3",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(input.run.as_str())
                    .bind(item_ctx.root_folder_id.as_str())
                    .fetch_one(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_rb_combined_probe", err.to_string()))?;

                    let rf_id_opt: Option<String> = r.get("rf_id");
                    if rf_id_opt.is_some() {
                        let parent_raw: Option<String> = r.get("rf_parent");
                        let cover_raw: Option<String> = r.get("rf_cover");
                        let lc_raw: String = r.get("rf_lc");
                        let head_rev_raw: String = r.get("rf_head_rev");
                        let write_lock_json: Option<String> = r.get("rf_write_lock");
                        let is_root_raw: i32 = r.get("rf_is_root");
                        let is_proj_raw: i32 = r.get("rf_is_project");

                        let parent_folder_id = match parent_raw {
                            Some(s) => Some(FolderId::parse(&s).map_err(|_| {
                                internal_not_committed("corrupt_parent_folder", "invalid FolderId")
                            })?),
                            None => None,
                        };
                        let cover_note_id = match cover_raw {
                            Some(s) => Some(NoteId::parse(&s).map_err(|_| {
                                internal_not_committed("corrupt_cover_note", "invalid NoteId")
                            })?),
                            None => None,
                        };
                        let head_rev_id = RevisionId::parse(&head_rev_raw).map_err(|_| {
                            internal_not_committed("corrupt_folder_rev", "invalid RevisionId")
                        })?;
                        let lifecycle = lifecycle_from_db(&lc_raw)?;
                        folder_cache.insert_preloaded_row(FolderHeadRow {
                            folder_id: item_ctx.root_folder_id.clone(),
                            parent_folder_id,
                            is_root: is_root_raw != 0,
                            slug: r.get("rf_slug"),
                            slug_fold: r.get("rf_slug_fold"),
                            display_name: r.get("rf_display_name"),
                            is_project: is_proj_raw != 0,
                            project_slug: r.get("rf_project_slug"),
                            project_slug_fold: r.get("rf_project_slug_fold"),
                            description: r.get("rf_description"),
                            cover_note_id,
                            write_locked: write_lock_json.is_some(),
                            lifecycle,
                            head_rev_id,
                        });
                    }

                    let run_inc: Option<Vec<u8>> = r.get("run_inc");
                    let run_rev: Option<String> = r.get("run_rev");
                    (
                        r.get("has_bmh"),
                        r.get("has_pf"),
                        r.get("has_cs"),
                        r.get("has_ov"),
                        r.get("has_schema"),
                        run_inc.zip(run_rev),
                    )
                }
                BackendConn::Sqlite(conn) => {
                    let bmh = sqlx::query_scalar::<_, i64>(
                        "SELECT 1 FROM board_move_history WHERE space_id = ? LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_bmh", e.to_string()))?
                    .is_some();
                    let pf = sqlx::query_scalar::<_, i64>(
                        "SELECT 1 FROM revision_purge_fences WHERE space_id = ? LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_pf", e.to_string()))?
                    .is_some();
                    let cs = sqlx::query_scalar::<_, i64>(
                        "SELECT 1 FROM collab_sessions WHERE space_id = ? LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_cs", e.to_string()))?
                    .is_some();
                    let ov = sqlx::query_scalar::<_, i64>(
                        "SELECT 1 FROM view_rank_overlays WHERE space_id = ? LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_ov", e.to_string()))?
                    .is_some();
                    let sch = sqlx::query_scalar::<_, i64>(
                        "SELECT 1 FROM space_field_schemas WHERE space_id = ? AND is_current = 1 LIMIT 1",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_sch", e.to_string()))?
                    .is_some();
                    let rr = sqlx::query(
                        "SELECT history_incarnation, run_revision FROM agent_run_heads WHERE space_id = ? AND run_id = ?",
                    )
                    .bind(scope_cl.space_id.as_str())
                    .bind(input.run.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|e| internal_not_committed("sqlite_rb_rh", e.to_string()))?
                    .map(|r| (r.get("history_incarnation"), r.get("run_revision")));
                    (bmh, pf, cs, ov, sch, rr)
                }
            };

            if has_bmh {
                return Err(rollback_fallback_board_present_err());
            }

            let Some((inc_bytes, run_rev_raw)) = run_head_opt else {
                return Err(DomainError::ResourceNotFound.into());
            };
            let inc_arr: [u8; 16] = inc_bytes
                .try_into()
                .map_err(|_| internal_not_committed("corrupt_run_inc", "incarnation != 16B"))?;
            scope_cl.check(&HistoryScope {
                space_id: scope_cl.space_id.clone(),
                incarnation: HistoryIncarnation::from_bytes(inc_arr),
            })?;

            let actual_run_rev = RevisionId::parse(&run_rev_raw)
                .map_err(|_| internal_not_committed("corrupt_run_rev", "invalid run_revision"))?;

            let purged_notes = if has_pf {
                load_space_purged_notes_tx(tx, &scope_cl.space_id).await?
            } else {
                HashMap::new()
            };

            let mut caller_notes: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
            for exp in &input.expected_entities {
                if purged_notes.contains_key(exp.note.as_str()) {
                    return Err(DomainError::ResourceNotFound.into());
                }
                if caller_notes
                    .insert(exp.note.clone(), exp.revision.clone())
                    .is_some()
                {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
            }

            let caller_note_vec: Vec<NoteId> = caller_notes.keys().cloned().collect();

            // Load all note revisions for `caller_note_vec` PLUS any extra notes touched by `input.run` in 1 query!
            let (mut rev_histories, touched_set) = load_revisions_and_run_touched_combined_tx(
                tx,
                &scope_cl.space_id,
                &input.run,
                &caller_note_vec,
            )
            .await?;

            let caller_set: BTreeSet<NoteId> = caller_notes.keys().cloned().collect();
            if caller_set != touched_set {
                return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
            }

            let mut heads_map =
                load_note_heads_batch_tx(tx, &scope_cl.space_id, &caller_note_vec).await?;

            for nid in caller_notes.keys() {
                let head = heads_map.get(nid).ok_or(DomainError::ResourceNotFound)?;
                let (rfacts, _) = folder_cache
                    .build_resource_facts_tx(
                        tx,
                        &item_ctx.space,
                        &head.parent_folder_id,
                        head.doc_class,
                        head.ability_id.clone(),
                        false,
                    )
                    .await?;
                auth.authorize_direct_write(&rfacts, &rfacts)?;
            }

            verify_authorized_rollback_revisions(actual_run_rev, &input, |nid| {
                heads_map.get(nid).map(|head| &head.head_rev_id)
            })?;

            let collab_states = if has_cs {
                load_space_collab_states_tx(tx, &scope_cl.space_id).await?
            } else {
                HashMap::new()
            };

            let mut skipped_manual_edits = Vec::new();
            let mut skipped_room_active = Vec::new();
            let mut eligible_notes: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();

            for nid in caller_note_vec {
                let head = heads_map
                    .remove(&nid)
                    .ok_or(DomainError::ResourceNotFound)?;
                let note_revs = rev_histories.remove(&nid).unwrap_or_default();

                let first_run_seq = note_revs
                    .iter()
                    .filter(|r| r.3.as_ref() == Some(&input.run))
                    .map(|r| r.1)
                    .min()
                    .ok_or_else(|| DomainError::validation(ValidationReason::SourceMismatch))?;

                let has_foreign_note_edit = note_revs
                    .iter()
                    .any(|r| r.1 > first_run_seq && r.3.as_ref() != Some(&input.run));
                if has_foreign_note_edit {
                    skipped_manual_edits.push(nid);
                    continue;
                }

                if collab_states.get(&nid) == Some(&true) {
                    skipped_room_active.push(nid);
                    continue;
                }

                let pre_rev_opt = note_revs
                    .iter()
                    .filter(|r| r.1 < first_run_seq)
                    .max_by_key(|r| r.1);

                let action = match pre_rev_opt {
                    None => CandidateAction::TrashCreated {
                        metadata: current_rollback_metadata(&note_revs, &head.head_rev_id, &nid)?,
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
                    Some((pre_rev_id, _, meta_bytes, _)) => {
                        let pre_meta = decode_rollback_note(meta_bytes, &nid)?;
                        let head_unchanged_placement = head.lifecycle == pre_meta.lifecycle
                            && head.parent_folder_id == pre_meta.parent_folder_id
                            && head.slug == pre_meta.slug
                            && head.slug_fold == pre_meta.slug_fold;
                        let needs_note_mutation =
                            head.head_rev_id != *pre_rev_id || !head_unchanged_placement;
                        CandidateAction::RestorePreExisting {
                            current_rev: head.head_rev_id,
                            pre_rev_id: pre_rev_id.clone(),
                            pre_meta: Box::new(pre_meta),
                            pre_carrier: None,
                            needs_note_mutation,
                            head_unchanged_placement,
                        }
                    }
                };

                eligible_notes.insert(nid, action);
            }

            // Lock per-note fences in ascending NoteId order before collision checks so no room can open/close
            // concurrently and any PathConflict drops the guards without bumping fence epochs.
            let mut final_eligible: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
            let mut locked_fences = Vec::with_capacity(eligible_notes.len());
            for (nid, action) in eligible_notes {
                match room_fences
                    .try_lock_closed_for_rollback(&scope_cl, &nid, &req_id)
                    .await?
                {
                    Some((guard, res)) => {
                        locked_fences.push((guard, res));
                        final_eligible.insert(nid, action);
                    }
                    None => {
                        skipped_room_active.push(nid);
                    }
                }
            }
            skipped_room_active.sort();

            let eligible_all_ids: BTreeSet<NoteId> = final_eligible.keys().cloned().collect();
            let mut planned_active_slots: HashMap<(FolderId, String), NoteId> = HashMap::new();
            let mut planned_collision_checks: Vec<(FolderId, String, String, bool)> = Vec::new();
            let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();

            for (nid, action) in &final_eligible {
                if let CandidateAction::RestorePreExisting {
                    pre_meta,
                    head_unchanged_placement,
                    ..
                } = action
                {
                    let anc = authorize_rollback_destination_tx(
                        tx,
                        &mut folder_cache,
                        &item_ctx.space,
                        &auth,
                        pre_meta,
                    )
                    .await?;
                    restored_ancestries.insert(nid.clone(), anc.is_root_child);

                    if pre_meta.lifecycle == Lifecycle::Active {
                        let slot_key = (
                            pre_meta.parent_folder_id.clone(),
                            pre_meta.slug_fold.clone(),
                        );
                        if planned_active_slots.insert(slot_key, nid.clone()).is_some() {
                            return Err(DomainError::PathConflict {
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
                            .into());
                        }
                        if !*head_unchanged_placement {
                            planned_collision_checks.push((
                                pre_meta.parent_folder_id.clone(),
                                pre_meta.slug_fold.clone(),
                                pre_meta.slug.clone(),
                                anc.is_root_child,
                            ));
                        }
                    }
                }
            }

            let mut needed_rebind_digests: BTreeSet<ContentDigest> = BTreeSet::new();
            for action in final_eligible.values() {
                match action {
                    CandidateAction::TrashCreated {
                        current_lifecycle,
                        content_digest: Some(d),
                        ..
                    } if *current_lifecycle != Lifecycle::Trashed => {
                        needed_rebind_digests.insert(*d);
                    }
                    CandidateAction::RestorePreExisting {
                        needs_note_mutation: true,
                        pre_meta,
                        ..
                    } => {
                        if let Some(d) = pre_meta.content_digest {
                            needed_rebind_digests.insert(d);
                        }
                    }
                    _ => {}
                }
            }

            let pg_pub_by_digest_opt = verify_collisions_and_load_pg_rebind_pubs_tx(
                tx,
                &scope_cl.space_id,
                &planned_collision_checks,
                &eligible_all_ids,
                &needed_rebind_digests,
            )
            .await?;

            for (mut guard, res) in locked_fences {
                guard.consume(res, &req_id)?;
                item_ctx.retain_until_batch_commit(guard);
            }

            let current_schema = if has_schema {
                load_current_space_schema_tx(tx, &scope_cl.space_id).await?
            } else {
                None
            };

            let trash_note_count = final_eligible
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
            let restore_note_count = final_eligible
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
            let rank_removals = if has_ov {
                rank_removal::plan_tx(tx, &scope_cl.space_id, &final_eligible, &[]).await?
            } else {
                Vec::new()
            };
            let total_seqs =
                (trash_note_count + restore_note_count + rank_removals.len() as u64).max(1);
            let (first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
            let vis_i64 = visibility_seq.get() as i64;
            let now_ts = now_utc_timestamp()?;
            let (sec, nsec) = encode_timestamp_parts(now_ts);

            let mut events = Vec::with_capacity(total_seqs as usize);
            let mut trashed_out = Vec::with_capacity(trash_note_count as usize);
            let mut restored_out = Vec::with_capacity(restore_note_count as usize);
            let mut owner_notes_for_receipt: BTreeSet<NoteId> = BTreeSet::new();
            let mut pending_blob_rebinds: Vec<ExistingBlobRefItem> =
                Vec::with_capacity(final_eligible.len());
            struct PendingSingleRev {
                rev_id: RevisionId,
                entity_type: &'static str,
                entity_key: String,
                space_seq: SpaceSeq,
                parent_rev_id: Option<RevisionId>,
                restored_from_rev_id: Option<RevisionId>,
                content_blake3: Option<ContentDigest>,
                metadata_msgpack: Vec<u8>,
                agent_run_id: Option<AgentRunId>,
            }
            let mut pending_rev_rows: Vec<PendingSingleRev> =
                Vec::with_capacity(final_eligible.len() + 1);
            let mut pending_trash_heads: Vec<(NoteId, RevisionId)> =
                Vec::with_capacity(trash_note_count as usize);

            // Trash created notes FIRST.
            for (nid, action) in &final_eligible {
                let CandidateAction::TrashCreated {
                    metadata,
                    current_rev,
                    current_lifecycle,
                    doc_class,
                    parent_folder_id,
                    content_digest,
                    ..
                } = action
                else {
                    continue;
                };

                owner_notes_for_receipt.insert(nid.clone());

                if *current_lifecycle == Lifecycle::Trashed {
                    trashed_out.push(NoteRevision {
                        note: nid.clone(),
                        revision: current_rev.clone(),
                    });
                    continue;
                }

                let tseq = item_ctx.alloc_next_seq()?;
                let trev = new_revision_id()?;
                let anc = folder_cache
                    .load_ancestry_tx(tx, &scope_cl.space_id, parent_folder_id, false)
                    .await?;

                pending_trash_heads.push((nid.clone(), trev.clone()));
                if collab_states.contains_key(nid) {
                    bump_closed_collab_session_lineage_tx(
                        tx,
                        &scope_cl.space_id,
                        nid,
                        &trev,
                        vis_i64,
                    )
                    .await?;
                }

                if let Some(digest) = *content_digest {
                    pending_blob_rebinds.push(ExistingBlobRefItem {
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: nid.as_str().to_owned(),
                        owner_rev_id: trev.as_str().to_owned(),
                        resource_key: "carrier",
                        digest,
                        created_seq: tseq,
                    });
                }

                let meta = encode_rollback_note(
                    metadata,
                    None,
                    anc.is_root_child,
                    RollbackRevision::Trash,
                )?;

                pending_rev_rows.push(PendingSingleRev {
                    rev_id: trev.clone(),
                    entity_type: "note",
                    entity_key: nid.as_str().to_owned(),
                    space_seq: tseq,
                    parent_rev_id: Some(current_rev.clone()),
                    restored_from_rev_id: None,
                    content_blake3: *content_digest,
                    metadata_msgpack: meta,
                    agent_run_id: None,
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

            update_note_heads_trashed_batch_tx(
                tx,
                &scope_cl.space_id,
                &pending_trash_heads,
                vis_i64,
                sec,
                nsec,
                auth.principal().as_str(),
            )
            .await?;

            let mut pending_restore_heads: Vec<RestoredHeadUpdateItem<'_>> =
                Vec::with_capacity(restore_note_count as usize);

            for (nid, action) in &final_eligible {
                let CandidateAction::RestorePreExisting {
                    current_rev,
                    pre_rev_id,
                    pre_meta,
                    needs_note_mutation,
                    ..
                } = action
                else {
                    continue;
                };
                owner_notes_for_receipt.insert(nid.clone());

                if !*needs_note_mutation {
                    continue;
                }

                let rseq = item_ctx.alloc_next_seq()?;
                let rrev = new_revision_id()?;
                let is_root_child = restored_ancestries.get(nid).copied().unwrap_or(false);

                if let Some(digest) = pre_meta.content_digest {
                    pending_blob_rebinds.push(ExistingBlobRefItem {
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: nid.as_str().to_owned(),
                        owner_rev_id: rrev.as_str().to_owned(),
                        resource_key: "carrier",
                        digest,
                        created_seq: rseq,
                    });
                }

                let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
                    normalize_title_key(&pre_meta.slug)
                } else {
                    normalize_title_key(&pre_meta.title)
                };

                pending_restore_heads.push(RestoredHeadUpdateItem {
                    note_id: nid,
                    parent_folder_id: &pre_meta.parent_folder_id,
                    slug: &pre_meta.slug,
                    slug_fold: &pre_meta.slug_fold,
                    title: &pre_meta.title,
                    title_fold,
                    doc_class_str: doc_class_to_db(pre_meta.doc_class),
                    ability_id_str: pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                    rev_id: rrev.clone(),
                    content_digest: pre_meta.content_digest,
                    byte_size: pre_meta.byte_size,
                    lifecycle_str: lifecycle_to_db(pre_meta.lifecycle),
                    visibility_mask: pre_meta.visibility_mask,
                });

                if collab_states.contains_key(nid) {
                    bump_closed_collab_session_lineage_tx(
                        tx,
                        &scope_cl.space_id,
                        nid,
                        &rrev,
                        vis_i64,
                    )
                    .await?;
                }

                let meta = encode_rollback_note(
                    pre_meta,
                    None,
                    is_root_child,
                    RollbackRevision::Restore(current_schema.as_ref()),
                )?;

                pending_rev_rows.push(PendingSingleRev {
                    rev_id: rrev.clone(),
                    entity_type: "note",
                    entity_key: nid.as_str().to_owned(),
                    space_seq: rseq,
                    parent_rev_id: Some(current_rev.clone()),
                    restored_from_rev_id: Some(pre_rev_id.clone()),
                    content_blake3: pre_meta.content_digest,
                    metadata_msgpack: meta,
                    agent_run_id: None,
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

            // Coalesce the `agent_run` revision row into the exact same `revisions` batch insert!
            let new_run_rev = new_revision_id()?;
            let run_meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
                crate::codec::AgentRunRevisionMetadata {
                    run_id: input.run.clone(),
                    last_seq: visibility_seq,
                },
            ))
            .encode()?;
            pending_rev_rows.push(PendingSingleRev {
                rev_id: new_run_rev.clone(),
                entity_type: "agent_run",
                entity_key: input.run.as_str().to_owned(),
                space_seq: visibility_seq,
                parent_rev_id: None,
                restored_from_rev_id: None,
                content_blake3: None,
                metadata_msgpack: run_meta,
                agent_run_id: Some(input.run.clone()),
            });

            let rev_items: Vec<RevisionInsertItem<'_>> = pending_rev_rows
                .iter()
                .map(|r| RevisionInsertItem {
                    rev_id: &r.rev_id,
                    entity_type: r.entity_type,
                    entity_key: &r.entity_key,
                    space_seq: r.space_seq,
                    visibility_seq,
                    parent_rev_id: r.parent_rev_id.as_ref(),
                    restored_from_rev_id: r.restored_from_rev_id.as_ref(),
                    content_blake3: r.content_blake3,
                    metadata_msgpack: &r.metadata_msgpack,
                    actor_id: auth.principal(),
                    agent_run_id: r.agent_run_id.as_ref(),
                    created_at: now_ts,
                })
                .collect();

            if let (Some(pub_by_digest), BackendConn::Postgres(conn)) =
                (pg_pub_by_digest_opt.as_ref(), &mut *tx)
            {
                execute_pg_rollback_domain_writes_cte(
                    conn,
                    &scope_cl,
                    &input.run,
                    &new_run_rev,
                    vis_i64,
                    sec,
                    nsec,
                    auth.principal().as_str(),
                    &pending_restore_heads,
                    &pending_blob_rebinds,
                    pub_by_digest,
                    &rev_items,
                )
                .await?;
            } else {
                update_note_heads_restored_batch_tx(
                    tx,
                    &scope_cl.space_id,
                    &pending_restore_heads,
                    vis_i64,
                    sec,
                    nsec,
                    auth.principal().as_str(),
                )
                .await?;

                bind_existing_active_blob_refs_batch_tx(
                    tx,
                    &scope_cl.space_id,
                    &pending_blob_rebinds,
                )
                .await?;

                insert_revision_rows_batch_tx(tx, &scope_cl, &rev_items).await?;

                upsert_agent_run_head_row_only_tx(
                    tx,
                    &scope_cl,
                    &input.run,
                    &new_run_rev,
                    vis_i64,
                    sec,
                    nsec,
                )
                .await?;
            }

            for removal in rank_removals {
                let seq = item_ctx.alloc_next_seq()?;
                let revision = new_revision_id()?;
                removal
                    .write_tx(
                        tx,
                        &scope_cl,
                        seq,
                        visibility_seq,
                        &revision,
                        auth.principal(),
                        now_ts,
                    )
                    .await?;
                owner_notes_for_receipt.extend(removal.owners().into_iter().cloned());
                events.push(removal.event(seq, revision));
            }

            if events.is_empty() {
                let noop_seq = item_ctx.alloc_next_seq()?;
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

            let owner_vec: Vec<NoteId> = owner_notes_for_receipt.into_iter().collect();
            let cmd_range = notarium_core::ports::CommandSeqRange::new(first_seq, visibility_seq)?;
            let effect_draft = build_effect_payload_draft(
                new_prefixed_hex_id("pay_")?,
                scope_cl.clone(),
                cmd_range,
                "rollback_agent_run",
                EffectBodyV1::AwaitProjection {
                    reason: StoredAwaitReasonV1::Bulk,
                },
                owner_vec.clone(),
            )?;
            let receipt_token = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
            let wire = StoredCommittedRollbackV1 {
                restored: restored_out,
                trashed: trashed_out,
                restored_ranks: Vec::new(),
                skipped_manual_edits,
                skipped_room_active: skipped_room_active.clone(),
                receipt: receipt_token.clone(),
            };
            let resp_bytes = encode_msgpack(&wire)?;
            let sanitized = encode_msgpack(&StoredCommittedRollbackV1 {
                restored: Vec::new(),
                trashed: Vec::new(),
                restored_ranks: Vec::new(),
                skipped_manual_edits: wire.skipped_manual_edits,
                skipped_room_active,
                receipt: receipt_token,
            })?;

            Ok(ItemCommitArtifacts {
                command_id: new_prefixed_hex_id("cmd_")?,
                command_kind: "rollback_agent_run".to_owned(),
                events,
                change_payload: Some(effect_draft),
                receipt_detail_blob: Some(resp_bytes.clone()),
                receipt_sanitized_blob: sanitized,
                receipt_owner_note_ids: owner_vec,
                response_bytes: resp_bytes,
            })
        })
    })
}

#[allow(clippy::too_many_arguments)]
fn build_rollback_execute_fn(
    scope_cl: HistoryScope,
    auth: notarium_core::auth::EngineAuthContext,
    req_id: notarium_core::receipt::CommandIdentity,
    input: RollbackAgentRun,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
    eligible_notes: BTreeMap<NoteId, CandidateAction>,
    eligible_reservations: BTreeMap<NoteId, ClosedRoomReservation>,
    skipped_manual_cl: Vec<NoteId>,
    skipped_room_cl: Vec<NoteId>,
    affected_views_set: BTreeSet<ViewRef>,
    rb_facts_opt: Option<notarium_core::ports::RollbackBoardFacts>,
    run_moves_cl: Vec<RunBoardMoveRow>,
) -> crate::writer::ItemExecuteFn {
    Box::new(move |tx, item_ctx| {
        Box::pin(async move {
            // 1. Re-verify `expected_run_revision`, `expected_entities`, and `associated_board_expectations`.
            let mut folder_cache = FolderAncestryCache::default();
            let _ = verify_run_and_entity_preconditions_tx(
                tx,
                &scope_cl,
                &item_ctx.space,
                &auth,
                &input,
                &mut folder_cache,
            )
            .await?;

            // 2. Consume all closed-room reservations in ascending NoteId order.
            let collab_states = load_space_collab_states_tx(tx, &scope_cl.space_id).await?;
            for (nid, res) in eligible_reservations {
                let guard = room_fences
                    .consume_reservation(&scope_cl, &nid, res, &req_id)
                    .await?;
                // Double-check durable `collab_sessions` did not become `'active'` or `'fenced'` concurrently.
                if collab_states.get(&nid) == Some(&true) {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
                item_ctx.retain_until_batch_commit(guard);
            }

            // 3. Validate folder existence and post-trash slug uniqueness for all eligible restored notes.
            let eligible_all_ids: BTreeSet<NoteId> = eligible_notes.keys().cloned().collect();
            let trashed_created_ids: BTreeSet<NoteId> = eligible_notes
                .iter()
                .filter_map(|(nid, act)| match act {
                    CandidateAction::TrashCreated { .. } => Some(nid.clone()),
                    CandidateAction::RestorePreExisting { .. } => None,
                })
                .collect();

            let mut planned_active_slots: HashMap<(FolderId, String), NoteId> = HashMap::new();
            let mut planned_collision_checks: Vec<(FolderId, String, String, bool)> = Vec::new();
            let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();

            for (nid, action) in &eligible_notes {
                if let CandidateAction::RestorePreExisting { pre_meta, .. } = action {
                    let anc = authorize_rollback_destination_tx(
                        tx,
                        &mut folder_cache,
                        &item_ctx.space,
                        &auth,
                        pre_meta,
                    )
                    .await?;
                    restored_ancestries.insert(nid.clone(), anc.is_root_child);

                    if pre_meta.lifecycle == Lifecycle::Active {
                        let slot_key = (
                            pre_meta.parent_folder_id.clone(),
                            pre_meta.slug_fold.clone(),
                        );
                        if planned_active_slots.insert(slot_key, nid.clone()).is_some() {
                            return Err(DomainError::PathConflict {
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
                            .into());
                        }
                        planned_collision_checks.push((
                            pre_meta.parent_folder_id.clone(),
                            pre_meta.slug_fold.clone(),
                            pre_meta.slug.clone(),
                            anc.is_root_child,
                        ));
                    }
                }
            }

            verify_no_active_non_eligible_collisions_batch_tx(
                tx,
                &scope_cl.space_id,
                &planned_collision_checks,
                &eligible_all_ids,
            )
            .await?;
            // 4. Plan reverse board rank replays `(command_end_seq DESC, ordinal DESC)` before mutating SQL.
            let mut planned_overlay_deletes: Vec<PlannedOverlayDelete> = Vec::new();
            let mut planned_neighbor_updates: Vec<PlannedNeighborRankUpdate> = Vec::new();
            let mut planned_target_restores: Vec<PlannedTargetRankRestore> = Vec::new();
            let mut preloaded_view_overlays: BTreeMap<
                ViewRef,
                HashMap<NoteId, crate::domain::board::OverlayRow>,
            > = BTreeMap::new();

            if let Some(ref rb_facts) = rb_facts_opt {
                let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                let cur_schema_rev = current_schema.as_ref().map(|s| &s.schema_revision);

                for view in &affected_views_set {
                    let view_facts = rb_facts
                        .views()
                        .get(view)
                        .ok_or_else(|| DomainError::validation(ValidationReason::InvalidState))?;
                    let view_head =
                        load_note_head_row_tx(tx, &scope_cl.space_id, &view.note).await?;
                    if view_head.lifecycle != Lifecycle::Active {
                        return Err(DomainError::ResourceNotFound.into());
                    }
                    if view_head.head_rev_id != view_facts.view_revision {
                        return Err(DomainError::RevisionConflict {
                            current: view_head.head_rev_id,
                            lineage: None,
                        }
                        .into());
                    }
                    if cur_schema_rev != view_facts.schema_revision.as_ref() {
                        return Err(DomainError::validation(ValidationReason::CursorStale).into());
                    }
                    if let Some(ref cs) = current_schema
                        && cs.descriptor_fingerprint != view_facts.descriptor_fingerprint
                    {
                        return Err(DomainError::validation(ValidationReason::CursorStale).into());
                    }

                    let overlays = load_view_overlays_tx(tx, &scope_cl.space_id, view).await?;

                    // Verify planner rows match current note & overlay state.
                    for eg in &view_facts.groups {
                        for row in &eg.rows {
                            let rhead = super::board::verified_board_row_tx(
                                tx,
                                &item_ctx.space,
                                &auth,
                                &mut folder_cache,
                                row,
                            )
                            .await?;
                            verify_rank_expectation(
                                &row.expected_rank,
                                overlays.get(&row.note),
                                &rhead.head_rev_id,
                            )?;
                        }
                    }

                    // Build mutable working group lists excluding notes being trashed by this rollback,
                    // materializing initial ranks for any unranked existing rows in each group.
                    let mut working_groups: Vec<(GroupKey, Vec<ExistingRankedItem>)> = Vec::new();
                    let mut neighbor_dirty: BTreeMap<NoteId, (GroupKey, String, bool)> =
                        BTreeMap::new();

                    for eg in &view_facts.groups {
                        let kept_notes: Vec<NoteId> = eg
                            .rows
                            .iter()
                            .filter(|r| !trashed_created_ids.contains(&r.note))
                            .map(|r| r.note.clone())
                            .collect();
                        if kept_notes.is_empty() {
                            working_groups.push((eg.group.clone(), Vec::new()));
                            continue;
                        }
                        let all_unranked = kept_notes
                            .iter()
                            .all(|nid| overlays.get(nid).map(|o| &o.group) != Some(&eg.group));
                        let mut items = Vec::with_capacity(kept_notes.len());
                        if all_unranked {
                            let init = evenly_spaced_ranks(kept_notes.len())?;
                            for (nid, r) in kept_notes.iter().zip(init) {
                                if !eligible_all_ids.contains(nid) {
                                    neighbor_dirty
                                        .insert(nid.clone(), (eg.group.clone(), r.clone(), false));
                                }
                                items.push(ExistingRankedItem {
                                    note_id: nid.clone(),
                                    rank: r,
                                });
                            }
                        } else {
                            let mut ranked_only: Vec<ExistingRankedItem> = kept_notes
                                .iter()
                                .filter_map(|nid| {
                                    let o = overlays.get(nid)?;
                                    if o.group == eg.group {
                                        Some(ExistingRankedItem {
                                            note_id: nid.clone(),
                                            rank: o.sort_rank_lexo.clone(),
                                        })
                                    } else {
                                        None
                                    }
                                })
                                .collect();
                            ranked_only.sort_by(|a, b| {
                                a.rank.cmp(&b.rank).then_with(|| a.note_id.cmp(&b.note_id))
                            });
                            items.extend(ranked_only);
                            for nid in &kept_notes {
                                let in_grp = overlays
                                    .get(nid)
                                    .map(|o| o.group == eg.group)
                                    .unwrap_or(false);
                                if !in_grp {
                                    let tail = compute_rank_placement(&items, nid, items.len())?;
                                    for (pn, pr) in tail.pma_neighbor_updates {
                                        if let Some(it) = items.iter_mut().find(|i| i.note_id == pn)
                                        {
                                            it.rank = pr.clone();
                                        }
                                        if !eligible_all_ids.contains(&pn) {
                                            neighbor_dirty.insert(pn, (eg.group.clone(), pr, true));
                                        }
                                    }
                                    if !eligible_all_ids.contains(nid) {
                                        neighbor_dirty.insert(
                                            nid.clone(),
                                            (eg.group.clone(), tail.target_rank.clone(), false),
                                        );
                                    }
                                    items.push(ExistingRankedItem {
                                        note_id: nid.clone(),
                                        rank: tail.target_rank,
                                    });
                                }
                            }
                        }
                        working_groups.push((eg.group.clone(), items));
                    }

                    // Replay run's board moves on `view` for non-trashed eligible notes in DESC order!
                    let mut target_final_state: BTreeMap<
                        NoteId,
                        Option<(GroupKey, String, Option<RevisionId>)>,
                    > = BTreeMap::new();

                    for bmh in &run_moves_cl {
                        if &bmh.view != view
                            || !eligible_all_ids.contains(&bmh.target_note_id)
                            || trashed_created_ids.contains(&bmh.target_note_id)
                        {
                            continue;
                        }
                        let target = &bmh.target_note_id;

                        // Remove `target` from whichever working group it currently occupies.
                        for (_, g_items) in &mut working_groups {
                            g_items.retain(|it| &it.note_id != target);
                        }

                        match &bmh.before_placement {
                            StoredSemanticPlacementV1::Ineligible => {
                                target_final_state.insert(target.clone(), None);
                            }
                            StoredSemanticPlacementV1::InGroup {
                                group,
                                predecessor,
                                successor,
                            } => {
                                // Find or create `group` in `working_groups`.
                                let g_idx =
                                    match working_groups.iter().position(|(gk, _)| gk == group) {
                                        Some(idx) => idx,
                                        None => {
                                            working_groups.push((group.clone(), Vec::new()));
                                            working_groups.len() - 1
                                        }
                                    };
                                let g_items = &mut working_groups[g_idx].1;

                                let pred_pos = match predecessor {
                                    Some(pred_id) => Some(
                                        g_items
                                            .iter()
                                            .position(|it| &it.note_id == pred_id)
                                            .ok_or_else(|| {
                                                DomainError::validation(
                                                    ValidationReason::InvalidState,
                                                )
                                            })?,
                                    ),
                                    None => None,
                                };
                                let succ_pos = match successor {
                                    Some(succ_id) => Some(
                                        g_items
                                            .iter()
                                            .position(|it| &it.note_id == succ_id)
                                            .ok_or_else(|| {
                                                DomainError::validation(
                                                    ValidationReason::InvalidState,
                                                )
                                            })?,
                                    ),
                                    None => None,
                                };

                                let ins_idx = match (pred_pos, succ_pos) {
                                    (None, None) => 0,
                                    (None, Some(s)) => s,
                                    (Some(p), None) => p + 1,
                                    (Some(p), Some(s)) => {
                                        if p >= s {
                                            return Err(DomainError::validation(
                                                ValidationReason::InvalidState,
                                            )
                                            .into());
                                        }
                                        p + 1
                                    }
                                };

                                let computed = compute_rank_placement(g_items, target, ins_idx)?;
                                for (pn, pr) in computed.pma_neighbor_updates {
                                    if let Some(it) = g_items.iter_mut().find(|i| i.note_id == pn) {
                                        it.rank = pr.clone();
                                    }
                                    if let Some(Some((_, tr_rank, _))) =
                                        target_final_state.get_mut(&pn)
                                    {
                                        *tr_rank = pr;
                                    } else if !eligible_all_ids.contains(&pn) {
                                        neighbor_dirty.insert(pn, (group.clone(), pr, true));
                                    }
                                }
                                g_items.insert(
                                    ins_idx,
                                    ExistingRankedItem {
                                        note_id: target.clone(),
                                        rank: computed.target_rank.clone(),
                                    },
                                );
                                target_final_state.insert(
                                    target.clone(),
                                    Some((
                                        group.clone(),
                                        computed.target_rank,
                                        bmh.before_placement_revision.clone(),
                                    )),
                                );
                            }
                        }
                    }

                    // Verify final replayed membership for every replayed target matches `post_restore_membership`!
                    for (target, final_opt) in target_final_state {
                        let expected_post = view_facts
                            .post_restore_membership
                            .get(&target)
                            .cloned()
                            .unwrap_or(None);
                        match (final_opt, expected_post) {
                            (None, None) => {
                                if overlays.contains_key(&target) {
                                    planned_overlay_deletes.push(PlannedOverlayDelete {
                                        view: view.clone(),
                                        target_note: target,
                                    });
                                }
                            }
                            (Some((grp, rnk, prev_pl_rev)), Some(post_grp)) if grp == post_grp => {
                                planned_target_restores.push(PlannedTargetRankRestore {
                                    view: view.clone(),
                                    target_note: target,
                                    group: grp,
                                    rank: rnk,
                                    restored_placement_revision: prev_pl_rev,
                                });
                            }
                            _ => {
                                return Err(DomainError::validation(
                                    ValidationReason::InvalidState,
                                )
                                .into());
                            }
                        }
                    }

                    for (nbr_id, (grp, rnk, is_pma)) in neighbor_dirty {
                        planned_neighbor_updates.push(PlannedNeighborRankUpdate {
                            view: view.clone(),
                            neighbor_note: nbr_id,
                            group: grp,
                            rank: rnk,
                            is_pma,
                        });
                    }

                    preloaded_view_overlays.insert(view.clone(), overlays);
                }
            }

            // 5. Count exact SpaceSeq allocations before executing SQL mutations.
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
            // A normalization must not recreate a rank whose view or card is being retired.
            planned_neighbor_updates.retain(|update| {
                !rank_removal::removes_view_or_target(
                    &eligible_notes,
                    &update.view,
                    &update.neighbor_note,
                )
            });
            planned_target_restores.retain(|restore| {
                !rank_removal::removes_view_or_target(
                    &eligible_notes,
                    &restore.view,
                    &restore.target_note,
                )
            });
            let rank_removals = if has_any_overlays_in_space_tx(tx, &scope_cl.space_id).await? {
                rank_removal::plan_tx(
                    tx,
                    &scope_cl.space_id,
                    &eligible_notes,
                    &planned_overlay_deletes,
                )
                .await?
            } else {
                Vec::new()
            };
            let entity_event_seqs = trash_note_count
                + restore_note_count
                + (rank_removals.len() as u64)
                + (planned_neighbor_updates.len() as u64)
                + (planned_target_restores.len() as u64);
            let total_seqs = entity_event_seqs.max(1);
            let (first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
            let vis_i64 = visibility_seq.get() as i64;
            let now_ts = now_utc_timestamp()?;
            let (sec, nsec) = encode_timestamp_parts(now_ts);
            let current_schema = load_current_space_schema_tx(tx, &scope_cl.space_id).await?;

            let mut events = Vec::with_capacity(total_seqs as usize);
            let mut trashed_out = Vec::new();
            let mut restored_out = Vec::new();
            let mut restored_ranks_out = Vec::new();
            let mut owner_notes_for_receipt: BTreeSet<NoteId> = BTreeSet::new();
            let mut pending_blob_rebinds: Vec<ExistingBlobRefItem> =
                Vec::with_capacity(eligible_notes.len());
            struct PendingRevRow {
                rev_id: RevisionId,
                entity_key: String,
                space_seq: SpaceSeq,
                parent_rev_id: RevisionId,
                restored_from_rev_id: Option<RevisionId>,
                content_blake3: Option<ContentDigest>,
                metadata_msgpack: Vec<u8>,
            }
            let mut pending_rev_rows: Vec<PendingRevRow> = Vec::with_capacity(eligible_notes.len());
            let mut pending_trash_heads: Vec<(NoteId, RevisionId)> =
                Vec::with_capacity(trash_note_count as usize);

            // 6a. Trash run-created eligible notes first.
            for (nid, action) in &eligible_notes {
                let CandidateAction::TrashCreated {
                    metadata,
                    current_rev,
                    current_lifecycle,
                    doc_class,
                    parent_folder_id,
                    content_digest,
                    ..
                } = action
                else {
                    continue;
                };

                owner_notes_for_receipt.insert(nid.clone());

                if *current_lifecycle == Lifecycle::Trashed {
                    trashed_out.push(NoteRevision {
                        note: nid.clone(),
                        revision: current_rev.clone(),
                    });
                    continue;
                }

                let tseq = item_ctx.alloc_next_seq()?;
                let trev = new_revision_id()?;
                let anc = folder_cache
                    .load_ancestry_tx(tx, &scope_cl.space_id, parent_folder_id, false)
                    .await?;

                pending_trash_heads.push((nid.clone(), trev.clone()));
                if collab_states.contains_key(nid) {
                    bump_closed_collab_session_lineage_tx(
                        tx,
                        &scope_cl.space_id,
                        nid,
                        &trev,
                        vis_i64,
                    )
                    .await?;
                }

                if let Some(digest) = *content_digest {
                    pending_blob_rebinds.push(ExistingBlobRefItem {
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: nid.as_str().to_owned(),
                        owner_rev_id: trev.as_str().to_owned(),
                        resource_key: "carrier",
                        digest,
                        created_seq: tseq,
                    });
                }

                let meta = encode_rollback_note(
                    metadata,
                    None,
                    anc.is_root_child,
                    RollbackRevision::Trash,
                )?;

                pending_rev_rows.push(PendingRevRow {
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

            update_note_heads_trashed_batch_tx(
                tx,
                &scope_cl.space_id,
                &pending_trash_heads,
                vis_i64,
                sec,
                nsec,
                auth.principal().as_str(),
            )
            .await?;

            // 6b. Restore pre-existing eligible notes (`restored_from_rev_id = Some(pre_rev_id)`).
            let mut pending_restore_heads: Vec<RestoredHeadUpdateItem<'_>> =
                Vec::with_capacity(restore_note_count as usize);

            for (nid, action) in &eligible_notes {
                let CandidateAction::RestorePreExisting {
                    current_rev,
                    pre_rev_id,
                    pre_meta,
                    needs_note_mutation,
                    ..
                } = action
                else {
                    continue;
                };
                owner_notes_for_receipt.insert(nid.clone());

                if !*needs_note_mutation {
                    continue;
                }

                let rseq = item_ctx.alloc_next_seq()?;
                let rrev = new_revision_id()?;
                let is_root_child = restored_ancestries.get(nid).copied().unwrap_or(false);

                if let Some(digest) = pre_meta.content_digest {
                    pending_blob_rebinds.push(ExistingBlobRefItem {
                        owner_kind: BlobOwnerKind::NoteRevision,
                        owner_id: nid.as_str().to_owned(),
                        owner_rev_id: rrev.as_str().to_owned(),
                        resource_key: "carrier",
                        digest,
                        created_seq: rseq,
                    });
                }

                let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
                    normalize_title_key(&pre_meta.slug)
                } else {
                    normalize_title_key(&pre_meta.title)
                };

                pending_restore_heads.push(RestoredHeadUpdateItem {
                    note_id: nid,
                    parent_folder_id: &pre_meta.parent_folder_id,
                    slug: &pre_meta.slug,
                    slug_fold: &pre_meta.slug_fold,
                    title: &pre_meta.title,
                    title_fold,
                    doc_class_str: doc_class_to_db(pre_meta.doc_class),
                    ability_id_str: pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                    rev_id: rrev.clone(),
                    content_digest: pre_meta.content_digest,
                    byte_size: pre_meta.byte_size,
                    lifecycle_str: lifecycle_to_db(pre_meta.lifecycle),
                    visibility_mask: pre_meta.visibility_mask,
                });

                if collab_states.contains_key(nid) {
                    bump_closed_collab_session_lineage_tx(
                        tx,
                        &scope_cl.space_id,
                        nid,
                        &rrev,
                        vis_i64,
                    )
                    .await?;
                }

                let meta = encode_rollback_note(
                    pre_meta,
                    None,
                    is_root_child,
                    RollbackRevision::Restore(current_schema.as_ref()),
                )?;

                pending_rev_rows.push(PendingRevRow {
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

            update_note_heads_restored_batch_tx(
                tx,
                &scope_cl.space_id,
                &pending_restore_heads,
                vis_i64,
                sec,
                nsec,
                auth.principal().as_str(),
            )
            .await?;
            bind_existing_active_blob_refs_batch_tx(tx, &scope_cl.space_id, &pending_blob_rebinds)
                .await?;

            if !pending_rev_rows.is_empty() {
                let rev_items: Vec<RevisionInsertItem<'_>> = pending_rev_rows
                    .iter()
                    .map(|r| RevisionInsertItem {
                        rev_id: &r.rev_id,
                        entity_type: "note",
                        entity_key: &r.entity_key,
                        space_seq: r.space_seq,
                        visibility_seq,
                        parent_rev_id: Some(&r.parent_rev_id),
                        restored_from_rev_id: r.restored_from_rev_id.as_ref(),
                        content_blake3: r.content_blake3,
                        metadata_msgpack: &r.metadata_msgpack,
                        actor_id: auth.principal(),
                        agent_run_id: None,
                        created_at: now_ts,
                    })
                    .collect();
                insert_revision_rows_batch_tx(tx, &scope_cl, &rev_items).await?;
            }

            // 6c. Apply planned board overlay deletes, neighbor normalizations, and target restores.
            for removal in rank_removals {
                let seq = item_ctx.alloc_next_seq()?;
                let revision = new_revision_id()?;
                removal
                    .write_tx(
                        tx,
                        &scope_cl,
                        seq,
                        visibility_seq,
                        &revision,
                        auth.principal(),
                        now_ts,
                    )
                    .await?;
                owner_notes_for_receipt.extend(removal.owners().into_iter().cloned());
                events.push(removal.event(seq, revision));
            }

            for nbr in &planned_neighbor_updates {
                let nseq = item_ctx.alloc_next_seq()?;
                let nrev = new_revision_id()?;
                let existing_ov = preloaded_view_overlays
                    .get(&nbr.view)
                    .and_then(|m| m.get(&nbr.neighbor_note));
                let (pl_rev, pl_actor, pl_run) = match existing_ov {
                    Some(ov) => (
                        ov.placement_revision.clone(),
                        ov.placement_actor_id.clone(),
                        ov.placement_run_id.clone(),
                    ),
                    None => (nrev.clone(), auth.principal().clone(), None),
                };
                upsert_overlay_and_rank_revision_tx(
                    tx,
                    &scope_cl,
                    &nbr.view,
                    &nbr.neighbor_note,
                    &nbr.group,
                    &nbr.rank,
                    &nrev,
                    existing_ov.map(|o| &o.rank_rev_id),
                    &pl_rev,
                    &pl_actor,
                    pl_run.as_ref(),
                    auth.principal(),
                    None,
                    nbr.is_pma,
                    nseq,
                    visibility_seq,
                    now_ts,
                )
                .await?;
                events.push(BatchEventDraft {
                    space_seq: nseq,
                    entity_type: "note".to_owned(),
                    entity_id: nbr.neighbor_note.as_str().to_owned(),
                    op_kind: "move".to_owned(),
                    rev_id: nrev,
                    lifecycle: Lifecycle::Active,
                    doc_class: None,
                });
            }

            for tr in planned_target_restores {
                let tseq = item_ctx.alloc_next_seq()?;
                let trev = new_revision_id()?;
                let pl_rev = tr
                    .restored_placement_revision
                    .unwrap_or_else(|| trev.clone());
                let existing_ov = preloaded_view_overlays
                    .get(&tr.view)
                    .and_then(|m| m.get(&tr.target_note));
                owner_notes_for_receipt.insert(tr.view.note.clone());

                upsert_overlay_and_rank_revision_tx(
                    tx,
                    &scope_cl,
                    &tr.view,
                    &tr.target_note,
                    &tr.group,
                    &tr.rank,
                    &trev,
                    existing_ov.map(|o| &o.rank_rev_id),
                    &pl_rev,
                    auth.principal(),
                    None,
                    auth.principal(),
                    None,
                    false,
                    tseq,
                    visibility_seq,
                    now_ts,
                )
                .await?;
                events.push(BatchEventDraft {
                    space_seq: tseq,
                    entity_type: "note".to_owned(),
                    entity_id: tr.target_note.as_str().to_owned(),
                    op_kind: "restore".to_owned(),
                    rev_id: trev.clone(),
                    lifecycle: Lifecycle::Active,
                    doc_class: None,
                });
                restored_ranks_out.push(RestoredBoardRank {
                    view: tr.view,
                    note: tr.target_note,
                    group: tr.group,
                    rank: tr.rank,
                    rank_revision: trev,
                    placement_revision: pl_rev,
                });
            }

            // 6d. Bump `agent_run_heads` so re-running the same rollback without fresh preconditions conflicts.
            let new_run_rev = upsert_agent_run_head_tx(
                tx,
                &scope_cl,
                &input.run,
                auth.principal(),
                visibility_seq,
                visibility_seq,
                now_ts,
            )
            .await?;
            if events.is_empty() {
                let noop_seq = item_ctx.alloc_next_seq()?;
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

            // 6e. Build `AwaitProjection { Bulk }` effect + receipt.
            let owner_vec: Vec<NoteId> = owner_notes_for_receipt.into_iter().collect();
            let cmd_range = notarium_core::ports::CommandSeqRange::new(first_seq, visibility_seq)?;
            let effect_draft = build_effect_payload_draft(
                new_prefixed_hex_id("pay_")?,
                scope_cl.clone(),
                cmd_range,
                "rollback_agent_run",
                EffectBodyV1::AwaitProjection {
                    reason: StoredAwaitReasonV1::Bulk,
                },
                owner_vec.clone(),
            )?;
            let receipt_token = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
            let wire = StoredCommittedRollbackV1 {
                restored: restored_out,
                trashed: trashed_out,
                restored_ranks: restored_ranks_out,
                skipped_manual_edits: skipped_manual_cl.clone(),
                skipped_room_active: skipped_room_cl.clone(),
                receipt: receipt_token,
            };
            let resp_bytes = encode_msgpack(&wire)?;
            let sanitized = encode_msgpack(&StoredCommittedRollbackV1 {
                restored: Vec::new(),
                trashed: Vec::new(),
                restored_ranks: Vec::new(),
                skipped_manual_edits: skipped_manual_cl,
                skipped_room_active: skipped_room_cl,
                receipt: MutationReceiptToken::new(scope_cl, visibility_seq)?,
            })?;

            Ok(ItemCommitArtifacts {
                command_id: new_prefixed_hex_id("cmd_")?,
                command_kind: "rollback_agent_run".to_owned(),
                events,
                change_payload: Some(effect_draft),
                receipt_detail_blob: Some(resp_bytes.clone()),
                receipt_sanitized_blob: sanitized,
                receipt_owner_note_ids: owner_vec,
                response_bytes: resp_bytes,
            })
        })
    })
}

#[allow(clippy::type_complexity)]
// The current head is authorized when verifying the run's expected entities. The
// restored revision can name a different folder, document class, or ability.
async fn authorize_rollback_destination_tx(
    tx: &mut BackendConn<'_>,
    cache: &mut FolderAncestryCache,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    meta: &NoteRevisionMetadata,
) -> Result<crate::domain::common::FolderAncestryFacts, PortError> {
    let (after, anc) = cache
        .build_resource_facts_tx(
            tx,
            space,
            &meta.parent_folder_id,
            meta.doc_class,
            meta.ability_id.clone(),
            meta.lifecycle == Lifecycle::Active,
        )
        .await?;
    auth.authorize_direct_write(&after, &after)?;
    Ok(anc)
}

async fn discover_rollback_state_tx(
    tx: &mut BackendConn<'_>,
    ctx: &SpaceContext,
    input: &RollbackAgentRun,
) -> Result<
    (
        crate::runtime::SpaceRecord,
        Vec<NoteId>,
        BTreeMap<NoteId, CandidateAction>,
        BTreeSet<NoteId>,
        Vec<RunBoardMoveRow>,
    ),
    PortError,
> {
    let srec = load_space_record(tx, &ctx.scope().space_id).await?;
    srec.scope.check(ctx.scope())?;

    let mut folder_cache = FolderAncestryCache::default();
    let (mut heads_map, run_moves) = verify_run_and_entity_preconditions_tx(
        tx,
        &srec.scope,
        &srec.space,
        ctx.auth(),
        input,
        &mut folder_cache,
    )
    .await?;

    let touched_notes: Vec<NoteId> = input
        .expected_entities
        .iter()
        .map(|e| e.note.clone())
        .collect();
    let mut touched_sorted = touched_notes;
    touched_sorted.sort();
    touched_sorted.dedup();

    let mut rev_histories =
        load_notes_revision_histories_batch_tx(tx, &srec.scope.space_id, &touched_sorted).await?;
    let space_has_bmh =
        !run_moves.is_empty() || has_any_board_moves_in_space_tx(tx, &srec.scope.space_id).await?;
    let collab_states = load_space_collab_states_tx(tx, &srec.scope.space_id).await?;

    let mut skipped_manual_edits = Vec::new();
    let mut candidates = BTreeMap::new();
    let mut durable_active_rooms = BTreeSet::new();

    for nid in touched_sorted {
        let head = heads_map
            .remove(&nid)
            .ok_or(DomainError::ResourceNotFound)?;
        let note_revs = rev_histories.remove(&nid).unwrap_or_default();
        let target_bmh = if space_has_bmh {
            load_target_board_move_runs_tx(tx, &srec.scope.space_id, &nid).await?
        } else {
            Vec::new()
        };

        let earliest_note_touch = note_revs
            .iter()
            .filter(|r| r.3.as_ref() == Some(&input.run))
            .map(|r| r.1)
            .min();
        let earliest_bmh_touch = target_bmh
            .iter()
            .filter(|m| m.1.as_ref() == Some(&input.run))
            .map(|m| m.0)
            .min();

        let first_run_seq = match (earliest_note_touch, earliest_bmh_touch) {
            (Some(a), Some(b)) => a.min(b),
            (Some(a), None) => a,
            (None, Some(b)) => b,
            (None, None) => {
                return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
            }
        };

        let has_foreign_note_edit = note_revs
            .iter()
            .any(|r| r.1 > first_run_seq && r.3.as_ref() != Some(&input.run));
        let has_foreign_board_move = target_bmh
            .iter()
            .any(|m| m.0 > first_run_seq && m.1.as_ref() != Some(&input.run));

        if has_foreign_note_edit || has_foreign_board_move {
            skipped_manual_edits.push(nid);
            continue;
        }

        if collab_states.get(&nid) == Some(&true) {
            durable_active_rooms.insert(nid.clone());
        }

        let pre_rev_opt = note_revs
            .iter()
            .filter(|r| r.1 < first_run_seq)
            .max_by_key(|r| r.1);

        match pre_rev_opt {
            None => {
                candidates.insert(
                    nid.clone(),
                    CandidateAction::TrashCreated {
                        metadata: current_rollback_metadata(&note_revs, &head.head_rev_id, &nid)?,
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
            }
            Some((pre_rev_id, _, meta_bytes, _)) => {
                let pre_meta = decode_rollback_note(meta_bytes, &nid)?;
                authorize_rollback_destination_tx(
                    tx,
                    &mut folder_cache,
                    &srec.space,
                    ctx.auth(),
                    &pre_meta,
                )
                .await?;
                let head_unchanged_placement = head.lifecycle == pre_meta.lifecycle
                    && head.parent_folder_id == pre_meta.parent_folder_id
                    && head.slug == pre_meta.slug
                    && head.slug_fold == pre_meta.slug_fold;
                let needs_note_mutation =
                    head.head_rev_id != *pre_rev_id || !head_unchanged_placement;
                candidates.insert(
                    nid,
                    CandidateAction::RestorePreExisting {
                        current_rev: head.head_rev_id,
                        pre_rev_id: pre_rev_id.clone(),
                        pre_meta: Box::new(pre_meta),
                        pre_carrier: None,
                        needs_note_mutation,
                        head_unchanged_placement,
                    },
                );
            }
        }
    }

    Ok((
        srec,
        skipped_manual_edits,
        candidates,
        durable_active_rooms,
        run_moves,
    ))
}

pub(crate) fn verify_authorized_rollback_revisions<'a>(
    actual_run: RevisionId,
    input: &RollbackAgentRun,
    current_head: impl Fn(&NoteId) -> Option<&'a RevisionId>,
) -> Result<(), PortError> {
    if actual_run != input.expected_run_revision {
        return Err(DomainError::RevisionConflict {
            current: actual_run,
            lineage: None,
        }
        .into());
    }
    for expected in &input.expected_entities {
        let current = current_head(&expected.note).ok_or(DomainError::ResourceNotFound)?;
        if current != &expected.revision {
            return Err(DomainError::RevisionConflict {
                current: current.clone(),
                lineage: None,
            }
            .into());
        }
    }
    Ok(())
}

async fn verify_run_and_entity_preconditions_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    input: &RollbackAgentRun,
    folder_cache: &mut FolderAncestryCache,
) -> Result<(BTreeMap<NoteId, NoteHeadRow>, Vec<RunBoardMoveRow>), PortError> {
    auth.authorize_space_write(space)?;
    for view in input
        .associated_board_expectations
        .iter()
        .map(|entry| &entry.view.note)
        .collect::<BTreeSet<_>>()
    {
        super::board::authorized_view_head(tx, space, auth, view).await?;
    }
    let run_row: Option<(Vec<u8>, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT history_incarnation, run_revision FROM agent_run_heads
                 WHERE space_id = ? AND run_id = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(input.run.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_run_head", err.to_string()))?;
            row.map(|r| (r.get("history_incarnation"), r.get("run_revision")))
        }
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                "SELECT history_incarnation, run_revision FROM agent_run_heads
                 WHERE space_id = $1 AND run_id = $2",
            )
            .bind(scope.space_id.as_str())
            .bind(input.run.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_run_head", err))?;
            row.map(|r| (r.get("history_incarnation"), r.get("run_revision")))
        }
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

    // Discover full touched set of notes in `revisions` UNION `board_move_history`.
    let mut touched_set: BTreeSet<NoteId> = BTreeSet::new();
    for nid in load_run_touched_notes_tx(tx, &scope.space_id, &input.run).await? {
        touched_set.insert(nid);
    }

    let purged_notes = load_space_purged_notes_tx(tx, &scope.space_id).await?;
    let mut caller_notes: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for exp in &input.expected_entities {
        if purged_notes.contains_key(exp.note.as_str()) {
            return Err(DomainError::ResourceNotFound.into());
        }
        if caller_notes
            .insert(exp.note.clone(), exp.revision.clone())
            .is_some()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    }

    let caller_set: BTreeSet<NoteId> = caller_notes.keys().cloned().collect();
    if caller_set != touched_set {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }

    let caller_note_vec: Vec<NoteId> = caller_notes.keys().cloned().collect();
    let heads_map = load_note_heads_batch_tx(tx, &scope.space_id, &caller_note_vec).await?;

    for nid in caller_notes.keys() {
        let head = heads_map.get(nid).ok_or(DomainError::ResourceNotFound)?;
        let (rfacts, _) = folder_cache
            .build_resource_facts_tx(
                tx,
                space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                false,
            )
            .await?;
        auth.authorize_direct_write(&rfacts, &rfacts)?;
    }

    // Verify `associated_board_expectations` covers all `(view, target_note)` pairs in `board_move_history` for this run.
    let run_moves = load_run_board_moves_tx(tx, &scope.space_id, &input.run).await?;
    let mut required_pairs: BTreeSet<(ViewRef, NoteId)> = BTreeSet::new();
    for m in &run_moves {
        required_pairs.insert((m.view.clone(), m.target_note_id.clone()));
    }

    let mut caller_pairs: BTreeMap<(ViewRef, NoteId), &AssociatedBoardExpectation> =
        BTreeMap::new();
    for assoc in &input.associated_board_expectations {
        if caller_pairs
            .insert((assoc.view.clone(), assoc.note.clone()), assoc)
            .is_some()
        {
            return Err(DomainError::validation(ValidationReason::InvalidState).into());
        }
    }
    let caller_pair_keys: BTreeSet<(ViewRef, NoteId)> = caller_pairs.keys().cloned().collect();
    if caller_pair_keys != required_pairs {
        return Err(DomainError::validation(ValidationReason::SourceMismatch).into());
    }

    verify_authorized_rollback_revisions(actual_run_rev, input, |nid| {
        heads_map.get(nid).map(|head| &head.head_rev_id)
    })?;

    for ((view, nid), assoc) in caller_pairs {
        let fallback_rev = caller_notes
            .get(&nid)
            .cloned()
            .unwrap_or(input.expected_run_revision.clone());
        let ov_opt = load_overlay_row_opt_tx(tx, &scope.space_id, &view, &nid).await?;
        verify_rank_expectation(&assoc.expected_rank, ov_opt.as_ref(), &fallback_rev)?;
        if let Some(ov) = ov_opt
            && ov.placement_revision != assoc.expected_placement_revision
        {
            return Err(DomainError::RevisionConflict {
                current: ov.placement_revision,
                lineage: None,
            }
            .into());
        }
    }

    Ok((heads_map, run_moves))
}

async fn load_run_touched_notes_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    run_id: &AgentRunId,
) -> Result<Vec<NoteId>, PortError> {
    let raw_ids: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let rows = sqlx::query(
                "SELECT DISTINCT entity_key AS nid FROM revisions
                 WHERE space_id = ? AND agent_run_id = ? AND entity_type = 'note'
                 UNION
                 SELECT DISTINCT target_note_id AS nid FROM board_move_history
                 WHERE space_id = ? AND agent_run_id = ?",
            )
            .bind(space_id.as_str())
            .bind(run_id.as_str())
            .bind(space_id.as_str())
            .bind(run_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_run_touched_notes", err.to_string()))?;
            rows.into_iter().map(|r| r.get("nid")).collect()
        }
        BackendConn::Postgres(conn) => {
            let rows = sqlx::query(
                "SELECT DISTINCT entity_key AS nid FROM revisions
                 WHERE space_id = $1 AND agent_run_id = $2 AND entity_type = 'note'
                 UNION
                 SELECT DISTINCT target_note_id AS nid FROM board_move_history
                 WHERE space_id = $1 AND agent_run_id = $2",
            )
            .bind(space_id.as_str())
            .bind(run_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_run_touched_notes", err))?;
            rows.into_iter().map(|r| r.get("nid")).collect()
        }
    };

    let mut out = Vec::with_capacity(raw_ids.len());
    for raw in raw_ids {
        let nid = NoteId::parse(&raw)
            .map_err(|_| internal_not_committed("corrupt_touched_note_id", "invalid NoteId"))?;
        out.push(nid);
    }
    Ok(out)
}

type RawRunBoardMoveTuple = (i64, i32, String, String, String, Option<String>, Vec<u8>);

async fn load_run_board_moves_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    run_id: &AgentRunId,
) -> Result<Vec<RunBoardMoveRow>, PortError> {
    let rows: Vec<RawRunBoardMoveTuple> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched = sqlx::query(
                "SELECT command_end_seq, ordinal, view_note_id, view_key, target_note_id,
                        before_placement_revision, before_placement_msgpack
                 FROM board_move_history
                 WHERE space_id = ? AND agent_run_id = ?
                 ORDER BY command_end_seq DESC, ordinal DESC",
            )
            .bind(space_id.as_str())
            .bind(run_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_run_bmh", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("command_end_seq"),
                        r.get::<i64, _>("ordinal") as i32,
                        r.get("view_note_id"),
                        r.get("view_key"),
                        r.get("target_note_id"),
                        r.get("before_placement_revision"),
                        r.get("before_placement_msgpack"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT command_end_seq, ordinal, view_note_id, view_key, target_note_id,
                        before_placement_revision, before_placement_msgpack
                 FROM board_move_history
                 WHERE space_id = $1 AND agent_run_id = $2
                 ORDER BY command_end_seq DESC, ordinal DESC",
            )
            .bind(space_id.as_str())
            .bind(run_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_run_bmh", err))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("command_end_seq"),
                        r.get("ordinal"),
                        r.get("view_note_id"),
                        r.get("view_key"),
                        r.get("target_note_id"),
                        r.get("before_placement_revision"),
                        r.get("before_placement_msgpack"),
                    )
                })
                .collect()
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for (end_seq_raw, ord, vnote_raw, vkey_raw, tnote_raw, bprev_raw, bp_bytes) in rows {
        let command_end_seq = i64_to_space_seq(end_seq_raw)?;
        let vnote = NoteId::parse(&vnote_raw)
            .map_err(|_| internal_not_committed("corrupt_bmh_view_note", "invalid NoteId"))?;
        let vkey = notarium_core::ids::ViewKey::parse(&vkey_raw)
            .map_err(|_| internal_not_committed("corrupt_bmh_view_key", "invalid ViewKey"))?;
        let target_note_id = NoteId::parse(&tnote_raw)
            .map_err(|_| internal_not_committed("corrupt_bmh_target", "invalid NoteId"))?;
        let before_placement_revision =
            match bprev_raw {
                Some(s) => Some(RevisionId::parse(&s).map_err(|_| {
                    internal_not_committed("corrupt_bmh_bprev", "invalid RevisionId")
                })?),
                None => None,
            };
        let before_placement: StoredSemanticPlacementV1 =
            decode_msgpack_bounded(&bp_bytes, MAX_MSGPACK_DECODE_BYTES)?;
        out.push(RunBoardMoveRow {
            command_end_seq,
            ordinal: ord,
            view: ViewRef {
                note: vnote,
                key: vkey,
            },
            target_note_id,
            before_placement_revision,
            before_placement,
        });
    }
    Ok(out)
}

async fn load_target_board_move_runs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Vec<(SpaceSeq, Option<AgentRunId>)>, PortError> {
    let rows: Vec<(i64, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched = sqlx::query(
                "SELECT command_end_seq, agent_run_id FROM board_move_history
                 WHERE space_id = ? AND target_note_id = ?
                 ORDER BY command_end_seq ASC, ordinal ASC",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_target_bmh", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| (r.get("command_end_seq"), r.get("agent_run_id")))
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT command_end_seq, agent_run_id FROM board_move_history
                 WHERE space_id = $1 AND target_note_id = $2
                 ORDER BY command_end_seq ASC, ordinal ASC",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_target_bmh", err))?;
            fetched
                .into_iter()
                .map(|r| (r.get("command_end_seq"), r.get("agent_run_id")))
                .collect()
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for (seq_raw, run_raw) in rows {
        let seq = i64_to_space_seq(seq_raw)?;
        let run = match run_raw {
            Some(s) => Some(
                AgentRunId::parse(&s)
                    .map_err(|_| internal_not_committed("corrupt_bmh_run", "invalid run_id"))?,
            ),
            None => None,
        };
        out.push((seq, run));
    }
    Ok(out)
}

#[allow(clippy::type_complexity)]
async fn load_notes_revision_histories_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_ids: &[NoteId],
) -> Result<BTreeMap<NoteId, Vec<(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)>>, PortError> {
    let mut out: BTreeMap<NoteId, Vec<(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)>> =
        BTreeMap::new();
    if note_ids.is_empty() {
        return Ok(out);
    }
    for chunk in note_ids.chunks(200) {
        let rows: Vec<(String, String, i64, Vec<u8>, Option<String>)> = match tx {
            BackendConn::Sqlite(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                    "SELECT entity_key, rev_id, space_seq, metadata_msgpack, agent_run_id
                     FROM revisions
                     WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str())
                    .push(" AND entity_type = 'note' AND entity_key IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(") ORDER BY entity_key ASC, space_seq ASC");
                let fetched = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                    internal_not_committed("sqlite_load_note_revs_batch", err.to_string())
                })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("entity_key"),
                            r.get("rev_id"),
                            r.get("space_seq"),
                            r.get("metadata_msgpack"),
                            r.get("agent_run_id"),
                        )
                    })
                    .collect()
            }
            BackendConn::Postgres(conn) => {
                let mut qb = sqlx::QueryBuilder::<sqlx::Postgres>::new(
                    "SELECT entity_key, rev_id, space_seq, metadata_msgpack, agent_run_id
                     FROM revisions
                     WHERE space_id = ",
                );
                qb.push_bind(space_id.as_str())
                    .push(" AND entity_type = 'note' AND entity_key IN (");
                let mut sep = qb.separated(", ");
                for nid in chunk {
                    sep.push_bind(nid.as_str());
                }
                sep.push_unseparated(") ORDER BY entity_key ASC, space_seq ASC");
                let fetched =
                    qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                        crate::runtime::pg_read_error("pg_load_note_revs_batch", err)
                    })?;
                fetched
                    .into_iter()
                    .map(|r| {
                        (
                            r.get("entity_key"),
                            r.get("rev_id"),
                            r.get("space_seq"),
                            r.get("metadata_msgpack"),
                            r.get("agent_run_id"),
                        )
                    })
                    .collect()
            }
        };

        for (nid_raw, rev_raw, seq_raw, meta, run_raw) in rows {
            let nid = NoteId::parse(&nid_raw)
                .map_err(|_| internal_not_committed("corrupt_rev_nid", "invalid note_id"))?;
            let rev = RevisionId::parse(&rev_raw)
                .map_err(|_| internal_not_committed("corrupt_rev_id", "invalid rev_id"))?;
            let seq = i64_to_space_seq(seq_raw)?;
            let run = match run_raw {
                Some(s) => Some(
                    AgentRunId::parse(&s)
                        .map_err(|_| internal_not_committed("corrupt_rev_run", "invalid run_id"))?,
                ),
                None => None,
            };
            out.entry(nid).or_default().push((rev, seq, meta, run));
        }
    }
    Ok(out)
}

#[allow(clippy::type_complexity)]
async fn load_revisions_and_run_touched_combined_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    run_id: &AgentRunId,
    caller_notes: &[NoteId],
) -> Result<
    (
        BTreeMap<NoteId, Vec<(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)>>,
        BTreeSet<NoteId>,
    ),
    PortError,
> {
    let mut histories: BTreeMap<NoteId, Vec<(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)>> =
        BTreeMap::new();
    let mut touched_set: BTreeSet<NoteId> = BTreeSet::new();

    let rows: Vec<(String, String, i64, Vec<u8>, Option<String>)> = match tx {
        BackendConn::Postgres(conn) => {
            let note_strs: Vec<&str> = caller_notes.iter().map(NoteId::as_str).collect();
            let fetched = sqlx::query(
                "SELECT entity_key, rev_id, space_seq, metadata_msgpack, agent_run_id
                 FROM revisions
                 WHERE space_id = $1 AND entity_type = 'note'
                   AND (entity_key = ANY($2) OR agent_run_id = $3)",
            )
            .bind(space_id.as_str())
            .bind(note_strs)
            .bind(run_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_note_revs_combined", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("entity_key"),
                        r.get("rev_id"),
                        r.get("space_seq"),
                        r.get("metadata_msgpack"),
                        r.get("agent_run_id"),
                    )
                })
                .collect()
        }
        BackendConn::Sqlite(_) => {
            for nid in load_run_touched_notes_tx(tx, space_id, run_id).await? {
                touched_set.insert(nid);
            }
            let h = load_notes_revision_histories_batch_tx(tx, space_id, caller_notes).await?;
            return Ok((h, touched_set));
        }
    };

    for (nid_raw, rev_raw, seq_raw, meta, run_raw) in rows {
        let nid = NoteId::parse(&nid_raw)
            .map_err(|_| internal_not_committed("corrupt_rev_nid", "invalid note_id"))?;
        let rev = RevisionId::parse(&rev_raw)
            .map_err(|_| internal_not_committed("corrupt_rev_id", "invalid rev_id"))?;
        let seq = i64_to_space_seq(seq_raw)?;
        let run = match run_raw {
            Some(s) => {
                let parsed = AgentRunId::parse(&s)
                    .map_err(|_| internal_not_committed("corrupt_rev_run", "invalid run_id"))?;
                if &parsed == run_id {
                    touched_set.insert(nid.clone());
                }
                Some(parsed)
            }
            None => None,
        };
        histories
            .entry(nid)
            .or_default()
            .push((rev, seq, meta, run));
    }
    Ok((histories, touched_set))
}

async fn upsert_agent_run_head_row_only_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    run_rev: &RevisionId,
    last_i64: i64,
    sec: i64,
    nsec: i32,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = excluded.history_incarnation,
                    run_revision = excluded.run_revision,
                    last_seq = excluded.last_seq,
                    updated_at_sec = excluded.updated_at_sec,
                    updated_at_nsec = excluded.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_upsert_agent_run_row", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "INSERT INTO agent_run_heads (
                    space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (space_id, run_id) DO UPDATE SET
                    history_incarnation = EXCLUDED.history_incarnation,
                    run_revision = EXCLUDED.run_revision,
                    last_seq = EXCLUDED.last_seq,
                    updated_at_sec = EXCLUDED.updated_at_sec,
                    updated_at_nsec = EXCLUDED.updated_at_nsec",
            )
            .bind(scope.space_id.as_str())
            .bind(scope.incarnation.as_bytes().as_slice())
            .bind(run_id.as_str())
            .bind(run_rev.as_str())
            .bind(last_i64)
            .bind(sec)
            .bind(nsec)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_upsert_agent_run_row", err.to_string()))?;
        }
    }
    Ok(())
}

async fn load_space_purged_notes_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<HashMap<String, ()>, PortError> {
    let rows: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query_scalar("SELECT note_id FROM revision_purge_fences WHERE space_id = ?")
                .bind(space_id.as_str())
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_load_purged_notes", err.to_string())
                })?
        }
        BackendConn::Postgres(conn) => {
            sqlx::query_scalar("SELECT note_id FROM revision_purge_fences WHERE space_id = $1")
                .bind(space_id.as_str())
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| crate::runtime::pg_read_error("pg_load_purged_notes", err))?
        }
    };
    Ok(rows.into_iter().map(|s| (s, ())).collect())
}

async fn load_space_collab_states_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<HashMap<NoteId, bool>, PortError> {
    let rows: Vec<(String, bool)> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched =
                sqlx::query("SELECT s.note_id, (s.room_state <> 'closed' OR COALESCE(c.carrier_dirty, 0) <> 0
                        OR EXISTS (SELECT 1 FROM collab_update_log u WHERE u.space_id = s.space_id AND u.note_id = s.note_id)) AS blocked
                     FROM collab_sessions s LEFT JOIN collab_checkpoints c USING (space_id, note_id) WHERE s.space_id = ?")
                    .bind(space_id.as_str())
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_collab_states", err.to_string())
                    })?;
            fetched
                .into_iter()
                .map(|r| (r.get("note_id"), r.get("blocked")))
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched =
                sqlx::query("SELECT s.note_id, (s.room_state <> 'closed' OR COALESCE(c.carrier_dirty, 0) <> 0
                        OR EXISTS (SELECT 1 FROM collab_update_log u WHERE u.space_id = s.space_id AND u.note_id = s.note_id)) AS blocked
                     FROM collab_sessions s LEFT JOIN collab_checkpoints c USING (space_id, note_id) WHERE s.space_id = $1")
                    .bind(space_id.as_str())
                    .fetch_all(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_collab_states", err))?;
            fetched
                .into_iter()
                .map(|r| (r.get("note_id"), r.get("blocked")))
                .collect()
        }
    };
    let mut out = HashMap::with_capacity(rows.len());
    for (nid_raw, state) in rows {
        if let Ok(nid) = NoteId::parse(&nid_raw) {
            out.insert(nid, state);
        }
    }
    Ok(out)
}

async fn has_any_board_moves_in_space_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            let found: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM board_move_history WHERE space_id = ? LIMIT 1")
                    .bind(space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("sqlite_has_bmh", err.to_string()))?;
            Ok(found.is_some())
        }
        BackendConn::Postgres(conn) => {
            let found: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM board_move_history WHERE space_id = $1 LIMIT 1")
                    .bind(space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| crate::runtime::pg_read_error("pg_has_bmh", err))?;
            Ok(found.is_some())
        }
    }
}

async fn has_any_overlays_in_space_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
) -> Result<bool, PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            let found: Option<i64> =
                sqlx::query_scalar("SELECT 1 FROM view_rank_overlays WHERE space_id = ? LIMIT 1")
                    .bind(space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_has_overlays", err.to_string())
                    })?;
            Ok(found.is_some())
        }
        BackendConn::Postgres(conn) => {
            let found: Option<i32> =
                sqlx::query_scalar("SELECT 1 FROM view_rank_overlays WHERE space_id = $1 LIMIT 1")
                    .bind(space_id.as_str())
                    .fetch_optional(&mut **conn)
                    .await
                    .map_err(|err| internal_not_committed("pg_has_overlays", err.to_string()))?;
            Ok(found.is_some())
        }
    }
}

async fn verify_no_active_non_eligible_collisions_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    checks: &[(FolderId, String, String, bool)],
    eligible_notes: &BTreeSet<NoteId>,
) -> Result<(), PortError> {
    if checks.is_empty() {
        return Ok(());
    }
    let mut unique_parents: Vec<&str> = checks.iter().map(|(f, _, _, _)| f.as_str()).collect();
    unique_parents.sort_unstable();
    unique_parents.dedup();
    let mut unique_slugs: Vec<&str> = checks.iter().map(|(_, sf, _, _)| sf.as_str()).collect();
    unique_slugs.sort_unstable();
    unique_slugs.dedup();

    let rows: Vec<(String, String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let mut qb = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
                "SELECT parent_folder_id, slug_fold, note_id FROM note_heads
                 WHERE space_id = ",
            );
            qb.push_bind(space_id.as_str())
                .push(" AND lifecycle_state = 'active' AND parent_folder_id IN (");
            let mut psep = qb.separated(", ");
            for p in &unique_parents {
                psep.push_bind(*p);
            }
            psep.push_unseparated(") AND slug_fold IN (");
            let mut ssep = qb.separated(", ");
            for s in &unique_slugs {
                ssep.push_bind(*s);
            }
            ssep.push_unseparated(")");
            let fetched = qb.build().fetch_all(&mut **conn).await.map_err(|err| {
                internal_not_committed("sqlite_rb_slug_check_batch", err.to_string())
            })?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("parent_folder_id"),
                        r.get("slug_fold"),
                        r.get("note_id"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT parent_folder_id, slug_fold, note_id FROM note_heads
                 WHERE space_id = $1 AND lifecycle_state = 'active'
                   AND parent_folder_id = ANY($2) AND slug_fold = ANY($3)",
            )
            .bind(space_id.as_str())
            .bind(&unique_parents)
            .bind(&unique_slugs)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_slug_check_batch", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("parent_folder_id"),
                        r.get("slug_fold"),
                        r.get("note_id"),
                    )
                })
                .collect()
        }
    };

    let mut non_eligible_occupants: HashMap<(String, String), ()> = HashMap::new();
    for (p_raw, sf, nid_raw) in rows {
        let nid = NoteId::parse(&nid_raw)
            .map_err(|_| internal_not_committed("corrupt_collision_nid", "invalid NoteId"))?;
        if !eligible_notes.contains(&nid) {
            non_eligible_occupants.insert((p_raw, sf), ());
        }
    }

    for (parent_id, slug_fold, slug, is_root_child) in checks {
        if non_eligible_occupants.contains_key(&(parent_id.as_str().to_owned(), slug_fold.clone()))
        {
            return Err(DomainError::PathConflict {
                target: PathTarget {
                    space_id: space_id.clone(),
                    parent: if *is_root_child {
                        None
                    } else {
                        Some(parent_id.clone())
                    },
                    component: slug.clone(),
                },
            }
            .into());
        }
    }
    Ok(())
}

struct RestoredHeadUpdateItem<'a> {
    note_id: &'a NoteId,
    parent_folder_id: &'a FolderId,
    slug: &'a str,
    slug_fold: &'a str,
    title: &'a str,
    title_fold: String,
    doc_class_str: &'static str,
    ability_id_str: Option<&'a str>,
    rev_id: RevisionId,
    content_digest: Option<ContentDigest>,
    byte_size: u64,
    lifecycle_str: &'static str,
    visibility_mask: i32,
}

async fn update_note_heads_trashed_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    items: &[(NoteId, RevisionId)],
    vis_seq: i64,
    sec: i64,
    nsec: i32,
    actor_str: &str,
) -> Result<(), PortError> {
    if items.is_empty() {
        return Ok(());
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            for (note_id, rev_id) in items {
                sqlx::query(
                    "UPDATE note_heads
                     SET head_rev_id = ?, lifecycle_state = 'trashed', updated_seq = ?,
                         updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                     WHERE space_id = ? AND note_id = ?",
                )
                .bind(rev_id.as_str())
                .bind(vis_seq)
                .bind(sec)
                .bind(nsec)
                .bind(actor_str)
                .bind(space_id.as_str())
                .bind(note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_rb_trash_head", err.to_string()))?;
            }
        }
        BackendConn::Postgres(conn) => {
            let note_ids: Vec<&str> = items.iter().map(|(n, _)| n.as_str()).collect();
            let rev_ids: Vec<&str> = items.iter().map(|(_, r)| r.as_str()).collect();
            sqlx::query(
                "UPDATE note_heads AS nh
                 SET head_rev_id = v.head_rev_id, lifecycle_state = 'trashed',
                     updated_seq = $2, updated_at_sec = $3, updated_at_nsec = $4,
                     last_actor_id = $5
                 FROM UNNEST($6::TEXT[], $7::TEXT[]) AS v(note_id, head_rev_id)
                 WHERE nh.space_id = $1 AND nh.note_id = v.note_id",
            )
            .bind(space_id.as_str())
            .bind(vis_seq)
            .bind(sec)
            .bind(nsec)
            .bind(actor_str)
            .bind(note_ids)
            .bind(rev_ids)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_trash_head_batch", err.to_string()))?;
        }
    }
    Ok(())
}

async fn update_note_heads_restored_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    items: &[RestoredHeadUpdateItem<'_>],
    vis_seq: i64,
    sec: i64,
    nsec: i32,
    actor_str: &str,
) -> Result<(), PortError> {
    if items.is_empty() {
        return Ok(());
    }
    match tx {
        BackendConn::Sqlite(conn) => {
            for it in items {
                let digest_slice = it.content_digest.as_ref().map(|d| d.as_bytes().as_slice());
                sqlx::query(
                    "UPDATE note_heads
                     SET parent_folder_id = ?, slug = ?, slug_fold = ?, title = ?, title_fold = ?,
                         doc_class = ?, ability_id = ?, head_rev_id = ?, content_blake3 = ?,
                         byte_size = ?, lifecycle_state = ?, visibility_mask = ?,
                         updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                     WHERE space_id = ? AND note_id = ?",
                )
                .bind(it.parent_folder_id.as_str())
                .bind(it.slug)
                .bind(it.slug_fold)
                .bind(it.title)
                .bind(&it.title_fold)
                .bind(it.doc_class_str)
                .bind(it.ability_id_str)
                .bind(it.rev_id.as_str())
                .bind(digest_slice)
                .bind(it.byte_size as i64)
                .bind(it.lifecycle_str)
                .bind(i64::from(it.visibility_mask))
                .bind(vis_seq)
                .bind(sec)
                .bind(nsec)
                .bind(actor_str)
                .bind(space_id.as_str())
                .bind(it.note_id.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("sqlite_rb_restore_head", err.to_string()))?;
            }
        }
        BackendConn::Postgres(conn) => {
            let note_ids: Vec<&str> = items.iter().map(|i| i.note_id.as_str()).collect();
            let parents: Vec<&str> = items.iter().map(|i| i.parent_folder_id.as_str()).collect();
            let slugs: Vec<&str> = items.iter().map(|i| i.slug).collect();
            let slug_folds: Vec<&str> = items.iter().map(|i| i.slug_fold).collect();
            let titles: Vec<&str> = items.iter().map(|i| i.title).collect();
            let title_folds: Vec<&str> = items.iter().map(|i| i.title_fold.as_str()).collect();
            let doc_classes: Vec<&str> = items.iter().map(|i| i.doc_class_str).collect();
            let abilities: Vec<Option<&str>> = items.iter().map(|i| i.ability_id_str).collect();
            let rev_ids: Vec<&str> = items.iter().map(|i| i.rev_id.as_str()).collect();
            let digests: Vec<Option<Vec<u8>>> = items
                .iter()
                .map(|i| i.content_digest.map(|d| d.as_bytes().to_vec()))
                .collect();
            let byte_sizes: Vec<i64> = items.iter().map(|i| i.byte_size as i64).collect();
            let lifecycles: Vec<&str> = items.iter().map(|i| i.lifecycle_str).collect();
            let vis_masks: Vec<i32> = items.iter().map(|i| i.visibility_mask).collect();

            sqlx::query(
                "UPDATE note_heads AS nh
                 SET parent_folder_id = v.parent_folder_id,
                     slug = v.slug,
                     slug_fold = v.slug_fold,
                     title = v.title,
                     title_fold = v.title_fold,
                     doc_class = v.doc_class,
                     ability_id = v.ability_id,
                     head_rev_id = v.head_rev_id,
                     content_blake3 = v.content_blake3,
                     byte_size = v.byte_size,
                     lifecycle_state = v.lifecycle_state,
                     visibility_mask = v.visibility_mask,
                     updated_seq = $2,
                     updated_at_sec = $3,
                     updated_at_nsec = $4,
                     last_actor_id = $5
                 FROM UNNEST(
                     $6::TEXT[], $7::TEXT[], $8::TEXT[], $9::TEXT[], $10::TEXT[],
                     $11::TEXT[], $12::TEXT[], $13::TEXT[], $14::TEXT[], $15::BYTEA[],
                     $16::BIGINT[], $17::TEXT[], $18::INT4[]
                 ) AS v(
                     note_id, parent_folder_id, slug, slug_fold, title,
                     title_fold, doc_class, ability_id, head_rev_id, content_blake3,
                     byte_size, lifecycle_state, visibility_mask
                 )
                 WHERE nh.space_id = $1 AND nh.note_id = v.note_id",
            )
            .bind(space_id.as_str())
            .bind(vis_seq)
            .bind(sec)
            .bind(nsec)
            .bind(actor_str)
            .bind(note_ids)
            .bind(parents)
            .bind(slugs)
            .bind(slug_folds)
            .bind(titles)
            .bind(title_folds)
            .bind(doc_classes)
            .bind(abilities)
            .bind(rev_ids)
            .bind(digests)
            .bind(byte_sizes)
            .bind(lifecycles)
            .bind(vis_masks)
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_restore_head_batch", err.to_string()))?;
        }
    }
    Ok(())
}

async fn bump_closed_collab_session_lineage_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    new_carrier_rev: &RevisionId,
    vis_seq: i64,
) -> Result<(), PortError> {
    let seq = crate::codec::i64_to_space_seq(vis_seq)?;
    crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
        tx,
        space_id,
        note_id,
        new_carrier_rev,
        seq,
    )
    .await
}

async fn verify_collisions_and_load_pg_rebind_pubs_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    checks: &[(FolderId, String, String, bool)],
    eligible_notes: &BTreeSet<NoteId>,
    needed_digests: &BTreeSet<ContentDigest>,
) -> Result<Option<HashMap<ContentDigest, String>>, PortError> {
    let BackendConn::Postgres(conn) = tx else {
        verify_no_active_non_eligible_collisions_batch_tx(tx, space_id, checks, eligible_notes)
            .await?;
        return Ok(None);
    };

    if checks.is_empty() && needed_digests.is_empty() {
        return Ok(Some(HashMap::new()));
    }

    let mut unique_parents: Vec<&str> = checks.iter().map(|(f, _, _, _)| f.as_str()).collect();
    unique_parents.sort_unstable();
    unique_parents.dedup();
    let mut unique_slugs: Vec<&str> = checks.iter().map(|(_, sf, _, _)| sf.as_str()).collect();
    unique_slugs.sort_unstable();
    unique_slugs.dedup();
    let has_checks = !checks.is_empty();
    let digest_slices: Vec<&[u8]> = needed_digests
        .iter()
        .map(|d| d.as_bytes().as_slice())
        .collect();

    let rows = sqlx::query(
        "WITH col AS (
            SELECT parent_folder_id, slug_fold, note_id
            FROM note_heads
            WHERE $4::BOOLEAN
              AND space_id = $1
              AND lifecycle_state = 'active'
              AND parent_folder_id = ANY($2::TEXT[])
              AND slug_fold = ANY($3::TEXT[])
        ),
        cat AS (
            SELECT content_blake3, admission_state, blob_state, current_publication_id
            FROM blob_catalog
            WHERE space_id = $1
              AND content_blake3 = ANY($5::BYTEA[])
        )
        SELECT
            1::INT4 AS kind,
            parent_folder_id, slug_fold, note_id,
            NULL::BYTEA AS content_blake3, NULL::TEXT AS admission_state,
            NULL::TEXT AS blob_state, NULL::TEXT AS current_publication_id
        FROM col
        UNION ALL
        SELECT
            2::INT4 AS kind,
            NULL::TEXT, NULL::TEXT, NULL::TEXT,
            content_blake3, admission_state, blob_state, current_publication_id
        FROM cat",
    )
    .bind(space_id.as_str())
    .bind(&unique_parents)
    .bind(&unique_slugs)
    .bind(has_checks)
    .bind(&digest_slices)
    .fetch_all(&mut **conn)
    .await
    .map_err(|err| internal_not_committed("pg_rb_col_and_cat_batch", err.to_string()))?;

    let mut non_eligible_occupants: HashMap<(String, String), ()> = HashMap::new();
    let mut cat_rows: Vec<(Vec<u8>, String, String, Option<String>)> =
        Vec::with_capacity(needed_digests.len());

    for r in rows {
        let kind: i32 = r.get("kind");
        if kind == 1 {
            let p_raw: String = r.get("parent_folder_id");
            let sf: String = r.get("slug_fold");
            let nid_raw: String = r.get("note_id");
            let nid = NoteId::parse(&nid_raw)
                .map_err(|_| internal_not_committed("corrupt_collision_nid", "invalid NoteId"))?;
            if !eligible_notes.contains(&nid) {
                non_eligible_occupants.insert((p_raw, sf), ());
            }
        } else {
            cat_rows.push((
                r.get("content_blake3"),
                r.get("admission_state"),
                r.get("blob_state"),
                r.get("current_publication_id"),
            ));
        }
    }

    for (parent_id, slug_fold, slug, is_root_child) in checks {
        if non_eligible_occupants.contains_key(&(parent_id.as_str().to_owned(), slug_fold.clone()))
        {
            return Err(DomainError::PathConflict {
                target: PathTarget {
                    space_id: space_id.clone(),
                    parent: if *is_root_child {
                        None
                    } else {
                        Some(parent_id.clone())
                    },
                    component: slug.clone(),
                },
            }
            .into());
        }
    }

    let mut pub_by_digest: HashMap<ContentDigest, String> =
        HashMap::with_capacity(needed_digests.len());
    for (d_bytes, admission, blob_state, pub_opt) in cat_rows {
        let arr: [u8; 32] = d_bytes
            .try_into()
            .map_err(|_| internal_not_committed("corrupt_cat_digest", "digest != 32B"))?;
        let digest = ContentDigest::from_bytes(arr);
        let Some(pub_id) = pub_opt else {
            return Err(unavailable_retryable(
                "blob_missing_for_rebind",
                "existing blob publication missing during metadata revision bind",
                std::time::Duration::from_millis(25),
            ));
        };
        if admission != "open" || blob_state != "active" {
            return Err(unavailable_retryable(
                "blob_retiring_on_rebind",
                "existing blob entered retirement before metadata revision commit",
                std::time::Duration::from_millis(25),
            ));
        }
        pub_by_digest.insert(digest, pub_id);
    }

    if pub_by_digest.len() != needed_digests.len() {
        return Err(unavailable_retryable(
            "blob_missing_for_rebind",
            "existing blob publication missing during metadata revision bind",
            std::time::Duration::from_millis(25),
        ));
    }

    Ok(Some(pub_by_digest))
}

#[allow(clippy::too_many_arguments)]
async fn execute_pg_rollback_domain_writes_cte(
    conn: &mut sqlx::PgConnection,
    scope: &HistoryScope,
    run_id: &AgentRunId,
    new_run_rev: &RevisionId,
    vis_seq: i64,
    sec: i64,
    nsec: i32,
    actor_str: &str,
    restore_heads: &[RestoredHeadUpdateItem<'_>],
    blob_rebinds: &[ExistingBlobRefItem],
    pub_by_digest: &HashMap<ContentDigest, String>,
    rev_items: &[RevisionInsertItem<'_>],
) -> Result<(), PortError> {
    let now_ms = now_unix_ms()?;

    let mut rh_note_ids: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_parents: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_slugs: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_slug_folds: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_titles: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_title_folds: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_doc_classes: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_abilities: Vec<Option<&str>> = Vec::with_capacity(restore_heads.len());
    let mut rh_rev_ids: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_digests: Vec<Option<&[u8]>> = Vec::with_capacity(restore_heads.len());
    let mut rh_byte_sizes: Vec<i64> = Vec::with_capacity(restore_heads.len());
    let mut rh_lifecycles: Vec<&str> = Vec::with_capacity(restore_heads.len());
    let mut rh_vis_masks: Vec<i32> = Vec::with_capacity(restore_heads.len());

    for i in restore_heads {
        rh_note_ids.push(i.note_id.as_str());
        rh_parents.push(i.parent_folder_id.as_str());
        rh_slugs.push(i.slug);
        rh_slug_folds.push(i.slug_fold);
        rh_titles.push(i.title);
        rh_title_folds.push(i.title_fold.as_str());
        rh_doc_classes.push(i.doc_class_str);
        rh_abilities.push(i.ability_id_str);
        rh_rev_ids.push(i.rev_id.as_str());
        rh_digests.push(i.content_digest.as_ref().map(|d| d.as_bytes().as_slice()));
        rh_byte_sizes.push(i.byte_size as i64);
        rh_lifecycles.push(i.lifecycle_str);
        rh_vis_masks.push(i.visibility_mask);
    }

    let mut seen_refs = BTreeSet::new();
    let mut br_owner_kinds: Vec<&str> = Vec::with_capacity(blob_rebinds.len());
    let mut br_owner_ids: Vec<&str> = Vec::with_capacity(blob_rebinds.len());
    let mut br_owner_rev_ids: Vec<&str> = Vec::with_capacity(blob_rebinds.len());
    let mut br_res_keys: Vec<&str> = Vec::with_capacity(blob_rebinds.len());
    let mut br_digests: Vec<&[u8]> = Vec::with_capacity(blob_rebinds.len());
    let mut br_pub_ids: Vec<&str> = Vec::with_capacity(blob_rebinds.len());
    let mut br_created_seqs: Vec<i64> = Vec::with_capacity(blob_rebinds.len());
    let mut delta_by_digest: HashMap<ContentDigest, i64> =
        HashMap::with_capacity(pub_by_digest.len());

    for it in blob_rebinds {
        let key = (
            it.owner_kind.as_db_str(),
            it.owner_id.as_str(),
            it.owner_rev_id.as_str(),
            it.resource_key,
        );
        if seen_refs.insert(key) {
            let pub_id = pub_by_digest
                .get(&it.digest)
                .ok_or_else(|| {
                    unavailable_retryable(
                        "blob_missing_for_rebind",
                        "existing blob publication missing during metadata revision bind",
                        std::time::Duration::from_millis(25),
                    )
                })?
                .as_str();
            br_owner_kinds.push(it.owner_kind.as_db_str());
            br_owner_ids.push(&it.owner_id);
            br_owner_rev_ids.push(&it.owner_rev_id);
            br_res_keys.push(it.resource_key);
            br_digests.push(it.digest.as_bytes().as_slice());
            br_pub_ids.push(pub_id);
            br_created_seqs.push(it.created_seq.get() as i64);
            *delta_by_digest.entry(it.digest).or_insert(0) += 1;
        }
    }

    let mut cat_digests_owned: Vec<[u8; 32]> = Vec::with_capacity(delta_by_digest.len());
    let mut cat_deltas: Vec<i64> = Vec::with_capacity(delta_by_digest.len());
    for (d, delta) in &delta_by_digest {
        if *delta > 0 {
            cat_digests_owned.push(*d.as_bytes());
            cat_deltas.push(*delta);
        }
    }
    let cat_digests: Vec<&[u8]> = cat_digests_owned.iter().map(|a| a.as_slice()).collect();

    let mut rv_ids: Vec<&str> = Vec::with_capacity(rev_items.len());
    let mut rv_entity_types: Vec<&str> = Vec::with_capacity(rev_items.len());
    let mut rv_entity_keys: Vec<&str> = Vec::with_capacity(rev_items.len());
    let mut rv_space_seqs: Vec<i64> = Vec::with_capacity(rev_items.len());
    let mut rv_parent_revs: Vec<Option<&str>> = Vec::with_capacity(rev_items.len());
    let mut rv_restored_revs: Vec<Option<&str>> = Vec::with_capacity(rev_items.len());
    let mut rv_digests: Vec<Option<&[u8]>> = Vec::with_capacity(rev_items.len());
    let mut rv_metas: Vec<&[u8]> = Vec::with_capacity(rev_items.len());
    let mut rv_runs: Vec<Option<&str>> = Vec::with_capacity(rev_items.len());

    for it in rev_items {
        rv_ids.push(it.rev_id.as_str());
        rv_entity_types.push(it.entity_type);
        rv_entity_keys.push(it.entity_key);
        rv_space_seqs.push(it.space_seq.get() as i64);
        rv_parent_revs.push(it.parent_rev_id.map(RevisionId::as_str));
        rv_restored_revs.push(it.restored_from_rev_id.map(RevisionId::as_str));
        rv_digests.push(it.content_blake3.as_ref().map(|d| d.as_bytes().as_slice()));
        rv_metas.push(it.metadata_msgpack);
        rv_runs.push(it.agent_run_id.map(AgentRunId::as_str));
    }

    sqlx::query(
        "WITH upd_restore AS (
            UPDATE note_heads AS nh
            SET parent_folder_id = v.parent_folder_id,
                slug = v.slug,
                slug_fold = v.slug_fold,
                title = v.title,
                title_fold = v.title_fold,
                doc_class = v.doc_class,
                ability_id = v.ability_id,
                head_rev_id = v.head_rev_id,
                content_blake3 = v.content_blake3,
                byte_size = v.byte_size,
                lifecycle_state = v.lifecycle_state,
                visibility_mask = v.visibility_mask,
                updated_seq = $3,
                updated_at_sec = $4,
                updated_at_nsec = $5,
                last_actor_id = $6
            FROM UNNEST(
                $10::TEXT[], $11::TEXT[], $12::TEXT[], $13::TEXT[], $14::TEXT[],
                $15::TEXT[], $16::TEXT[], $17::TEXT[], $18::TEXT[], $19::BYTEA[],
                $20::BIGINT[], $21::TEXT[], $22::INT4[]
            ) AS v(
                note_id, parent_folder_id, slug, slug_fold, title,
                title_fold, doc_class, ability_id, head_rev_id, content_blake3,
                byte_size, lifecycle_state, visibility_mask
            )
            WHERE nh.space_id = $1 AND nh.note_id = v.note_id
        ),
        ins_refs AS (
            INSERT INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            )
            SELECT $1, u.owner_kind, u.owner_id, u.owner_rev_id, u.res_key,
                   u.digest, u.pub_id, u.cseq
            FROM UNNEST(
                $23::TEXT[], $24::TEXT[], $25::TEXT[], $26::TEXT[],
                $27::BYTEA[], $28::TEXT[], $29::BIGINT[]
            ) AS u(owner_kind, owner_id, owner_rev_id, res_key, digest, pub_id, cseq)
        ),
        upd_cat AS (
            UPDATE blob_catalog AS bc
            SET ref_count = bc.ref_count + v.delta
            FROM UNNEST($30::BYTEA[], $31::BIGINT[]) AS v(digest, delta)
            WHERE bc.space_id = $1 AND bc.content_blake3 = v.digest AND $7::BIGINT >= 0
        ),
        ins_revs AS (
            INSERT INTO revisions (
                space_id, history_incarnation, rev_id, entity_type, entity_key,
                space_seq, visibility_seq, parent_rev_id, their_rev_id,
                restored_from_rev_id, content_blake3, metadata_msgpack,
                patch_meta_json, actor_id, session_id, agent_run_id,
                quarantine_reason, created_at_sec, created_at_nsec
            )
            SELECT
                $1, $2, u.rev_id, u.entity_type, u.entity_key,
                u.space_seq, $3, u.parent_rev_id, NULL,
                u.restored_rev_id, u.content_blake3, u.metadata_msgpack,
                NULL, $6, NULL, u.agent_run_id,
                NULL, $4, $5
            FROM UNNEST(
                $32::TEXT[], $33::TEXT[], $34::TEXT[], $35::BIGINT[],
                $36::TEXT[], $37::TEXT[], $38::BYTEA[], $39::BYTEA[],
                $40::TEXT[]
            ) AS u(
                rev_id, entity_type, entity_key, space_seq,
                parent_rev_id, restored_rev_id, content_blake3, metadata_msgpack,
                agent_run_id
            )
        )
        INSERT INTO agent_run_heads (
            space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
        ) VALUES ($1, $2, $8, $9, $3, $4, $5)
        ON CONFLICT (space_id, run_id) DO UPDATE SET
            history_incarnation = EXCLUDED.history_incarnation,
            run_revision = EXCLUDED.run_revision,
            last_seq = EXCLUDED.last_seq,
            updated_at_sec = EXCLUDED.updated_at_sec,
            updated_at_nsec = EXCLUDED.updated_at_nsec",
    )
    .bind(scope.space_id.as_str())
    .bind(scope.incarnation.as_bytes().as_slice())
    .bind(vis_seq)
    .bind(sec)
    .bind(nsec)
    .bind(actor_str)
    .bind(now_ms)
    .bind(run_id.as_str())
    .bind(new_run_rev.as_str())
    .bind(rh_note_ids)
    .bind(rh_parents)
    .bind(rh_slugs)
    .bind(rh_slug_folds)
    .bind(rh_titles)
    .bind(rh_title_folds)
    .bind(rh_doc_classes)
    .bind(rh_abilities)
    .bind(rh_rev_ids)
    .bind(rh_digests)
    .bind(rh_byte_sizes)
    .bind(rh_lifecycles)
    .bind(rh_vis_masks)
    .bind(br_owner_kinds)
    .bind(br_owner_ids)
    .bind(br_owner_rev_ids)
    .bind(br_res_keys)
    .bind(br_digests)
    .bind(br_pub_ids)
    .bind(br_created_seqs)
    .bind(cat_digests)
    .bind(cat_deltas)
    .bind(rv_ids)
    .bind(rv_entity_types)
    .bind(rv_entity_keys)
    .bind(rv_space_seqs)
    .bind(rv_parent_revs)
    .bind(rv_restored_revs)
    .bind(rv_digests)
    .bind(rv_metas)
    .bind(rv_runs)
    .execute(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_rb_domain_writes_cte", err.to_string()))?;

    Ok(())
}

fn build_rollback_pg_single_item_fast(
    scope_cl: HistoryScope,
    idemp: crate::writer::CommandIdentitySpec,
    auth: notarium_core::auth::EngineAuthContext,
    req_id: notarium_core::receipt::CommandIdentity,
    input: RollbackAgentRun,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
    writer_epoch: notarium_core::ids::LeaseEpoch,
) -> crate::writer::PgSingleItemFastFn {
    Box::new(move |store, conn, cfg, faults| {
        Box::pin(async move {
            execute_pg_fast_rollback_on_conn(
                store,
                conn,
                cfg,
                faults,
                &scope_cl,
                &idemp,
                &auth,
                &req_id,
                &input,
                &room_fences,
                writer_epoch,
            )
            .await
        })
    })
}

enum PgFastInnerResult {
    FallbackToStandard,
    Failed {
        err: PortError,
        effective_cut: Option<SpaceSeq>,
    },
    Committed {
        response_bytes: Vec<u8>,
        initial_cut: SpaceSeq,
        new_effective_cut: SpaceSeq,
    },
    UnknownCommit {
        response_bytes: Vec<u8>,
        diag_reason: String,
    },
}

#[allow(clippy::too_many_arguments)]
async fn execute_pg_fast_rollback_on_conn(
    store: &CanonicalStore,
    conn: &mut sqlx::PgConnection,
    cfg: crate::config::WriterConfig,
    faults: &crate::writer::WriterFaultState,
    scope_cl: &HistoryScope,
    idemp: &crate::writer::CommandIdentitySpec,
    auth: &notarium_core::auth::EngineAuthContext,
    req_id: &notarium_core::receipt::CommandIdentity,
    input: &RollbackAgentRun,
    room_fences: &std::sync::Arc<crate::domain::RoomFenceTable>,
    writer_epoch: notarium_core::ids::LeaseEpoch,
) -> crate::writer::PgSingleFastAttempt {
    use crate::writer::{BatchExecOutcome, ItemOutcomeSlot, PgSingleFastAttempt};

    let inner_res = execute_pg_fast_rollback_inner(
        conn,
        cfg,
        scope_cl,
        idemp,
        auth,
        req_id,
        input,
        room_fences,
        writer_epoch,
    )
    .await;

    match inner_res {
        PgFastInnerResult::FallbackToStandard => PgSingleFastAttempt::FallbackToStandard,
        PgFastInnerResult::Failed { err, effective_cut } => {
            let mut cuts = BTreeMap::new();
            let mut windows = Vec::new();
            if let Some(c) = effective_cut {
                cuts.insert(scope_cl.space_id.clone(), c);
                windows.push(crate::projection_fence::VisibilityWindow {
                    scope: scope_cl.clone(),
                    after: c,
                    through: c,
                    changes: crate::projection_fence::VisibilityChanges::default(),
                });
            }
            PgSingleFastAttempt::Handled(BatchExecOutcome::Committed {
                slots: vec![ItemOutcomeSlot::Failed(err)],
                space_effective_cuts: cuts,
                visibility_windows: windows,
            })
        }
        PgFastInnerResult::Committed {
            response_bytes,
            initial_cut,
            new_effective_cut,
        } => {
            store
                .inner
                .broadcast_hub
                .publish(crate::changes::BroadcastSignal::Committed {
                    scope: scope_cl.clone(),
                    new_last_seq: new_effective_cut,
                    targets: crate::changes::CommittedTargets::All,
                });
            if faults
                .drop_commit_response_once
                .swap(false, std::sync::atomic::Ordering::SeqCst)
            {
                return PgSingleFastAttempt::Handled(BatchExecOutcome::UnknownCommit {
                    slots: vec![ItemOutcomeSlot::Succeeded {
                        response_bytes,
                        has_idempotency: true,
                    }],
                    diag_reason: "fault_injected_commit_response_loss".to_owned(),
                });
            }
            let mut cuts = BTreeMap::new();
            cuts.insert(scope_cl.space_id.clone(), new_effective_cut);
            PgSingleFastAttempt::Handled(BatchExecOutcome::Committed {
                slots: vec![ItemOutcomeSlot::Succeeded {
                    response_bytes,
                    has_idempotency: true,
                }],
                space_effective_cuts: cuts,
                visibility_windows: vec![crate::projection_fence::VisibilityWindow {
                    scope: scope_cl.clone(),
                    after: initial_cut,
                    through: new_effective_cut,
                    changes: crate::projection_fence::VisibilityChanges {
                        notes: true,
                        folders: true,
                        erasures: false,
                    },
                }],
            })
        }
        PgFastInnerResult::UnknownCommit {
            response_bytes,
            diag_reason,
        } => PgSingleFastAttempt::Handled(BatchExecOutcome::UnknownCommit {
            slots: vec![ItemOutcomeSlot::Succeeded {
                response_bytes,
                has_idempotency: true,
            }],
            diag_reason,
        }),
    }
}

struct PendingRollbackFencesGuard {
    slots: Vec<
        Option<(
            tokio::sync::OwnedMutexGuard<notarium_core::ports::RoomFenceState>,
            ClosedRoomReservation,
        )>,
    >,
    req_id: notarium_core::receipt::CommandIdentity,
    armed_for_drop_consume: bool,
}

impl Drop for PendingRollbackFencesGuard {
    fn drop(&mut self) {
        if self.armed_for_drop_consume {
            for slot_opt in &mut self.slots {
                if let Some((mut guard, res)) = slot_opt.take() {
                    let _ = guard.consume(res, &self.req_id);
                }
            }
        }
    }
}

fn rollback_time_left(
    budget: &notarium_core::ports::CallBudget,
    deadline: Instant,
) -> Result<std::time::Duration, PortError> {
    super::common::CommandDeadline::at(deadline, "rollback").remaining(budget)
}

async fn rollback_wait<T>(
    budget: &notarium_core::ports::CallBudget,
    deadline: Instant,
    operation: impl Future<Output = T>,
) -> Result<T, PortError> {
    super::common::CommandDeadline::at(deadline, "rollback")
        .wait(budget, || operation)
        .await
}

// Reuse one session's prepared history and commit plans across clean rollbacks.
fn park_pg_rollback_connection(
    store: &CanonicalStore,
    connection: crate::dialect::postgres::StorePgConnection,
) {
    if let crate::runtime::SqlDriverState::Postgres {
        fast_write_conn,
        can_cache_fast_conn: true,
        ..
    } = &store.inner.sql
    {
        let mut slot = fast_write_conn.lock().expect("pg fast_write_conn mutex");
        if slot.is_none()
            && !store
                .inner
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            *slot = Some(connection);
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn try_execute_pg_root_rollback(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    idemp: &crate::writer::CommandIdentitySpec,
    request: &Mutation<RollbackAgentRun>,
    writer_epoch: notarium_core::ids::LeaseEpoch,
    try_pg_batch_plan: &mut bool,
    deadline: Instant,
) -> Option<Result<Committed<RollbackResult>, PortError>> {
    use crate::{
        codec::{
            cancelled_not_committed, deadline_not_committed, ordered_ids_batch,
            unknown_commit_outcome,
        },
        runtime::SqlDriverState,
    };
    use notarium_core::auth::{Space, SpaceKind, SpaceLifecycle};
    use std::sync::atomic::Ordering;

    if ctx.budget.cancellation.is_cancelled() {
        return Some(Err(cancelled_not_committed(
            "writer_cancelled_pre_enqueue",
            "write cancelled prior to mailbox admission",
        )));
    }
    if ctx.budget.remaining.is_zero() {
        return Some(Err(deadline_not_committed(
            "writer_deadline_zero_pre_enqueue",
            "write call budget expired prior to mailbox admission",
        )));
    }
    if !request.input.associated_board_expectations.is_empty() {
        return None;
    }

    let writer = match store.inner.writer() {
        Ok(w) => w,
        Err(err) => return Some(Err(err)),
    };
    match writer.faults().pre_commit_space_delays.try_lock() {
        Ok(delays) if delays.is_empty() => {}
        _ => return None,
    }

    let SqlDriverState::Postgres {
        pool,
        fast_write_conn,
        statement_timeout,
        ..
    } = &store.inner.sql
    else {
        return None;
    };

    let expected = &request.input.expected_entities;
    let n = expected.len();
    if n == 0 {
        return None;
    }

    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_unstable_by(|&a, &b| expected[a].note.cmp(&expected[b].note));
    for pair in indices.windows(2) {
        if expected[pair[0]].note == expected[pair[1]].note {
            return None;
        }
    }

    let scope = ctx.scope();
    let sorted_note_refs: Vec<&NoteId> = indices.iter().map(|&idx| &expected[idx].note).collect();
    let sorted_note_strs: Vec<&str> = sorted_note_refs.iter().map(|nid| nid.as_str()).collect();
    let sorted_exp_rev_strs: Vec<&str> = indices
        .iter()
        .map(|&idx| expected[idx].revision.as_str())
        .collect();

    let _commit_gate = match writer.try_acquire_commit_read_guard() {
        Some(g) => g,
        None => {
            {
                let _ = fast_write_conn
                    .lock()
                    .expect("pg fast_write_conn mutex")
                    .take();
            }
            match rollback_wait(&ctx.budget, deadline, writer.acquire_commit_read_guard()).await {
                Ok(guard) => guard,
                Err(err) => return Some(Err(err)),
            }
        }
    };
    let visibility = match rollback_wait(
        &ctx.budget,
        deadline,
        store
            .inner
            .live_visibility
            .for_write(vec![scope.space_id.clone()]),
    )
    .await
    {
        Ok(visibility) => visibility,
        Err(err) => return Some(Err(err)),
    };
    if let Err(error) = store
        .inner
        .check_writer_epoch(&scope.space_id, writer_epoch)
    {
        return Some(Err(error));
    }
    if visibility.has_live_state() {
        // The shared actor updates visibility for the standard and optimized
        // batch paths. Keep this direct fast path for unprojected Spaces.
        return None;
    }

    if !writer.is_accepting() || store.inner.shutting_down.load(Ordering::SeqCst) {
        return Some(Err(unavailable_retryable(
            "writer_shutting_down",
            "canonical WriteBatchActor is draining for shutdown",
            std::time::Duration::from_millis(100),
        )));
    }
    if ctx.budget.cancellation.is_cancelled() {
        return Some(Err(cancelled_not_committed(
            "writer_cancelled_before_commit_handoff",
            "write cancelled prior to commit handoff",
        )));
    }

    let cached_conn = {
        fast_write_conn
            .lock()
            .expect("pg fast_write_conn mutex")
            .take()
    };
    let read_deadline = deadline.min(crate::runtime::deadline_after(
        Instant::now(),
        *statement_timeout,
    ));
    let mut pooled = match cached_conn {
        Some(c) => c,
        None => match rollback_wait(&ctx.budget, read_deadline, pool.acquire()).await {
            Ok(Ok(c)) => c,
            Err(err) => return Some(Err(err)),
            Ok(Err(err)) => {
                return Some(Err(unavailable_retryable(
                    "pg_pool_acquire_failed",
                    err.to_string(),
                    std::time::Duration::from_millis(25),
                )));
            }
        },
    };

    // Read each run entity and the publication of the content it could restore together.
    // The commit rechecks the grant, heads and live publication before applying any writes.
    struct RollbackHead {
        slug: String,
        folded_slug: String,
        head_rev: String,
        lifecycle: Lifecycle,
        digest: Option<ContentDigest>,
    }
    struct RestoredMetadata {
        pre_meta: NoteRevisionMetadata,
        normalized_title_fold: String,
        canonical_root_meta_msgpack: Vec<u8>,
    }
    struct RunHistory {
        first_run_seq: i64,
        max_other_seq: Option<i64>,
        pre_rev_id: Option<String>,
        metadata: Option<RestoredMetadata>,
    }
    let mut read_lease = crate::sql_exec::PgTransactionLease::new(&mut pooled);
    let query = sqlx::query(crate::schema::PG_LEAN_ROLLBACK_READ_SQL)
        .bind(scope.space_id.as_str())
        .bind(request.input.run.as_str())
        .bind(&sorted_note_strs)
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(writer_epoch.get() as i64)
        .bind(request.input.expected_run_revision.as_str())
        .fetch_all(read_lease.conn());
    let rows = match rollback_wait(&ctx.budget, read_deadline, query).await {
        Ok(Ok(rows)) => rows,
        Ok(Err(err)) => {
            return Some(Err(internal_not_committed(
                "pg_rollback_read",
                err.to_string(),
            )));
        }
        Err(err) => return Some(Err(err)),
    };
    read_lease.complete();
    // The batch optimization also requires an empty room table. A known unsupported
    // room should enter the ordinary planner directly, without a second history read.
    if rows.iter().any(|row| !row.get::<bool, _>("room_writable")) {
        *try_pg_batch_plan = false;
        park_pg_rollback_connection(store, pooled);
        return None;
    }
    let hydrated = (|| {
        if rows.len() != n {
            return None;
        }
        let first = rows.first()?;
        let folder = FolderId::parse(first.get("root_folder_id")).ok()?;
        let kind = match first.get::<&str, _>("space_kind") {
            "personal" => SpaceKind::Personal,
            "shared" => SpaceKind::Shared,
            _ => return None,
        };
        let mut heads = Vec::with_capacity(n);
        let mut history = Vec::with_capacity(n);
        let mut pubs = std::collections::BTreeMap::new();
        for (idx, row) in rows.iter().enumerate() {
            if row.get::<&str, _>("note_id") != sorted_note_strs[idx]
                || row.get::<&str, _>("head_rev_id") != sorted_exp_rev_strs[idx]
            {
                return None;
            }
            let dig = |col: &str| -> Option<Option<ContentDigest>> {
                row.get::<Option<&[u8]>, _>(col)
                    .map(|bytes| <[u8; 32]>::try_from(bytes).map(ContentDigest::from_bytes))
                    .transpose()
                    .ok()
            };
            let head = RollbackHead {
                slug: row.get("slug"),
                folded_slug: row.get("slug_fold"),
                head_rev: row.get("head_rev_id"),
                lifecycle: lifecycle_from_db(row.get("lifecycle_state")).ok()?,
                digest: dig("content_blake3")?,
            };
            if let Some(pub_id) = row.get::<Option<&str>, _>("current_publication_id") {
                pubs.insert(*dig("publication_digest")??.as_bytes(), pub_id.to_owned());
            }
            let metadata = match row.get::<Option<&[u8]>, _>("prior_metadata") {
                Some(bytes) => {
                    let pm = decode_rollback_note(bytes, sorted_note_refs[idx]).ok()?;
                    if pm.doc_class != DocClass::UserDoc
                        || pm.ability_id.is_some()
                        || pm.visibility_mask < 0
                        || pm.parent_folder_id != folder
                    {
                        return None;
                    }
                    let normalized_title_fold = normalize_title_key(&pm.title);
                    let encoded = encode_rollback_note(
                        &pm,
                        Some(bytes.into()),
                        true,
                        RollbackRevision::Restore(None),
                    )
                    .ok()?;
                    Some(RestoredMetadata {
                        pre_meta: pm,
                        normalized_title_fold,
                        canonical_root_meta_msgpack: encoded,
                    })
                }
                None => None,
            };
            heads.push(head);
            history.push(RunHistory {
                first_run_seq: row.get("first_seq"),
                max_other_seq: row.get("space_seq"),
                pre_rev_id: row.get("rev_id"),
                metadata,
            });
        }
        Some((folder, kind, heads, history, pubs))
    })();
    let Some((root_folder_id, space_kind, heads, mut revs, active_pubs)) = hydrated else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };

    let root_facts = notarium_core::auth::ResourceFacts {
        space: Space {
            id: scope.space_id.clone(),
            lifecycle: SpaceLifecycle::Active,
            kind: space_kind,
        },
        class: DocClass::UserDoc,
        ancestor_folders: vec![root_folder_id.clone()],
        folder_write_locked: false,
        ability_package: None,
    };
    if ctx
        .auth()
        .authorize_direct_write(&root_facts, &root_facts)
        .is_err()
    {
        park_pg_rollback_connection(store, pooled);
        return None;
    }

    let root_folder_str = root_folder_id.as_str();

    // Step 2: Acquire room fences only for non-manual-skip notes (matching `execute_pg_fast_rollback_inner`),
    // classify actions in memory, and encode metadata + receipt MsgPack payloads in compiled Rust.
    if let Err(err) = rollback_time_left(&ctx.budget, deadline) {
        return Some(Err(err));
    }
    let fence_slots = match store.inner.room_fences.try_lock_batch_for_rollback_sync(
        scope,
        &sorted_note_refs,
        &request.identity,
    ) {
        Ok(Some(slots)) => slots,
        Ok(None) => {
            let mut slots = Vec::with_capacity(n);
            for &nid in &sorted_note_refs {
                if let Err(err) = rollback_time_left(&ctx.budget, deadline) {
                    return Some(Err(err));
                }
                match store
                    .inner
                    .room_fences
                    .try_lock_closed_for_rollback(scope, nid, &request.identity)
                    .await
                {
                    Ok(opt) => slots.push(opt),
                    Err(err) => {
                        park_pg_rollback_connection(store, pooled);
                        return Some(Err(err));
                    }
                }
            }
            slots
        }
        Err(err) => {
            park_pg_rollback_connection(store, pooled);
            return Some(Err(err));
        }
    };

    let mut fences_guard = PendingRollbackFencesGuard {
        slots: fence_slots,
        req_id: request.identity.clone(),
        armed_for_drop_consume: false,
    };

    struct DecodedRestore {
        pre_rev_id: String,
        metadata: RestoredMetadata,
        is_full: bool,
    }

    let mut acts: Vec<i16> = vec![0; n];
    let mut decoded_restores: Vec<Option<DecodedRestore>> = (0..n).map(|_| None).collect();
    let mut planned_active_slots: std::collections::BTreeSet<&str> =
        std::collections::BTreeSet::new();
    let mut trash_mut_cnt: usize = 0;
    let mut restore_mut_cnt: usize = 0;
    {
        for i in 0..n {
            let head = &heads[i];
            let r_acc = &mut revs[i];
            let first_run_seq = r_acc.first_run_seq;
            if r_acc.max_other_seq.is_some_and(|mo| mo >= first_run_seq) {
                // Release unused fence immediately for manual-edit skipped notes.
                let _ = fences_guard.slots[i].take();
                acts[i] = 0;
                continue;
            }
            if fences_guard.slots[i].is_none() {
                acts[i] = 1;
                continue;
            }
            if r_acc.max_other_seq.is_none() {
                if head.lifecycle == Lifecycle::Trashed {
                    acts[i] = 2;
                } else {
                    acts[i] = 3;
                    trash_mut_cnt += 1;
                }
            } else {
                let Some(pre_rev_id) = r_acc.pre_rev_id.take() else {
                    park_pg_rollback_connection(store, pooled);
                    return None;
                };
                let Some(cached) = r_acc.metadata.take() else {
                    park_pg_rollback_connection(store, pooled);
                    return None;
                };
                let pre_meta = &cached.pre_meta;
                let unchanged_placement = head.lifecycle == pre_meta.lifecycle
                    && head.slug == pre_meta.slug
                    && head.folded_slug == pre_meta.slug_fold;
                let needs_mut = head.head_rev != pre_rev_id || !unchanged_placement;
                if !needs_mut {
                    acts[i] = 4;
                } else {
                    acts[i] = 5;
                    restore_mut_cnt += 1;
                }
                decoded_restores[i] = Some(DecodedRestore {
                    pre_rev_id,
                    metadata: cached,
                    is_full: !unchanged_placement,
                });
            }
        }
    }

    // Intra-batch active sibling slug collision & swap guard (all notes live in `root_folder_id`).
    let mut current_full_active_slugs: std::collections::BTreeSet<&str> =
        std::collections::BTreeSet::new();
    for i in 0..n {
        if let Some(ref dr) = decoded_restores[i] {
            let pm = &dr.metadata.pre_meta;
            if pm.lifecycle == Lifecycle::Active
                && !planned_active_slots.insert(pm.slug_fold.as_str())
            {
                park_pg_rollback_connection(store, pooled);
                return None;
            }
            if acts[i] == 5 && dr.is_full {
                let h = &heads[i];
                if h.lifecycle == Lifecycle::Active {
                    current_full_active_slugs.insert(h.folded_slug.as_str());
                }
            }
        }
    }
    for i in 0..n {
        if acts[i] == 5
            && let Some(ref dr) = decoded_restores[i]
            && dr.is_full
            && dr.metadata.pre_meta.lifecycle == Lifecycle::Active
            && current_full_active_slugs.contains(dr.metadata.pre_meta.slug_fold.as_str())
        {
            // Guard against intra-statement active slug swaps between two `is_full` restores.
            park_pg_rollback_connection(store, pooled);
            return None;
        }
    }

    let Ok(total_seqs) = i64::try_from((trash_mut_cnt + restore_mut_cnt).max(1)) else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };

    let (Ok(committed_at_ms), Ok(now_ts), Ok(raw_ids)) = (
        now_unix_ms(),
        now_utc_timestamp(),
        ordered_ids_batch(trash_mut_cnt + restore_mut_cnt + 3),
    ) else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };
    let cfg = writer.config();
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);
    let (sec, nsec) = encode_timestamp_parts(now_ts);

    let mut raw_it = raw_ids.into_iter();
    let mut next_rev = || RevisionId::from_bytes(raw_it.next().expect("pre-sized"));

    let mut rel_seq: i64 = 0;
    let mut_cap = trash_mut_cnt + restore_mut_cnt;
    let mut m_nids: Vec<&str> = Vec::with_capacity(mut_cap);
    let mut m_prev_revs: Vec<&str> = Vec::with_capacity(mut_cap);
    let mut m_rest_revs: Vec<Option<&str>> = Vec::with_capacity(mut_cap);
    let mut m_digs_owned: Vec<Option<ContentDigest>> = Vec::with_capacity(mut_cap);
    let mut m_lc: Vec<&'static str> = Vec::with_capacity(mut_cap);
    let mut m_rel_seqs: Vec<i64> = Vec::with_capacity(mut_cap);
    let mut m_ops: Vec<&'static str> = Vec::with_capacity(mut_cap);
    let mut m_rev_ids: Vec<RevisionId> = Vec::with_capacity(mut_cap);

    let mut tr_nids: Vec<&str> = Vec::with_capacity(trash_mut_cnt);
    let mut tr_rev_idxs: Vec<usize> = Vec::with_capacity(trash_mut_cnt);

    let mut hot_nids: Vec<&str> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_t: Vec<&str> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_tf: Vec<&str> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_rev_idxs: Vec<usize> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_digs_owned: Vec<Option<ContentDigest>> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_bs: Vec<i64> = Vec::with_capacity(restore_mut_cnt);
    let mut hot_vm: Vec<i32> = Vec::with_capacity(restore_mut_cnt);

    let mut fl_nids: Vec<&str> = Vec::new();
    let mut fl_pf: Vec<&str> = Vec::new();
    let mut fl_s: Vec<&str> = Vec::new();
    let mut fl_sf: Vec<&str> = Vec::new();
    let mut fl_t: Vec<&str> = Vec::new();
    let mut fl_tf: Vec<&str> = Vec::new();
    let mut fl_rev_idxs: Vec<usize> = Vec::new();
    let mut fl_digs_owned: Vec<Option<ContentDigest>> = Vec::new();
    let mut fl_bs: Vec<i64> = Vec::new();
    let mut fl_lc: Vec<&'static str> = Vec::new();
    let mut fl_vm: Vec<i32> = Vec::new();

    let mut trash_metas_owned: Vec<Vec<u8>> = Vec::with_capacity(trash_mut_cnt);
    let mut m_metas: Vec<&[u8]> = Vec::with_capacity(mut_cap);

    struct PendingBr<'a> {
        nid: &'a str,
        rev_idx: usize,
        dig: [u8; 32],
        pub_id: &'a str,
        rel_seq: i64,
    }
    let mut pending_brs: Vec<PendingBr<'_>> = Vec::with_capacity(mut_cap);

    let mut trashed_out: Vec<NoteRevision> = Vec::with_capacity(trash_mut_cnt + 2);
    let mut restored_out: Vec<NoteRevision> = Vec::with_capacity(restore_mut_cnt);
    let mut skipped_manual_edits: Vec<NoteId> = Vec::new();
    let mut skipped_room_active: Vec<NoteId> = Vec::new();
    let mut owner_vec: Vec<NoteId> = Vec::with_capacity(n);
    let mut elig_nids: Vec<&str> = Vec::with_capacity(n);
    let mut delta_by_digest: BTreeMap<[u8; 32], (i64, &str)> = BTreeMap::new();

    // Pass 1: Trash created notes first (`act_code in {2, 3}` in ascending `NoteId` order),
    // plus collect `skipped_manual_edits`, `skipped_room_active`, and `owner_vec` / `elig_nids`.
    for i in 0..n {
        let nid_ref = sorted_note_refs[i];
        match acts[i] {
            0 => skipped_manual_edits.push(nid_ref.clone()),
            1 => skipped_room_active.push(nid_ref.clone()),
            2 => {
                owner_vec.push(nid_ref.clone());
                elig_nids.push(nid_ref.as_str());
                trashed_out.push(NoteRevision {
                    note: nid_ref.clone(),
                    revision: expected[indices[i]].revision.clone(),
                });
            }
            3 => {
                owner_vec.push(nid_ref.clone());
                elig_nids.push(nid_ref.as_str());
                let head = &heads[i];
                rel_seq += 1;
                let trel = rel_seq;
                let trev = next_rev();
                let rev_idx = m_rev_ids.len();
                if let Some(d) = head.digest {
                    let Some(pub_arc) = active_pubs.get(d.as_bytes()) else {
                        park_pg_rollback_connection(store, pooled);
                        return None;
                    };
                    let pub_s = pub_arc.as_str();
                    delta_by_digest.entry(*d.as_bytes()).or_insert((0, pub_s)).0 += 1;
                    pending_brs.push(PendingBr {
                        nid: nid_ref.as_str(),
                        rev_idx,
                        dig: *d.as_bytes(),
                        pub_id: pub_s,
                        rel_seq: trel,
                    });
                }
                let metadata = rows[i]
                    .get::<Option<&[u8]>, _>("created_metadata")
                    .and_then(|bytes| decode_rollback_note(bytes, nid_ref).ok());
                let Some(meta) = metadata.and_then(|source| {
                    encode_rollback_note(&source, None, true, RollbackRevision::Trash).ok()
                }) else {
                    park_pg_rollback_connection(store, pooled);
                    return None;
                };
                m_nids.push(nid_ref.as_str());
                m_prev_revs.push(head.head_rev.as_str());
                m_rest_revs.push(None);
                m_digs_owned.push(head.digest);
                m_lc.push("trashed");
                m_rel_seqs.push(trel);
                trash_metas_owned.push(meta);
                m_ops.push("trash");
                tr_nids.push(nid_ref.as_str());
                tr_rev_idxs.push(rev_idx);
                trashed_out.push(NoteRevision {
                    note: nid_ref.clone(),
                    revision: trev.clone(),
                });
                m_rev_ids.push(trev);
            }
            4 | 5 => {
                owner_vec.push(nid_ref.clone());
                elig_nids.push(nid_ref.as_str());
            }
            _ => {}
        }
    }
    for tm in &trash_metas_owned {
        m_metas.push(tm.as_slice());
    }

    // Pass 2: Restore pre-existing notes (`act_code == 5` in ascending `NoteId` order),
    // borrowing pre-encoded `canonical_root_meta_msgpack` and `normalized_title_fold` with zero allocations.
    for i in 0..n {
        if acts[i] != 5 {
            continue;
        }
        let nid_ref = sorted_note_refs[i];
        let head = &heads[i];
        let dr = decoded_restores[i]
            .as_ref()
            .expect("verified decoded_restore");
        let pm = &dr.metadata.pre_meta;
        rel_seq += 1;
        let rrel = rel_seq;
        let rrev = next_rev();
        let rev_idx = m_rev_ids.len();
        if let Some(d) = pm.content_digest {
            let Some(pub_arc) = active_pubs.get(d.as_bytes()) else {
                park_pg_rollback_connection(store, pooled);
                return None;
            };
            let pub_s = pub_arc.as_str();
            delta_by_digest.entry(*d.as_bytes()).or_insert((0, pub_s)).0 += 1;
            pending_brs.push(PendingBr {
                nid: nid_ref.as_str(),
                rev_idx,
                dig: *d.as_bytes(),
                pub_id: pub_s,
                rel_seq: rrel,
            });
        }
        let lc_str = lifecycle_to_db(pm.lifecycle);
        m_nids.push(nid_ref.as_str());
        m_prev_revs.push(head.head_rev.as_str());
        m_rest_revs.push(Some(dr.pre_rev_id.as_str()));
        m_digs_owned.push(pm.content_digest);
        m_lc.push(lc_str);
        m_rel_seqs.push(rrel);
        m_metas.push(dr.metadata.canonical_root_meta_msgpack.as_slice());
        m_ops.push("restore");
        if dr.is_full {
            fl_nids.push(nid_ref.as_str());
            fl_pf.push(pm.parent_folder_id.as_str());
            fl_s.push(pm.slug.as_str());
            fl_sf.push(pm.slug_fold.as_str());
            fl_t.push(pm.title.as_str());
            fl_tf.push(dr.metadata.normalized_title_fold.as_str());
            fl_rev_idxs.push(rev_idx);
            fl_digs_owned.push(pm.content_digest);
            fl_bs.push(pm.byte_size as i64);
            fl_lc.push(lc_str);
            fl_vm.push(pm.visibility_mask);
        } else {
            hot_nids.push(nid_ref.as_str());
            hot_t.push(pm.title.as_str());
            hot_tf.push(dr.metadata.normalized_title_fold.as_str());
            hot_rev_idxs.push(rev_idx);
            hot_digs_owned.push(pm.content_digest);
            hot_bs.push(pm.byte_size as i64);
            hot_vm.push(pm.visibility_mask);
        }
        restored_out.push(NoteRevision {
            note: nid_ref.clone(),
            revision: rrev.clone(),
        });
        m_rev_ids.push(rrev);
    }

    let m_revs: Vec<&str> = m_rev_ids.iter().map(RevisionId::as_str).collect();
    let m_digs: Vec<Option<&[u8]>> = m_digs_owned
        .iter()
        .map(|d| d.as_ref().map(|x| x.as_bytes().as_slice()))
        .collect();

    // Sort `blob_references` in ascending `(owner_rev_id, owner_id)` PK order.
    pending_brs.sort_unstable_by(|a, b| {
        m_revs[a.rev_idx]
            .cmp(m_revs[b.rev_idx])
            .then_with(|| a.nid.cmp(b.nid))
    });
    let mut br_nids: Vec<&str> = Vec::with_capacity(pending_brs.len());
    let mut br_revs: Vec<&str> = Vec::with_capacity(pending_brs.len());
    let mut br_digs: Vec<&[u8]> = Vec::with_capacity(pending_brs.len());
    let mut br_pubs: Vec<&str> = Vec::with_capacity(pending_brs.len());
    let mut br_rel_seqs: Vec<i64> = Vec::with_capacity(pending_brs.len());
    for br in &pending_brs {
        br_nids.push(br.nid);
        br_revs.push(m_revs[br.rev_idx]);
        br_digs.push(br.dig.as_slice());
        br_pubs.push(br.pub_id);
        br_rel_seqs.push(br.rel_seq);
    }

    let tr_revs: Vec<&str> = tr_rev_idxs.iter().map(|&idx| m_revs[idx]).collect();
    let hot_revs: Vec<&str> = hot_rev_idxs.iter().map(|&idx| m_revs[idx]).collect();
    let hot_digs: Vec<Option<&[u8]>> = hot_digs_owned
        .iter()
        .map(|d| d.as_ref().map(|x| x.as_bytes().as_slice()))
        .collect();
    let fl_revs: Vec<&str> = fl_rev_idxs.iter().map(|&idx| m_revs[idx]).collect();
    let fl_digs: Vec<Option<&[u8]>> = fl_digs_owned
        .iter()
        .map(|d| d.as_ref().map(|x| x.as_bytes().as_slice()))
        .collect();

    let new_run_rev = next_rev();
    let pay_id = format!(
        "pay_{:032x}",
        u128::from_be_bytes(raw_it.next().expect("pre-sized"))
    );
    let cmd_id = format!(
        "cmd_{:032x}",
        u128::from_be_bytes(raw_it.next().expect("pre-sized"))
    );
    let owner_key = format!("{}:{}", idemp.actor.as_str(), idemp.command_key.as_str());
    let resp_pid = format!("rcpt_pay:{owner_key}");

    // Pre-encode MsgPack payloads with distinct 64-bit big-endian sentinels (`> u32::MAX`) so PostgreSQL
    // patches live `v_first_seq` / `v_vis_seq` via `overlay(... placing int8send(...) from off for 8)`
    // in a single UDS round-trip without a preliminary read of `spaces.last_seq`.
    const SEQ_SENTINEL_FIRST_U64: u64 = 0x5f4e_4f54_4653_5131;
    const SEQ_SENTINEL_VIS_U64: u64 = 0x5f4e_4f54_5653_5132;
    fn find_unique_u64_be_payload_offset_1based(buf: &[u8], val: u64) -> Option<i32> {
        let mut pattern = [0u8; 9];
        pattern[0] = 0xcf;
        pattern[1..9].copy_from_slice(&val.to_be_bytes());
        let first_pos = buf.windows(9).position(|w| w == pattern)?;
        if buf[first_pos + 1..].windows(9).any(|w| w == pattern) {
            return None;
        }
        i32::try_from(first_pos.checked_add(2)?).ok()
    }

    let sentinel_first = SpaceSeq::new(SEQ_SENTINEL_FIRST_U64).expect("valid first sentinel");
    let sentinel_vis = SpaceSeq::new(SEQ_SENTINEL_VIS_U64).expect("valid vis sentinel");

    let (Ok(run_meta), Ok(cmd_range), Ok(sentinel_receipt)) = (
        RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
            crate::codec::AgentRunRevisionMetadata {
                run_id: request.input.run.clone(),
                last_seq: sentinel_vis,
            },
        ))
        .encode(),
        notarium_core::ports::CommandSeqRange::new(sentinel_first, sentinel_vis),
        MutationReceiptToken::new(scope.clone(), sentinel_vis),
    ) else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };
    let Ok(effect_draft) = build_effect_payload_draft(
        pay_id,
        scope.clone(),
        cmd_range,
        "rollback_agent_run",
        EffectBodyV1::AwaitProjection {
            reason: StoredAwaitReasonV1::Bulk,
        },
        owner_vec,
    ) else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };

    let eff_pid_str = effect_draft.payload_id.as_str();
    let owner_key_str = owner_key.as_str();

    let result_value = RollbackResult {
        restored: restored_out,
        trashed: trashed_out,
        restored_ranks: Vec::new(),
        skipped_manual_edits,
        skipped_room_active,
    };
    let wire = StoredCommittedRollbackV1 {
        restored: result_value.restored.clone(),
        trashed: result_value.trashed.clone(),
        restored_ranks: Vec::new(),
        skipped_manual_edits: result_value.skipped_manual_edits.clone(),
        skipped_room_active: result_value.skipped_room_active.clone(),
        receipt: sentinel_receipt.clone(),
    };
    let (Ok(resp_bytes), Ok(sanitized)) = (
        encode_msgpack(&wire),
        encode_msgpack(&StoredCommittedRollbackV1 {
            restored: Vec::new(),
            trashed: Vec::new(),
            restored_ranks: Vec::new(),
            skipped_manual_edits: result_value.skipped_manual_edits.clone(),
            skipped_room_active: result_value.skipped_room_active.clone(),
            receipt: sentinel_receipt,
        }),
    ) else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };

    let (
        Some(off_run_vis),
        Some(off_eff_first),
        Some(off_eff_vis),
        Some(off_resp_vis),
        Some(off_san_vis),
    ) = (
        find_unique_u64_be_payload_offset_1based(&run_meta, SEQ_SENTINEL_VIS_U64),
        find_unique_u64_be_payload_offset_1based(
            &effect_draft.effect_msgpack,
            SEQ_SENTINEL_FIRST_U64,
        ),
        find_unique_u64_be_payload_offset_1based(
            &effect_draft.effect_msgpack,
            SEQ_SENTINEL_VIS_U64,
        ),
        find_unique_u64_be_payload_offset_1based(&resp_bytes, SEQ_SENTINEL_VIS_U64),
        find_unique_u64_be_payload_offset_1based(&sanitized, SEQ_SENTINEL_VIS_U64),
    )
    else {
        park_pg_rollback_connection(store, pooled);
        return None;
    };
    if (off_eff_first - off_eff_vis).abs() < 9 {
        park_pg_rollback_connection(store, pooled);
        return None;
    }

    let noop_folder_id: Option<&str> = if m_nids.is_empty() {
        Some(root_folder_id.as_str())
    } else {
        None
    };
    let cat_digs_owned: Vec<[u8; 32]> = delta_by_digest.keys().copied().collect();
    let cat_deltas: Vec<i64> = delta_by_digest.values().map(|(d, _)| *d).collect();
    let cat_pubs: Vec<&str> = delta_by_digest.values().map(|(_, p)| *p).collect();
    let cat_digs: Vec<&[u8]> = cat_digs_owned.iter().map(|a| a.as_slice()).collect();

    let all_exp_lcs: Vec<&'static str> =
        heads.iter().map(|h| lifecycle_to_db(h.lifecycle)).collect();

    // Step 3: Commit in 1 lean PL/pgSQL transaction (all INSERTs in PK order before pre-sliced UPDATEs).
    let phase2_start = writer
        .is_batch_telemetry_enabled()
        .then(std::time::Instant::now);

    if let Err(err) = ctx.auth().authorize_direct_write(&root_facts, &root_facts) {
        park_pg_rollback_connection(store, pooled);
        return Some(Err(err.into()));
    }
    let (room_leases, room_lineages): (Vec<Option<i64>>, Vec<Option<i64>>) = rows
        .iter()
        .map(|row| {
            (
                row.get::<Option<i64>, _>("room_lease"),
                row.get::<Option<i64>, _>("room_lineage"),
            )
        })
        .unzip();
    let apply = sqlx::query(crate::schema::PG_LEAN_ROLLBACK_COMMIT_CALL_SQL)
        .bind(scope.space_id.as_str())
        .bind(scope.incarnation.as_bytes().as_slice())
        .bind(total_seqs)
        .bind(off_run_vis)
        .bind(off_eff_first)
        .bind(off_eff_vis)
        .bind(off_resp_vis)
        .bind(off_san_vis)
        .bind(sec)
        .bind(nsec)
        .bind(committed_at_ms)
        .bind(expires_at_ms)
        .bind(idemp.actor.as_str())
        .bind(idemp.command_key.as_str())
        .bind(idemp.command_hash.as_bytes().as_slice())
        .bind(cmd_id.as_str())
        .bind(request.input.run.as_str())
        .bind(request.input.expected_run_revision.as_str())
        .bind(new_run_rev.as_str())
        .bind(run_meta.as_slice())
        .bind(eff_pid_str)
        .bind(effect_draft.effect_msgpack.as_slice())
        .bind(resp_pid.as_str())
        .bind(resp_bytes.as_slice())
        .bind(sanitized.as_slice())
        .bind(noop_folder_id)
        .bind(&elig_nids)
        .bind(&br_nids)
        .bind(&br_revs)
        .bind(&br_digs)
        .bind(&br_pubs)
        .bind(&br_rel_seqs)
        .bind(&m_nids)
        .bind(&m_revs)
        .bind(&m_prev_revs)
        .bind(&m_rest_revs)
        .bind(&m_digs)
        .bind(&m_rel_seqs)
        .bind(&m_metas)
        .bind(&m_lc)
        .bind(&m_ops)
        .bind(owner_key_str)
        .bind(&cat_digs)
        .bind(&cat_deltas)
        .bind(&tr_nids)
        .bind(&tr_revs)
        .bind(&hot_nids)
        .bind(&hot_t)
        .bind(&hot_tf)
        .bind(&hot_revs)
        .bind(&hot_digs)
        .bind(&hot_bs)
        .bind(&hot_vm)
        .bind(&fl_nids)
        .bind(&fl_pf)
        .bind(&fl_s)
        .bind(&fl_sf)
        .bind(&fl_t)
        .bind(&fl_tf)
        .bind(&fl_revs)
        .bind(&fl_digs)
        .bind(&fl_bs)
        .bind(&fl_lc)
        .bind(&fl_vm)
        .bind(&cat_pubs)
        .bind(&sorted_note_strs)
        .bind(&sorted_exp_rev_strs)
        .bind(&all_exp_lcs)
        .bind(root_folder_str)
        .bind(writer_epoch.get() as i64)
        .bind(&room_leases)
        .bind(&room_lineages);
    let remaining = match rollback_time_left(&ctx.budget, deadline) {
        Ok(remaining) => remaining,
        Err(err) => return Some(Err(err)),
    };
    // The owned transaction rolls back on any return before COMMIT. The SQL
    // timeout also bounds server work if the client disconnects.
    let sql = format!(
        "BEGIN; SET LOCAL statement_timeout = '{}ms'",
        remaining.as_millis().clamp(1, i32::MAX as u128)
    );
    let mut transaction = crate::sql_exec::PgTransactionLease::new(pooled);
    let begin = sqlx::raw_sql(sqlx::AssertSqlSafe(sql)).execute(transaction.conn());
    match rollback_wait(&ctx.budget, deadline, begin).await {
        Ok(Ok(_)) => {}
        Ok(Err(err)) => {
            return Some(Err(internal_not_committed(
                "pg_rollback_begin",
                err.to_string(),
            )));
        }
        Err(err) => return Some(Err(err)),
    };
    let row = match rollback_wait(&ctx.budget, deadline, apply.fetch_one(transaction.conn())).await
    {
        Ok(Ok(row)) => row,
        Ok(Err(sqlx::Error::Database(err))) if err.message().contains("NOTARIUM_RB_FALLBACK_0") => {
            *try_pg_batch_plan = false;
            return None;
        }
        Ok(Err(sqlx::Error::Database(err))) if err.code().as_deref() == Some("57014") => {
            return Some(Err(deadline_not_committed(
                "pg_rollback_statement_timeout",
                "rollback statement exceeded its SQL time budget",
            )));
        }
        Ok(Err(err)) => {
            return Some(Err(internal_not_committed(
                "pg_lean_rb_apply",
                err.to_string(),
            )));
        }
        Err(err) => return Some(Err(err)),
    };
    if row.get::<i64, usize>(0) <= 0 {
        *try_pg_batch_plan = false;
        return None;
    }

    let executor = store.inner.backup_executor.clone();
    let store = store.clone();
    let scope = scope.clone();
    let writer = writer.clone();
    let commit = async move {
        // Retain the backup safe point and room fences until the database
        // answers, including when the caller stops waiting for the ACK.
        let _gate = _commit_gate;
        fences_guard.armed_for_drop_consume = true;
        let connection = match sqlx::raw_sql("COMMIT").execute(transaction.conn()).await {
            Ok(_) => {
                fences_guard.armed_for_drop_consume = false;
                transaction.into_completed_connection()
            }
            Err(sqlx::Error::Database(err)) => {
                fences_guard.armed_for_drop_consume = false;
                drop(fences_guard);
                return Err(internal_not_committed("pg_lean_rb_commit", err.to_string()));
            }
            Err(_) => {
                return Err(unknown_commit_outcome(
                    "pg_lean_rb_lost_ack",
                    "rollback COMMIT reply was lost",
                ));
            }
        };

        if let Some(t0) = phase2_start {
            let dur_ns = u64::try_from(t0.elapsed().as_nanos()).unwrap_or(u64::MAX);
            writer.record_batch_telemetry(dur_ns, 1);
        }

        let vis_seq_i64 = row.get::<i64, usize>(0);
        let (Ok(visibility_seq), Some(receipt)) = (
            i64_to_space_seq(vis_seq_i64),
            i64_to_space_seq(vis_seq_i64)
                .ok()
                .and_then(|vs| MutationReceiptToken::new(scope.clone(), vs).ok()),
        ) else {
            drop(fences_guard);
            return Err(unknown_commit_outcome(
                "corrupt_lean_rb_vis_seq",
                format!("invalid committed visibility_seq {vis_seq_i64}"),
            ));
        };

        for (i, slot_opt) in fences_guard.slots.iter_mut().enumerate() {
            if acts[i] >= 2
                && let Some((mut guard, res)) = slot_opt.take()
                && let Err(err) = guard.consume(res, &fences_guard.req_id)
            {
                return Err(unknown_commit_outcome(
                    "fence_consume_lean_rb",
                    format!("fence consume failed after lean rollback commit: {err:?}"),
                ));
            }
        }
        drop(fences_guard);

        store
            .inner
            .broadcast_hub
            .publish(crate::changes::BroadcastSignal::Committed {
                scope: scope.clone(),
                new_last_seq: visibility_seq,
                targets: crate::changes::CommittedTargets::All,
            });

        if writer
            .faults()
            .drop_commit_response_once
            .swap(false, Ordering::SeqCst)
        {
            return Err(unknown_commit_outcome(
                "fault_injected_commit_response_loss",
                "fault-injected commit response loss after lean rollback commit",
            ));
        }

        park_pg_rollback_connection(&store, connection);
        Ok(Committed {
            value: result_value,
            receipt,
        })
    };
    let mut completion = Box::pin(commit);
    // First poll is the COMMIT handoff. Prior cancellation can still discard
    // the transaction. After that poll the same future must drain the ACK.
    if let Err(err) = rollback_time_left(&ctx.budget, deadline) {
        return Some(Err(err));
    }
    let first =
        std::future::poll_fn(|cx| std::task::Poll::Ready(completion.as_mut().poll(cx))).await;
    if let std::task::Poll::Ready(result) = first {
        return Some(result);
    }
    let acknowledgement = executor.spawn(completion);
    Some(
        match rollback_wait(&ctx.budget, deadline, acknowledgement).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) | Err(_) => Err(unknown_commit_outcome(
                "pg_lean_rb_ambiguous_commit",
                "rollback COMMIT was sent without a definitive reply",
            )),
        },
    )
}

#[allow(clippy::too_many_arguments)]
async fn execute_pg_fast_rollback_inner(
    conn: &mut sqlx::PgConnection,
    cfg: crate::config::WriterConfig,
    scope_cl: &HistoryScope,
    idemp: &crate::writer::CommandIdentitySpec,
    auth: &notarium_core::auth::EngineAuthContext,
    req_id: &notarium_core::receipt::CommandIdentity,
    input: &RollbackAgentRun,
    room_fences: &std::sync::Arc<crate::domain::RoomFenceTable>,
    writer_epoch: notarium_core::ids::LeaseEpoch,
) -> PgFastInnerResult {
    use crate::codec::{doc_class_from_db, ordered_ids_batch};
    use notarium_core::{
        auth::{Space, SpaceKind, SpaceLifecycle},
        ids::LeaseEpoch,
    };

    let committed_at_ms = match now_unix_ms() {
        Ok(ms) => ms,
        Err(err) => {
            return PgFastInnerResult::Failed {
                err,
                effective_cut: None,
            };
        }
    };
    let receipt_ttl_ms = i64::try_from(cfg.receipt_ttl.as_millis()).unwrap_or(86_400_000);
    let expires_at_ms = committed_at_ms.saturating_add(receipt_ttl_ms);

    let mut caller_notes: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    let mut has_duplicate_expected = false;
    for exp in &input.expected_entities {
        if caller_notes
            .insert(exp.note.clone(), exp.revision.clone())
            .is_some()
        {
            has_duplicate_expected = true;
        }
    }
    let caller_note_vec: Vec<NoteId> = caller_notes.keys().cloned().collect();
    let caller_note_strs: Vec<&str> = caller_note_vec.iter().map(NoteId::as_str).collect();

    // Round-Trip 1: Single autocommit PL/pgSQL table call with cached SPI plan & single-pass window scan!
    let r_rows = match sqlx::query(
        "SELECT * FROM notarium_pg_fast_rollback_prep_v1($1, $2, $3, $4, $5, $6::TEXT[])",
    )
    .bind(scope_cl.space_id.as_str())
    .bind(scope_cl.incarnation.as_bytes().as_slice())
    .bind(idemp.actor.as_str())
    .bind(idemp.command_key.as_str())
    .bind(input.run.as_str())
    .bind(&caller_note_strs)
    .fetch_all(&mut *conn)
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            return PgFastInnerResult::Failed {
                err: internal_not_committed("pg_fast_rb_combined_read", err.to_string()),
                effective_cut: None,
            };
        }
    };

    let Some(r0_idx) = r_rows.iter().position(|r| r.get::<i32, usize>(0) == 0) else {
        return PgFastInnerResult::Failed {
            err: DomainError::ResourceNotFound.into(),
            effective_cut: None,
        };
    };
    let r1 = &r_rows[r0_idx];

    let s_inc_bytes: Vec<u8> = r1.get::<Vec<u8>, usize>(22);
    let Ok(s_inc_arr) = <[u8; 16]>::try_from(s_inc_bytes) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_incarnation", "incarnation != 16B"),
            effective_cut: None,
        };
    };
    let s_last_seq_raw: i64 = r1.get::<i64, usize>(20);
    let current_effective_cut = match i64_to_space_seq(s_last_seq_raw) {
        Ok(seq) => seq,
        Err(err) => {
            return PgFastInnerResult::Failed {
                err: err.into(),
                effective_cut: None,
            };
        }
    };
    let db_scope = HistoryScope {
        space_id: scope_cl.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(s_inc_arr),
    };
    if let Err(err) = db_scope.check(scope_cl) {
        return PgFastInnerResult::Failed {
            err: err.into(),
            effective_cut: Some(current_effective_cut),
        };
    }

    if r1.get::<i64, usize>(19) != writer_epoch.get() as i64 {
        return PgFastInnerResult::Failed {
            err: DomainError::validation(ValidationReason::InvalidAuthority).into(),
            effective_cut: Some(current_effective_cut),
        };
    }

    // Deliver receipts from the standard writer transaction, which checks live resource authority.
    if r1.get::<Option<Vec<u8>>, usize>(23).is_some() {
        return PgFastInnerResult::FallbackToStandard;
    }

    let flags: i32 = r1.get::<i32, usize>(21);
    if (flags & 1) != 0 {
        return PgFastInnerResult::Failed {
            err: rollback_fallback_board_present_err(),
            effective_cut: Some(current_effective_cut),
        };
    }
    if (flags & (2 | 4 | 8 | 16)) != 0 {
        return PgFastInnerResult::FallbackToStandard;
    }

    if has_duplicate_expected {
        return PgFastInnerResult::Failed {
            err: DomainError::validation(ValidationReason::InvalidState).into(),
            effective_cut: Some(current_effective_cut),
        };
    }

    let s_root_raw: String = r1.get::<String, usize>(1);
    let Ok(root_folder_id) = FolderId::parse(&s_root_raw) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_root_folder", "invalid root_folder_id"),
            effective_cut: Some(current_effective_cut),
        };
    };
    let s_kind_raw: String = r1.get::<String, usize>(2);
    let s_lc_raw: String = r1.get::<String, usize>(3);
    let s_epoch_raw: i64 = r1.get::<i64, usize>(19);
    let Ok(ep_u64) = u64::try_from(s_epoch_raw) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_epoch", "negative active_epoch"),
            effective_cut: Some(current_effective_cut),
        };
    };
    let Ok(active_epoch) = LeaseEpoch::new(ep_u64) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_epoch", "invalid active_epoch"),
            effective_cut: Some(current_effective_cut),
        };
    };
    let space_kind = match s_kind_raw.as_str() {
        "personal" => SpaceKind::Personal,
        "shared" => SpaceKind::Shared,
        _ => return PgFastInnerResult::FallbackToStandard,
    };
    let space_lc = match s_lc_raw.as_str() {
        "active" => SpaceLifecycle::Active,
        "closing" => SpaceLifecycle::Closing,
        "archived" => SpaceLifecycle::Archived,
        _ => return PgFastInnerResult::FallbackToStandard,
    };
    let space_obj = Space {
        id: scope_cl.space_id.clone(),
        lifecycle: space_lc,
        kind: space_kind,
    };

    if let Err(err) = auth.authorize_space_write(&space_obj) {
        return PgFastInnerResult::Failed {
            err: err.into(),
            effective_cut: Some(current_effective_cut),
        };
    }
    let run_inc_opt: Option<Vec<u8>> = r1.get::<Option<Vec<u8>>, usize>(24);
    let run_rev_opt: Option<String> = r1.get::<Option<String>, usize>(6);
    let Some((run_inc_bytes, run_rev_raw)) = run_inc_opt.zip(run_rev_opt) else {
        return PgFastInnerResult::Failed {
            err: DomainError::ResourceNotFound.into(),
            effective_cut: Some(current_effective_cut),
        };
    };
    let Ok(run_inc_arr) = <[u8; 16]>::try_from(run_inc_bytes) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_run_inc", "incarnation != 16B"),
            effective_cut: Some(current_effective_cut),
        };
    };
    if let Err(err) = scope_cl.check(&HistoryScope {
        space_id: scope_cl.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(run_inc_arr),
    }) {
        return PgFastInnerResult::Failed {
            err: err.into(),
            effective_cut: Some(current_effective_cut),
        };
    }
    let Ok(actual_run_rev) = RevisionId::parse(&run_rev_raw) else {
        return PgFastInnerResult::Failed {
            err: internal_not_committed("corrupt_run_rev", "invalid run_revision"),
            effective_cut: Some(current_effective_cut),
        };
    };

    if (flags & 512) != 0 {
        return PgFastInnerResult::Failed {
            err: DomainError::validation(ValidationReason::SourceMismatch).into(),
            effective_cut: Some(current_effective_cut),
        };
    }

    let mut folder_cache = FolderAncestryCache::default();
    let rf_id_opt: Option<String> = r1.get::<Option<String>, usize>(7);
    if rf_id_opt.is_some() {
        let parent_raw: Option<String> = r1.get::<Option<String>, usize>(8);
        let cover_raw: Option<String> = r1.get::<Option<String>, usize>(15);
        let write_lock_json: Option<String> = r1.get::<Option<String>, usize>(16);
        let lc_raw: Option<String> = r1.get::<Option<String>, usize>(17);
        let head_rev_raw: Option<String> = r1.get::<Option<String>, usize>(18);
        if let (Some(lc_s), Some(hrev_s)) = (lc_raw, head_rev_raw)
            && let (Ok(head_rev_id), Ok(lifecycle)) =
                (RevisionId::parse(&hrev_s), lifecycle_from_db(&lc_s))
        {
            let parent_folder_id = parent_raw.and_then(|s| FolderId::parse(&s).ok());
            let cover_note_id = cover_raw.and_then(|s| NoteId::parse(&s).ok());
            folder_cache.insert_preloaded_row(FolderHeadRow {
                folder_id: root_folder_id.clone(),
                parent_folder_id,
                is_root: (flags & 64) != 0,
                slug: r1.get::<Option<String>, usize>(9).unwrap_or_default(),
                slug_fold: r1.get::<Option<String>, usize>(10).unwrap_or_default(),
                display_name: r1.get::<Option<String>, usize>(11).unwrap_or_default(),
                is_project: (flags & 128) != 0,
                project_slug: r1.get::<Option<String>, usize>(12),
                project_slug_fold: r1.get::<Option<String>, usize>(13),
                description: r1.get::<Option<String>, usize>(14),
                cover_note_id,
                write_locked: write_lock_json.is_some(),
                lifecycle,
                head_rev_id,
            });
        }
    }

    struct MiniNoteSummary {
        created_source: Option<(String, Vec<u8>)>,
        has_foreign: bool,
        pre_rev: Option<(RevisionId, Vec<u8>)>,
    }

    struct MiniHead {
        parent_folder_id: FolderId,
        slug: String,
        slug_fold: String,
        title: String,
        doc_class: DocClass,
        ability_id: Option<notarium_core::ids::AbilityId>,
        head_rev_id: RevisionId,
        content_digest: Option<ContentDigest>,
        byte_size: u64,
        lifecycle: Lifecycle,
        visibility_mask: i32,
    }

    let mut rev_summaries: HashMap<NoteId, MiniNoteSummary> =
        HashMap::with_capacity(caller_notes.len());
    let mut heads_map: HashMap<NoteId, MiniHead> = HashMap::with_capacity(caller_notes.len());
    let mut cat_map: HashMap<ContentDigest, (String, String, Option<String>)> = HashMap::new();

    for row in &r_rows {
        let kind: i32 = row.get::<i32, usize>(0);
        if kind == 0 {
            continue;
        } else if kind == 1 {
            let nid_raw: String = row.get::<String, usize>(1);
            let first_run_seq_raw: i64 = row.get::<i64, usize>(19);
            if first_run_seq_raw < 0 {
                return PgFastInnerResult::Failed {
                    err: DomainError::validation(ValidationReason::SourceMismatch).into(),
                    effective_cut: Some(current_effective_cut),
                };
            }
            let Ok(nid) = NoteId::parse(&nid_raw) else {
                return PgFastInnerResult::Failed {
                    err: internal_not_committed("corrupt_rev_nid", "invalid note_id"),
                    effective_cut: Some(current_effective_cut),
                };
            };
            let has_foreign = row.get::<i32, usize>(21) != 0;
            let pre_rev_raw: Option<String> = row.get::<Option<String>, usize>(2);
            let pre_meta_opt: Option<Vec<u8>> = row.get::<Option<Vec<u8>>, usize>(23);
            let pre_rev = match (pre_rev_raw, pre_meta_opt) {
                (Some(r_str), Some(meta_bytes)) => {
                    let Ok(rev) = RevisionId::parse(&r_str) else {
                        return PgFastInnerResult::Failed {
                            err: internal_not_committed("corrupt_rev_id", "invalid rev_id"),
                            effective_cut: Some(current_effective_cut),
                        };
                    };
                    Some((rev, meta_bytes))
                }
                _ => None,
            };
            rev_summaries.insert(
                nid,
                MiniNoteSummary {
                    created_source: row
                        .get::<Option<String>, usize>(3)
                        .zip(row.get::<Option<Vec<u8>>, usize>(24)),
                    has_foreign,
                    pre_rev,
                },
            );
        } else if kind == 2 {
            let nid_raw: String = row.get::<String, usize>(1);
            let parent_raw: String = row.get::<String, usize>(2);
            let slug: String = row.get::<String, usize>(3);
            let slug_fold: String = row.get::<String, usize>(4);
            let title: String = row.get::<String, usize>(5);
            let dc_raw: String = row.get::<String, usize>(6);
            let ab_raw: Option<String> = row.get::<Option<String>, usize>(7);
            let hrev_raw: String = row.get::<String, usize>(8);
            let lc_raw: String = row.get::<String, usize>(9);
            let bsize_raw: i64 = row.get::<i64, usize>(19);
            let vmask: i32 = row.get::<i32, usize>(21);
            let cbytes_opt: Option<Vec<u8>> = row.get::<Option<Vec<u8>>, usize>(22);

            let (Ok(nid), Ok(parent_folder_id), Ok(doc_class), Ok(head_rev_id), Ok(lifecycle)) = (
                NoteId::parse(&nid_raw),
                FolderId::parse(&parent_raw),
                doc_class_from_db(&dc_raw),
                RevisionId::parse(&hrev_raw),
                lifecycle_from_db(&lc_raw),
            ) else {
                return PgFastInnerResult::Failed {
                    err: internal_not_committed("corrupt_head_row", "invalid note_heads column"),
                    effective_cut: Some(current_effective_cut),
                };
            };
            let ability_id = match ab_raw {
                Some(s) => match notarium_core::ids::AbilityId::parse(&s) {
                    Ok(id) => Some(id),
                    Err(_) => {
                        return PgFastInnerResult::Failed {
                            err: internal_not_committed("corrupt_ability_id", "invalid AbilityId"),
                            effective_cut: Some(current_effective_cut),
                        };
                    }
                },
                None => None,
            };
            let Ok(byte_size) = u64::try_from(bsize_raw) else {
                return PgFastInnerResult::Failed {
                    err: internal_not_committed("corrupt_byte_size", "negative size"),
                    effective_cut: Some(current_effective_cut),
                };
            };
            let content_digest = match cbytes_opt {
                Some(b) => match <[u8; 32]>::try_from(b) {
                    Ok(arr) => Some(ContentDigest::from_bytes(arr)),
                    Err(_) => {
                        return PgFastInnerResult::Failed {
                            err: internal_not_committed("corrupt_digest", "digest != 32B"),
                            effective_cut: Some(current_effective_cut),
                        };
                    }
                },
                None => None,
            };
            heads_map.insert(
                nid,
                MiniHead {
                    parent_folder_id,
                    slug,
                    slug_fold,
                    title,
                    doc_class,
                    ability_id,
                    head_rev_id,
                    content_digest,
                    byte_size,
                    lifecycle,
                    visibility_mask: vmask,
                },
            );
        } else {
            let adm: String = row.get::<String, usize>(1);
            let bstate: String = row.get::<String, usize>(2);
            let pub_opt: Option<String> = row.get::<Option<String>, usize>(3);
            let d_bytes: Vec<u8> = row.get::<Vec<u8>, usize>(22);
            let Ok(arr) = <[u8; 32]>::try_from(d_bytes) else {
                return PgFastInnerResult::Failed {
                    err: internal_not_committed("corrupt_cat_digest", "digest != 32B"),
                    effective_cut: Some(current_effective_cut),
                };
            };
            cat_map.insert(ContentDigest::from_bytes(arr), (adm, bstate, pub_opt));
        }
    }
    drop(r_rows);

    if rev_summaries.len() != caller_notes.len() {
        return PgFastInnerResult::Failed {
            err: DomainError::validation(ValidationReason::SourceMismatch).into(),
            effective_cut: Some(current_effective_cut),
        };
    }

    {
        let mut bconn = BackendConn::Postgres(conn);
        for nid in caller_notes.keys() {
            let Some(head) = heads_map.get(nid) else {
                return PgFastInnerResult::Failed {
                    err: DomainError::ResourceNotFound.into(),
                    effective_cut: Some(current_effective_cut),
                };
            };
            let rfacts = match folder_cache
                .build_resource_facts_tx(
                    &mut bconn,
                    &space_obj,
                    &head.parent_folder_id,
                    head.doc_class,
                    head.ability_id.clone(),
                    false,
                )
                .await
            {
                Ok((rf, _)) => rf,
                Err(err) => {
                    return PgFastInnerResult::Failed {
                        err,
                        effective_cut: Some(current_effective_cut),
                    };
                }
            };
            if let Err(err) = auth.authorize_direct_write(&rfacts, &rfacts) {
                return PgFastInnerResult::Failed {
                    err: err.into(),
                    effective_cut: Some(current_effective_cut),
                };
            }
        }
    }

    if let Err(err) = verify_authorized_rollback_revisions(actual_run_rev, input, |nid| {
        heads_map.get(nid).map(|head| &head.head_rev_id)
    }) {
        return PgFastInnerResult::Failed {
            err,
            effective_cut: Some(current_effective_cut),
        };
    }

    let mut skipped_manual_edits = Vec::new();
    let mut skipped_room_active = Vec::new();
    let mut eligible_notes: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();

    for nid in caller_note_vec {
        let Some(head) = heads_map.remove(&nid) else {
            return PgFastInnerResult::Failed {
                err: DomainError::ResourceNotFound.into(),
                effective_cut: Some(current_effective_cut),
            };
        };
        let Some(summary) = rev_summaries.remove(&nid) else {
            return PgFastInnerResult::Failed {
                err: DomainError::validation(ValidationReason::SourceMismatch).into(),
                effective_cut: Some(current_effective_cut),
            };
        };
        if summary.has_foreign {
            skipped_manual_edits.push(nid);
            continue;
        }
        let action = match summary.pre_rev {
            None => CandidateAction::TrashCreated {
                metadata: match summary.created_source {
                    Some((rev, bytes)) if rev == head.head_rev_id.as_str() => {
                        match decode_rollback_note(&bytes, &nid) {
                            Ok(meta) => Box::new(meta),
                            Err(err) => {
                                return PgFastInnerResult::Failed {
                                    err,
                                    effective_cut: Some(current_effective_cut),
                                };
                            }
                        }
                    }
                    _ => return PgFastInnerResult::FallbackToStandard,
                },
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
            Some((pre_rev_id, meta_bytes)) => {
                let pre_meta = match decode_rollback_note(&meta_bytes, &nid) {
                    Ok(meta) => meta,
                    Err(err) => {
                        return PgFastInnerResult::Failed {
                            err,
                            effective_cut: Some(current_effective_cut),
                        };
                    }
                };
                let head_unchanged_placement = head.lifecycle == pre_meta.lifecycle
                    && head.parent_folder_id == pre_meta.parent_folder_id
                    && head.slug == pre_meta.slug
                    && head.slug_fold == pre_meta.slug_fold;
                let needs_note_mutation =
                    head.head_rev_id != pre_rev_id || !head_unchanged_placement;
                CandidateAction::RestorePreExisting {
                    current_rev: head.head_rev_id,
                    pre_rev_id,
                    pre_meta: Box::new(pre_meta),
                    pre_carrier: None,
                    needs_note_mutation,
                    head_unchanged_placement,
                }
            }
        };
        eligible_notes.insert(nid, action);
    }

    let mut final_eligible: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
    let mut locked_fences = Vec::with_capacity(eligible_notes.len());
    for (nid, action) in eligible_notes {
        match room_fences
            .try_lock_closed_for_rollback(scope_cl, &nid, req_id)
            .await
        {
            Ok(Some((guard, res))) => {
                locked_fences.push((guard, res));
                final_eligible.insert(nid, action);
            }
            Ok(None) => {
                skipped_room_active.push(nid);
            }
            Err(err) => {
                return PgFastInnerResult::Failed {
                    err,
                    effective_cut: Some(current_effective_cut),
                };
            }
        }
    }
    skipped_room_active.sort();

    let mut planned_active_slots: HashMap<(FolderId, String), NoteId> = HashMap::new();
    let mut planned_collision_checks: Vec<(FolderId, String, String, bool)> = Vec::new();
    let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();
    let mut trash_ancestries: HashMap<NoteId, bool> = HashMap::new();

    {
        let mut bconn = BackendConn::Postgres(conn);
        for (nid, action) in &final_eligible {
            match action {
                CandidateAction::TrashCreated {
                    current_lifecycle,
                    parent_folder_id,
                    ..
                } if *current_lifecycle != Lifecycle::Trashed => {
                    let anc = match folder_cache
                        .load_ancestry_tx(&mut bconn, &scope_cl.space_id, parent_folder_id, false)
                        .await
                    {
                        Ok(a) => a,
                        Err(err) => {
                            return PgFastInnerResult::Failed {
                                err,
                                effective_cut: Some(current_effective_cut),
                            };
                        }
                    };
                    trash_ancestries.insert(nid.clone(), anc.is_root_child);
                }
                CandidateAction::RestorePreExisting {
                    pre_meta,
                    head_unchanged_placement,
                    ..
                } => {
                    let anc = match authorize_rollback_destination_tx(
                        &mut bconn,
                        &mut folder_cache,
                        &space_obj,
                        auth,
                        pre_meta,
                    )
                    .await
                    {
                        Ok(a) => a,
                        Err(err) => {
                            return PgFastInnerResult::Failed {
                                err,
                                effective_cut: Some(current_effective_cut),
                            };
                        }
                    };
                    restored_ancestries.insert(nid.clone(), anc.is_root_child);
                    if pre_meta.lifecycle == Lifecycle::Active {
                        let slot_key = (
                            pre_meta.parent_folder_id.clone(),
                            pre_meta.slug_fold.clone(),
                        );
                        if planned_active_slots.insert(slot_key, nid.clone()).is_some() {
                            return PgFastInnerResult::Failed {
                                err: DomainError::PathConflict {
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
                                effective_cut: Some(current_effective_cut),
                            };
                        }
                        if !*head_unchanged_placement {
                            planned_collision_checks.push((
                                pre_meta.parent_folder_id.clone(),
                                pre_meta.slug_fold.clone(),
                                pre_meta.slug.clone(),
                                anc.is_root_child,
                            ));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    let mut pub_by_digest: HashMap<ContentDigest, String> = HashMap::new();
    for action in final_eligible.values() {
        let d_opt = match action {
            CandidateAction::TrashCreated {
                current_lifecycle,
                content_digest,
                ..
            } if *current_lifecycle != Lifecycle::Trashed => *content_digest,
            CandidateAction::RestorePreExisting {
                needs_note_mutation: true,
                pre_meta,
                ..
            } => pre_meta.content_digest,
            _ => None,
        };
        if let Some(d) = d_opt
            && !pub_by_digest.contains_key(&d)
        {
            let Some((adm, bstate, pub_opt)) = cat_map.get(&d) else {
                return PgFastInnerResult::Failed {
                    err: unavailable_retryable(
                        "blob_missing_for_rebind",
                        "existing blob publication missing during metadata revision bind",
                        std::time::Duration::from_millis(25),
                    ),
                    effective_cut: Some(current_effective_cut),
                };
            };
            let Some(pub_id) = pub_opt else {
                return PgFastInnerResult::Failed {
                    err: unavailable_retryable(
                        "blob_missing_for_rebind",
                        "existing blob publication missing during metadata revision bind",
                        std::time::Duration::from_millis(25),
                    ),
                    effective_cut: Some(current_effective_cut),
                };
            };
            if adm != "open" || bstate != "active" {
                return PgFastInnerResult::Failed {
                    err: unavailable_retryable(
                        "blob_retiring_on_rebind",
                        "existing blob entered retirement before metadata revision commit",
                        std::time::Duration::from_millis(25),
                    ),
                    effective_cut: Some(current_effective_cut),
                };
            }
            pub_by_digest.insert(d, pub_id.clone());
        }
    }

    let trash_note_count = final_eligible
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
    let restore_note_count = final_eligible
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

    let prep_res: Result<(Vec<u8>, SpaceSeq, i64), PortError> = async {
        let first_seq = current_effective_cut.checked_next()?;
        let next_u64 = current_effective_cut
            .get()
            .checked_add(total_seqs)
            .ok_or_else(|| DomainError::validation(ValidationReason::SequenceOverflow))?;
        let visibility_seq = SpaceSeq::new(next_u64)?;
        let mut cursor_seq = current_effective_cut;

        let vis_i64 = visibility_seq.get() as i64;
        let now_ts = now_utc_timestamp()?;
        let (sec, nsec) = encode_timestamp_parts(now_ts);
        let actor_str = idemp.actor.as_str();

        let id_count = (trash_note_count + restore_note_count) as usize + 3;
        let mut raw_ids = ordered_ids_batch(id_count)?.into_iter();
        let mut next_rev = || RevisionId::from_bytes(raw_ids.next().expect("pre-allocated ID"));

        struct UnifiedMutRow<'a> {
            is_full: bool,
            note_id: &'a str,
            parent_folder_id: &'a str,
            slug: &'a str,
            slug_fold: &'a str,
            title: &'a str,
            title_fold: String,
            doc_class_str: &'static str,
            ability_id_str: Option<&'a str>,
            rev_id: RevisionId,
            parent_rev_str: &'a str,
            restored_rev_str: Option<&'a str>,
            content_digest: Option<ContentDigest>,
            pub_id_str: Option<&'a str>,
            byte_size: i64,
            lifecycle_str: &'static str,
            visibility_mask: i32,
            space_seq: i64,
            metadata_msgpack: Vec<u8>,
            op_kind: &'static str,
        }

        let mut_cap = (trash_note_count + restore_note_count) as usize;
        let mut mut_rows: Vec<UnifiedMutRow<'_>> = Vec::with_capacity(mut_cap);
        let mut trashed_out = Vec::with_capacity(trash_note_count as usize);
        let mut restored_out = Vec::with_capacity(restore_note_count as usize);
        let mut owner_vec: Vec<NoteId> = Vec::with_capacity(final_eligible.len());
        let mut delta_by_digest: BTreeMap<[u8; 32], i64> = BTreeMap::new();
        let mut has_full = false;

        for (nid, action) in &final_eligible {
            let CandidateAction::TrashCreated {
                metadata,
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
            if *current_lifecycle == Lifecycle::Trashed {
                trashed_out.push(NoteRevision {
                    note: nid.clone(),
                    revision: current_rev.clone(),
                });
                continue;
            }
            cursor_seq = cursor_seq.checked_next()?;
            let tseq = cursor_seq;
            let trev = next_rev();
            let is_root_child = trash_ancestries.get(nid).copied().unwrap_or(false);
            let title_fold = if *doc_class == DocClass::EncryptedNote {
                normalize_title_key(slug)
            } else {
                normalize_title_key(title)
            };
            let pub_id_str = if let Some(d) = *content_digest {
                *delta_by_digest.entry(*d.as_bytes()).or_insert(0) += 1;
                Some(pub_by_digest.get(&d).expect("verified digest").as_str())
            } else {
                None
            };
            let meta = encode_rollback_note(metadata, None, is_root_child, RollbackRevision::Trash)?;
            mut_rows.push(UnifiedMutRow {
                is_full: false,
                note_id: nid.as_str(),
                parent_folder_id: parent_folder_id.as_str(),
                slug: slug.as_str(),
                slug_fold: slug_fold.as_str(),
                title: title.as_str(),
                title_fold,
                doc_class_str: doc_class_to_db(*doc_class),
                ability_id_str: ability_id.as_ref().map(|a| a.as_str()),
                rev_id: trev.clone(),
                parent_rev_str: current_rev.as_str(),
                restored_rev_str: None,
                content_digest: *content_digest,
                pub_id_str,
                byte_size: *byte_size as i64,
                lifecycle_str: "trashed",
                visibility_mask: *visibility_mask,
                space_seq: tseq.get() as i64,
                metadata_msgpack: meta,
                op_kind: "trash",
            });
            trashed_out.push(NoteRevision {
                note: nid.clone(),
                revision: trev,
            });
        }

        for (nid, action) in &final_eligible {
            owner_vec.push(nid.clone());
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
            if !*needs_note_mutation {
                continue;
            }
            cursor_seq = cursor_seq.checked_next()?;
            let rseq = cursor_seq;
            let rrev = next_rev();
            let is_root_child = restored_ancestries.get(nid).copied().unwrap_or(false);
            let pub_id_str = if let Some(d) = pre_meta.content_digest {
                *delta_by_digest.entry(*d.as_bytes()).or_insert(0) += 1;
                Some(pub_by_digest.get(&d).expect("verified digest").as_str())
            } else {
                None
            };
            let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
                normalize_title_key(&pre_meta.slug)
            } else {
                normalize_title_key(&pre_meta.title)
            };
            let is_full = !*head_unchanged_placement;
            if is_full {
                has_full = true;
            }
            let meta = encode_rollback_note(pre_meta, None, is_root_child, RollbackRevision::Restore(None))?;
            mut_rows.push(UnifiedMutRow {
                is_full,
                note_id: nid.as_str(),
                parent_folder_id: pre_meta.parent_folder_id.as_str(),
                slug: pre_meta.slug.as_str(),
                slug_fold: pre_meta.slug_fold.as_str(),
                title: pre_meta.title.as_str(),
                title_fold,
                doc_class_str: doc_class_to_db(pre_meta.doc_class),
                ability_id_str: pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                rev_id: rrev.clone(),
                parent_rev_str: current_rev.as_str(),
                restored_rev_str: Some(pre_rev_id.as_str()),
                content_digest: pre_meta.content_digest,
                pub_id_str,
                byte_size: pre_meta.byte_size as i64,
                lifecycle_str: lifecycle_to_db(pre_meta.lifecycle),
                visibility_mask: pre_meta.visibility_mask,
                space_seq: rseq.get() as i64,
                metadata_msgpack: meta,
                op_kind: "restore",
            });
            restored_out.push(NoteRevision {
                note: nid.clone(),
                revision: rrev,
            });
        }

        let new_run_rev = next_rev();
        let pay_raw = raw_ids.next().expect("pre-allocated pay ID");
        let cmd_raw = raw_ids.next().expect("pre-allocated cmd ID");
        let pay_id = format!("pay_{:032x}", u128::from_be_bytes(pay_raw));
        let cmd_id = format!("cmd_{:032x}", u128::from_be_bytes(cmd_raw));

        let run_meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
            crate::codec::AgentRunRevisionMetadata {
                run_id: input.run.clone(),
                last_seq: visibility_seq,
            },
        ))
        .encode()?;

        let noop_folder_id: Option<&str> = if mut_rows.is_empty() {
            Some(root_folder_id.as_str())
        } else {
            None
        };
        let has_trash = trash_note_count > 0;

        let cmd_range = notarium_core::ports::CommandSeqRange::new(first_seq, visibility_seq)?;
        let effect_draft = build_effect_payload_draft(
            pay_id,
            scope_cl.clone(),
            cmd_range,
            "rollback_agent_run",
            EffectBodyV1::AwaitProjection {
                reason: StoredAwaitReasonV1::Bulk,
            },
            owner_vec.clone(),
        )?;
        let receipt_token = MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
        let wire = StoredCommittedRollbackV1 {
            restored: restored_out,
            trashed: trashed_out,
            restored_ranks: Vec::new(),
            skipped_manual_edits,
            skipped_room_active: skipped_room_active.clone(),
            receipt: receipt_token.clone(),
        };
        let resp_bytes = encode_msgpack(&wire)?;
        let sanitized = encode_msgpack(&StoredCommittedRollbackV1 {
            restored: Vec::new(),
            trashed: Vec::new(),
            restored_ranks: Vec::new(),
            skipped_manual_edits: wire.skipped_manual_edits,
            skipped_room_active,
            receipt: receipt_token,
        })?;
        let owner_key = format!("{}:{}", idemp.actor.as_str(), idemp.command_key.as_str());
        let resp_pid = format!("rcpt_pay:{owner_key}");

        let owner_nid_strs: Vec<&str> = owner_vec.iter().map(NoteId::as_str).collect();
        let chk_folders: Vec<&str> = planned_collision_checks
            .iter()
            .map(|(f, _, _, _)| f.as_str())
            .collect();
        let chk_slug_folds: Vec<&str> = planned_collision_checks
            .iter()
            .map(|(_, sf, _, _)| sf.as_str())
            .collect();

        let cat_digests_owned: Vec<[u8; 32]> = delta_by_digest.keys().copied().collect();
        let cat_deltas: Vec<i64> = delta_by_digest.values().copied().collect();
        let cat_digests: Vec<&[u8]> = cat_digests_owned.iter().map(|a| a.as_slice()).collect();

        let mut m_is_full: Vec<bool> = Vec::with_capacity(mut_rows.len());
        let mut m_nids: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_parents: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_slugs: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_slug_folds: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_titles: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_title_folds: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_doc_classes: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_abilities: Vec<Option<&str>> = Vec::with_capacity(mut_rows.len());
        let mut m_revs: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_parent_revs: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_restored_revs: Vec<Option<&str>> = Vec::with_capacity(mut_rows.len());
        let mut m_digests: Vec<Option<&[u8]>> = Vec::with_capacity(mut_rows.len());
        let mut m_pub_ids: Vec<Option<&str>> = Vec::with_capacity(mut_rows.len());
        let mut m_byte_sizes: Vec<i64> = Vec::with_capacity(mut_rows.len());
        let mut m_lifecycles: Vec<&str> = Vec::with_capacity(mut_rows.len());
        let mut m_vis_masks: Vec<i32> = Vec::with_capacity(mut_rows.len());
        let mut m_sseqs: Vec<i64> = Vec::with_capacity(mut_rows.len());
        let mut m_metas: Vec<&[u8]> = Vec::with_capacity(mut_rows.len());
        let mut m_op_kinds: Vec<&str> = Vec::with_capacity(mut_rows.len());
        for m in &mut_rows {
            m_is_full.push(m.is_full);
            m_nids.push(m.note_id);
            m_parents.push(m.parent_folder_id);
            m_slugs.push(m.slug);
            m_slug_folds.push(m.slug_fold);
            m_titles.push(m.title);
            m_title_folds.push(m.title_fold.as_str());
            m_doc_classes.push(m.doc_class_str);
            m_abilities.push(m.ability_id_str);
            m_revs.push(m.rev_id.as_str());
            m_parent_revs.push(m.parent_rev_str);
            m_restored_revs.push(m.restored_rev_str);
            m_digests.push(m.content_digest.as_ref().map(|d| d.as_bytes().as_slice()));
            m_pub_ids.push(m.pub_id_str);
            m_byte_sizes.push(m.byte_size);
            m_lifecycles.push(m.lifecycle_str);
            m_vis_masks.push(m.visibility_mask);
            m_sseqs.push(m.space_seq);
            m_metas.push(m.metadata_msgpack.as_slice());
            m_op_kinds.push(m.op_kind);
        }

        let delta_i64 = total_seqs as i64;
        let epoch_i64 = active_epoch.get() as i64;
        let before_i64 = current_effective_cut.get() as i64;
        let max_allowed_before = (SpaceSeq::MAX.get() - total_seqs) as i64;
        let first_i64 = first_seq.get() as i64;

        // Round-Trip 2: Single autocommit PL/pgSQL call executing unified single-CTE writes + synchronous WAL flush!
        auth.authorize_space_write(&space_obj)?;
        let apply_res = sqlx::query_scalar::<_, i64>(
            "SELECT notarium_pg_fast_rollback_apply_v1(
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26, $27, $28, $29, $30::TEXT[],
                $31::TEXT[], $32::TEXT[], $33::BYTEA[], $34::BIGINT[], $35::BOOL[], $36::TEXT[], $37::TEXT[], $38::TEXT[],
                $39::TEXT[], $40::TEXT[], $41::TEXT[], $42::TEXT[], $43::TEXT[], $44::TEXT[], $45::TEXT[], $46::TEXT[],
                $47::BYTEA[], $48::TEXT[], $49::BIGINT[], $50::TEXT[], $51::INT4[], $52::BIGINT[], $53::BYTEA[], $54::TEXT[]
            )",
        )
        .bind(scope_cl.space_id.as_str())
        .bind(scope_cl.incarnation.as_bytes().as_slice())
        .bind(epoch_i64)
        .bind(before_i64)
        .bind(max_allowed_before)
        .bind(delta_i64)
        .bind(first_i64)
        .bind(vis_i64)
        .bind(sec)
        .bind(nsec)
        .bind(committed_at_ms)
        .bind(expires_at_ms)
        .bind(actor_str)
        .bind(idemp.command_key.as_str())
        .bind(idemp.command_hash.as_bytes().as_slice())
        .bind(cmd_id.as_str())
        .bind(input.run.as_str())
        .bind(new_run_rev.as_str())
        .bind(run_meta.as_slice())
        .bind(owner_key.as_str())
        .bind(effect_draft.payload_id.as_str())
        .bind(effect_draft.codec.as_str())
        .bind(effect_draft.effect_msgpack.as_slice())
        .bind(resp_pid.as_str())
        .bind(resp_bytes.as_slice())
        .bind(sanitized.as_slice())
        .bind(noop_folder_id)
        .bind(has_full)
        .bind(has_trash)
        .bind(owner_nid_strs)
        .bind(chk_folders)
        .bind(chk_slug_folds)
        .bind(cat_digests)
        .bind(cat_deltas)
        .bind(m_is_full)
        .bind(m_nids)
        .bind(m_parents)
        .bind(m_slugs)
        .bind(m_slug_folds)
        .bind(m_titles)
        .bind(m_title_folds)
        .bind(m_doc_classes)
        .bind(m_abilities)
        .bind(m_revs)
        .bind(m_parent_revs)
        .bind(m_restored_revs)
        .bind(m_digests)
        .bind(m_pub_ids)
        .bind(m_byte_sizes)
        .bind(m_lifecycles)
        .bind(m_vis_masks)
        .bind(m_sseqs)
        .bind(m_metas)
        .bind(m_op_kinds)
        .fetch_one(&mut *conn)
        .await;

        match apply_res {
            Ok(code) => Ok((resp_bytes, visibility_seq, code)),
            Err(sqlx::Error::Database(db_err))
                if db_err.message().contains("NOTARIUM_RB_FALLBACK_0") =>
            {
                Ok((resp_bytes, visibility_seq, 0))
            }
            Err(sqlx::Error::Database(db_err)) => Err(internal_not_committed(
                "pg_fast_rb_apply_db_err",
                db_err.to_string(),
            )),
            Err(_transport_err) => {
                // Ambiguous autocommit outcome on transport/IO failure: consume held fences conservatively.
                for (mut guard, res) in locked_fences.drain(..) {
                    let _ = guard.consume(res, req_id);
                }
                Ok((resp_bytes, visibility_seq, i64::MIN))
            }
        }
    }
    .await;

    match prep_res {
        Ok((response_bytes, new_effective_cut, 1)) => {
            for (mut guard, res) in locked_fences {
                if let Err(err) = guard.consume(res, req_id) {
                    return PgFastInnerResult::UnknownCommit {
                        response_bytes,
                        diag_reason: format!("fence_consume_post_commit:{err:?}"),
                    };
                }
            }
            PgFastInnerResult::Committed {
                response_bytes,
                initial_cut: current_effective_cut,
                new_effective_cut,
            }
        }
        Ok((_, _, 0)) => {
            drop(locked_fences);
            PgFastInnerResult::FallbackToStandard
        }
        Ok((_, _, neg_idx)) if neg_idx < 0 && neg_idx > i64::MIN => {
            drop(locked_fences);
            let idx = ((-neg_idx) as usize).saturating_sub(1);
            let (folder_id, _, slug, is_root_child) = planned_collision_checks
                .get(idx)
                .cloned()
                .unwrap_or_else(|| (root_folder_id.clone(), String::new(), String::new(), true));
            PgFastInnerResult::Failed {
                err: DomainError::PathConflict {
                    target: PathTarget {
                        space_id: scope_cl.space_id.clone(),
                        parent: if is_root_child { None } else { Some(folder_id) },
                        component: slug,
                    },
                }
                .into(),
                effective_cut: Some(current_effective_cut),
            }
        }
        Ok((response_bytes, _, _)) => PgFastInnerResult::UnknownCommit {
            response_bytes,
            diag_reason: "pg_fast_rb_apply_ambiguous_io".to_owned(),
        },
        Err(err) => {
            drop(locked_fences);
            PgFastInnerResult::Failed {
                err,
                effective_cut: Some(current_effective_cut),
            }
        }
    }
}

use std::collections::{BTreeMap, BTreeSet, HashMap};

use notarium_core::{
    DomainError,
    auth::EngineAuthContext,
    classes::DocClass,
    error::{Diagnostic, PortError, ValidationReason},
    ids::{
        AbilityId, AgentRunId, ContentDigest, FolderId, HistoryIncarnation, LeaseEpoch, NoteId,
        RevisionId, SpaceId, SpaceSeq,
    },
    model::{HistoryScope, Lifecycle, PathTarget},
    ports::{
        ClosedRoomReservation, Committed, Mutation, NoteRevision, RollbackReservation,
        RollbackResult, SpaceContext,
    },
    receipt::{CommandIdentity, MutationReceiptToken},
    value::Timestamp,
};
use sqlx::Row;
use tokio::time::Instant;

use crate::{
    CanonicalStore,
    blobs::{BlobOwnerKind, ExistingBlobRefItem, bind_existing_active_blob_refs_batch_tx},
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        NoteRevisionMetadata, RevisionMetadataEnvelope, RevisionMetadataPayload, doc_class_to_db,
        encode_msgpack, encode_timestamp_parts, evaluate_fields_with_schema, i64_to_space_seq,
        internal_not_committed, lifecycle_to_db, new_prefixed_hex_id, new_revision_id,
        normalize_title_key, now_utc_timestamp, unavailable_retryable,
    },
    domain::{
        common::{
            FolderAncestryCache, StoredCommittedRollbackV1, load_current_space_schema_tx,
            load_note_heads_batch_tx, validate_mutation_identity,
        },
        notes::try_replay_completed_receipt,
    },
    runtime::{RevisionInsertItem, SpaceRecord, insert_revision_rows_batch_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent},
};

mod ability;
pub(crate) mod rank_removal;

const MAX_PLANNER_RETRIES: usize = 4;

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
    Restore {
        schema: Option<&'a crate::domain::common::CurrentSpaceSchema>,
        logical_updated_at: Option<Timestamp>,
    },
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
            if source.logical_updated_at.is_some() {
                result.to_mut().logical_updated_at = None;
            }
        }
        RollbackRevision::Restore {
            schema,
            logical_updated_at,
        } => {
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
            if source.logical_updated_at != logical_updated_at {
                result.to_mut().logical_updated_at = logical_updated_at;
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

#[derive(Clone, Debug)]
pub(crate) enum CandidateAction {
    TrashCreated {
        metadata: Box<NoteRevisionMetadata>,
        current_rev: RevisionId,
        current_lifecycle: Lifecycle,
        doc_class: DocClass,
        parent_folder_id: FolderId,
        content_digest: Option<ContentDigest>,
    },
    RestorePreExisting {
        current_rev: RevisionId,
        pre_rev_id: RevisionId,
        pre_meta: Box<NoteRevisionMetadata>,
        pre_updated_at: Option<Timestamp>,
        needs_note_mutation: bool,
        head_unchanged_placement: bool,
        current_cover_parent: Option<FolderId>,
    },
}

/// A run-created `AgentMemory` note that the same run also trashed still carries
/// `agent_run_id = Some(run)` on its latest tombstone revision. Emitting a fresh
/// rollback tombstone (`agent_run_id = None` at the rollback visibility cut) lets
/// `MEMORY_UNDONE_SLOT_SQL` recognize the undone creation and reopen the slot.
fn needs_trash_mutation(current_lifecycle: Lifecycle, doc_class: DocClass) -> bool {
    current_lifecycle != Lifecycle::Trashed || doc_class == DocClass::AgentMemory
}

type RoomGuard = tokio::sync::OwnedMutexGuard<notarium_core::ports::RoomFenceState>;

/// Validate every room transition before writing and keep each guard through settlement.
fn stage_rollback_fences(
    ctx: &mut crate::writer::ItemExecCtx,
    guards: Vec<(RoomGuard, ClosedRoomReservation)>,
    identity: &CommandIdentity,
) -> Result<(), PortError> {
    if guards.is_empty() {
        return Ok(());
    }
    let mut transitions = Vec::with_capacity(guards.len());
    for (guard, reservation) in guards {
        let mut next = (*guard).clone();
        next.consume(reservation, identity)?;
        transitions.push((guard, next));
    }
    ctx.on_commit_or_unknown(move || {
        for (mut guard, next) in transitions {
            *guard = next;
        }
    });
    Ok(())
}

struct RoomRollbackPlan {
    expected_run_rev: RevisionId,
    expected_heads: BTreeMap<NoteId, RevisionId>,
    reservations: BTreeMap<NoteId, ClosedRoomReservation>,
    skipped_room_active: BTreeSet<NoteId>,
}

struct RoomPlanDiscovery {
    space_epoch: LeaseEpoch,
    actual_run_rev: RevisionId,
    expected_heads: BTreeMap<NoteId, RevisionId>,
    candidates: BTreeMap<NoteId, RevisionId>,
    durable_blocked_rooms: BTreeSet<NoteId>,
    durable_fenced_rooms: BTreeSet<NoteId>,
}

fn rollback_needs_room_planning(store: &CanonicalStore, space: &SpaceId) -> bool {
    store.inner.collab_interceptor.get().is_some_and(|rooms| {
        rooms.space_has_live_rooms(space) || store.inner.room_fences.has_any_fenced_in_space(space)
    })
}

async fn rollback_writer_epoch(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    deadline: Instant,
) -> Result<LeaseEpoch, PortError> {
    if store.is_postgres() {
        return store.inner.writer_epoch(&ctx.scope().space_id);
    }
    Ok(rollback_wait(
        &ctx.budget,
        deadline,
        store.read_space_fast_or_pool(&ctx.scope().space_id, Some(&ctx.budget)),
    )
    .await??
    .active_epoch)
}

pub(crate) async fn rollback_agent_run_by_id(
    store: &CanonicalStore,
    mut ctx: SpaceContext,
    request: Mutation<AgentRunId>,
) -> Result<Committed<RollbackResult>, PortError> {
    let deadline = super::common::CommandDeadline::start(&ctx.budget, "rollback").at;
    validate_mutation_identity(&ctx, &request.identity)?;
    super::common::require_empty_preconditions(&request.preconditions)?;
    let idemp = super::common::derive_command_identity_spec(
        &ctx,
        &request.identity,
        "rollback_agent_run_by_id_v1",
        request.input.as_str().as_bytes(),
    )
    .with_policy(
        ctx.auth(),
        crate::writer::replay::ReplayPolicy::RollbackRun(request.input.clone()),
    );

    if !rollback_needs_room_planning(store, &ctx.scope().space_id) {
        let guard = store.enter_write_op(&ctx.scope().space_id)?;
        let epoch = rollback_writer_epoch(store, &ctx, deadline).await?;
        let intent = build_unified_rollback_intent(
            ctx.scope().clone(),
            epoch,
            idemp,
            ctx.auth().clone(),
            request.identity,
            request.input,
            store.inner.room_fences.clone(),
            None,
        );
        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        let done: StoredCommittedRollbackV1 = store
            .submit_write_command_until(&ctx.budget, deadline, intent, None, Some(guard))
            .await?;
        return Ok(done.into_committed());
    }

    execute_room_planned_rollback(store, &mut ctx, request, idemp, deadline).await
}

async fn execute_room_planned_rollback(
    store: &CanonicalStore,
    ctx: &mut SpaceContext,
    request: Mutation<AgentRunId>,
    idemp: crate::writer::CommandIdentitySpec,
    deadline: Instant,
) -> Result<Committed<RollbackResult>, PortError> {
    ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
    if let Some(replayed) = rollback_wait(
        &ctx.budget,
        deadline,
        try_replay_completed_receipt::<StoredCommittedRollbackV1>(
            store,
            ctx.scope(),
            &idemp,
            Some(&ctx.budget),
        ),
    )
    .await??
    {
        return Ok(replayed.into_committed());
    }

    let mut attempt = 0;
    let mut replanned_after_recovery = false;
    while attempt < MAX_PLANNER_RETRIES {
        if let Some(effect) = ctx.canonical_effect() {
            effect.check()?;
        }
        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        let scope_read = ctx.scope().clone();
        let auth_read = ctx.auth().clone();
        let run_read = request.input.clone();
        let discovery = match rollback_wait(
            &ctx.budget,
            deadline,
            store.with_read_tx_budget(Some(&ctx.budget), |tx| {
                Box::pin(async move {
                    discover_room_plan_tx(tx, &scope_read, &auth_read, &run_read).await
                })
            }),
        )
        .await?
        {
            Ok(found) => found,
            Err(err @ PortError::Domain(DomainError::ResourceNotFound)) => {
                ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
                if let Some(replayed) = rollback_wait(
                    &ctx.budget,
                    deadline,
                    try_replay_completed_receipt::<StoredCommittedRollbackV1>(
                        store,
                        ctx.scope(),
                        &idemp,
                        Some(&ctx.budget),
                    ),
                )
                .await??
                {
                    return Ok(replayed.into_committed());
                }
                return Err(err);
            }
            Err(err) => return Err(err),
        };

        // Reserve closed rooms in ascending NoteId order outside the writer transaction.
        let mut skipped_room_active = BTreeSet::new();
        let mut reservations = BTreeMap::new();
        let mut recovered_any = false;
        let interceptor = store.inner.collab_interceptor.get();
        let fences = &store.inner.room_fences;
        let space_id = ctx.scope().space_id.clone();

        for (nid, current_rev) in &discovery.candidates {
            let was_fenced = discovery.durable_fenced_rooms.contains(nid);
            let was_blocked = was_fenced || discovery.durable_blocked_rooms.contains(nid);
            // A durably fenced room must always flow through `interceptor.reserve_rollback`
            // so clean fenced recovery does not get misclassified as `skipped_room_active`.
            if was_blocked
                && (interceptor.is_none()
                    || (!was_fenced
                        && !fences.is_room_fenced(&space_id, nid)
                        && fences
                            .fenced_recovery_revision(&space_id, nid, current_rev)
                            .is_none()))
            {
                skipped_room_active.insert(nid.clone());
                continue;
            }
            if let Some(effect) = ctx.canonical_effect() {
                effect.check()?;
            }
            ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
            let reservation = rollback_wait(&ctx.budget, deadline, async {
                if let Some(interceptor) = interceptor {
                    interceptor
                        .reserve_rollback(ctx.clone(), nid.clone(), request.identity.clone())
                        .await
                } else {
                    fences
                        .reserve_rollback(ctx.scope(), nid, request.identity.clone())
                        .await
                }
            })
            .await??;
            match reservation {
                RollbackReservation::SkippedRoomActive => {
                    skipped_room_active.insert(nid.clone());
                }
                RollbackReservation::Closed(closed_res) => {
                    if was_blocked
                        && fences
                            .fenced_recovery_revision(&space_id, nid, current_rev)
                            .is_some()
                    {
                        recovered_any = true;
                        continue;
                    }
                    reservations.insert(nid.clone(), closed_res);
                }
            }
        }

        if recovered_any {
            if replanned_after_recovery {
                return Err(unavailable_retryable(
                    "rollback_room_revision_contention",
                    "additional rooms recovered while planning the rollback",
                    std::time::Duration::from_millis(10),
                ));
            }
            replanned_after_recovery = true;
            continue;
        }

        attempt += 1;
        let plan = RoomRollbackPlan {
            expected_run_rev: discovery.actual_run_rev,
            expected_heads: discovery.expected_heads,
            reservations,
            skipped_room_active,
        };
        let intent = build_unified_rollback_intent(
            ctx.scope().clone(),
            discovery.space_epoch,
            idemp.clone(),
            ctx.auth().clone(),
            request.identity.clone(),
            request.input.clone(),
            store.inner.room_fences.clone(),
            Some(plan),
        );

        ctx.budget.remaining = rollback_time_left(&ctx.budget, deadline)?;
        match store
            .submit_write_command_until::<StoredCommittedRollbackV1>(
                &ctx.budget,
                deadline,
                intent,
                None,
                None,
            )
            .await
        {
            Ok(decoded) => return Ok(decoded.into_committed()),
            Err(PortError::Domain(DomainError::ValidationFailed {
                diagnostic:
                    Diagnostic {
                        reason: ValidationReason::CursorStale,
                        ..
                    },
            })) if attempt < MAX_PLANNER_RETRIES => continue,
            Err(err) => return Err(err),
        }
    }

    Err(unavailable_retryable(
        "rollback_planner_cut_contention",
        "rollback room planning contended across bounded retries",
        std::time::Duration::from_millis(10),
    ))
}

async fn discover_room_plan_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    auth: &EngineAuthContext,
    run: &AgentRunId,
) -> Result<RoomPlanDiscovery, PortError> {
    let srec = load_space_record(tx, &scope.space_id).await?;
    srec.scope.check(scope)?;
    auth.authorize_space_write(&srec.space)?;
    ensure_chat_run_not_active_tx(tx, &srec.space, auth, run).await?;

    let actual_run_rev = load_run_revision_only_tx(tx, &srec.scope, run).await?;
    let histories = load_direct_rollback_histories(tx, &scope.space_id, run).await?;
    let touched: Vec<NoteId> = histories.keys().cloned().collect();
    let states = load_rollback_note_states(
        tx,
        &scope.space_id,
        touched.iter().map(NoteId::as_str).collect(),
    )
    .await?;
    if !states.purged.is_empty() {
        return Err(DomainError::ResourceNotFound.into());
    }
    let heads_map = load_note_heads_batch_tx(tx, &scope.space_id, &touched).await?;
    let mut folder_cache = FolderAncestryCache::default();
    let mut expected_heads = BTreeMap::new();

    if touched.is_empty() {
        auth.can_view_folder(
            &srec.space,
            &srec.root_folder_id,
            std::slice::from_ref(&srec.root_folder_id),
        )?;
    }

    // Authorize every touched note before inspecting ability publication state so
    // unauthorized/purged notes always fail with ResourceNotFound first.
    for nid in &touched {
        let head = heads_map.get(nid).ok_or(DomainError::ResourceNotFound)?;
        let (rfacts, anc) = folder_cache
            .build_resource_facts_tx(
                tx,
                &srec.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                false,
            )
            .await?;
        if anc.folder_lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound.into());
        }
        auth.can_view_resource(&rfacts)?;
        auth.authorize_direct_write(&rfacts, &rfacts)?;
        expected_heads.insert(nid.clone(), head.head_rev_id.clone());
    }

    let mut candidates = BTreeMap::new();
    let mut durable_blocked_rooms = BTreeSet::new();
    let mut durable_fenced_rooms = BTreeSet::new();

    for (nid, history) in &histories {
        let head = heads_map.get(nid).ok_or(DomainError::ResourceNotFound)?;
        if history.foreign_edit {
            continue;
        }
        if (head.doc_class == DocClass::Skill || head.ability_id.is_some())
            && ability::has_later_foreign_publication(
                tx,
                &srec.scope,
                head,
                history.first_seq,
                run,
                history.prior.is_none(),
            )
            .await?
        {
            continue;
        }
        match states.rooms.get(nid).copied() {
            Some(DurableRoomStatus::Fenced) => {
                durable_fenced_rooms.insert(nid.clone());
            }
            Some(DurableRoomStatus::Blocked) => {
                durable_blocked_rooms.insert(nid.clone());
            }
            Some(DurableRoomStatus::Clean) | None => {}
        }
        candidates.insert(nid.clone(), head.head_rev_id.clone());
    }

    Ok(RoomPlanDiscovery {
        space_epoch: srec.active_epoch,
        actual_run_rev,
        expected_heads,
        candidates,
        durable_blocked_rooms,
        durable_fenced_rooms,
    })
}

#[allow(clippy::too_many_arguments)]
fn build_unified_rollback_intent(
    scope: HistoryScope,
    active_epoch: LeaseEpoch,
    idemp: crate::writer::CommandIdentitySpec,
    auth: EngineAuthContext,
    req_id: CommandIdentity,
    run: AgentRunId,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
    room_plan: Option<RoomRollbackPlan>,
) -> PreparedWriteIntent {
    let source_note_ids = room_plan
        .as_ref()
        .map(|plan| plan.expected_heads.keys().cloned().collect())
        .unwrap_or_default();
    PreparedWriteIntent {
        scope: scope.clone(),
        active_epoch,
        idempotency: Some(idemp),
        source_note_ids,
        staged_bytes: 0,
        required_semantic_cut: None,
        execute: Box::new(move |tx, item_ctx| {
            Box::pin(async move {
                execute_unified_rollback_tx(
                    tx,
                    item_ctx,
                    scope,
                    auth,
                    req_id,
                    run,
                    room_fences,
                    room_plan,
                )
                .await
            })
        }),
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_unified_rollback_tx(
    tx: &mut BackendConn<'_>,
    item_ctx: &mut crate::writer::ItemExecCtx,
    scope_cl: HistoryScope,
    auth: EngineAuthContext,
    req_id: CommandIdentity,
    run: AgentRunId,
    room_fences: std::sync::Arc<crate::domain::RoomFenceTable>,
    mut room_plan: Option<RoomRollbackPlan>,
) -> Result<ItemCommitArtifacts, PortError> {
    auth.authorize_space_write(&item_ctx.space)?;
    ensure_chat_run_not_active_tx(tx, &item_ctx.space, &auth, &run).await?;

    let mut folder_cache = FolderAncestryCache::default();
    type RollbackStateProbe = (bool, Option<bool>, bool, Option<(Vec<u8>, String)>);
    let (has_note_states, known_overlays, read_schema, run_head_opt): RollbackStateProbe = match tx
    {
        BackendConn::Postgres(conn) => {
            let row = sqlx::query(
                    "SELECT (EXISTS(SELECT 1 FROM revision_purge_fences WHERE space_id = $1) OR
                             EXISTS(SELECT 1 FROM collab_sessions WHERE space_id = $1)) AS has_note_states,
                            history_incarnation, run_revision
                     FROM agent_run_heads WHERE space_id = $1 AND run_id = $2",
                )
                .bind(scope_cl.space_id.as_str())
                .bind(run.as_str())
                .fetch_optional(&mut **conn)
                .await
                .map_err(|err| internal_not_committed("pg_rb_combined_probe", err.to_string()))?
                .ok_or(DomainError::ResourceNotFound)?;
            (
                row.get("has_note_states"),
                None,
                true,
                Some((row.get("history_incarnation"), row.get("run_revision"))),
            )
        }
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                    "SELECT (EXISTS(SELECT 1 FROM revision_purge_fences WHERE space_id = ?1) OR
                             EXISTS(SELECT 1 FROM collab_sessions WHERE space_id = ?1)) AS has_note_states,
                            EXISTS(SELECT 1 FROM view_rank_overlays WHERE space_id = ?1) AS has_ov,
                            EXISTS(SELECT 1 FROM space_field_schemas WHERE space_id = ?1 AND is_current = 1) AS has_schema,
                            arh.history_incarnation, arh.run_revision
                     FROM (SELECT 1)
                     LEFT JOIN agent_run_heads arh ON arh.space_id = ?1 AND arh.run_id = ?2",
                )
                .bind(scope_cl.space_id.as_str())
                .bind(run.as_str())
                .fetch_one(&mut **conn)
                .await
                .map_err(|e| internal_not_committed("sqlite_rb_combined_probe", e.to_string()))?;
            let incarnation: Option<Vec<u8>> = row.get("history_incarnation");
            (
                row.get("has_note_states"),
                Some(row.get("has_ov")),
                row.get("has_schema"),
                incarnation.zip(row.get("run_revision")),
            )
        }
    };

    let Some((inc_bytes, run_rev_raw)) = run_head_opt else {
        return Err(DomainError::ResourceNotFound.into());
    };
    let actual_run_rev = scoped_run_revision(&scope_cl, &inc_bytes, &run_rev_raw)?;

    let histories = load_direct_rollback_histories(tx, &scope_cl.space_id, &run).await?;
    let touched: Vec<NoteId> = histories.keys().cloned().collect();
    let states = if has_note_states {
        let ids = touched.iter().map(NoteId::as_str).collect();
        load_rollback_note_states(tx, &scope_cl.space_id, ids).await?
    } else {
        RollbackNoteStates::default()
    };
    if !states.purged.is_empty() {
        return Err(DomainError::ResourceNotFound.into());
    }

    let mut heads_map = load_note_heads_batch_tx(tx, &scope_cl.space_id, &touched).await?;

    if touched.is_empty() {
        auth.can_view_folder(
            &item_ctx.space,
            &item_ctx.root_folder_id,
            std::slice::from_ref(&item_ctx.root_folder_id),
        )?;
    }

    for nid in &touched {
        let head = heads_map.get(nid).ok_or(DomainError::ResourceNotFound)?;
        let (rfacts, anc) = folder_cache
            .build_resource_facts_tx(
                tx,
                &item_ctx.space,
                &head.parent_folder_id,
                head.doc_class,
                head.ability_id.clone(),
                false,
            )
            .await?;
        if anc.folder_lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound.into());
        }
        auth.can_view_resource(&rfacts)?;
        auth.authorize_direct_write(&rfacts, &rfacts)?;
    }

    if let Some(plan) = &room_plan {
        let heads_match = actual_run_rev == plan.expected_run_rev
            && heads_map.len() == plan.expected_heads.len()
            && plan
                .expected_heads
                .iter()
                .all(|(nid, rev)| heads_map.get(nid).is_some_and(|h| &h.head_rev_id == rev));
        if !heads_match {
            return Err(DomainError::validation(ValidationReason::CursorStale).into());
        }
    }

    let collab_states = states.rooms;
    let mut skipped_manual_edits = Vec::new();
    let mut skipped_room_active = Vec::new();
    let mut eligible_notes: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();

    for (nid, history) in histories {
        let head = heads_map
            .remove(&nid)
            .ok_or(DomainError::ResourceNotFound)?;
        if history.foreign_edit {
            skipped_manual_edits.push(nid);
            continue;
        }
        if (head.doc_class == DocClass::Skill || head.ability_id.is_some())
            && ability::has_later_foreign_publication(
                tx,
                &scope_cl,
                &head,
                history.first_seq,
                &run,
                history.prior.is_none(),
            )
            .await?
        {
            skipped_manual_edits.push(nid);
            continue;
        }
        if let Some(plan) = &room_plan {
            if plan.skipped_room_active.contains(&nid) {
                skipped_room_active.push(nid);
                continue;
            }
        } else if collab_states
            .get(&nid)
            .is_some_and(|status| status.is_blocked())
        {
            skipped_room_active.push(nid);
            continue;
        }

        let current_cover_parent = if head.slug_fold == super::folder_cover::SLUG
            && crate::runtime::load_folder_head_row(tx, &scope_cl.space_id, &head.parent_folder_id)
                .await?
                .cover_note_id
                .as_ref()
                == Some(&nid)
        {
            Some(head.parent_folder_id.clone())
        } else {
            None
        };

        let action = match history.prior {
            None => {
                let mut metadata = decode_rollback_note(
                    history.current_metadata.as_deref().ok_or_else(|| {
                        internal_not_committed(
                            "rollback_missing_head",
                            "current note revision is missing",
                        )
                    })?,
                    &nid,
                )?;
                metadata.folder_page |= current_cover_parent.is_some();
                ability::retain_binding(&mut metadata, &head)?;
                CandidateAction::TrashCreated {
                    metadata: Box::new(metadata),
                    current_rev: head.head_rev_id,
                    current_lifecycle: head.lifecycle,
                    doc_class: head.doc_class,
                    parent_folder_id: head.parent_folder_id,
                    content_digest: head.content_digest,
                }
            }
            Some((pre_rev_id, meta_bytes, pre_updated_at)) => {
                let mut pre_meta = decode_rollback_note(&meta_bytes, &nid)?;
                ability::retain_binding(&mut pre_meta, &head)?;
                let head_unchanged_placement = head.lifecycle == pre_meta.lifecycle
                    && head.parent_folder_id == pre_meta.parent_folder_id
                    && head.slug == pre_meta.slug
                    && head.slug_fold == pre_meta.slug_fold;
                let needs_note_mutation =
                    head.head_rev_id != pre_rev_id || !head_unchanged_placement;
                let pre_updated_at = pre_meta.logical_updated_at.or(pre_updated_at);
                CandidateAction::RestorePreExisting {
                    current_rev: head.head_rev_id,
                    pre_rev_id,
                    pre_meta: Box::new(pre_meta),
                    pre_updated_at,
                    needs_note_mutation,
                    head_unchanged_placement,
                    current_cover_parent,
                }
            }
        };

        eligible_notes.insert(nid, action);
    }

    // Lock per-note fences in ascending NoteId order before collision checks so no room can open/close
    // concurrently and any PathConflict drops the guards without bumping fence epochs.
    let planned = room_plan.is_some();
    let map_planned_stale = |err: PortError| -> PortError {
        if planned
            && matches!(
                err,
                PortError::Domain(DomainError::ValidationFailed {
                    diagnostic: Diagnostic {
                        reason: ValidationReason::SourceMismatch,
                        ..
                    },
                })
            )
        {
            DomainError::validation(ValidationReason::CursorStale).into()
        } else {
            err
        }
    };
    let mut final_eligible: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
    let mut locked_fences = Vec::with_capacity(eligible_notes.len());
    if let Some(plan) = room_plan.as_mut() {
        for (nid, action) in eligible_notes {
            let Some(mut res) = plan.reservations.remove(&nid) else {
                return Err(DomainError::validation(ValidationReason::CursorStale).into());
            };
            let guard = room_fences
                .lock_for_consume(&scope_cl, &nid, &mut res)
                .map_err(map_planned_stale)?;
            if collab_states
                .get(&nid)
                .is_some_and(|status| status.is_blocked())
            {
                return Err(DomainError::validation(ValidationReason::CursorStale).into());
            }
            locked_fences.push((guard, res));
            final_eligible.insert(nid, action);
        }
    } else {
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
    }
    skipped_room_active.sort();

    let eligible_all_ids: BTreeSet<NoteId> = final_eligible.keys().cloned().collect();
    let mut planned_active_slots: HashMap<(FolderId, String), NoteId> = HashMap::new();
    let mut planned_collision_checks: Vec<(FolderId, String, String, bool)> = Vec::new();
    let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();
    let mut restored_ability_slots = Vec::new();

    for (nid, action) in &final_eligible {
        if let CandidateAction::RestorePreExisting {
            pre_meta,
            needs_note_mutation,
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
                if *needs_note_mutation && let Some(ability) = &pre_meta.ability_id {
                    restored_ability_slots.push((ability, &pre_meta.slug_fold, anc.project));
                }
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

    verify_no_active_non_eligible_collisions_batch_tx(
        tx,
        &scope_cl.space_id,
        &planned_collision_checks,
        &eligible_all_ids,
    )
    .await?;

    stage_rollback_fences(item_ctx, locked_fences, &req_id).map_err(map_planned_stale)?;

    let current_schema = if read_schema {
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
                    doc_class,
                    ..
                } if needs_trash_mutation(*current_lifecycle, *doc_class)
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
    let has_ov = match known_overlays {
        Some(present) => present,
        None => {
            final_eligible
                .values()
                .any(|action| rank_removal::removes_ranks(Some(action)))
                && has_any_overlays_in_space_tx(tx, &scope_cl.space_id).await?
        }
    };
    let rank_removals = if has_ov {
        rank_removal::plan_tx(tx, &scope_cl.space_id, &final_eligible).await?
    } else {
        Vec::new()
    };

    let mut planned_covers = BTreeMap::new();
    let mut restored_covers = Vec::new();
    for (note, action) in &final_eligible {
        match action {
            CandidateAction::TrashCreated {
                current_lifecycle: Lifecycle::Active,
                metadata,
                parent_folder_id,
                ..
            } if metadata.folder_page => {
                planned_covers.insert(parent_folder_id, None);
            }
            CandidateAction::RestorePreExisting {
                pre_meta,
                current_cover_parent,
                needs_note_mutation: true,
                ..
            } => {
                if let Some(folder) = current_cover_parent {
                    planned_covers.insert(folder, None);
                }
                if pre_meta.folder_page && pre_meta.lifecycle == Lifecycle::Active {
                    restored_covers.push((&pre_meta.parent_folder_id, Some(note)));
                }
            }
            _ => {}
        }
    }
    planned_covers.extend(restored_covers);
    let mut cover_changes = Vec::with_capacity(planned_covers.len());
    for (folder, cover) in planned_covers {
        let row = crate::runtime::load_folder_head_row(tx, &scope_cl.space_id, folder).await?;
        if row.cover_note_id.as_ref() != cover {
            cover_changes.push((folder, cover));
        }
    }

    let total_seqs = (trash_note_count
        + restore_note_count
        + cover_changes.len() as u64
        + rank_removals.len() as u64)
        .max(1);
    let (first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
    let vis_i64 = visibility_seq.get() as i64;
    let now_ts = now_utc_timestamp()?;
    let (sec, nsec) = encode_timestamp_parts(now_ts);

    let mut events = Vec::with_capacity(total_seqs as usize);
    let mut trashed_out = Vec::with_capacity(trash_note_count as usize);
    let mut restored_out = Vec::with_capacity(restore_note_count as usize);
    let mut owner_notes_for_receipt: BTreeSet<NoteId> = BTreeSet::new();
    let mut changed_packages = Vec::new();

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
    let mut pending_rev_rows: Vec<PendingSingleRev> = Vec::with_capacity(final_eligible.len() + 1);
    let mut pending_trash_heads: Vec<(NoteId, RevisionId)> =
        Vec::with_capacity(trash_note_count as usize);

    // Trash run-created notes FIRST to vacate active slugs before restoring pre-existing notes.
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

        if !needs_trash_mutation(*current_lifecycle, *doc_class) {
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
        if let Some(ability) = &metadata.ability_id {
            changed_packages.push((nid, ability));
        }
        if collab_states.contains_key(nid) {
            bump_closed_collab_session_lineage_tx(tx, &scope_cl.space_id, nid, &trev, vis_i64)
                .await?;
        }

        let meta =
            encode_rollback_note(metadata, None, anc.is_root_child, RollbackRevision::Trash)?;

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
            pre_updated_at,
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

        let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
            normalize_title_key(&pre_meta.slug)
        } else {
            normalize_title_key(&pre_meta.title)
        };
        if let Some(ability) = &pre_meta.ability_id {
            changed_packages.push((nid, ability));
        }
        let (head_updated_sec, head_updated_nsec) = pre_updated_at
            .map(encode_timestamp_parts)
            .unwrap_or((sec, nsec));

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
            updated_at_sec: head_updated_sec,
            updated_at_nsec: head_updated_nsec,
        });

        if collab_states.contains_key(nid) {
            bump_closed_collab_session_lineage_tx(tx, &scope_cl.space_id, nid, &rrev, vis_i64)
                .await?;
        }

        let meta = encode_rollback_note(
            pre_meta,
            None,
            is_root_child,
            RollbackRevision::Restore {
                schema: current_schema.as_ref(),
                logical_updated_at: *pre_updated_at,
            },
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

    let new_run_rev = new_revision_id()?;
    let run_meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::AgentRun(
        crate::codec::AgentRunRevisionMetadata {
            run_id: run.clone(),
            last_seq: visibility_seq,
        },
    ))
    .encode()?;
    pending_rev_rows.push(PendingSingleRev {
        rev_id: new_run_rev.clone(),
        entity_type: "agent_run",
        entity_key: run.as_str().to_owned(),
        space_seq: visibility_seq,
        parent_rev_id: None,
        restored_from_rev_id: None,
        content_blake3: None,
        metadata_msgpack: run_meta,
        agent_run_id: Some(run.clone()),
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

    if let BackendConn::Postgres(conn) = &mut *tx {
        execute_pg_rollback_domain_writes_cte(
            conn,
            &scope_cl,
            &run,
            &new_run_rev,
            vis_i64,
            sec,
            nsec,
            auth.principal().as_str(),
            &pending_restore_heads,
            &rev_items,
        )
        .await?;
    } else {
        update_note_heads_restored_batch_tx(
            tx,
            &scope_cl.space_id,
            &pending_restore_heads,
            vis_i64,
            auth.principal().as_str(),
        )
        .await?;

        let pending_blob_rebinds: Vec<_> = rev_items
            .iter()
            .filter(|revision| revision.entity_type == "note")
            .filter_map(|revision| {
                Some(ExistingBlobRefItem {
                    owner_kind: BlobOwnerKind::NoteRevision,
                    owner_id: revision.entity_key.to_owned(),
                    owner_rev_id: revision.rev_id.as_str().to_owned(),
                    resource_key: "carrier",
                    digest: revision.content_blake3?,
                    created_seq: revision.space_seq,
                })
            })
            .collect();
        bind_existing_active_blob_refs_batch_tx(tx, &scope_cl.space_id, &pending_blob_rebinds)
            .await?;

        insert_revision_rows_batch_tx(tx, &scope_cl, &rev_items).await?;

        upsert_agent_run_head_row_only_tx(tx, &scope_cl, &run, &new_run_rev, vis_i64, sec, nsec)
            .await?;
    }

    for (note, ability) in changed_packages {
        ability::sync_entrypoint(tx, &scope_cl.space_id, note, ability).await?;
    }
    // Final heads include every package arriving in or leaving the same project.
    for (ability, slug, project) in restored_ability_slots {
        super::packages::check_restored_ability_slot_tx(
            tx,
            &scope_cl.space_id,
            ability,
            slug,
            project.as_ref(),
        )
        .await?;
    }

    for (folder, cover) in cover_changes {
        let cseq = item_ctx.alloc_next_seq()?;
        if let Some(event) = super::folder_cover::assign(
            tx,
            &scope_cl,
            folder,
            cover,
            cseq,
            visibility_seq,
            auth.principal(),
            None,
            now_ts,
        )
        .await?
        {
            events.push(event);
        }
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
        skipped_manual_edits,
        skipped_room_active,
        receipt: receipt_token.clone(),
    };
    let resp_bytes = encode_msgpack(&wire)?;
    let sanitized = encode_msgpack(&StoredCommittedRollbackV1::sanitized(receipt_token))?;

    Ok(ItemCommitArtifacts {
        command_id: new_prefixed_hex_id("cmd_")?,
        command_kind: "rollback_agent_run".to_owned(),
        events,
        change_payload: Some(effect_draft),
        receipt_detail_blob: Some(resp_bytes.clone()),
        receipt_sanitized_blob: sanitized,
        receipt_owner_note_ids: wire.receipt_owners(owner_vec),
        response_bytes: resp_bytes,
    })
}

#[derive(sqlx::FromRow)]
struct RollbackReplayHeadRow {
    incarnation: Vec<u8>,
    run_revision: String,
    note_id: Option<String>,
    parent_folder_id: Option<String>,
    doc_class: Option<String>,
    ability_id: Option<String>,
    purged: bool,
}

pub(crate) async fn authorize_rollback_run_replay_tx(
    tx: &mut BackendConn<'_>,
    record: &SpaceRecord,
    auth: &EngineAuthContext,
    run: &AgentRunId,
) -> Result<(), PortError> {
    const SQL: &str = "WITH notes AS (
        SELECT DISTINCT entity_key AS note_id FROM revisions
        WHERE space_id = $1 AND agent_run_id = $2 AND entity_type = 'note'
    )
    SELECT r.history_incarnation AS incarnation, r.run_revision, n.note_id,
           h.parent_folder_id, h.doc_class, h.ability_id,
           EXISTS (SELECT 1 FROM revision_purge_fences p
                   WHERE p.space_id = $1 AND p.note_id = n.note_id) AS purged
    FROM agent_run_heads r LEFT JOIN notes n ON TRUE
    LEFT JOIN note_heads h ON h.space_id = $1 AND h.note_id = n.note_id
    WHERE r.space_id = $1 AND r.run_id = $2
    ORDER BY n.note_id";

    let scope = &record.scope;
    auth.authorize_space_write(&record.space)?;
    let rows: Vec<RollbackReplayHeadRow> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(SQL)
            .bind(scope.space_id.as_str())
            .bind(run.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| internal_not_committed("sqlite_rollback_heads", error.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(SQL)
            .bind(scope.space_id.as_str())
            .bind(run.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|error| crate::runtime::pg_read_error("pg_rollback_heads", error))?,
    };
    let run_head = rows.first().ok_or(DomainError::ResourceNotFound)?;
    let _ = scoped_run_revision(scope, &run_head.incarnation, &run_head.run_revision)?;
    if rows.iter().any(|row| row.purged) {
        return Err(DomainError::ResourceNotFound.into());
    }
    if rows.iter().all(|row| row.note_id.is_none()) {
        auth.can_view_folder(
            &record.space,
            &record.root_folder_id,
            std::slice::from_ref(&record.root_folder_id),
        )?;
        return Ok(());
    }
    let mut folders = FolderAncestryCache::default();
    for row in rows {
        let Some(_) = row.note_id else {
            continue;
        };
        let (Some(parent), Some(class)) = (row.parent_folder_id, row.doc_class) else {
            return Err(DomainError::ResourceNotFound.into());
        };
        let parent = FolderId::parse(&parent).map_err(|_| {
            internal_not_committed("corrupt_note_parent", "invalid parent_folder_id")
        })?;
        let ability = row
            .ability_id
            .as_deref()
            .map(AbilityId::parse)
            .transpose()
            .map_err(|_| internal_not_committed("corrupt_ability_id", "invalid ability_id"))?;
        let (facts, anc) = folders
            .build_resource_facts_tx(
                tx,
                &record.space,
                &parent,
                crate::codec::doc_class_from_db(&class)?,
                ability,
                true,
            )
            .await?;
        if anc.folder_lifecycle == Lifecycle::Purged {
            return Err(DomainError::ResourceNotFound.into());
        }
        auth.can_view_resource(&facts)?;
        auth.authorize_direct_write(&facts, &facts)?;
    }
    Ok(())
}

async fn authorize_rollback_destination_tx(
    tx: &mut BackendConn<'_>,
    cache: &mut FolderAncestryCache,
    space: &notarium_core::auth::Space,
    auth: &EngineAuthContext,
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
    if anc.folder_lifecycle == Lifecycle::Purged {
        return Err(DomainError::ResourceNotFound.into());
    }
    auth.authorize_direct_write(&after, &after)?;
    Ok(anc)
}

async fn ensure_chat_run_not_active_tx(
    tx: &mut BackendConn<'_>,
    space: &notarium_core::auth::Space,
    auth: &EngineAuthContext,
    run: &AgentRunId,
) -> Result<(), PortError> {
    let rows: Vec<(String, String, String, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_as(
            "SELECT thread_id, kind, owner_id, project_folder_id
             FROM chat_threads
             WHERE space_id = ? AND active_run_id IS NOT NULL AND active_run_id = ?",
        )
        .bind(space.id.as_str())
        .bind(run.as_str())
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_rollback_active_chat", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_as(
            "SELECT thread_id, kind, owner_id, project_folder_id
             FROM chat_threads
             WHERE space_id = $1 AND active_run_id IS NOT NULL AND active_run_id = $2",
        )
        .bind(space.id.as_str())
        .bind(run.as_str())
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_rollback_active_chat", err))?,
    };
    if rows.is_empty() {
        return Ok(());
    }
    let mut visible = false;
    for (tid, kind_raw, owner_raw, project_raw) in rows {
        let thread_id = notarium_core::ids::ChatThreadId::parse(&tid).map_err(|_| {
            internal_not_committed("corrupt_active_chat_thread", "invalid thread_id")
        })?;
        let kind = match kind_raw.as_str() {
            "personal" => notarium_core::ports::ChatThreadKind::Personal,
            "space_group" => notarium_core::ports::ChatThreadKind::SpaceGroup,
            "keeper_log" => notarium_core::ports::ChatThreadKind::KeeperLog,
            _ => {
                return Err(internal_not_committed(
                    "corrupt_active_chat_kind",
                    "unknown thread kind",
                ));
            }
        };
        let owner = notarium_core::ids::PrincipalId::parse(&owner_raw)
            .map_err(|_| internal_not_committed("corrupt_active_chat_owner", "invalid owner_id"))?;
        let project = project_raw
            .as_deref()
            .map(FolderId::parse)
            .transpose()
            .map_err(|_| {
                internal_not_committed("corrupt_active_chat_project", "invalid project_folder_id")
            })?;
        if auth
            .can_view_chat_thread(space, &thread_id, kind, &owner, project.as_ref(), false)
            .is_ok()
        {
            visible = true;
            break;
        }
    }
    if visible {
        return Err(DomainError::validation(ValidationReason::InvalidState).into());
    }
    let has_run_head: bool = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_run_heads WHERE space_id = ? AND run_id = ?)",
        )
        .bind(space.id.as_str())
        .bind(run.as_str())
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| {
            internal_not_committed("sqlite_rollback_run_head_exists", err.to_string())
        })?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_run_heads WHERE space_id = $1 AND run_id = $2)",
        )
        .bind(space.id.as_str())
        .bind(run.as_str())
        .fetch_one(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_rollback_run_head_exists", err))?,
    };
    if has_run_head {
        let touched = load_run_touched_notes_tx(tx, &space.id, run).await?;
        if !touched.is_empty() {
            let states = load_rollback_note_states(
                tx,
                &space.id,
                touched.iter().map(NoteId::as_str).collect(),
            )
            .await?;
            if states.purged.is_empty() {
                let heads_map = load_note_heads_batch_tx(tx, &space.id, &touched).await?;
                let mut folder_cache = FolderAncestryCache::default();
                let mut authorized = true;
                for nid in &touched {
                    let Some(head) = heads_map.get(nid) else {
                        authorized = false;
                        break;
                    };
                    let (rfacts, anc) = folder_cache
                        .build_resource_facts_tx(
                            tx,
                            space,
                            &head.parent_folder_id,
                            head.doc_class,
                            head.ability_id.clone(),
                            false,
                        )
                        .await?;
                    if anc.folder_lifecycle == Lifecycle::Purged
                        || auth.can_view_resource(&rfacts).is_err()
                        || auth.authorize_direct_write(&rfacts, &rfacts).is_err()
                    {
                        authorized = false;
                        break;
                    }
                }
                if authorized {
                    return Err(DomainError::validation(ValidationReason::InvalidState).into());
                }
            }
        }
    }
    Err(DomainError::ResourceNotFound.into())
}

async fn load_run_revision_only_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    run: &AgentRunId,
) -> Result<RevisionId, PortError> {
    let run_row: Option<(Vec<u8>, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let row = sqlx::query(
                "SELECT history_incarnation, run_revision FROM agent_run_heads
                 WHERE space_id = ? AND run_id = ?",
            )
            .bind(scope.space_id.as_str())
            .bind(run.as_str())
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
            .bind(run.as_str())
            .fetch_optional(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_load_run_head", err))?;
            row.map(|r| (r.get("history_incarnation"), r.get("run_revision")))
        }
    };
    let Some((inc_bytes, run_rev_raw)) = run_row else {
        return Err(DomainError::ResourceNotFound.into());
    };
    scoped_run_revision(scope, &inc_bytes, &run_rev_raw)
}

fn scoped_run_revision(
    scope: &HistoryScope,
    incarnation: &[u8],
    revision: &str,
) -> Result<RevisionId, PortError> {
    let inc_arr: [u8; 16] = incarnation
        .try_into()
        .map_err(|_| internal_not_committed("corrupt_run_inc", "incarnation != 16B"))?;
    let run_scope = HistoryScope {
        space_id: scope.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(inc_arr),
    };
    scope.check(&run_scope)?;

    RevisionId::parse(revision)
        .map_err(|_| internal_not_committed("corrupt_run_rev", "invalid run_revision"))
}

async fn load_run_touched_notes_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    run_id: &AgentRunId,
) -> Result<Vec<NoteId>, PortError> {
    let raw_ids: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT DISTINCT entity_key FROM revisions
             WHERE space_id = ? AND agent_run_id = ? AND entity_type = 'note'
             ORDER BY entity_key",
        )
        .bind(space_id.as_str())
        .bind(run_id.as_str())
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_touched_notes", err.to_string()))?,
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT DISTINCT entity_key FROM revisions
             WHERE space_id = $1 AND agent_run_id = $2 AND entity_type = 'note'
             ORDER BY entity_key",
        )
        .bind(space_id.as_str())
        .bind(run_id.as_str())
        .fetch_all(&mut **conn)
        .await
        .map_err(|err| crate::runtime::pg_read_error("pg_touched_notes", err))?,
    };
    raw_ids
        .into_iter()
        .map(|s| {
            NoteId::parse(&s)
                .map_err(|_| internal_not_committed("corrupt_touched_note", "invalid NoteId"))
        })
        .collect()
}

struct DirectRollbackHistory {
    first_seq: SpaceSeq,
    foreign_edit: bool,
    prior: Option<(RevisionId, Vec<u8>, Option<Timestamp>)>,
    current_metadata: Option<Vec<u8>>,
}

async fn load_direct_rollback_histories(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    run: &AgentRunId,
) -> Result<BTreeMap<NoteId, DirectRollbackHistory>, PortError> {
    // Command visibility is monotonic, with space_seq ordering events inside a command.
    // The newest non-run revision is either a foreign edit after the first touch
    // or the exact predecessor to restore. Only a run-created note needs its head payload.
    const SQLITE_SQL: &str = concat!(
        include_str!("rollback/direct_history_select.sql"),
        "LEFT JOIN revisions p ON p.space_id = $1 AND p.rev_id = (
        SELECT r.rev_id FROM revisions r
        WHERE r.space_id = $1 AND r.entity_type = 'note' AND r.entity_key = t.entity_key
          AND r.agent_run_id IS DISTINCT FROM $2
        ORDER BY r.visibility_seq DESC, r.space_seq DESC LIMIT 1
    )"
    );
    const PG_SQL: &str = concat!(
        include_str!("rollback/direct_history_select.sql"),
        "LEFT JOIN LATERAL (
        SELECT r.space_seq, r.rev_id, r.metadata_msgpack, r.created_at_sec, r.created_at_nsec FROM revisions r
        WHERE r.space_id = $1 AND r.entity_type = 'note' AND r.entity_key = t.entity_key
          AND r.agent_run_id IS DISTINCT FROM $2
        ORDER BY r.visibility_seq DESC, r.space_seq DESC LIMIT 1
    ) p ON TRUE"
    );
    type Row = (
        String,
        i64,
        bool,
        Option<String>,
        Option<Vec<u8>>,
        Option<i64>,
        Option<i32>,
        Option<Vec<u8>>,
    );
    let rows: Vec<Row> = match tx {
        BackendConn::Postgres(conn) => sqlx::query_as(PG_SQL)
            .bind(space.as_str())
            .bind(run.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_rollback_history", err))?,
        BackendConn::Sqlite(conn) => sqlx::query_as(SQLITE_SQL)
            .bind(space.as_str())
            .bind(run.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_rollback_history", err.to_string()))?,
    };
    rows.into_iter()
        .map(
            |(
                id,
                first_seq_raw,
                foreign_edit,
                rev,
                metadata,
                pre_sec,
                pre_nsec,
                current_metadata,
            )| {
                let note = NoteId::parse(&id)
                    .map_err(|_| internal_not_committed("corrupt_rev_nid", "invalid note_id"))?;
                let first_seq = i64_to_space_seq(first_seq_raw)?;
                let prior = rev
                    .zip(metadata)
                    .map(|(rev, meta)| {
                        let rev = RevisionId::parse(&rev).map_err(|_| {
                            internal_not_committed("corrupt_rev_id", "invalid rev_id")
                        })?;
                        let pre_ts = pre_sec
                            .zip(pre_nsec)
                            .map(|(s, ns)| Timestamp::from_unix_parts(s, ns as u32))
                            .transpose()
                            .map_err(|_| {
                                internal_not_committed("corrupt_rev_ts", "invalid pre timestamp")
                            })?;
                        Ok::<_, PortError>((rev, meta, pre_ts))
                    })
                    .transpose()?;
                Ok((
                    note,
                    DirectRollbackHistory {
                        first_seq,
                        foreign_edit,
                        prior,
                        current_metadata,
                    },
                ))
            },
        )
        .collect()
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DurableRoomStatus {
    Clean,
    Blocked,
    Fenced,
}

impl DurableRoomStatus {
    fn is_blocked(self) -> bool {
        !matches!(self, Self::Clean)
    }
}

#[derive(Default)]
struct RollbackNoteStates {
    purged: BTreeSet<NoteId>,
    // No entry means no durable session. A clean closed session still needs a lineage bump.
    rooms: HashMap<NoteId, DurableRoomStatus>,
}

const SQLITE_ROLLBACK_NOTE_STATES: &str = concat!(
    "WITH requested(note_id) AS (SELECT value FROM json_each($2)) ",
    include_str!("rollback/note_states.sql")
);
const PG_ROLLBACK_NOTE_STATES: &str = concat!(
    "WITH requested(note_id) AS (SELECT unnest($2::text[])) ",
    include_str!("rollback/note_states.sql")
);

async fn load_rollback_note_states(
    tx: &mut BackendConn<'_>,
    space: &SpaceId,
    notes: Vec<&str>,
) -> Result<RollbackNoteStates, PortError> {
    let mut states = RollbackNoteStates::default();
    if notes.is_empty() {
        return Ok(states);
    }
    let rows: Vec<(String, bool, Option<i32>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let ids = serde_json::to_string(&notes)
                .map_err(|e| internal_not_committed("sqlite_rollback_note_ids", e.to_string()))?;
            sqlx::query_as(SQLITE_ROLLBACK_NOTE_STATES)
                .bind(space.as_str())
                .bind(ids)
                .fetch_all(&mut **conn)
                .await
                .map_err(|e| internal_not_committed("sqlite_rollback_note_states", e.to_string()))?
        }
        BackendConn::Postgres(conn) => sqlx::query_as(PG_ROLLBACK_NOTE_STATES)
            .bind(space.as_str())
            .bind(notes)
            .fetch_all(&mut **conn)
            .await
            .map_err(|e| crate::runtime::pg_read_error("pg_rollback_note_states", e))?,
    };
    for (id, purged, status) in rows {
        let note = NoteId::parse(&id)?;
        if purged {
            states.purged.insert(note.clone());
        }
        if let Some(code) = status {
            let parsed = match code {
                0 => DurableRoomStatus::Clean,
                1 => DurableRoomStatus::Blocked,
                2 => DurableRoomStatus::Fenced,
                _ => {
                    return Err(internal_not_committed(
                        "corrupt_room_status",
                        format!("unexpected rollback room_status code {code}"),
                    ));
                }
            };
            states.rooms.insert(note, parsed);
        }
    }
    Ok(states)
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
                    .map_err(|err| crate::runtime::pg_read_error("pg_has_overlays", err))?;
            Ok(found.is_some())
        }
    }
}

pub const ROLLBACK_ACTIVE_COLLISION_CHECK_SQLITE_SQL: &str =
    "SELECT nh.parent_folder_id, nh.slug_fold, nh.note_id
     FROM json_each(?) AS k
     CROSS JOIN note_heads nh
     WHERE nh.space_id = ?
       AND nh.parent_folder_id = json_extract(k.value, '$[0]')
       AND nh.slug_fold = json_extract(k.value, '$[1]')
       AND nh.lifecycle_state = 'active'";

async fn verify_no_active_non_eligible_collisions_batch_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    checks: &[(FolderId, String, String, bool)],
    eligible_notes: &BTreeSet<NoteId>,
) -> Result<(), PortError> {
    if checks.is_empty() {
        return Ok(());
    }
    let mut unique_pairs: Vec<(&str, &str)> = checks
        .iter()
        .map(|(f, sf, _, _)| (f.as_str(), sf.as_str()))
        .collect();
    unique_pairs.sort_unstable();
    unique_pairs.dedup();

    let rows: Vec<(String, String, String)> = match tx {
        BackendConn::Sqlite(conn) => {
            let pairs_json = serde_json::to_string(&unique_pairs).map_err(|err| {
                internal_not_committed("sqlite_rb_slug_pairs_json", err.to_string())
            })?;
            let fetched = sqlx::query(ROLLBACK_ACTIVE_COLLISION_CHECK_SQLITE_SQL)
                .bind(&pairs_json)
                .bind(space_id.as_str())
                .fetch_all(&mut **conn)
                .await
                .map_err(|err| {
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
            let parents: Vec<&str> = unique_pairs.iter().map(|(p, _)| *p).collect();
            let slugs: Vec<&str> = unique_pairs.iter().map(|(_, s)| *s).collect();
            let fetched = sqlx::query(
                "SELECT nh.parent_folder_id, nh.slug_fold, nh.note_id
                 FROM UNNEST($2::TEXT[], $3::TEXT[]) AS k(pf, sf)
                 JOIN note_heads nh
                   ON nh.space_id = $1
                  AND nh.parent_folder_id = k.pf
                  AND nh.slug_fold = k.sf
                  AND nh.lifecycle_state = 'active'",
            )
            .bind(space_id.as_str())
            .bind(&parents)
            .bind(&slugs)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| crate::runtime::pg_read_error("pg_rb_slug_check_batch", err))?;
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
    updated_at_sec: i64,
    updated_at_nsec: i32,
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
    actor_str: &str,
) -> Result<(), PortError> {
    if items.is_empty() {
        return Ok(());
    }
    let needs_vacate = items.len() > 1 && items.iter().any(|i| i.lifecycle_str == "active");
    match tx {
        BackendConn::Sqlite(conn) => {
            if needs_vacate {
                for it in items {
                    sqlx::query(
                        "UPDATE note_heads
                         SET lifecycle_state = 'trashed'
                         WHERE space_id = ? AND note_id = ? AND lifecycle_state = 'active'",
                    )
                    .bind(space_id.as_str())
                    .bind(it.note_id.as_str())
                    .execute(&mut **conn)
                    .await
                    .map_err(|err| {
                        internal_not_committed("sqlite_rb_vacate_head", err.to_string())
                    })?;
                }
            }
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
                .bind(it.updated_at_sec)
                .bind(it.updated_at_nsec)
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
            if needs_vacate {
                sqlx::query(
                    "UPDATE note_heads
                     SET lifecycle_state = 'trashed'
                     WHERE space_id = $1 AND note_id = ANY($2) AND lifecycle_state = 'active'",
                )
                .bind(space_id.as_str())
                .bind(&note_ids)
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("pg_rb_vacate_head_batch", err.to_string())
                })?;
            }
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
            let updated_secs: Vec<i64> = items.iter().map(|i| i.updated_at_sec).collect();
            let updated_nsecs: Vec<i32> = items.iter().map(|i| i.updated_at_nsec).collect();

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
                     updated_at_sec = v.updated_at_sec,
                     updated_at_nsec = v.updated_at_nsec,
                     last_actor_id = $3
                 FROM UNNEST(
                     $4::TEXT[], $5::TEXT[], $6::TEXT[], $7::TEXT[], $8::TEXT[],
                     $9::TEXT[], $10::TEXT[], $11::TEXT[], $12::TEXT[], $13::BYTEA[],
                     $14::BIGINT[], $15::TEXT[], $16::INT4[], $17::BIGINT[], $18::INT4[]
                 ) AS v(
                     note_id, parent_folder_id, slug, slug_fold, title,
                     title_fold, doc_class, ability_id, head_rev_id, content_blake3,
                     byte_size, lifecycle_state, visibility_mask, updated_at_sec, updated_at_nsec
                 )
                 WHERE nh.space_id = $1 AND nh.note_id = v.note_id",
            )
            .bind(space_id.as_str())
            .bind(vis_seq)
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
            .bind(updated_secs)
            .bind(updated_nsecs)
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
    let seq = i64_to_space_seq(vis_seq)?;
    crate::domain::common::sync_closed_collab_session_on_direct_write_tx(
        tx,
        space_id,
        note_id,
        new_carrier_rev,
        seq,
    )
    .await
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
    rev_items: &[RevisionInsertItem<'_>],
) -> Result<(), PortError> {
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
    let mut rh_updated_secs: Vec<i64> = Vec::with_capacity(restore_heads.len());
    let mut rh_updated_nsecs: Vec<i32> = Vec::with_capacity(restore_heads.len());

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
        rh_updated_secs.push(i.updated_at_sec);
        rh_updated_nsecs.push(i.updated_at_nsec);
    }

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

    if restore_heads.len() > 1 && restore_heads.iter().any(|i| i.lifecycle_str == "active") {
        sqlx::query(
            "UPDATE note_heads
             SET lifecycle_state = 'trashed'
             WHERE space_id = $1 AND note_id = ANY($2) AND lifecycle_state = 'active'",
        )
        .bind(scope.space_id.as_str())
        .bind(&rh_note_ids)
        .execute(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_rb_direct_vacate_head", err.to_string()))?;
    }

    let carrier_digests = || {
        rev_items
            .iter()
            .filter(|revision| revision.entity_type == "note")
            .filter_map(|revision| {
                revision
                    .content_blake3
                    .as_ref()
                    .map(|digest| digest.as_bytes().as_slice())
            })
    };
    let expected_refs = carrier_digests().count() as i64;
    let inserted_refs: i64 = sqlx::query_scalar(
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
                updated_at_sec = v.updated_at_sec,
                updated_at_nsec = v.updated_at_nsec,
                last_actor_id = $6
            FROM UNNEST(
                $9::TEXT[], $10::TEXT[], $11::TEXT[], $12::TEXT[], $13::TEXT[],
                $14::TEXT[], $15::TEXT[], $16::TEXT[], $17::TEXT[], $18::BYTEA[],
                $19::BIGINT[], $20::TEXT[], $21::INT4[], $22::BIGINT[], $23::INT4[]
            ) AS v(
                note_id, parent_folder_id, slug, slug_fold, title,
                title_fold, doc_class, ability_id, head_rev_id, content_blake3,
                byte_size, lifecycle_state, visibility_mask, updated_at_sec, updated_at_nsec
            )
            WHERE nh.space_id = $1 AND nh.note_id = v.note_id
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
                $24::TEXT[], $25::TEXT[], $26::TEXT[], $27::BIGINT[],
                $28::TEXT[], $29::TEXT[], $30::BYTEA[], $31::BYTEA[],
                $32::TEXT[]
            ) AS u(
                rev_id, entity_type, entity_key, space_seq,
                parent_rev_id, restored_rev_id, content_blake3, metadata_msgpack,
                agent_run_id
            )
            RETURNING entity_type, entity_key, rev_id, content_blake3, space_seq
        ),
        ref_inputs AS (
            SELECT entity_key, rev_id, content_blake3 AS digest, space_seq
            FROM ins_revs WHERE entity_type = 'note' AND content_blake3 IS NOT NULL
        ),
        rebound AS (
            UPDATE blob_catalog AS bc SET ref_count = bc.ref_count + v.delta
            FROM (SELECT digest, COUNT(*) AS delta FROM ref_inputs GROUP BY digest) AS v
            WHERE bc.space_id = $1 AND bc.content_blake3 = v.digest
              AND bc.admission_state = 'open' AND bc.blob_state = 'active'
              AND bc.current_publication_id IS NOT NULL
            RETURNING bc.content_blake3, bc.current_publication_id
        ),
        ins_refs AS (
            INSERT INTO blob_references (
                space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                content_blake3, publication_id, created_seq
            )
            SELECT $1, 'note_revision', u.entity_key, u.rev_id, 'carrier',
                   u.digest, r.current_publication_id, u.space_seq
            FROM ref_inputs u JOIN rebound r ON r.content_blake3 = u.digest
            RETURNING 1
        ),
        upsert_run AS (
            INSERT INTO agent_run_heads (
                space_id, history_incarnation, run_id, run_revision, last_seq, updated_at_sec, updated_at_nsec
            ) VALUES ($1, $2, $7, $8, $3, $4, $5)
            ON CONFLICT (space_id, run_id) DO UPDATE SET
                history_incarnation = EXCLUDED.history_incarnation,
                run_revision = EXCLUDED.run_revision,
                last_seq = EXCLUDED.last_seq,
                updated_at_sec = EXCLUDED.updated_at_sec,
                updated_at_nsec = EXCLUDED.updated_at_nsec
        ) SELECT COUNT(*) FROM ins_refs",
    )
    .bind(scope.space_id.as_str())
    .bind(scope.incarnation.as_bytes().as_slice())
    .bind(vis_seq)
    .bind(sec)
    .bind(nsec)
    .bind(actor_str)
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
    .bind(rh_updated_secs)
    .bind(rh_updated_nsecs)
    .bind(rv_ids)
    .bind(rv_entity_types)
    .bind(rv_entity_keys)
    .bind(rv_space_seqs)
    .bind(rv_parent_revs)
    .bind(rv_restored_revs)
    .bind(rv_digests)
    .bind(rv_metas)
    .bind(rv_runs)
    .fetch_one(&mut *conn)
    .await
    .map_err(|err| internal_not_committed("pg_rb_domain_writes_cte", err.to_string()))?;

    if inserted_refs != expected_refs {
        // Returning an error aborts all domain writes in this item. Preserve
        // the retry diagnostic for a publication that has started retirement.
        let retiring: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM blob_catalog WHERE space_id = $1
             AND content_blake3 = ANY($2) AND current_publication_id IS NOT NULL
             AND (admission_state <> 'open' OR blob_state <> 'active'))",
        )
        .bind(scope.space_id.as_str())
        .bind(carrier_digests().collect::<Vec<_>>())
        .fetch_one(&mut *conn)
        .await
        .map_err(|err| internal_not_committed("pg_rb_rebind_status", err.to_string()))?;
        let (code, message) = if retiring {
            (
                "blob_retiring_on_rebind",
                "existing blob entered retirement before metadata revision commit",
            )
        } else {
            (
                "blob_missing_for_rebind",
                "existing blob publication missing during metadata revision bind",
            )
        };
        return Err(unavailable_retryable(
            code,
            message,
            std::time::Duration::from_millis(25),
        ));
    }
    Ok(())
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

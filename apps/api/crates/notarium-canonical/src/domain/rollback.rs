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

use crate::{
    CanonicalStore,
    blobs::{BlobOwnerKind, bind_existing_active_blob_ref_tx},
    changes::{EffectBodyV1, StoredAwaitReasonV1, build_effect_payload_draft},
    codec::{
        MAX_MSGPACK_DECODE_BYTES, NoteRevisionMetadata, RevisionMetadataEnvelope,
        RevisionMetadataPayload, decode_msgpack_bounded, doc_class_to_db, encode_msgpack,
        encode_timestamp_parts, evaluate_fields_with_schema, group_key_hex, i64_to_space_seq,
        internal_not_committed, lifecycle_to_db, new_prefixed_hex_id, new_revision_id,
        normalize_title_key, now_utc_timestamp, unavailable_retryable,
    },
    domain::{
        board::{
            ExistingRankedItem, StoredSemanticPlacementV1, compute_rank_placement,
            evenly_spaced_ranks, load_overlay_row_opt_tx, load_view_overlays_tx,
            upsert_overlay_and_rank_revision_tx, verify_rank_expectation,
        },
        common::{
            StoredCommittedRollbackV1, build_resource_facts_tx, derive_command_identity_spec,
            load_current_space_schema_tx, load_folder_ancestry_tx, load_note_head_row_tx,
            upsert_agent_run_head_tx, validate_mutation_identity,
        },
        notes::try_replay_completed_receipt,
    },
    runtime::{insert_revision_row, is_note_purge_fenced_tx, load_space_record},
    sql_exec::BackendConn,
    writer::{BatchEventDraft, ItemCommitArtifacts, PreparedWriteIntent, SemanticCutMismatchKind},
};

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

#[derive(Clone, Debug)]
enum CandidateAction {
    TrashCreated {
        current_rev: RevisionId,
        current_lifecycle: Lifecycle,
        doc_class: DocClass,
        parent_folder_id: FolderId,
        slug: String,
        slug_fold: String,
        title: String,
        ability_id: Option<notarium_core::ids::AbilityId>,
        visibility_mask: i32,
    },
    RestorePreExisting {
        current_rev: RevisionId,
        pre_rev_id: RevisionId,
        pre_meta: Box<NoteRevisionMetadata>,
        pre_carrier: Option<String>,
        needs_note_mutation: bool,
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

pub(crate) async fn rollback_agent_run_impl(
    store: &CanonicalStore,
    ctx: SpaceContext,
    request: Mutation<RollbackAgentRun>,
) -> Result<Committed<RollbackResult>, PortError> {
    validate_mutation_identity(&ctx, &request.identity)?;
    let idemp = build_rollback_identity_spec(&request)?;
    if let Some(replayed) = try_replay_completed_receipt::<StoredCommittedRollbackV1>(
        store,
        ctx.scope(),
        &idemp,
        Some(&ctx.budget),
    )
    .await?
    {
        return Ok(replayed.into_committed());
    }

    for attempt in 0..MAX_PLANNER_RETRIES {
        // Step 1 & 2: Read run head, touched set, caller expectations, and classify `skipped_manual_edits`.
        let ctx_read = ctx.clone();
        let input_read = request.input.clone();
        let (space_rec, skipped_manual_edits, candidates, durable_active_rooms, run_board_moves) =
            store
                .with_read_tx_budget(Some(&ctx.budget), |tx| {
                    Box::pin(
                        async move { discover_rollback_state_tx(tx, &ctx_read, &input_read).await },
                    )
                })
                .await?;

        // Load pre-run carriers from CAS for pre-existing notes that need `planned_carrier` in `PlannedNoteRestoration`.
        let mut candidates_with_carriers: BTreeMap<NoteId, CandidateAction> = BTreeMap::new();
        for (nid, mut action) in candidates {
            if let CandidateAction::RestorePreExisting {
                ref pre_meta,
                ref mut pre_carrier,
                ..
            } = action
                && pre_meta.doc_class != DocClass::EncryptedNote
                && let Some(digest) = pre_meta.content_digest
            {
                let raw = store.read_verified_blob(&space_rec.scope, digest).await?;
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

        for (nid, action) in candidates_with_carriers {
            if durable_active_rooms.contains(&nid) {
                skipped_room_active.push(nid);
                continue;
            }
            let reservation = if let Some(interceptor) = store.inner.collab_interceptor.get() {
                interceptor
                    .reserve_rollback(ctx.clone(), nid.clone(), request.identity.clone())
                    .await?
            } else {
                store
                    .inner
                    .room_fences
                    .reserve_rollback(ctx.scope(), &nid, request.identity.clone())
                    .await?
            };
            match reservation {
                RollbackReservation::SkippedRoomActive => {
                    skipped_room_active.push(nid);
                }
                RollbackReservation::Closed(closed_res) => {
                    eligible_reservations.insert(nid.clone(), closed_res);
                    eligible_notes.insert(nid, action);
                }
            }
        }

        // Step 4: If eligible notes have board moves in `input.run`, evaluate rollback board facts.
        let mut affected_views_set: BTreeSet<ViewRef> = BTreeSet::new();
        for bmh in &run_board_moves {
            if eligible_notes.contains_key(&bmh.target_note_id) {
                affected_views_set.insert(bmh.view.clone());
            }
        }

        let rb_facts_opt = if !affected_views_set.is_empty() {
            let (board_authority, provider) = store
                .inner
                .board_provider
                .get()
                .ok_or_else(|| DomainError::validation(ValidationReason::NotReady))?
                .clone();

            let mut planned_list = Vec::with_capacity(eligible_notes.len());
            for (nid, action) in &eligible_notes {
                match action {
                    CandidateAction::TrashCreated { current_rev, .. } => {
                        planned_list.push(PlannedNoteRestoration {
                            note: nid.clone(),
                            current_revision: current_rev.clone(),
                            restored_from_revision: None,
                            planned_lifecycle: Lifecycle::Trashed,
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
            let facts = provider
                .evaluate_rollback(&board_authority, ctx.clone(), req)
                .await?;
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

        let scope_cl = space_rec.scope.clone();
        let space_obj = space_rec.space.clone();
        let auth = ctx.auth().clone();
        let req_id = request.identity.clone();
        let input = request.input.clone();
        let room_fences = store.inner.room_fences.clone();
        let idemp_cl = idemp.clone();
        let skipped_manual_cl = skipped_manual_edits.clone();
        let skipped_room_cl = skipped_room_active.clone();
        let run_moves_cl = run_board_moves.clone();

        let intent = PreparedWriteIntent {
            scope: space_rec.scope.clone(),
            active_epoch: space_rec.active_epoch,
            idempotency: Some(idemp_cl),
            source_note_ids,
            staged_bytes: 0,
            required_semantic_cut: required_cut,
            execute: Box::new(move |tx, item_ctx| {
                Box::pin(async move {
                    // 1. Consume all closed-room reservations in ascending NoteId order.
                    for (nid, res) in eligible_reservations {
                        let guard = room_fences
                            .consume_reservation(&scope_cl, &nid, res, &req_id)
                            .await?;
                        // Double-check durable `collab_sessions` did not become `'active'` or `'fenced'` concurrently.
                        let dstate =
                            read_collab_room_state_tx(tx, &scope_cl.space_id, &nid).await?;
                        if matches!(dstate.as_deref(), Some("active" | "fenced")) {
                            return Err(
                                DomainError::validation(ValidationReason::InvalidState).into()
                            );
                        }
                        item_ctx.retain_until_batch_commit(guard);
                    }

                    // 2. Re-verify `expected_run_revision`, `expected_entities`, and `associated_board_expectations`.
                    verify_run_and_entity_preconditions_tx(
                        tx, &scope_cl, &space_obj, &auth, &input,
                    )
                    .await?;

                    // 3. Validate folder existence and post-trash slug uniqueness for all eligible restored notes.
                    let eligible_all_ids: BTreeSet<NoteId> =
                        eligible_notes.keys().cloned().collect();
                    let trashed_created_ids: BTreeSet<NoteId> = eligible_notes
                        .iter()
                        .filter_map(|(nid, act)| match act {
                            CandidateAction::TrashCreated { .. } => Some(nid.clone()),
                            CandidateAction::RestorePreExisting { .. } => None,
                        })
                        .collect();

                    let mut planned_active_slots: HashMap<(FolderId, String), NoteId> =
                        HashMap::new();
                    let mut restored_ancestries: HashMap<NoteId, bool> = HashMap::new();

                    for (nid, action) in &eligible_notes {
                        if let CandidateAction::RestorePreExisting { pre_meta, .. } = action {
                            let require_active_folder = pre_meta.lifecycle == Lifecycle::Active;
                            let anc = load_folder_ancestry_tx(
                                tx,
                                &scope_cl.space_id,
                                &pre_meta.parent_folder_id,
                                require_active_folder,
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
                                if active_non_eligible_collision_tx(
                                    tx,
                                    &scope_cl.space_id,
                                    &pre_meta.parent_folder_id,
                                    &pre_meta.slug_fold,
                                    &eligible_all_ids,
                                )
                                .await?
                                {
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
                            }
                        }
                    }

                    // 4. Plan reverse board rank replays `(command_end_seq DESC, ordinal DESC)` before mutating SQL.
                    let mut planned_overlay_deletes: Vec<PlannedOverlayDelete> = Vec::new();
                    let mut planned_neighbor_updates: Vec<PlannedNeighborRankUpdate> = Vec::new();
                    let mut planned_target_restores: Vec<PlannedTargetRankRestore> = Vec::new();
                    let mut preloaded_view_overlays: BTreeMap<
                        ViewRef,
                        HashMap<NoteId, crate::domain::board::OverlayRow>,
                    > = BTreeMap::new();

                    if let Some(ref rb_facts) = rb_facts_opt {
                        let current_schema =
                            load_current_space_schema_tx(tx, &scope_cl.space_id).await?;
                        let cur_schema_rev = current_schema.as_ref().map(|s| &s.schema_revision);

                        for view in &affected_views_set {
                            let view_facts = rb_facts.views().get(view).ok_or_else(|| {
                                DomainError::validation(ValidationReason::InvalidState)
                            })?;
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
                                return Err(
                                    DomainError::validation(ValidationReason::CursorStale).into()
                                );
                            }
                            if let Some(ref cs) = current_schema
                                && cs.descriptor_fingerprint != view_facts.descriptor_fingerprint
                            {
                                return Err(
                                    DomainError::validation(ValidationReason::CursorStale).into()
                                );
                            }

                            let overlays =
                                load_view_overlays_tx(tx, &scope_cl.space_id, view).await?;

                            // Verify planner rows match current note & overlay state.
                            for eg in &view_facts.groups {
                                for row in &eg.rows {
                                    let rhead =
                                        load_note_head_row_tx(tx, &scope_cl.space_id, &row.note)
                                            .await?;
                                    if rhead.lifecycle != Lifecycle::Active
                                        || rhead.head_rev_id != row.expected_note
                                    {
                                        return Err(DomainError::RevisionConflict {
                                            current: rhead.head_rev_id,
                                            lineage: None,
                                        }
                                        .into());
                                    }
                                    verify_rank_expectation(
                                        &row.expected_rank,
                                        overlays.get(&row.note),
                                        &rhead.head_rev_id,
                                    )?;
                                }
                            }

                            // Build mutable working group lists excluding notes being trashed by this rollback,
                            // materializing initial ranks for any unranked existing rows in each group.
                            let mut working_groups: Vec<(GroupKey, Vec<ExistingRankedItem>)> =
                                Vec::new();
                            let mut neighbor_dirty: BTreeMap<NoteId, (GroupKey, String, bool)> =
                                BTreeMap::new();

                            for eg in &view_facts.groups {
                                let (_, gk_hex) = group_key_hex(&eg.group)?;
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
                                let all_unranked = kept_notes.iter().all(|nid| {
                                    overlays.get(nid).map(|o| &o.group_key_hex) != Some(&gk_hex)
                                });
                                let mut items = Vec::with_capacity(kept_notes.len());
                                if all_unranked {
                                    let init = evenly_spaced_ranks(kept_notes.len())?;
                                    for (nid, r) in kept_notes.iter().zip(init) {
                                        if !eligible_all_ids.contains(nid) {
                                            neighbor_dirty.insert(
                                                nid.clone(),
                                                (eg.group.clone(), r.clone(), false),
                                            );
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
                                            if o.group_key_hex == gk_hex {
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
                                            .map(|o| o.group_key_hex == gk_hex)
                                            .unwrap_or(false);
                                        if !in_grp {
                                            let tail =
                                                compute_rank_placement(&items, nid, items.len())?;
                                            for (pn, pr) in tail.pma_neighbor_updates {
                                                if let Some(it) =
                                                    items.iter_mut().find(|i| i.note_id == pn)
                                                {
                                                    it.rank = pr.clone();
                                                }
                                                if !eligible_all_ids.contains(&pn) {
                                                    neighbor_dirty
                                                        .insert(pn, (eg.group.clone(), pr, true));
                                                }
                                            }
                                            if !eligible_all_ids.contains(nid) {
                                                neighbor_dirty.insert(
                                                    nid.clone(),
                                                    (
                                                        eg.group.clone(),
                                                        tail.target_rank.clone(),
                                                        false,
                                                    ),
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
                                        let g_idx = match working_groups
                                            .iter()
                                            .position(|(gk, _)| gk == group)
                                        {
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

                                        let computed =
                                            compute_rank_placement(g_items, target, ins_idx)?;
                                        for (pn, pr) in computed.pma_neighbor_updates {
                                            if let Some(it) =
                                                g_items.iter_mut().find(|i| i.note_id == pn)
                                            {
                                                it.rank = pr.clone();
                                            }
                                            if let Some(Some((_, tr_rank, _))) =
                                                target_final_state.get_mut(&pn)
                                            {
                                                *tr_rank = pr;
                                            } else if !eligible_all_ids.contains(&pn) {
                                                neighbor_dirty
                                                    .insert(pn, (group.clone(), pr, true));
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
                                    (Some((grp, rnk, prev_pl_rev)), Some(post_grp))
                                        if grp == post_grp =>
                                    {
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

                    // 5. Count exact SpaceSeq allocations before executing SQL mutations:
                    //    - TrashCreated notes (where current_lifecycle != Trashed): 1 note rev each
                    //    - RestorePreExisting notes (where needs_note_mutation): 1 note rev each
                    //    - Neighbor rank updates: 1 rank rev each
                    //    - Target rank restores: 1 rank rev each
                    //    - `agent_run_heads` bump: 1 agent_run rev
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
                    let entity_event_seqs = trash_note_count
                        + restore_note_count
                        + (planned_neighbor_updates.len() as u64)
                        + (planned_target_restores.len() as u64);
                    let total_seqs = entity_event_seqs.max(1);
                    let (first_seq, visibility_seq) = item_ctx.preview_seq_range(total_seqs)?;
                    let vis_i64 = visibility_seq.get() as i64;
                    let now_ts = now_utc_timestamp()?;
                    let (sec, nsec) = encode_timestamp_parts(now_ts);
                    let current_schema =
                        load_current_space_schema_tx(tx, &scope_cl.space_id).await?;

                    let mut events = Vec::with_capacity(total_seqs as usize);
                    let mut trashed_out = Vec::new();
                    let mut restored_out = Vec::new();
                    let mut restored_ranks_out = Vec::new();
                    let mut owner_notes_for_receipt: BTreeSet<NoteId> = BTreeSet::new();

                    // 6a. Trash run-created eligible notes FIRST & remove their overlays across ALL views.
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
                        } = action
                        else {
                            continue;
                        };

                        delete_all_target_overlays_tx(tx, &scope_cl.space_id, nid).await?;
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
                        let anc = load_folder_ancestry_tx(
                            tx,
                            &scope_cl.space_id,
                            parent_folder_id,
                            false,
                        )
                        .await?;

                        update_note_head_trashed_tx(
                            tx,
                            &scope_cl.space_id,
                            nid,
                            &trev,
                            vis_i64,
                            sec,
                            nsec,
                            auth.principal().as_str(),
                        )
                        .await?;
                        bump_closed_collab_session_lineage_tx(
                            tx,
                            &scope_cl.space_id,
                            nid,
                            &trev,
                            vis_i64,
                        )
                        .await?;

                        let head_after = load_note_head_row_tx(tx, &scope_cl.space_id, nid).await?;
                        if let Some(digest) = head_after.content_digest {
                            bind_existing_active_blob_ref_tx(
                                tx,
                                &scope_cl.space_id,
                                BlobOwnerKind::NoteRevision,
                                nid.as_str(),
                                trev.as_str(),
                                "carrier",
                                digest,
                                tseq,
                            )
                            .await?;
                        }

                        let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                            NoteRevisionMetadata {
                                note_id: nid.clone(),
                                parent_folder_id: parent_folder_id.clone(),
                                is_root_child: anc.is_root_child,
                                slug: slug.clone(),
                                slug_fold: slug_fold.clone(),
                                title: title.clone(),
                                doc_class: *doc_class,
                                ability_id: ability_id.clone(),
                                lifecycle: Lifecycle::Trashed,
                                visibility_mask: *visibility_mask,
                                byte_size: head_after.byte_size,
                                content_digest: head_after.content_digest,
                                schema_revision: current_schema
                                    .as_ref()
                                    .map(|s| s.schema_revision.clone()),
                                raw_fields: None,
                                evaluated_fields: BTreeMap::new(),
                                diagnostics: Vec::new(),
                            },
                        ))
                        .encode()?;

                        insert_revision_row(
                            tx,
                            &scope_cl,
                            &trev,
                            "note",
                            nid.as_str(),
                            tseq,
                            visibility_seq,
                            Some(current_rev),
                            None,
                            head_after.content_digest,
                            &meta,
                            auth.principal(),
                            None,
                            now_ts,
                        )
                        .await?;

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

                    // 6b. Restore pre-existing eligible notes (`restored_from_rev_id = Some(pre_rev_id)`).
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
                            bind_existing_active_blob_ref_tx(
                                tx,
                                &scope_cl.space_id,
                                BlobOwnerKind::NoteRevision,
                                nid.as_str(),
                                rrev.as_str(),
                                "carrier",
                                digest,
                                rseq,
                            )
                            .await?;
                        }

                        let title_fold = if pre_meta.doc_class == DocClass::EncryptedNote {
                            normalize_title_key(&pre_meta.slug)
                        } else {
                            normalize_title_key(&pre_meta.title)
                        };

                        update_note_head_restored_tx(
                            tx,
                            &scope_cl.space_id,
                            nid,
                            &pre_meta.parent_folder_id,
                            &pre_meta.slug,
                            &pre_meta.slug_fold,
                            &pre_meta.title,
                            &title_fold,
                            doc_class_to_db(pre_meta.doc_class),
                            pre_meta.ability_id.as_ref().map(|a| a.as_str()),
                            &rrev,
                            pre_meta.content_digest.as_ref(),
                            pre_meta.byte_size,
                            lifecycle_to_db(pre_meta.lifecycle),
                            pre_meta.visibility_mask,
                            vis_i64,
                            sec,
                            nsec,
                            auth.principal().as_str(),
                        )
                        .await?;

                        bump_closed_collab_session_lineage_tx(
                            tx,
                            &scope_cl.space_id,
                            nid,
                            &rrev,
                            vis_i64,
                        )
                        .await?;

                        if pre_meta.lifecycle != Lifecycle::Active {
                            delete_all_target_overlays_tx(tx, &scope_cl.space_id, nid).await?;
                        }

                        let eval_fields = if pre_meta.doc_class == DocClass::EncryptedNote {
                            BTreeMap::new()
                        } else {
                            evaluate_fields_with_schema(
                                pre_meta.raw_fields.as_ref(),
                                pre_meta.diagnostics.first(),
                                current_schema.as_ref().map(|s| &s.fields),
                            )
                        };
                        let meta = RevisionMetadataEnvelope::v1(RevisionMetadataPayload::Note(
                            NoteRevisionMetadata {
                                note_id: nid.clone(),
                                parent_folder_id: pre_meta.parent_folder_id.clone(),
                                is_root_child,
                                slug: pre_meta.slug.clone(),
                                slug_fold: pre_meta.slug_fold.clone(),
                                title: pre_meta.title.clone(),
                                doc_class: pre_meta.doc_class,
                                ability_id: pre_meta.ability_id.clone(),
                                lifecycle: pre_meta.lifecycle,
                                visibility_mask: pre_meta.visibility_mask,
                                byte_size: pre_meta.byte_size,
                                content_digest: pre_meta.content_digest,
                                schema_revision: current_schema
                                    .as_ref()
                                    .map(|s| s.schema_revision.clone()),
                                raw_fields: pre_meta.raw_fields.clone(),
                                evaluated_fields: eval_fields,
                                diagnostics: pre_meta.diagnostics.clone(),
                            },
                        ))
                        .encode()?;

                        insert_revision_row(
                            tx,
                            &scope_cl,
                            &rrev,
                            "note",
                            nid.as_str(),
                            rseq,
                            visibility_seq,
                            Some(current_rev),
                            None,
                            pre_meta.content_digest,
                            &meta,
                            auth.principal(),
                            None,
                            now_ts,
                        )
                        .await?;
                        set_revision_restored_from_tx(tx, &scope_cl.space_id, &rrev, pre_rev_id)
                            .await?;

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

                    // 6c. Apply planned board overlay deletes, neighbor normalizations, and target restores.
                    for del in &planned_overlay_deletes {
                        delete_single_overlay_tx(
                            tx,
                            &scope_cl.space_id,
                            &del.view,
                            &del.target_note,
                        )
                        .await?;
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
                    let cmd_range =
                        notarium_core::ports::CommandSeqRange::new(first_seq, visibility_seq)?;
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
                    let receipt_token =
                        MutationReceiptToken::new(scope_cl.clone(), visibility_seq)?;
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
            }),
        };

        match store
            .submit_write_command::<StoredCommittedRollbackV1>(&ctx.budget, intent)
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

fn build_rollback_identity_spec(
    request: &Mutation<RollbackAgentRun>,
) -> Result<crate::writer::CommandIdentitySpec, PortError> {
    let mut fp = blake3::Hasher::new();
    fp.update(request.input.run.as_str().as_bytes());
    fp.update(&[0]);
    fp.update(request.input.expected_run_revision.as_str().as_bytes());
    for ent in &request.input.expected_entities {
        fp.update(&[0]);
        fp.update(ent.note.as_str().as_bytes());
        fp.update(ent.revision.as_str().as_bytes());
    }
    for assoc in &request.input.associated_board_expectations {
        fp.update(&[0]);
        fp.update(assoc.view.note.as_str().as_bytes());
        fp.update(assoc.view.key.as_str().as_bytes());
        fp.update(assoc.note.as_str().as_bytes());
        let er = serde_json::to_vec(&assoc.expected_rank)
            .map_err(|err| internal_not_committed("rb_fp_json", err.to_string()))?;
        fp.update(&er);
        fp.update(assoc.expected_placement_revision.as_str().as_bytes());
    }
    Ok(derive_command_identity_spec(
        &request.identity,
        "rollback_agent_run",
        fp.finalize().as_bytes(),
    ))
}

#[allow(clippy::type_complexity)]
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

    verify_run_and_entity_preconditions_tx(tx, &srec.scope, &srec.space, ctx.auth(), input).await?;

    let run_moves = load_run_board_moves_tx(tx, &srec.scope.space_id, &input.run).await?;
    let touched_notes: BTreeSet<NoteId> = input
        .expected_entities
        .iter()
        .map(|e| e.note.clone())
        .collect();

    let mut skipped_manual_edits = Vec::new();
    let mut candidates = BTreeMap::new();
    let mut durable_active_rooms = BTreeSet::new();

    for nid in touched_notes {
        let head = load_note_head_row_tx(tx, &srec.scope.space_id, &nid).await?;
        let note_revs = load_note_revision_history_tx(tx, &srec.scope.space_id, &nid).await?;
        let target_bmh = load_target_board_move_runs_tx(tx, &srec.scope.space_id, &nid).await?;

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

        if matches!(
            read_collab_room_state_tx(tx, &srec.scope.space_id, &nid)
                .await?
                .as_deref(),
            Some("active" | "fenced")
        ) {
            durable_active_rooms.insert(nid.clone());
        }

        let pre_rev_opt = note_revs
            .iter()
            .filter(|r| r.1 < first_run_seq)
            .max_by_key(|r| r.1);

        match pre_rev_opt {
            None => {
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
                    },
                );
            }
            Some((pre_rev_id, _, meta_bytes, _)) => {
                let env = RevisionMetadataEnvelope::decode(meta_bytes)?;
                let RevisionMetadataPayload::Note(pre_meta) = env.payload else {
                    return Err(internal_not_committed(
                        "corrupt_note_rev_meta",
                        "expected NoteRevisionMetadata",
                    ));
                };
                let needs_note_mutation = head.head_rev_id != *pre_rev_id
                    || head.lifecycle != pre_meta.lifecycle
                    || head.parent_folder_id != pre_meta.parent_folder_id
                    || head.slug != pre_meta.slug;
                candidates.insert(
                    nid,
                    CandidateAction::RestorePreExisting {
                        current_rev: head.head_rev_id,
                        pre_rev_id: pre_rev_id.clone(),
                        pre_meta: Box::new(pre_meta),
                        pre_carrier: None,
                        needs_note_mutation,
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

async fn verify_run_and_entity_preconditions_tx(
    tx: &mut BackendConn<'_>,
    scope: &HistoryScope,
    space: &notarium_core::auth::Space,
    auth: &notarium_core::auth::EngineAuthContext,
    input: &RollbackAgentRun,
) -> Result<(), PortError> {
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
            .map_err(|err| internal_not_committed("pg_load_run_head", err.to_string()))?;
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
    if actual_run_rev != input.expected_run_revision {
        return Err(DomainError::RevisionConflict {
            current: actual_run_rev,
            lineage: None,
        }
        .into());
    }

    // Discover full touched set of notes in `revisions` UNION `board_move_history`.
    let mut touched_set: BTreeSet<NoteId> = BTreeSet::new();
    for nid in load_run_touched_notes_tx(tx, &scope.space_id, &input.run).await? {
        touched_set.insert(nid);
    }

    let mut caller_notes: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for exp in &input.expected_entities {
        if is_note_purge_fenced_tx(tx, &scope.space_id, exp.note.as_str()).await? {
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

    for (nid, exp_rev) in &caller_notes {
        let head = load_note_head_row_tx(tx, &scope.space_id, nid).await?;
        if head.head_rev_id != *exp_rev {
            return Err(DomainError::RevisionConflict {
                current: head.head_rev_id,
                lineage: None,
            }
            .into());
        }
        let (rfacts, _) = build_resource_facts_tx(
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

    Ok(())
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
            .map_err(|err| internal_not_committed("pg_run_touched_notes", err.to_string()))?;
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
            .map_err(|err| internal_not_committed("pg_load_run_bmh", err.to_string()))?;
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

#[allow(clippy::type_complexity)]
async fn load_note_revision_history_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Vec<(RevisionId, SpaceSeq, Vec<u8>, Option<AgentRunId>)>, PortError> {
    let rows: Vec<(String, i64, Vec<u8>, Option<String>)> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched = sqlx::query(
                "SELECT rev_id, space_seq, metadata_msgpack, agent_run_id
                 FROM revisions
                 WHERE space_id = ? AND entity_type = 'note' AND entity_key = ?
                 ORDER BY space_seq ASC",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_load_note_revs", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("rev_id"),
                        r.get("space_seq"),
                        r.get("metadata_msgpack"),
                        r.get("agent_run_id"),
                    )
                })
                .collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT rev_id, space_seq, metadata_msgpack, agent_run_id
                 FROM revisions
                 WHERE space_id = $1 AND entity_type = 'note' AND entity_key = $2
                 ORDER BY space_seq ASC",
            )
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_load_note_revs", err.to_string()))?;
            fetched
                .into_iter()
                .map(|r| {
                    (
                        r.get("rev_id"),
                        r.get("space_seq"),
                        r.get("metadata_msgpack"),
                        r.get("agent_run_id"),
                    )
                })
                .collect()
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for (rev_raw, seq_raw, meta, run_raw) in rows {
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
        out.push((rev, seq, meta, run));
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
            .map_err(|err| internal_not_committed("pg_load_target_bmh", err.to_string()))?;
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

async fn read_collab_room_state_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
) -> Result<Option<String>, PortError> {
    match tx {
        BackendConn::Sqlite(conn) => sqlx::query_scalar(
            "SELECT room_state FROM collab_sessions WHERE space_id = ? AND note_id = ?",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("sqlite_collab_state", err.to_string())),
        BackendConn::Postgres(conn) => sqlx::query_scalar(
            "SELECT room_state FROM collab_sessions WHERE space_id = $1 AND note_id = $2",
        )
        .bind(space_id.as_str())
        .bind(note_id.as_str())
        .fetch_optional(&mut **conn)
        .await
        .map_err(|err| internal_not_committed("pg_collab_state", err.to_string())),
    }
}

async fn active_non_eligible_collision_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    parent_folder_id: &FolderId,
    slug_fold: &str,
    eligible_notes: &BTreeSet<NoteId>,
) -> Result<bool, PortError> {
    let rows: Vec<String> = match tx {
        BackendConn::Sqlite(conn) => {
            let fetched = sqlx::query(
                "SELECT note_id FROM note_heads
                 WHERE space_id = ? AND parent_folder_id = ? AND slug_fold = ? AND lifecycle_state = 'active'",
            )
            .bind(space_id.as_str())
            .bind(parent_folder_id.as_str())
            .bind(slug_fold)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_rb_slug_check", err.to_string()))?;
            fetched.into_iter().map(|r| r.get("note_id")).collect()
        }
        BackendConn::Postgres(conn) => {
            let fetched = sqlx::query(
                "SELECT note_id FROM note_heads
                 WHERE space_id = $1 AND parent_folder_id = $2 AND slug_fold = $3 AND lifecycle_state = 'active'",
            )
            .bind(space_id.as_str())
            .bind(parent_folder_id.as_str())
            .bind(slug_fold)
            .fetch_all(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_slug_check", err.to_string()))?;
            fetched.into_iter().map(|r| r.get("note_id")).collect()
        }
    };
    for raw in rows {
        let nid = NoteId::parse(&raw)
            .map_err(|_| internal_not_committed("corrupt_collision_nid", "invalid NoteId"))?;
        if !eligible_notes.contains(&nid) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[allow(clippy::too_many_arguments)]
async fn update_note_head_trashed_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    rev_id: &RevisionId,
    vis_seq: i64,
    sec: i64,
    nsec: i32,
    actor_str: &str,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
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
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE note_heads
                 SET head_rev_id = $1, lifecycle_state = 'trashed', updated_seq = $2,
                     updated_at_sec = $3, updated_at_nsec = $4, last_actor_id = $5
                 WHERE space_id = $6 AND note_id = $7",
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
            .map_err(|err| internal_not_committed("pg_rb_trash_head", err.to_string()))?;
        }
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn update_note_head_restored_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    note_id: &NoteId,
    parent_folder_id: &FolderId,
    slug: &str,
    slug_fold: &str,
    title: &str,
    title_fold: &str,
    doc_class_str: &str,
    ability_id_str: Option<&str>,
    rev_id: &RevisionId,
    content_digest: Option<&ContentDigest>,
    byte_size: u64,
    lifecycle_str: &str,
    visibility_mask: i32,
    vis_seq: i64,
    sec: i64,
    nsec: i32,
    actor_str: &str,
) -> Result<(), PortError> {
    let digest_slice = content_digest.map(|d| d.as_bytes().as_slice());
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE note_heads
                 SET parent_folder_id = ?, slug = ?, slug_fold = ?, title = ?, title_fold = ?,
                     doc_class = ?, ability_id = ?, head_rev_id = ?, content_blake3 = ?,
                     byte_size = ?, lifecycle_state = ?, visibility_mask = ?,
                     updated_seq = ?, updated_at_sec = ?, updated_at_nsec = ?, last_actor_id = ?
                 WHERE space_id = ? AND note_id = ?",
            )
            .bind(parent_folder_id.as_str())
            .bind(slug)
            .bind(slug_fold)
            .bind(title)
            .bind(title_fold)
            .bind(doc_class_str)
            .bind(ability_id_str)
            .bind(rev_id.as_str())
            .bind(digest_slice)
            .bind(byte_size as i64)
            .bind(lifecycle_str)
            .bind(i64::from(visibility_mask))
            .bind(vis_seq)
            .bind(sec)
            .bind(nsec)
            .bind(actor_str)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_rb_restore_head", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE note_heads
                 SET parent_folder_id = $1, slug = $2, slug_fold = $3, title = $4, title_fold = $5,
                     doc_class = $6, ability_id = $7, head_rev_id = $8, content_blake3 = $9,
                     byte_size = $10, lifecycle_state = $11, visibility_mask = $12,
                     updated_seq = $13, updated_at_sec = $14, updated_at_nsec = $15, last_actor_id = $16
                 WHERE space_id = $17 AND note_id = $18",
            )
            .bind(parent_folder_id.as_str())
            .bind(slug)
            .bind(slug_fold)
            .bind(title)
            .bind(title_fold)
            .bind(doc_class_str)
            .bind(ability_id_str)
            .bind(rev_id.as_str())
            .bind(digest_slice)
            .bind(byte_size as i64)
            .bind(lifecycle_str)
            .bind(visibility_mask)
            .bind(vis_seq)
            .bind(sec)
            .bind(nsec)
            .bind(actor_str)
            .bind(space_id.as_str())
            .bind(note_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_restore_head", err.to_string()))?;
        }
    }
    Ok(())
}

async fn set_revision_restored_from_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    rev_id: &RevisionId,
    restored_from_rev: &RevisionId,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "UPDATE revisions SET restored_from_rev_id = ? WHERE space_id = ? AND rev_id = ?",
            )
            .bind(restored_from_rev.as_str())
            .bind(space_id.as_str())
            .bind(rev_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("sqlite_set_restored_from", err.to_string()))?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "UPDATE revisions SET restored_from_rev_id = $1 WHERE space_id = $2 AND rev_id = $3",
            )
            .bind(restored_from_rev.as_str())
            .bind(space_id.as_str())
            .bind(rev_id.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_set_restored_from", err.to_string()))?;
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

async fn delete_all_target_overlays_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    target_note: &NoteId,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query("DELETE FROM view_rank_overlays WHERE space_id = ? AND target_note_id = ?")
                .bind(space_id.as_str())
                .bind(target_note.as_str())
                .execute(&mut **conn)
                .await
                .map_err(|err| {
                    internal_not_committed("sqlite_rb_del_all_overlays", err.to_string())
                })?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "DELETE FROM view_rank_overlays WHERE space_id = $1 AND target_note_id = $2",
            )
            .bind(space_id.as_str())
            .bind(target_note.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_del_all_overlays", err.to_string()))?;
        }
    }
    Ok(())
}

async fn delete_single_overlay_tx(
    tx: &mut BackendConn<'_>,
    space_id: &SpaceId,
    view: &ViewRef,
    target_note: &NoteId,
) -> Result<(), PortError> {
    match tx {
        BackendConn::Sqlite(conn) => {
            sqlx::query(
                "DELETE FROM view_rank_overlays
                 WHERE space_id = ? AND view_note_id = ? AND view_key = ? AND target_note_id = ?",
            )
            .bind(space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(target_note.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| {
                internal_not_committed("sqlite_rb_del_single_overlay", err.to_string())
            })?;
        }
        BackendConn::Postgres(conn) => {
            sqlx::query(
                "DELETE FROM view_rank_overlays
                 WHERE space_id = $1 AND view_note_id = $2 AND view_key = $3 AND target_note_id = $4",
            )
            .bind(space_id.as_str())
            .bind(view.note.as_str())
            .bind(view.key.as_str())
            .bind(target_note.as_str())
            .execute(&mut **conn)
            .await
            .map_err(|err| internal_not_committed("pg_rb_del_single_overlay", err.to_string()))?;
        }
    }
    Ok(())
}

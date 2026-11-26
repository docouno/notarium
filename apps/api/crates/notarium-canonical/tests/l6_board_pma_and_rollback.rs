#![forbid(unsafe_code)]

#[path = "l6_board_pma_and_rollback/applied.rs"]
mod applied;
#[path = "l6_board_pma_and_rollback/board_deadline.rs"]
mod board_deadline;
#[path = "l6_board_pma_and_rollback/historical_deadline.rs"]
mod historical_deadline;
#[path = "l6_board_pma_and_rollback/note_states.rs"]
mod note_states;
#[path = "l6_board_pma_and_rollback/pg_deadline.rs"]
mod pg_deadline;
#[path = "l6_board_pma_and_rollback/projection_rank_history.rs"]
mod projection_rank_history;
#[path = "l6_board_pma_and_rollback/rollback_deadline.rs"]
mod rollback_deadline;
mod support;

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, S3BucketModePolicy,
    blobs::s3::admin_ensure_bucket,
    domain::board::{
        ExistingRankedItem, RANK_WIDTH, compute_rank_placement, decode_rank_u128,
        evenly_spaced_ranks,
    },
};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{
        AgentRunId, CommandKey, ContentDigest, FolderId, GrantId, HistoryIncarnation, LeaseEpoch,
        NoteId, PrincipalId, RequestId, RevisionId, SpaceId, SpaceSeq, ViewKey,
    },
    model::{HistoryScope, Lifecycle},
    ports::{
        AssociatedBoardExpectation, BoardGroupFieldKind, BoardMoveFacts, BoardMoveFactsSpec,
        BoardMutationFactsProvider, BoardPlannerAuthority, BoardViewRollbackFacts, CallBudget,
        Cancellation, CreateNote, DeleteDisposition, DeleteNote, EditNote, EvaluatedBoardGroup,
        EvaluatedBoardRow, GetNote, GroupKey, MoveBoardCard, Mutation, NoteRevision, NoteWritePort,
        PortFuture, Preconditions, RankExpectation, RankNeighbor, RenameNote, RollbackAgentRun,
        RollbackBoardFacts, RollbackBoardFactsRequest, SemanticPlacement, SpaceContext, ViewRef,
    },
    query::{FieldObservation, FieldValue},
    receipt::{AwaitReason, CausalBasis, CommandIdentity, MutationEffect, ReceiptSet},
    value::{ScalarValue, YamlValue},
};
use notarium_syntax::{extract, frontmatter::FieldEdit};

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, random_bytes_16, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id, sample_run_id,
    sample_space_id,
};

fn make_budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(random_bytes_16()),
        cancellation: Cancellation::default(),
        remaining: std::time::Duration::from_secs(30),
    }
}

fn owner_ctx(scope: &HistoryScope, principal: PrincipalId) -> SpaceContext {
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let verified = VerifiedHuman::attest(
        principal,
        GrantId::from_bytes([8u8; 16]),
        BTreeMap::from([(scope.space_id.clone(), grant)]),
        true,
    );
    SpaceContext::new(
        EngineAuthContext::for_human(verified),
        scope.clone(),
        make_budget(),
    )
    .expect("owner SpaceContext")
}

fn agent_run_ctx(base_human: &SpaceContext, run: AgentRunId) -> SpaceContext {
    let auth = base_human
        .auth()
        .for_agent_run(
            run,
            base_human.scope().space_id.clone(),
            ChatAudience::Personal,
            base_human.auth().spaces().clone(),
        )
        .expect("for_agent_run");
    SpaceContext::new(auth, base_human.scope().clone(), make_budget()).expect("run SpaceContext")
}

fn next_mutation<T>(scope: &HistoryScope, actor: &PrincipalId, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: scope.clone(),
            actor: actor.clone(),
            key: CommandKey::from_bytes(random_bytes_16()),
            hash: ContentDigest::from_bytes(*blake3::hash(&random_bytes_16()).as_bytes()),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

async fn seed_space(
    store: &CanonicalStore,
    space_id: SpaceId,
    incarnation: HistoryIncarnation,
    owner: PrincipalId,
) -> (HistoryScope, FolderId) {
    let root = sample_folder_id(1);
    let rec = store
        .create_space(CreateSpaceSpec {
            space_id,
            incarnation,
            root_folder_id: root.clone(),
            slug: "board-space".to_owned(),
            kind: SpaceKind::Personal,
            owner,
            active_epoch: LeaseEpoch::new(1).expect("epoch 1"),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .expect("create_space");
    (rec.scope, root)
}

type MovePlannerPause = (
    tokio::sync::oneshot::Sender<()>,
    tokio::sync::oneshot::Receiver<()>,
);

/// Real canonical-reading test `BoardMutationFactsProvider` that evaluates board membership by reading
/// `status` frontmatter from canonical notes (excluding `status == "archived"` as `OutsideView`),
/// sorts each column by `(overlay_rank_or_unranked, slug, note_id)`, and supports deterministic
/// fault injection (`forge_authority_once`, `inject_stale_cutoff_once`).
struct CanonicalTestBoardPlanner {
    store: CanonicalStore,
    tracked_notes: Mutex<BTreeSet<NoteId>>,
    forge_authority_once: AtomicBool,
    inject_stale_cutoff_once: AtomicBool,
    stale_rollback_responses: AtomicUsize,
    evaluate_move_calls: AtomicUsize,
    move_waits: Mutex<Option<Vec<std::time::Duration>>>,
    move_pause_once: Mutex<Option<MovePlannerPause>>,
}

impl CanonicalTestBoardPlanner {
    fn new(store: CanonicalStore, tracked_notes: impl IntoIterator<Item = NoteId>) -> Arc<Self> {
        Arc::new(Self {
            store,
            tracked_notes: Mutex::new(tracked_notes.into_iter().collect()),
            forge_authority_once: AtomicBool::new(false),
            inject_stale_cutoff_once: AtomicBool::new(false),
            stale_rollback_responses: AtomicUsize::new(0),
            evaluate_move_calls: AtomicUsize::new(0),
            move_waits: Mutex::new(None),
            move_pause_once: Mutex::new(None),
        })
    }

    fn group_from_status_str(status: Option<&str>) -> Option<GroupKey> {
        match status {
            Some("archived") => None, // OutsideView!
            Some(s) => Some(GroupKey::Value(ScalarValue::String(s.to_owned()))),
            None => Some(GroupKey::Absent),
        }
    }

    fn binding_for(slug: &str, nid: &NoteId) -> ContentDigest {
        let mut h = blake3::Hasher::new();
        h.update(slug.as_bytes());
        h.update(&[0]);
        h.update(nid.as_str().as_bytes());
        ContentDigest::from_bytes(*h.finalize().as_bytes())
    }
}

impl BoardMutationFactsProvider for CanonicalTestBoardPlanner {
    fn evaluate_move<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        _cutoff: Option<SpaceSeq>,
        intent: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts> {
        Box::pin(async move {
            self.evaluate_move_calls.fetch_add(1, Ordering::SeqCst);
            let pause = self.move_pause_once.lock().unwrap().take();
            if let Some((entered, release)) = pause {
                entered.send(()).unwrap();
                release.await.unwrap();
            }
            let wait_number = self.move_waits.lock().unwrap().as_mut().map(|waits| {
                waits.push(ctx.budget.remaining);
                waits.len()
            });
            match wait_number {
                Some(1) => tokio::time::sleep(std::time::Duration::from_millis(180)).await,
                Some(_) => std::future::pending().await,
                None => {}
            }

            let scope = ctx.scope().clone();
            let space_rec = self.store.read_space(&scope.space_id).await?;
            let view_snap = self
                .store
                .get_note(
                    ctx.clone(),
                    GetNote {
                        note: intent.view.note.clone(),
                        revision: None,
                        causal: CausalBasis::Exact(ReceiptSet::default()),
                    },
                )
                .await?;
            let view_rev = view_snap.document.metadata().revision().clone();
            let overlays = self
                .store
                .inspect_view_overlays_for_test(&scope.space_id, &intent.view)
                .await?;

            let tracked: Vec<NoteId> = self
                .tracked_notes
                .lock()
                .expect("lock")
                .iter()
                .cloned()
                .collect();

            // Group active notes by their current `status` field.
            type MoveGroupEntry = (Option<String>, String, EvaluatedBoardRow);
            let mut by_group: Vec<(GroupKey, Vec<MoveGroupEntry>)> = Vec::new();
            let mut target_slug = String::new();
            let mut target_cur_group: Option<GroupKey> = None;

            for nid in tracked {
                let snap = match self
                    .store
                    .get_note(
                        ctx.clone(),
                        GetNote {
                            note: nid.clone(),
                            revision: None,
                            causal: CausalBasis::Exact(ReceiptSet::default()),
                        },
                    )
                    .await
                {
                    Ok(snap) => snap,
                    Err(PortError::Domain(
                        DomainError::ResourceNotFound | DomainError::AccessDenied,
                    )) => continue,
                    Err(error) => return Err(error),
                };
                let listing = snap.document.listing(ctx.auth())?;
                if listing.lifecycle() != Lifecycle::Active {
                    continue;
                }
                let carrier = snap.document.explicit_read(ctx.auth())?;
                let slug = nid.as_str().to_owned();
                if nid == intent.note {
                    target_slug = slug.clone();
                }
                let grp_opt = match snap.fields.get("status") {
                    Some(FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(s)))) => {
                        Self::group_from_status_str(Some(s))
                    }
                    Some(FieldObservation::Ok(FieldValue::Scalar(
                        number @ ScalarValue::Number(_),
                    ))) => Some(GroupKey::Value(number.clone())),
                    _ => Self::group_from_status_str(None),
                };
                if nid == intent.note {
                    target_cur_group = grp_opt.clone();
                }
                let Some(grp) = grp_opt else {
                    let _ = carrier;
                    continue;
                };

                let ov_opt = overlays.get(&nid);
                let exp_rank = match ov_opt {
                    Some(ov) => RankExpectation::Existing(ov.rank_rev_id.clone()),
                    None => RankExpectation::Absent,
                };
                let rank_for_sort = ov_opt
                    .filter(|ov| ov.group == grp)
                    .map(|ov| ov.sort_rank_lexo.clone());

                let eval_row = EvaluatedBoardRow {
                    note: nid.clone(),
                    expected_note: listing.revision().clone(),
                    expected_rank: exp_rank,
                    base_order_binding: Self::binding_for(&slug, &nid),
                };

                if let Some((_, list)) = by_group.iter_mut().find(|(g, _)| *g == grp) {
                    list.push((rank_for_sort, slug, eval_row));
                } else {
                    by_group.push((grp, vec![(rank_for_sort, slug, eval_row)]));
                }
            }

            // Ensure destination `intent.group` is represented even when currently empty!
            if !by_group.iter().any(|(g, _)| *g == intent.group) {
                by_group.push((intent.group.clone(), Vec::new()));
            }

            let mut groups = Vec::with_capacity(by_group.len());
            let mut before_placement = SemanticPlacement::OutsideView;

            for (grp, mut entries) in by_group {
                entries.sort_by(|a, b| {
                    let ra = a.0.as_deref().unwrap_or("~");
                    let rb = b.0.as_deref().unwrap_or("~");
                    ra.cmp(rb)
                        .then_with(|| a.1.cmp(&b.1))
                        .then_with(|| a.2.note.cmp(&b.2.note))
                });
                let rows: Vec<EvaluatedBoardRow> = entries.into_iter().map(|(_, _, r)| r).collect();
                if target_cur_group.as_ref() == Some(&grp)
                    && let Some(pos) = rows.iter().position(|r| r.note == intent.note)
                {
                    let pred = pos.checked_sub(1).map(|i| rows[i].note.clone());
                    let succ = rows.get(pos + 1).map(|r| r.note.clone());
                    before_placement = SemanticPlacement::InGroup {
                        group: grp.clone(),
                        predecessor: pred,
                        successor: succ,
                    };
                }
                groups.push(EvaluatedBoardGroup { group: grp, rows });
            }

            // Check whether post-patch `intent.fields` leaves target eligible in `intent.group`:
            let after_eligible = match intent.fields.get("status") {
                Some(Some(YamlValue::String(s))) => {
                    Self::group_from_status_str(Some(s.as_str())).as_ref() == Some(&intent.group)
                }
                Some(None) => intent.group == GroupKey::Absent,
                None => target_cur_group.as_ref() == Some(&intent.group),
                _ => false,
            };

            let cutoff = if self.inject_stale_cutoff_once.swap(false, Ordering::SeqCst) {
                // Inject an older sequence so `WriteBatchActor` triggers `SemanticCutMismatch`!
                SpaceSeq::new(space_rec.last_seq.get().saturating_sub(1).max(1))?
            } else {
                space_rec.last_seq
            };

            let forged;
            let auth_to_use = if self.forge_authority_once.swap(false, Ordering::SeqCst) {
                forged = BoardPlannerAuthority::admit();
                &forged
            } else {
                authority
            };

            Ok(BoardMoveFacts::attest(
                auth_to_use,
                BoardMoveFactsSpec {
                    scope,
                    cutoff,
                    view: intent.view,
                    view_revision: view_rev,
                    schema_revision: None,
                    descriptor_fingerprint: ContentDigest::from_bytes([0u8; 32]),
                    group_field: "status".to_owned(),
                    group_field_kind: if matches!(
                        intent.group,
                        GroupKey::Value(ScalarValue::Number(_))
                    ) {
                        BoardGroupFieldKind::Number
                    } else {
                        BoardGroupFieldKind::String
                    },
                    groups,
                    before_placement,
                    base_order_binding: Self::binding_for(&target_slug, &intent.note),
                    after_eligible_in_group: after_eligible,
                },
            ))
        })
    }

    fn evaluate_rollback<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        request: RollbackBoardFactsRequest,
    ) -> PortFuture<'a, RollbackBoardFacts> {
        Box::pin(async move {
            if self
                .stale_rollback_responses
                .try_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    count.checked_sub(1)
                })
                .is_ok()
            {
                return Err(DomainError::validation(ValidationReason::CursorStale).into());
            }
            let scope = ctx.scope().clone();
            let space_rec = self.store.read_space(&scope.space_id).await?;
            let tracked: Vec<NoteId> = self
                .tracked_notes
                .lock()
                .expect("lock")
                .iter()
                .cloned()
                .collect();

            let mut post_restore_membership = BTreeMap::new();
            for planned in &request.eligible_notes {
                if planned.planned_lifecycle != Lifecycle::Active {
                    post_restore_membership.insert(planned.note.clone(), None);
                    continue;
                }
                let status_str = match planned.planned_fields.get("status") {
                    Some(Some(YamlValue::String(s))) => Some(s.as_str()),
                    _ => None,
                };
                post_restore_membership.insert(
                    planned.note.clone(),
                    Self::group_from_status_str(status_str),
                );
            }

            let mut views_map = BTreeMap::new();
            for view in request.views {
                let view_rev = if let Some(planned) = request
                    .eligible_notes
                    .iter()
                    .find(|p| p.note == view.note && p.planned_lifecycle == Lifecycle::Active)
                {
                    planned.current_revision.clone()
                } else {
                    let view_snap = self
                        .store
                        .get_note(
                            ctx.clone(),
                            GetNote {
                                note: view.note.clone(),
                                revision: None,
                                causal: CausalBasis::Exact(ReceiptSet::default()),
                            },
                        )
                        .await?;
                    view_snap.document.metadata().revision().clone()
                };
                let overlays = self
                    .store
                    .inspect_view_overlays_for_test(&scope.space_id, &view)
                    .await?;

                type RollbackGroupEntry = (Option<String>, EvaluatedBoardRow);
                let mut by_group: Vec<(GroupKey, Vec<RollbackGroupEntry>)> = Vec::new();
                for g_seed in [
                    GroupKey::Value(ScalarValue::String("todo".to_owned())),
                    GroupKey::Value(ScalarValue::String("doing".to_owned())),
                    GroupKey::Value(ScalarValue::String("done".to_owned())),
                ] {
                    by_group.push((g_seed, Vec::new()));
                }

                for nid in &tracked {
                    let snap = match self
                        .store
                        .get_note(
                            ctx.clone(),
                            GetNote {
                                note: nid.clone(),
                                revision: None,
                                causal: CausalBasis::Exact(ReceiptSet::default()),
                            },
                        )
                        .await
                    {
                        Ok(snap) => snap,
                        Err(PortError::Domain(
                            DomainError::ResourceNotFound | DomainError::AccessDenied,
                        )) => continue,
                        Err(error) => return Err(error),
                    };
                    let listing = snap.document.listing(ctx.auth())?;
                    if listing.lifecycle() != Lifecycle::Active {
                        continue;
                    }
                    let status_opt = match snap.fields.get("status") {
                        Some(FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(s)))) => {
                            Some(s.as_str())
                        }
                        _ => None,
                    };
                    let Some(grp) = Self::group_from_status_str(status_opt) else {
                        continue;
                    };
                    let ov_opt = overlays.get(nid);
                    let exp_rank = match ov_opt {
                        Some(ov) => RankExpectation::Existing(ov.rank_rev_id.clone()),
                        None => RankExpectation::Absent,
                    };
                    let rank_sort = ov_opt
                        .filter(|ov| ov.group == grp)
                        .map(|ov| ov.sort_rank_lexo.clone());
                    let row = EvaluatedBoardRow {
                        note: nid.clone(),
                        expected_note: listing.revision().clone(),
                        expected_rank: exp_rank,
                        base_order_binding: Self::binding_for(nid.as_str(), nid),
                    };
                    if let Some((_, list)) = by_group.iter_mut().find(|(g, _)| *g == grp) {
                        list.push((rank_sort, row));
                    } else {
                        by_group.push((grp, vec![(rank_sort, row)]));
                    }
                }

                let mut groups = Vec::with_capacity(by_group.len());
                for (grp, mut entries) in by_group {
                    entries.sort_by(|a, b| {
                        let ra = a.0.as_deref().unwrap_or("~");
                        let rb = b.0.as_deref().unwrap_or("~");
                        ra.cmp(rb).then_with(|| a.1.note.cmp(&b.1.note))
                    });
                    groups.push(EvaluatedBoardGroup {
                        group: grp,
                        rows: entries.into_iter().map(|(_, r)| r).collect(),
                    });
                }

                views_map.insert(
                    view.clone(),
                    BoardViewRollbackFacts {
                        view,
                        view_revision: view_rev,
                        schema_revision: None,
                        descriptor_fingerprint: ContentDigest::from_bytes([0u8; 32]),
                        group_field: "status".to_owned(),
                        group_field_kind: BoardGroupFieldKind::String,
                        groups,
                        post_restore_membership: post_restore_membership.clone(),
                        post_restore_group_order: Vec::new(),
                    },
                );
            }

            Ok(RollbackBoardFacts::attest(
                authority,
                scope,
                space_rec.last_seq,
                views_map,
            ))
        })
    }
}

#[test]
fn l6_ten_thousand_first_slot_board_moves_rank_bound_and_strict_ordering() {
    const GROUP_SIZE: usize = 128;
    const MOVES: usize = 10_000;

    let initial_ranks = evenly_spaced_ranks(GROUP_SIZE).expect("evenly spaced initial ranks");
    let mut items: Vec<ExistingRankedItem> = (0..GROUP_SIZE)
        .map(|idx| {
            let mut id_bytes = [0u8; 16];
            id_bytes[0] = 0xB0;
            id_bytes[1..3].copy_from_slice(&(idx as u16).to_be_bytes());
            ExistingRankedItem {
                note_id: NoteId::from_bytes(id_bytes),
                rank: initial_ranks[idx].clone(),
            }
        })
        .collect();

    let mut total_pma_rewrites: usize = 0;

    for step in 0..MOVES {
        // Always take the LAST card in the group and move it to index `0` (worst-case adversarial first-slot hammering!).
        let moving = items.pop().expect("non-empty group");
        let computed =
            compute_rank_placement(&items, &moving.note_id, 0).expect("compute first-slot rank");

        assert!(
            computed.target_rank.len() <= 16 && computed.target_rank.len() == RANK_WIDTH,
            "step {step}: rank '{}' exceeded 16-byte ceiling",
            computed.target_rank
        );
        assert!(
            computed
                .target_rank
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit()),
            "rank '{}' must be pure lowercase ASCII Base36",
            computed.target_rank
        );
        let _ = decode_rank_u128(&computed.target_rank).expect("valid decoded u128 rank");

        total_pma_rewrites += computed.pma_neighbor_updates.len();
        if !computed.pma_neighbor_updates.is_empty() {
            let upd_map: BTreeMap<NoteId, String> =
                computed.pma_neighbor_updates.into_iter().collect();
            for item in &mut items {
                if let Some(new_r) = upd_map.get(&item.note_id) {
                    assert!(new_r.len() <= 16);
                    item.rank = new_r.clone();
                }
            }
        }

        items.insert(
            0,
            ExistingRankedItem {
                note_id: moving.note_id,
                rank: computed.target_rank,
            },
        );

        // Verify strict ascending lexicographical order across the entire group at checkpoints & end!
        if step % 500 == 0 || step + 1 == MOVES {
            for pair in items.windows(2) {
                assert!(
                    (pair[0].rank.as_str(), &pair[0].note_id)
                        < (pair[1].rank.as_str(), &pair[1].note_id),
                    "step {step}: ordering violated between {:?} and {:?}",
                    pair[0],
                    pair[1]
                );
            }
        }
    }

    // Amortized PMA cost over 10,000 adversarial first-slot moves must stay tiny (< 3 neighbor updates/move).
    assert!(
        total_pma_rewrites < MOVES * 3,
        "unexpectedly high total PMA neighbor rewrites: {total_pma_rewrites}"
    );
}

struct BoardEffects {
    scope: HistoryScope,
    materialized: ReceiptSet,
    neighbor_rank: notarium_core::ids::RevisionId,
    column_change: SpaceSeq,
}

async fn run_move_board_card_suite(store: &CanonicalStore) -> BoardEffects {
    let owner = sample_principal_id(30);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(3),
        sample_incarnation(3),
        owner.clone(),
    )
    .await;
    let ctx = owner_ctx(&scope, owner.clone());

    let project = sample_folder_id(123);
    store
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: project.clone(),
            parent: None,
            slug: "board-project".into(),
            display_name: "Board Project".into(),
            is_project: true,
            project_slug: Some("board-project".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let mut grants = ctx.auth().spaces().clone();
    grants.get_mut(&scope.space_id).unwrap().project_root = Some(project.clone());
    let pinned = SpaceContext::new(
        ctx.auth().for_pat(grants).unwrap(),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let view_note = sample_note_id(100);
    let view_created = store
        .create_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view_note.clone(),
                    parent: Some(project.clone()),
                    slug: "sprint-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Sprint Board\n---\n# Sprint Board\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create view note");
    let view = ViewRef {
        note: view_note.clone(),
        key: ViewKey::from_bytes([0x61; 16]),
    };

    let card_1 = sample_note_id(101);
    let card_2 = sample_note_id(102);
    let card_3 = sample_note_id(103);
    let mut revs = BTreeMap::new();
    for (nid, slug) in [
        (&card_1, "card-1"),
        (&card_2, "card-2"),
        (&card_3, "card-3"),
    ] {
        let c = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: (nid == &card_3).then(|| project.clone()),
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: todo\n---\n# {slug}\n"),
                    },
                ),
            )
            .await
            .expect("create card");
        revs.insert(nid.clone(), c.value.revision);
    }

    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let doing_grp = GroupKey::Value(ScalarValue::String("doing".to_owned()));

    // 1. Calling `move_board_card` BEFORE `register_board_facts_provider` must fail with `NotReady`!
    let unreg_res = store
        .move_board_card(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: card_3.clone(),
                    group: todo_grp.clone(),
                    before: Some(RankNeighbor {
                        note: card_1.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&card_3].clone(),
                    expected_view: view_created.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await;
    assert_validation_err(&unreg_res, ValidationReason::NotReady);

    // Register planner (and verify duplicate registration is rejected).
    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [card_1.clone(), card_2.clone(), card_3.clone()],
    );
    store
        .register_board_facts_provider(planner.clone())
        .expect("register_board_facts_provider");
    assert!(
        store
            .register_board_facts_provider(planner.clone())
            .is_err(),
        "second register_board_facts_provider must fail"
    );

    // 2. Forged `BoardPlannerAuthority` must be rejected with `InvalidAuthority`!
    planner.forge_authority_once.store(true, Ordering::SeqCst);
    let forged_auth_res = store
        .move_board_card(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: card_3.clone(),
                    group: todo_grp.clone(),
                    before: Some(RankNeighbor {
                        note: card_1.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&card_3].clone(),
                    expected_view: view_created.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await;
    assert_validation_err(&forged_auth_res, ValidationReason::InvalidAuthority);

    // 3. Stale planner cutoff triggers automatic `WriteBatchActor` retry without rebasing caller preconditions!
    planner.evaluate_move_calls.store(0, Ordering::SeqCst);
    planner
        .inject_stale_cutoff_once
        .store(true, Ordering::SeqCst);

    let first_request = next_mutation(
        &scope,
        &owner,
        MoveBoardCard {
            view: view.clone(),
            note: card_3.clone(),
            group: todo_grp.clone(),
            before: Some(RankNeighbor {
                note: card_1.clone(),
                expected_rank: RankExpectation::Absent,
            }),
            after: None,
            fields: BTreeMap::new(),
            expected_note: revs[&card_3].clone(),
            expected_view: view_created.value.revision.clone(),
            expected_rank: RankExpectation::Absent,
        },
    );
    let moved_first = store
        .move_board_card(ctx.clone(), first_request.clone())
        .await
        .expect("move_board_card succeeds after automatic stale cutoff retry");
    assert_eq!(
        planner.evaluate_move_calls.load(Ordering::SeqCst),
        2,
        "planner must be called twice when attempt 1 had stale cutoff"
    );

    // Initial unranked materialization materialized ranks for `card_1` and `card_2` too, with `card_3 < card_1 < card_2`!
    let overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .expect("inspect overlays");
    assert_eq!(overlays.len(), 3);
    assert!(overlays[&card_3].sort_rank_lexo < overlays[&card_1].sort_rank_lexo);
    assert!(overlays[&card_1].sort_rank_lexo < overlays[&card_2].sort_rank_lexo);
    assert_eq!(moved_first.value.rank, overlays[&card_3].sort_rank_lexo);

    let materialized = ReceiptSet::new([moved_first.receipt.clone()]).unwrap();
    let effects = store
        .resolve_receipt_effects(&scope, &materialized)
        .await
        .unwrap();
    let MutationEffect::Notes { versions, .. } = &effects[0].effect else {
        panic!("expected materialized neighbors")
    };
    let actual: BTreeMap<_, _> = versions
        .iter()
        .map(|v| (v.note_id.clone(), v.revision.clone()))
        .collect();
    assert_eq!(actual, revs);

    // Cross-column move (`todo -> doing`) updates frontmatter `status: doing` AND rank overlay atomically!
    let cross_col = store
        .move_board_card(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: card_3.clone(),
                    group: doing_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: moved_first.value.revision.revision.clone(),
                    expected_view: view_created.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        moved_first.value.rank_revision.clone(),
                    ),
                },
            ),
        )
        .await
        .expect("cross-column move_board_card");
    assert_eq!(cross_col.value.group, doing_grp);

    let placement = |before, after| {
        next_mutation(
            &scope,
            &owner,
            MoveBoardCard {
                view: view.clone(),
                note: card_1.clone(),
                group: todo_grp.clone(),
                before,
                after,
                fields: BTreeMap::new(),
                expected_note: revs[&card_1].clone(),
                expected_view: view_created.value.revision.clone(),
                expected_rank: RankExpectation::Existing(overlays[&card_1].rank_rev_id.clone()),
            },
        )
    };
    let member = RankNeighbor {
        note: card_2.clone(),
        expected_rank: RankExpectation::Absent,
    };
    let former_member = RankNeighbor {
        note: card_3.clone(),
        expected_rank: RankExpectation::Absent,
    };
    assert!(matches!(
        store
            .move_board_card(ctx.clone(), placement(Some(member.clone()), None))
            .await,
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. }))
            if current == overlays[&card_2].rank_rev_id
    ));
    for (before, after) in [
        (Some(former_member.clone()), None),
        (Some(member), Some(former_member)),
    ] {
        let result = store
            .move_board_card(ctx.clone(), placement(before, after))
            .await;
        assert_validation_err(&result, ValidationReason::InvalidState);
    }
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        cross_col.receipt.seq()
    );
    let snap_card_3 = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: card_3.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get card_3");
    assert!(
        snap_card_3
            .document
            .explicit_read(ctx.auth())
            .expect("read")
            .contains("status: doing")
    );
    // A group of nine unranked cards exceeds the exact-overlay bound on its first move.
    let mut large_cards = Vec::new();
    for id in 112..121 {
        let note = sample_note_id(id);
        let created = store
            .create_note(
                ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: note.clone(),
                        parent: None,
                        slug: format!("large-{id}"),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: Large {id}\nstatus: large\n---\n"),
                    },
                ),
            )
            .await
            .unwrap();
        planner.tracked_notes.lock().unwrap().insert(note);
        large_cards.push(created.value);
    }
    let last = large_cards.pop().unwrap();
    let moved = store
        .move_board_card(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: last.note,
                    expected_note: last.revision,
                    expected_view: view_created.value.revision.clone(),
                    group: GroupKey::Value(ScalarValue::String("large".into())),
                    before: None,
                    after: None,
                    expected_rank: RankExpectation::Absent,
                    fields: BTreeMap::new(),
                },
            ),
        )
        .await
        .unwrap();
    let effects = store
        .resolve_receipt_effects(&scope, &ReceiptSet::new([moved.receipt]).unwrap())
        .await
        .unwrap();
    assert!(matches!(
        effects[0].effect,
        MutationEffect::AwaitProjection {
            reason: AwaitReason::TooManyNotes
        }
    ));

    // Poll the live-interception scenarios as their own task. Their nested
    // PostgreSQL futures otherwise share the stack of this entire parity suite.
    let room_store = store.clone();
    let room_ctx = ctx.clone();
    let room_view = view.clone();
    tokio::spawn(async move {
        applied::check(
            &room_store,
            &room_ctx,
            &room_view,
            view_created.value.revision,
            &planner,
        )
        .await
    })
    .await
    .unwrap();

    assert_eq!(
        store
            .move_board_card(pinned.clone(), first_request.clone())
            .await
            .unwrap()
            .receipt,
        moved_first.receipt
    );
    // The former neighbor now belongs to this reader, but the earlier Board command did not.
    store
        .move_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                notarium_core::ports::MoveNote {
                    note: card_1.clone(),
                    parent: Some(project),
                    slug: "card-1".into(),
                },
            ),
        )
        .await
        .unwrap();
    let log = notarium_core::ports::ChangeRead::Log {
        after: notarium_core::receipt::ChangeCursor {
            scope: scope.clone(),
            after: SpaceSeq::ZERO,
        },
        through: moved_first.receipt.seq(),
        limit: notarium_core::ports::PageLimit::new(100).unwrap(),
    };
    let notarium_core::ports::ChangeReadResult::Log(filtered) = store
        .recent_activity(pinned.clone(), log.clone())
        .await
        .unwrap()
    else {
        panic!("expected log")
    };
    let board_rows: Vec<_> = filtered
        .changes
        .iter()
        .filter(|ch| ch.command_range.last_seq == moved_first.receipt.seq())
        .collect();
    assert!(!board_rows.is_empty());
    assert!(board_rows.iter().all(|ch| ch.entity
        == notarium_core::ports::EntityId::Note(card_3.clone())
        && matches!(
            ch.effect,
            MutationEffect::AwaitProjection {
                reason: AwaitReason::UnavailableVersion
            }
        )));
    assert_eq!(filtered.safe_ack_end, moved_first.receipt.seq());
    store
        .move_note(
            ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                notarium_core::ports::MoveNote {
                    note: view.note.clone(),
                    parent: None,
                    slug: "sprint-board".into(),
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        store.move_board_card(pinned.clone(), first_request).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let notarium_core::ports::ChangeReadResult::Log(filtered) =
        store.read_changes(pinned, log).await.unwrap()
    else {
        panic!("expected log")
    };
    assert!(
        filtered
            .changes
            .iter()
            .all(|ch| ch.revision != moved_first.value.rank_revision)
    );
    BoardEffects {
        scope,
        materialized,
        neighbor_rank: overlays[&card_1].rank_rev_id.clone(),
        column_change: cross_col.receipt.seq(),
    }
}

async fn verify_board_effects(store: &CanonicalStore, evidence: BoardEffects, bytes: &[u8]) {
    let env = notarium_canonical::changes::EffectEnvelopeV1::decode(bytes).unwrap();
    let notarium_canonical::EffectBodyV1::Notes { notes } = env.body else {
        panic!("expected a cross-column note effect")
    };
    assert_eq!(notes.len(), 1);
    assert_eq!(
        notes[0].changed_fields,
        BTreeMap::from([(
            "status".into(),
            FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String("doing".into())))
        )])
    );
    let effects = store
        .resolve_receipt_effects(&evidence.scope, &evidence.materialized)
        .await
        .unwrap();
    assert!(matches!(
        effects[0].effect,
        MutationEffect::AwaitProjection {
            reason: AwaitReason::UnavailableVersion
        }
    ));
}

async fn run_rollback_agent_run_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(40);
    let foreign_human = sample_principal_id(41);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(4),
        sample_incarnation(4),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());
    let foreign_ctx = owner_ctx(&scope, foreign_human.clone());
    let run_id = sample_run_id(9);
    let run_ctx = agent_run_ctx(&human_ctx, run_id.clone());

    // View note + pre-existing notes:
    // - `n_pre`: starts at `slug = "roadmap"`, `status = "todo"`, closed `collab_sessions` at `lineage_epoch = 3`.
    //   Run renames `n_pre` to `"roadmap-legacy"`, moves it on board `todo -> doing -> archived` (OutsideView!),
    //   AND creates `n_created` taking `slug = "roadmap"` in the SAME folder!
    // - `n_manual`: edited by `run_id`, then edited by `foreign_human` -> `skipped_manual_edits`!
    // - `n_room`: edited by `run_id`, then has an active collaborative room opened -> `skipped_room_active`!
    let view_note = sample_note_id(110);
    let view_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view_note.clone(),
                    parent: None,
                    slug: "agent-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Agent Board\n---\n# Agent Board\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create view_note");
    let view = ViewRef {
        note: view_note,
        key: ViewKey::from_bytes([0x62; 16]),
    };

    let n_anchor = sample_note_id(111);
    let n_pre = sample_note_id(112);
    let n_created = sample_note_id(113);
    let n_manual = sample_note_id(114);
    let n_room = sample_note_id(115);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            n_anchor.clone(),
            n_pre.clone(),
            n_created.clone(),
            n_manual.clone(),
            n_room.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner.clone())
        .expect("register planner");

    let anchor_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_anchor.clone(),
                    parent: None,
                    slug: "anchor-card".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Anchor\nstatus: todo\n---\n# Anchor\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create n_anchor");

    let pre_carrier_v0 =
        "---\ntitle: Roadmap v0\nstatus: todo\n---\n# Roadmap v0\n\nOriginal plan.\n";
    let pre_v0 = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_pre.clone(),
                    parent: None,
                    slug: "roadmap".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: pre_carrier_v0.to_owned(),
                },
            ),
        )
        .await
        .expect("create n_pre");

    // Seed a closed `collab_sessions` row on `n_pre` at `lineage_epoch = 3` so we verify rollback bumps it to `4`!
    store
        .execute_diagnostic_write_sql_for_test(&format!(
            "INSERT INTO collab_sessions (space_id, note_id, lease_epoch, lineage_epoch, carrier_rev_id, \
             yrs_snapshot_blob, yrs_snapshot_blake3, room_state, owner_id, updated_seq) \
             VALUES ('{}', '{}', 1, 3, '{}', NULL, NULL, 'closed', NULL, 1)",
            scope.space_id.as_str(),
            n_pre.as_str(),
            pre_v0.value.revision.as_str()
        ))
        .await
        .expect("seed closed collab_sessions row");

    // Place `n_pre` before `n_anchor` in `todo` as human baseline before the agent run starts.
    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let doing_grp = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let pre_board_v0 = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n_pre.clone(),
                    group: todo_grp.clone(),
                    before: Some(RankNeighbor {
                        note: n_anchor.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: pre_v0.value.revision.clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("initial human board placement of n_pre");
    let _ = anchor_c;

    let manual_v0 = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_manual.clone(),
                    parent: None,
                    slug: "manual-note".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Manual\n---\n# Manual\n\nV0.\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create n_manual");

    let room_v0 = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_room.clone(),
                    parent: None,
                    slug: "room-note".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Room\n---\n# Room\n\nV0.\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create n_room");

    // --- Agent Run `run_id` executes mutations ---
    // (a) Rename `n_pre` away from `"roadmap"` -> `"roadmap-legacy"`, move it `todo -> doing`, then edit `status: archived` (OutsideView!).
    let pre_renamed = store
        .rename_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RenameNote {
                    note: n_pre.clone(),
                    slug: "roadmap-legacy".to_owned(),
                    title: None,
                },
            ),
        )
        .await
        .expect("run renames n_pre");

    let _pre_moved_doing = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n_pre.clone(),
                    group: doing_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: pre_renamed.value.revision,
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(pre_board_v0.value.rank_revision),
                },
            ),
        )
        .await
        .expect("run moves n_pre to doing");

    // Edit `n_pre` to `status: archived` (now `OutsideView` at rollback time!).
    let pre_doing_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: n_pre.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get n_pre in doing");
    let archive_plan = extract::finalize_document(
        pre_doing_snap
            .document
            .explicit_read(human_ctx.auth())
            .expect("read"),
        DocClass::UserDoc,
        &n_pre,
        &[FieldEdit::Set {
            key: "status".to_owned(),
            value: YamlValue::String("archived".to_owned()),
        }],
    )
    .expect("archive plan");
    let pre_archived = store
        .edit_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: n_pre.clone(),
                    plan: archive_plan,
                },
            ),
        )
        .await
        .expect("run archives n_pre");

    // (b) Create `n_created` taking `slug = "roadmap"` in the SAME root folder and place it on the board!
    let created_c = store
        .create_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_created.clone(),
                    parent: None,
                    slug: "roadmap".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Replacement Roadmap\nstatus: doing\n---\n# Replacement Roadmap\n".to_owned(),
                },
            ),
        )
        .await
        .expect("run creates n_created at slug roadmap");
    let created_board = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n_created.clone(),
                    group: doing_grp,
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: created_c.value.revision,
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("run places n_created on board");

    // (c) Run edits `n_manual`, then `foreign_human` edits `n_manual` afterward -> `skipped_manual_edits`!
    let manual_plan_run = extract::finalize_document(
        "---\ntitle: Manual\n---\n# Manual\n\nV0.\n",
        DocClass::UserDoc,
        &n_manual,
        &[FieldEdit::Set {
            key: "run_touched".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("manual_plan_run");
    let _ = manual_v0;
    let manual_run_ed = store
        .edit_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: n_manual.clone(),
                    plan: manual_plan_run,
                },
            ),
        )
        .await
        .expect("run edits n_manual");
    let manual_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: n_manual.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get n_manual");
    let manual_plan_foreign = extract::finalize_document(
        manual_snap
            .document
            .explicit_read(human_ctx.auth())
            .expect("read"),
        DocClass::UserDoc,
        &n_manual,
        &[FieldEdit::Set {
            key: "human_override".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("manual_plan_foreign");
    let _ = manual_run_ed;
    let manual_foreign_ed = store
        .edit_note(
            foreign_ctx,
            next_mutation(
                &scope,
                &foreign_human,
                EditNote {
                    note: n_manual.clone(),
                    plan: manual_plan_foreign,
                },
            ),
        )
        .await
        .expect("foreign human edits n_manual");

    // (d) Run edits `n_room`, then collaborative room opens on `n_room` -> `skipped_room_active`!
    let _ = room_v0;
    let room_plan = extract::finalize_document(
        "---\ntitle: Room\n---\n# Room\n\nV0.\n",
        DocClass::UserDoc,
        &n_room,
        &[FieldEdit::Set {
            key: "agent_edit".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("room_plan");
    let room_run_ed = store
        .edit_note(
            run_ctx,
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: n_room.clone(),
                    plan: room_plan,
                },
            ),
        )
        .await
        .expect("run edits n_room");
    store
        .room_fences()
        .open_room(&scope, &n_room)
        .await
        .expect("open live room on n_room");

    // Inspect current overlays & run revision to supply exact preconditions to `RollbackAgentRun`.
    let cur_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .expect("inspect overlays before rollback");
    let expected_run_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run_id)
        .await
        .expect("inspect run rev")
        .expect("run head exists");

    let lineage_before_rb = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT lineage_epoch FROM collab_sessions WHERE space_id = '{}' AND note_id = '{}'",
                scope.space_id.as_str(),
                n_pre.as_str()
            ),
        )
        .await
        .expect("read lineage_epoch before rollback");
    assert_eq!(
        lineage_before_rb, 5,
        "closed collab_sessions.lineage_epoch must advance 3 -> 4 (board field patch) -> 5 (direct edit)"
    );

    let mut trashed_metadata = note_metadata_at(
        store,
        &scope,
        &created_board.value.revision,
        &created_board.receipt,
    )
    .await;
    trashed_metadata.lifecycle = Lifecycle::Trashed;
    assert!(trashed_metadata.evaluated_fields.contains_key("status"));
    let restored_metadata = note_metadata_at(store, &scope, &pre_v0.value, &pre_v0.receipt).await;

    let board_rollback = next_mutation(
        &scope,
        &owner,
        RollbackAgentRun {
            run: run_id.clone(),
            expected_run_revision: expected_run_rev,
            expected_entities: vec![
                NoteRevision {
                    note: n_pre.clone(),
                    revision: pre_archived.value.revision,
                },
                NoteRevision {
                    note: n_created.clone(),
                    revision: created_board.value.revision.revision,
                },
                NoteRevision {
                    note: n_manual.clone(),
                    revision: manual_foreign_ed.value.revision,
                },
                NoteRevision {
                    note: n_room.clone(),
                    revision: room_run_ed.value.revision,
                },
            ],
            associated_board_expectations: vec![
                AssociatedBoardExpectation {
                    view: view.clone(),
                    note: n_pre.clone(),
                    expected_rank: RankExpectation::Existing(
                        cur_overlays[&n_pre].rank_rev_id.clone(),
                    ),
                    expected_placement_revision: cur_overlays[&n_pre].placement_revision.clone(),
                },
                AssociatedBoardExpectation {
                    view: view.clone(),
                    note: n_created.clone(),
                    expected_rank: RankExpectation::Existing(
                        cur_overlays[&n_created].rank_rev_id.clone(),
                    ),
                    expected_placement_revision: cur_overlays[&n_created]
                        .placement_revision
                        .clone(),
                },
            ],
        },
    );
    let mut grants = human_ctx.auth().spaces().clone();
    grants
        .get_mut(&scope.space_id)
        .unwrap()
        .read_classes
        .clear();
    let write_only = SpaceContext::new(
        human_ctx.auth().for_pat(grants).unwrap(),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    assert!(matches!(
        store
            .rollback_agent_run(write_only.clone(), board_rollback.clone())
            .await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    planner.stale_rollback_responses.store(5, Ordering::SeqCst);
    assert!(matches!(
        store.rollback_agent_run(human_ctx.clone(), board_rollback.clone()).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::CursorStale
    ));
    assert_eq!(
        planner.stale_rollback_responses.swap(0, Ordering::SeqCst),
        1
    );
    let rollback_committed = store
        .rollback_agent_run(human_ctx.clone(), board_rollback.clone())
        .await
        .expect("rollback_agent_run");

    assert!(matches!(
        store.rollback_agent_run(write_only, board_rollback).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    let rb = rollback_committed.value;
    assert_eq!(rb.trashed.len(), 1);
    assert_eq!(rb.trashed[0].note, n_created);
    assert_eq!(rb.restored.len(), 1);
    assert_eq!(rb.restored[0].note, n_pre);
    assert_eq!(
        note_metadata_at(store, &scope, &rb.trashed[0], &rollback_committed.receipt).await,
        trashed_metadata
    );
    assert_eq!(
        note_metadata_at(store, &scope, &rb.restored[0], &rollback_committed.receipt).await,
        restored_metadata
    );
    assert_eq!(rb.skipped_manual_edits, vec![n_manual]);
    assert_eq!(rb.skipped_room_active, vec![n_room.clone()]);

    store
        .room_fences()
        .close_room(&scope, &n_room)
        .await
        .expect("close room on n_room");

    // Verify `n_created` was trashed AND its overlay deleted, while `n_pre` reclaimed `slug = "roadmap"`,
    // restored `Original plan.` + `status: todo`, restored its rank before `n_anchor` in `todo`,
    // recorded `restored_from_rev_id`, AND bumped closed-room `collab_sessions.lineage_epoch` from 3 -> 4!
    assert!(
        !store
            .is_live_visible(&human_ctx, &n_created)
            .await
            .expect("vis")
    );
    let restored_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: n_pre.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("get restored n_pre");
    assert_eq!(
        restored_snap
            .document
            .explicit_read(human_ctx.auth())
            .expect("read"),
        pre_carrier_v0
    );

    let post_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .expect("post overlays");
    assert!(
        !post_overlays.contains_key(&n_created),
        "trashed run-created note overlay must be deleted"
    );
    let key = format!("{}:{}:{}", view.note, view.key, n_created);
    let rank_tombstone = store
        .read_entity_revision_at_cutoff(
            &scope,
            "rank",
            &key,
            Some(rollback_committed.receipt.seq()),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        rank_tombstone.visibility_seq,
        rollback_committed.receipt.seq()
    );
    assert_ne!(
        rank_tombstone.revision_id,
        cur_overlays[&n_created].rank_rev_id
    );
    let notarium_canonical::codec::RevisionMetadataPayload::Rank(removed) =
        rank_tombstone.metadata.payload
    else {
        panic!("expected rank tombstone");
    };
    assert!(removed.removed);
    assert_eq!(removed.view_note_id, view.note);
    assert_eq!(removed.view_key, view.key);
    assert_eq!(removed.target_note_id, n_created);
    let old = store
        .read_entity_revision_at_cutoff(
            &scope,
            "rank",
            &key,
            Some(cur_overlays[&n_created].updated_seq),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(old.revision_id, cur_overlays[&n_created].rank_rev_id);
    assert!(matches!(
        old.metadata.payload,
        notarium_canonical::codec::RevisionMetadataPayload::Rank(rank) if !rank.removed
    ));
    let projection = support::maintenance_ctx(notarium_core::ports::ServicePurpose::Projection);
    let ranked = store
        .read_projection_overlays_page(
            &projection,
            &scope,
            rollback_committed.receipt.seq(),
            None,
            notarium_core::ports::PageLimit::new(200).unwrap(),
        )
        .await
        .unwrap();
    assert!(
        ranked
            .rows
            .iter()
            .all(|row| row.metadata.target_note_id != n_created)
    );
    assert!(
        ranked
            .rows
            .iter()
            .any(|row| row.metadata.target_note_id == n_pre)
    );
    assert_eq!(post_overlays[&n_pre].group, todo_grp);
    assert!(
        post_overlays[&n_pre].sort_rank_lexo < post_overlays[&n_anchor].sort_rank_lexo,
        "n_pre must be restored before n_anchor in todo column"
    );

    let lineage_after = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT lineage_epoch FROM collab_sessions WHERE space_id = '{}' AND note_id = '{}'",
                scope.space_id.as_str(),
                n_pre.as_str()
            ),
        )
        .await
        .expect("read lineage_epoch");
    assert_eq!(
        lineage_after, 6,
        "closed collab_sessions.lineage_epoch must advance 5 -> 6 on rollback"
    );

    let restored_from_cnt = store
        .execute_diagnostic_read_sql_for_test(
            None,
            &format!(
                "SELECT COUNT(*) FROM revisions WHERE space_id = '{}' AND rev_id = '{}' AND restored_from_rev_id = '{}'",
                scope.space_id.as_str(),
                rb.restored[0].revision.as_str(),
                pre_v0.value.revision.as_str()
            ),
        )
        .await
        .expect("check restored_from_rev_id");
    assert_eq!(
        restored_from_cnt, 1,
        "forward revert revision must record restored_from_rev_id"
    );

    // Atomicity check on post-trash slug conflict:
    // Run 2 renames `n_pre` away from `"roadmap"`, then a foreign human creates an independent active note at `"roadmap"`.
    // Rolling back Run 2 MUST abort atomically with `PathConflict` without partially mutating anything!
    let run_2 = sample_run_id(10);
    let run_2_ctx = agent_run_ctx(&human_ctx, run_2.clone());
    let run2_ren = store
        .rename_note(
            run_2_ctx,
            next_mutation(
                &scope,
                &owner,
                RenameNote {
                    note: n_pre.clone(),
                    slug: "roadmap-temp-away".to_owned(),
                    title: None,
                },
            ),
        )
        .await
        .expect("run_2 renames n_pre");

    let blocker_note = sample_note_id(119);
    store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: blocker_note,
                    parent: None,
                    slug: "roadmap".to_owned(), // Foreign note occupies `"roadmap"`!
                    class: DocClass::UserDoc,
                    carrier: "# Blocker\n".to_owned(),
                },
            ),
        )
        .await
        .expect("foreign blocker note takes slug roadmap");

    let run2_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run_2)
        .await
        .expect("run_2 rev")
        .expect("exists");
    let seq_before_abort = store
        .read_space(&scope.space_id)
        .await
        .expect("space")
        .last_seq;

    let conflict_rb = store
        .rollback_agent_run(
            human_ctx,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run: run_2,
                    expected_run_revision: run2_rev,
                    expected_entities: vec![NoteRevision {
                        note: n_pre,
                        revision: run2_ren.value.revision,
                    }],
                    associated_board_expectations: Vec::new(),
                },
            ),
        )
        .await;
    assert!(
        matches!(
            conflict_rb,
            Err(PortError::Domain(DomainError::PathConflict { .. }))
        ),
        "post-trash slug collision must abort RollbackAgentRun with PathConflict, got {conflict_rb:?}"
    );
    let seq_after_abort = store
        .read_space(&scope.space_id)
        .await
        .expect("space")
        .last_seq;
    assert_eq!(
        seq_before_abort, seq_after_abort,
        "aborted RollbackAgentRun must leave last_seq untouched"
    );
    projection_rank_history::check_board_exit_tombstones_rank(
        store,
        &scope,
        &owner,
        &planner,
        &view,
        view_c.value.revision,
    )
    .await;
    check_rollback_destination_authority(store, &scope, &owner).await;
}

#[tokio::test]
async fn l6_move_board_card_planner_cutoff_and_pma_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-move-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        let evidence = Box::pin(run_move_board_card_suite(&store)).await;
        let mut conn = root.open_raw_sqlite().await;
        let bytes: Vec<u8> = sqlx::query_scalar(
            "SELECT effect_msgpack FROM change_payloads WHERE created_seq=? AND codec='effect_v1'",
        )
        .bind(evidence.column_change.get() as i64)
        .fetch_one(&mut conn)
        .await
        .unwrap();
        sqlx::query("DELETE FROM revisions WHERE rev_id=?")
            .bind(evidence.neighbor_rank.as_str())
            .execute(&mut conn)
            .await
            .unwrap();
        verify_board_effects(&store, evidence, &bytes).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }

    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6mov");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        let evidence = Box::pin(run_move_board_card_suite(&store)).await;
        let mut conn = fixtures.open_raw_pg().await;
        let bytes: Vec<u8> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("SELECT effect_msgpack FROM {schema}.change_payloads WHERE created_seq=$1 AND codec='effect_v1'")))
            .bind(evidence.column_change.get() as i64).fetch_one(&mut conn).await.unwrap();
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "DELETE FROM {schema}.revisions WHERE rev_id=$1"
        )))
        .bind(evidence.neighbor_rank.as_str())
        .execute(&mut conn)
        .await
        .unwrap();
        verify_board_effects(&store, evidence, &bytes).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_agent_run_ordering_trash_first_and_atomicity_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-rb-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_rollback_agent_run_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }

    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6rbk");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_rollback_agent_run_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

async fn check_rollback_destination_authority(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
) {
    let human = owner_ctx(scope, owner.clone());
    let destination = sample_folder_id(208);
    let current = sample_folder_id(209);
    for (id, slug) in [
        (&destination, "rollback-source"),
        (&current, "rollback-current"),
    ] {
        store
            .create_folder(notarium_canonical::CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: id.clone(),
                parent: None,
                slug: slug.into(),
                display_name: slug.into(),
                is_project: true,
                project_slug: Some(slug.into()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let note = sample_note_id(208);
    store
        .create_note(
            human.clone(),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: Some(destination.clone()),
                    slug: "moved-between-projects".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Original placement\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let run = sample_run_id(208);
    let moved = store
        .move_note(
            agent_run_ctx(&human, run.clone()),
            next_mutation(
                scope,
                owner,
                notarium_core::ports::MoveNote {
                    note: note.clone(),
                    parent: Some(current.clone()),
                    slug: "moved-between-projects".into(),
                },
            ),
        )
        .await
        .unwrap();
    let revision = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let rollback = next_mutation(
        scope,
        owner,
        RollbackAgentRun {
            run,
            expected_run_revision: revision.clone(),
            expected_entities: vec![moved.value],
            associated_board_expectations: vec![],
        },
    );
    let mut stale = rollback.clone();
    stale.input.expected_run_revision = RevisionId::from_bytes([93; 16]);
    store
        .set_folder_write_lock(human.clone(), current.clone(), true)
        .await
        .unwrap();
    let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert!(matches!(
        store.rollback_agent_run(human.clone(), stale.clone()).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        cut
    );
    store
        .set_folder_write_lock(human.clone(), current.clone(), false)
        .await
        .unwrap();
    assert!(
        matches!(store.rollback_agent_run(human.clone(), stale).await,
        Err(PortError::Domain(DomainError::RevisionConflict { current, .. })) if current == revision)
    );
    store
        .set_folder_write_lock(human.clone(), destination.clone(), true)
        .await
        .unwrap();
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let denied = store
        .rollback_agent_run(human.clone(), rollback.clone())
        .await;
    assert!(
        matches!(denied, Err(PortError::Domain(DomainError::SpaceReadOnly))),
        "locked rollback destination: {denied:?}"
    );
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
    store
        .set_folder_write_lock(human.clone(), destination, false)
        .await
        .unwrap();

    let mut grants = human.auth().spaces().clone();
    grants.get_mut(&scope.space_id).unwrap().project_root = Some(current);
    let pinned = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner.clone(),
            GrantId::from_bytes([7; 16]),
            grants,
            true,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let denied = store.rollback_agent_run(pinned, rollback.clone()).await;
    assert!(
        matches!(
            denied,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "out-of-project rollback destination: {denied:?}"
    );
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
    let restored = store.rollback_agent_run(human, rollback).await.unwrap();
    assert_eq!(restored.value.restored.len(), 1);
    assert_eq!(restored.value.restored[0].note, note);
}

async fn check_rollback_with_dirty_room(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
) {
    use notarium_canonical::peers::{AppendCollabUpdate, CloseCollabSession, OpenCollabSession};
    let human = owner_ctx(scope, owner.clone());
    let note = sample_note_id(232);
    let run = sample_run_id(46);
    let created = store
        .create_note(
            agent_run_ctx(&human, run.clone()),
            next_mutation(
                scope,
                owner,
                CreateNote {
                    folder_page: false,
                    note: note.clone(),
                    parent: None,
                    slug: "unsettled".into(),
                    class: DocClass::UserDoc,
                    carrier: "Unsettled".into(),
                },
            ),
        )
        .await
        .unwrap();
    let opened = store
        .open_collab_session(
            &make_budget(),
            OpenCollabSession {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "room-owner".into(),
                expected_carrier_rev: created.value.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    store
        .append_collab_update(
            &make_budget(),
            AppendCollabUpdate {
                scope: scope.clone(),
                note: note.clone(),
                owner_id: "room-owner".into(),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                update_seq: 1,
                update_bytes: vec![1, 2, 3],
            },
        )
        .await
        .unwrap();
    let closed = store
        .close_collab_session(
            &make_budget(),
            CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: note.clone(),
                owner_id: Some("room-owner".into()),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();
    assert!(closed.carrier_dirty);
    let run_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let result = store
        .rollback_agent_run(
            human,
            next_mutation(
                scope,
                owner,
                RollbackAgentRun {
                    run,
                    expected_run_revision: run_rev,
                    expected_entities: vec![NoteRevision {
                        note: note.clone(),
                        revision: created.value.revision,
                    }],
                    associated_board_expectations: Vec::new(),
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        result.value.skipped_room_active.as_slice(),
        std::slice::from_ref(&note)
    );
    assert!(result.value.trashed.is_empty());
    let snap = store
        .read_collab_session(None, scope, &note)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(snap.session, closed);
    assert_eq!(snap.updates.len(), 1);
    assert_eq!(snap.updates[0].update_bytes, [1, 2, 3]);
}

async fn note_metadata_at(
    store: &CanonicalStore,
    scope: &HistoryScope,
    revision: &NoteRevision,
    receipt: &notarium_core::receipt::MutationReceiptToken,
) -> notarium_canonical::codec::NoteRevisionMetadata {
    let record = store
        .read_entity_revision_at_cutoff(scope, "note", revision.note.as_str(), Some(receipt.seq()))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(record.revision_id, revision.revision);
    let notarium_canonical::codec::RevisionMetadataPayload::Note(meta) = record.metadata.payload
    else {
        panic!("expected note metadata");
    };
    meta
}

async fn check_legacy_rollback(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    command: &Mutation<RollbackAgentRun>,
    committed: &notarium_core::ports::Committed<notarium_core::ports::RollbackResult>,
    postgres: bool,
) {
    assert!(command.input.associated_board_expectations.is_empty());
    let mut payload = blake3::Hasher::new();
    payload.update(command.input.run.as_str().as_bytes());
    payload.update(&[0]);
    payload.update(command.input.expected_run_revision.as_str().as_bytes());
    for expected in &command.input.expected_entities {
        payload.update(&[0]);
        payload.update(expected.note.as_str().as_bytes());
        payload.update(expected.revision.as_str().as_bytes());
    }
    let mut hash = blake3::Hasher::new();
    hash.update(b"notarium-cmd-v1:rollback_agent_run\0");
    hash.update(command.identity.hash.as_bytes());
    hash.update(&[0]);
    hash.update(payload.finalize().as_bytes());
    let hex = hash.finalize().to_hex();
    let literal = if postgres {
        format!("decode('{hex}','hex')")
    } else {
        format!("X'{hex}'")
    };
    assert_eq!(store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE command_receipts SET command_hash={literal} WHERE space_id='{}' AND actor_id='{}' AND idempotency_key='{}'",
        ctx.scope().space_id.as_str(), command.identity.actor.as_str(), command.identity.key.as_str()
    )).await.unwrap(),1);
    let replayed = store
        .rollback_agent_run(ctx.clone(), command.clone())
        .await
        .unwrap();
    assert_eq!(replayed.receipt, committed.receipt);
    assert_eq!(replayed.value, committed.value);
    let mut changed = command.clone();
    changed.input.expected_entities.reverse();
    assert!(matches!(
        store.rollback_agent_run(ctx.clone(), changed).await,
        Err(PortError::Domain(DomainError::IdempotencyKeyReused))
    ));
    assert_eq!(
        store
            .read_space(&ctx.scope().space_id)
            .await
            .unwrap()
            .last_seq,
        committed.receipt.seq()
    );
}

async fn run_note_only_rollback_suite(
    store: &CanonicalStore,
    mut pg: Option<&mut sqlx::PgConnection>,
) {
    let owner = sample_principal_id(45);
    let run_id = sample_run_id(45);
    let (scope, root_folder) = seed_space(
        store,
        sample_space_id(45),
        sample_incarnation(45),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());
    let run_ctx = agent_run_ctx(&human_ctx, run_id.clone());

    let n_ed = sample_note_id(201);
    let cur_c = "---\ntitle: V0\n---\nHello v0\n";
    let pre = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_ed.clone(),
                    parent: None,
                    slug: "note-only-pre".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: cur_c.to_owned(),
                },
            ),
        )
        .await
        .expect("create pre");

    let plan = extract::finalize_document(
        cur_c,
        DocClass::UserDoc,
        &n_ed,
        &[FieldEdit::Set {
            key: "touched".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("plan");
    let ed = store
        .edit_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: n_ed.clone(),
                    plan,
                },
            ),
        )
        .await
        .expect("run edit");

    let n_cr = sample_note_id(202);
    let created_carrier = "---\ntitle: Created\npriority: 3\ntags: [red, green]\n---\nBody\n";
    let cr = store
        .create_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_cr.clone(),
                    parent: None,
                    slug: "note-only-created".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: created_carrier.into(),
                },
            ),
        )
        .await
        .expect("run create");

    // A duplicate ordinary key is opaque YAML with a preserved diagnostic.
    let opaque_carrier = "---\nstatus: draft\nstatus: sent\n---\nOpaque body\n";
    let opaque = store
        .create_note(
            run_ctx,
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: sample_note_id(203),
                    parent: None,
                    slug: "opaque-created".into(),
                    class: DocClass::UserDoc,
                    carrier: opaque_carrier.into(),
                },
            ),
        )
        .await
        .unwrap();
    let pre_meta = note_metadata_at(store, &scope, &pre.value, &pre.receipt).await;
    let created_meta = note_metadata_at(store, &scope, &cr.value, &cr.receipt).await;
    let opaque_meta = note_metadata_at(store, &scope, &opaque.value, &opaque.receipt).await;
    assert!(
        created_meta
            .raw_fields
            .as_ref()
            .unwrap()
            .contains_key("tags")
    );
    assert!(created_meta.evaluated_fields.contains_key("priority"));
    assert!(!opaque_meta.diagnostics.is_empty());
    let unrelated = sample_note_id(231);
    let unrelated_rev = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: unrelated.clone(),
                    parent: None,
                    slug: "unrelated-live".into(),
                    class: DocClass::UserDoc,
                    carrier: "Unrelated".into(),
                },
            ),
        )
        .await
        .unwrap();
    let open = |note, rev| notarium_canonical::peers::OpenCollabSession {
        scope: scope.clone(),
        note,
        owner_id: "room-owner".into(),
        expected_carrier_rev: rev,
        expected_lease: None,
        expected_lineage: None,
        initial_yrs_snapshot: None,
        allow_fenced_recovery: false,
    };
    let live = store
        .open_collab_session(
            &make_budget(),
            open(unrelated, unrelated_rev.value.revision),
        )
        .await
        .unwrap();
    let opened = store
        .open_collab_session(
            &make_budget(),
            open(n_ed.clone(), ed.value.revision.clone()),
        )
        .await
        .unwrap();
    let closed = store
        .close_collab_session(
            &make_budget(),
            notarium_canonical::peers::CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: n_ed.clone(),
                owner_id: Some("room-owner".into()),
                expected_lease: opened.lease_epoch,
                expected_lineage: opened.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();

    let seeded_snapshot = if let Some(db) = pg.as_deref_mut() {
        // A settled snapshot may share a publication with the revision about to be restored.
        let snapshot = cur_c.as_bytes();
        sqlx::query("UPDATE collab_sessions SET yrs_snapshot_blob=$1, yrs_snapshot_blake3=$2 WHERE space_id=$3 AND note_id=$4")
            .bind(snapshot).bind(blake3::hash(snapshot).as_bytes().as_slice())
            .bind(scope.space_id.as_str()).bind(n_ed.as_str()).execute(&mut *db).await.unwrap();
        sqlx::query("INSERT INTO collab_checkpoints(space_id, note_id, snapshot_lease_epoch, snapshot_update_seq, carrier_dirty)
                     VALUES ($1, $2, $3, 1, 0)
                     ON CONFLICT(space_id,note_id) DO UPDATE SET snapshot_lease_epoch=$3, snapshot_update_seq=1, carrier_dirty=0")
            .bind(scope.space_id.as_str()).bind(n_ed.as_str()).bind(opened.lease_epoch.get() as i64)
            .execute(&mut *db).await.unwrap();
        let shared_digest: Vec<u8> = sqlx::query_scalar(
            "INSERT INTO blob_references (space_id, owner_kind, owner_id, owner_rev_id, resource_key,
                                          content_blake3, publication_id, created_seq)
             SELECT space_id,'collab_snapshot',owner_id,owner_rev_id,'snapshot',content_blake3,publication_id,created_seq
             FROM blob_references WHERE space_id=$1 AND owner_kind='note_revision' AND owner_id=$2 AND owner_rev_id=$3
             RETURNING content_blake3",
        ).bind(scope.space_id.as_str()).bind(n_ed.as_str()).bind(pre.value.revision.as_str())
            .fetch_one(&mut *db).await.unwrap();
        assert_eq!(shared_digest.as_slice(), blake3::hash(snapshot).as_bytes());
        sqlx::query(
            "UPDATE blob_catalog SET ref_count=ref_count+1 WHERE space_id=$1 AND content_blake3=$2",
        )
        .bind(scope.space_id.as_str())
        .bind(&shared_digest)
        .execute(&mut *db)
        .await
        .unwrap();

        // Record which public rollback route actually performed the room update.
        sqlx::raw_sql("CREATE TABLE room_rollback_calls (used_root_function BOOLEAN NOT NULL);
            CREATE FUNCTION observe_room_rollback() RETURNS trigger LANGUAGE plpgsql AS $fn$
            BEGIN
                INSERT INTO room_rollback_calls VALUES (position('notarium_pg_lean_commit_v3(' IN current_query()) > 0);
                RETURN NEW;
            END;
            $fn$;
            CREATE TRIGGER observe_room_rollback AFTER UPDATE OF lineage_epoch ON collab_sessions
            FOR EACH ROW EXECUTE FUNCTION observe_room_rollback()")
            .execute(&mut *db).await.unwrap();
        Some(shared_digest)
    } else {
        None
    };
    let run_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run_id)
        .await
        .unwrap()
        .unwrap();

    let rollback = next_mutation(
        &scope,
        &owner,
        RollbackAgentRun {
            run: run_id,
            expected_run_revision: run_rev,
            expected_entities: vec![ed.value.clone(), cr.value.clone(), opaque.value.clone()],
            associated_board_expectations: Vec::new(),
        },
    );
    let mut grants = human_ctx.auth().spaces().clone();
    grants
        .get_mut(&scope.space_id)
        .unwrap()
        .write_classes
        .remove(&DocClass::UserDoc);
    let restricted = SpaceContext::new(
        EngineAuthContext::for_human(VerifiedHuman::attest(
            owner.clone(),
            GrantId::from_bytes([7; 16]),
            grants,
            true,
        )),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert!(matches!(
        store.rollback_agent_run(restricted, rollback.clone()).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
    assert_eq!(
        store
            .read_collab_session(None, &scope, &n_ed)
            .await
            .unwrap()
            .unwrap()
            .session
            .lineage_epoch,
        closed.lineage_epoch
    );

    let rb = store
        .rollback_agent_run(human_ctx.clone(), rollback.clone())
        .await
        .expect("note-only rollback");
    check_legacy_rollback(store, &human_ctx, &rollback, &rb, pg.is_some()).await;
    assert_eq!(rb.value.restored.len(), 1);
    assert_eq!(rb.value.trashed.len(), 2);
    let restored = note_metadata_at(store, &scope, &rb.value.restored[0], &rb.receipt).await;
    assert_eq!(restored, pre_meta);
    assert_eq!(restored.parent_folder_id, root_folder);
    assert!(restored.is_root_child);
    for (original, carrier) in [
        (created_meta, created_carrier),
        (opaque_meta, opaque_carrier),
    ] {
        let trash = rb
            .value
            .trashed
            .iter()
            .find(|r| r.note == original.note_id)
            .unwrap();
        let trash_meta = note_metadata_at(store, &scope, trash, &rb.receipt).await;
        let mut expected = original.clone();
        expected.lifecycle = Lifecycle::Trashed;
        assert_eq!(trash_meta, expected);
        let undo = store
            .delete_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::DeleteNote {
                        note: original.note_id.clone(),
                        disposition: notarium_core::ports::DeleteDisposition::Restore,
                    },
                ),
            )
            .await
            .unwrap();
        assert_eq!(
            note_metadata_at(store, &scope, &undo.value, &undo.receipt).await,
            original
        );
        for (revision, expected_lifecycle) in [
            (Some(trash.revision.clone()), Lifecycle::Trashed),
            (None, Lifecycle::Active),
        ] {
            let snap = store
                .get_note(
                    human_ctx.clone(),
                    GetNote {
                        note: original.note_id.clone(),
                        revision,
                        causal: CausalBasis::Exact(
                            ReceiptSet::new([undo.receipt.clone()]).unwrap(),
                        ),
                    },
                )
                .await
                .unwrap();
            assert_eq!(snap.document.lifecycle(), expected_lifecycle);
            assert_eq!(
                snap.document.explicit_read(human_ctx.auth()).unwrap(),
                carrier
            );
            assert_eq!(snap.parent, None);
            assert_eq!(snap.fields, original.evaluated_fields);
            assert_eq!(snap.diagnostics, original.diagnostics);
        }
    }
    let now = store
        .read_collab_session(None, &scope, &n_ed)
        .await
        .unwrap()
        .unwrap()
        .session;
    assert_eq!(now.lease_epoch, closed.lease_epoch);
    assert_eq!(now.lineage_epoch.get(), closed.lineage_epoch.get() + 1);
    assert_eq!(now.carrier_rev_id, rb.value.restored[0].revision);
    assert_eq!(now.updated_seq, rb.receipt.seq());
    assert!(now.yrs_snapshot_blob.is_none() && now.yrs_snapshot_digest.is_none());
    assert!(now.snapshot_coverage.is_none() && !now.carrier_dirty);
    assert_eq!(
        store
            .read_collab_session(None, &scope, &live.note)
            .await
            .unwrap()
            .unwrap()
            .session,
        live
    );
    if let (Some(db), Some(shared_digest)) = (pg, seeded_snapshot) {
        let clean: (bool, i64, i64) = sqlx::query_as(
            "SELECT NOT EXISTS(SELECT 1 FROM blob_references WHERE space_id=$1 AND owner_kind='collab_snapshot' AND owner_id=$2),
                    (SELECT ref_count FROM blob_catalog WHERE space_id=$1 AND content_blake3=$3),
                    (SELECT count(*) FROM blob_references WHERE space_id=$1 AND content_blake3=$3)"
        ).bind(scope.space_id.as_str()).bind(n_ed.as_str()).bind(&shared_digest).fetch_one(&mut *db).await.unwrap();
        assert!(clean.0 && clean.1 > 0);
        assert_eq!(clean.1, clean.2);
        let calls: Vec<bool> =
            sqlx::query_scalar("SELECT used_root_function FROM room_rollback_calls")
                .fetch_all(&mut *db)
                .await
                .unwrap();
        assert_eq!(calls, [true]);
    }
    check_rollback_with_dirty_room(store, &scope, &owner).await;
    let got = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: n_ed,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::new([rb.receipt]).unwrap()),
            },
        )
        .await
        .expect("read restored");
    assert_eq!(
        got.document.explicit_read(human_ctx.auth()).expect("read"),
        cur_c
    );
    check_rollback_destination_authority(store, &scope, &owner).await;
}

#[tokio::test]
async fn l6_note_only_rollback_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-nonly-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_note_only_rollback_suite(&store, None).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6non");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let mut cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);
        // Exercise the smallest pool that can keep a warm rollback session.
        let notarium_canonical::SqlBackendConfig::Postgres { pool_size, .. } = &mut cfg.sql else {
            unreachable!()
        };
        *pool_size = 3;
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        let mut conn = fixtures.open_raw_pg().await;
        sqlx::query(sqlx::AssertSqlSafe(format!("SET search_path TO {schema}")))
            .execute(&mut conn)
            .await
            .unwrap();
        run_note_only_rollback_suite(&store, Some(&mut conn)).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

async fn run_sibling_slug_swap_rollback_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(46);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(46),
        sample_incarnation(46),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    for (mode_idx, mix_folder) in [(0u8, false), (1u8, true)] {
        let base = 210u8 + mode_idx * 20;
        let folder_id = FolderId::from_bytes([base; 16]);
        let (folder_ref, _, _) = store
            .create_folder(notarium_canonical::CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: folder_id.clone(),
                parent: None,
                slug: format!("rb-swap-dir-{mode_idx}"),
                display_name: format!("RB Swap Dir {mode_idx}"),
                is_project: false,
                project_slug: None,
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .expect("create folder");
        let parent = Some(folder_ref.folder_id.clone());
        let mix_dir = if mix_folder {
            let mix_id = FolderId::from_bytes([base + 15; 16]);
            store
                .create_folder(notarium_canonical::CreateFolderSpec {
                    scope: scope.clone(),
                    active_epoch: LeaseEpoch::new(1).unwrap(),
                    folder_id: mix_id.clone(),
                    parent: parent.clone(),
                    slug: "mix-sub-orig".into(),
                    display_name: "Mix Sub Orig".into(),
                    is_project: false,
                    project_slug: None,
                    actor: owner.clone(),
                    timestamp: None,
                })
                .await
                .expect("create mix subfolder");
            Some(mix_id)
        } else {
            None
        };

        // Scenario 1: Intra-batch sibling slug swap (A: alpha -> tmp, B: beta -> alpha, A: tmp -> beta).
        let a = NoteId::from_bytes([base, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let b = NoteId::from_bytes([base, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        assert!(a.as_str() < b.as_str());
        for (nid, slug, title) in [(&a, "alpha", "Alpha"), (&b, "beta", "Beta")] {
            store
                .create_note(
                    human_ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        CreateNote {
                            folder_page: false,
                            note: nid.clone(),
                            parent: parent.clone(),
                            slug: slug.into(),
                            class: DocClass::UserDoc,
                            carrier: format!("# {title}\n"),
                        },
                    ),
                )
                .await
                .unwrap();
        }
        let swap_run = sample_run_id(base + 1);
        let swap_ctx = agent_run_ctx(&human_ctx, swap_run.clone());
        let a_tmp = store
            .move_note(
                swap_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::MoveNote {
                        note: a.clone(),
                        parent: parent.clone(),
                        slug: "tmp".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let b_alpha = store
            .move_note(
                swap_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::MoveNote {
                        note: b.clone(),
                        parent: parent.clone(),
                        slug: "alpha".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let a_beta = store
            .move_note(
                swap_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::MoveNote {
                        note: a.clone(),
                        parent: parent.clone(),
                        slug: "beta".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let expected = vec![a_beta.value.clone(), b_alpha.value.clone()];
        if let Some(mix_id) = &mix_dir {
            let renamed = store
                .rename_folder(
                    swap_ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        notarium_core::ports::RenameFolder {
                            folder: mix_id.clone(),
                            name: "mix-sub-1".into(),
                        },
                    ),
                )
                .await
                .unwrap();
            let _ = renamed;
        }
        let _ = a_tmp;
        let run_rev = store
            .inspect_agent_run_revision_for_test(&scope.space_id, &swap_run)
            .await
            .unwrap()
            .unwrap();
        let rb = store
            .rollback_agent_run(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    RollbackAgentRun {
                        run: swap_run,
                        expected_run_revision: run_rev,
                        expected_entities: expected,
                        associated_board_expectations: Vec::new(),
                    },
                ),
            )
            .await
            .expect("sibling slug swap rollback must succeed");
        assert_eq!(rb.value.restored.len(), 2);
        let a_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == a).unwrap(),
            &rb.receipt,
        )
        .await;
        let b_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == b).unwrap(),
            &rb.receipt,
        )
        .await;
        assert_eq!(a_after.slug, "alpha");
        assert_eq!(b_after.slug, "beta");

        // Scenario 2: 2-step rename chain (NoteId(c) < NoteId(d): c: c-one -> c-gamma, d: c-two -> c-one).
        let c = NoteId::from_bytes([base, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let d = NoteId::from_bytes([base, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        assert!(c.as_str() < d.as_str());
        for (nid, slug) in [(&c, "c-one"), (&d, "c-two")] {
            store
                .create_note(
                    human_ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        CreateNote {
                            folder_page: false,
                            note: nid.clone(),
                            parent: parent.clone(),
                            slug: slug.into(),
                            class: DocClass::UserDoc,
                            carrier: format!("# {slug}\n"),
                        },
                    ),
                )
                .await
                .unwrap();
        }
        let chain_run = sample_run_id(base + 2);
        let chain_ctx = agent_run_ctx(&human_ctx, chain_run.clone());
        let c_moved = store
            .move_note(
                chain_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::MoveNote {
                        note: c.clone(),
                        parent: parent.clone(),
                        slug: "c-gamma".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let d_moved = store
            .move_note(
                chain_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::MoveNote {
                        note: d.clone(),
                        parent: parent.clone(),
                        slug: "c-one".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let expected = vec![c_moved.value.clone(), d_moved.value.clone()];
        if let Some(mix_id) = &mix_dir {
            store
                .rename_folder(
                    chain_ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        notarium_core::ports::RenameFolder {
                            folder: mix_id.clone(),
                            name: "mix-sub-2".into(),
                        },
                    ),
                )
                .await
                .unwrap();
        }
        let run_rev = store
            .inspect_agent_run_revision_for_test(&scope.space_id, &chain_run)
            .await
            .unwrap()
            .unwrap();
        let rb = store
            .rollback_agent_run(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    RollbackAgentRun {
                        run: chain_run,
                        expected_run_revision: run_rev,
                        expected_entities: expected,
                        associated_board_expectations: Vec::new(),
                    },
                ),
            )
            .await
            .expect("rename chain rollback must succeed");
        assert_eq!(rb.value.restored.len(), 2);
        let c_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == c).unwrap(),
            &rb.receipt,
        )
        .await;
        let d_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == d).unwrap(),
            &rb.receipt,
        )
        .await;
        assert_eq!(c_after.slug, "c-one");
        assert_eq!(d_after.slug, "c-two");

        // Scenario 3: Trash + slug reuse (NoteId(e) < NoteId(f): e active at reuse-slug,
        // f trashed at reuse-slug; run trashes e and restores f at reuse-slug).
        let e = NoteId::from_bytes([base, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        let f = NoteId::from_bytes([base, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
        assert!(e.as_str() < f.as_str());
        store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: f.clone(),
                        parent: parent.clone(),
                        slug: "reuse-slug".into(),
                        class: DocClass::UserDoc,
                        carrier: "# F\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        store
            .delete_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::DeleteNote {
                        note: f.clone(),
                        disposition: notarium_core::ports::DeleteDisposition::Trash,
                    },
                ),
            )
            .await
            .unwrap();
        store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: e.clone(),
                        parent: parent.clone(),
                        slug: "reuse-slug".into(),
                        class: DocClass::UserDoc,
                        carrier: "# E\n".into(),
                    },
                ),
            )
            .await
            .unwrap();
        let reuse_run = sample_run_id(base + 3);
        let reuse_ctx = agent_run_ctx(&human_ctx, reuse_run.clone());
        let e_trashed = store
            .delete_note(
                reuse_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::DeleteNote {
                        note: e.clone(),
                        disposition: notarium_core::ports::DeleteDisposition::Trash,
                    },
                ),
            )
            .await
            .unwrap();
        let f_restored = store
            .delete_note(
                reuse_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    notarium_core::ports::DeleteNote {
                        note: f.clone(),
                        disposition: notarium_core::ports::DeleteDisposition::Restore,
                    },
                ),
            )
            .await
            .unwrap();
        let expected = vec![e_trashed.value.clone(), f_restored.value.clone()];
        if let Some(mix_id) = &mix_dir {
            store
                .rename_folder(
                    reuse_ctx.clone(),
                    next_mutation(
                        &scope,
                        &owner,
                        notarium_core::ports::RenameFolder {
                            folder: mix_id.clone(),
                            name: "mix-sub-3".into(),
                        },
                    ),
                )
                .await
                .unwrap();
        }
        let run_rev = store
            .inspect_agent_run_revision_for_test(&scope.space_id, &reuse_run)
            .await
            .unwrap()
            .unwrap();
        let rb = store
            .rollback_agent_run(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    RollbackAgentRun {
                        run: reuse_run,
                        expected_run_revision: run_rev,
                        expected_entities: expected,
                        associated_board_expectations: Vec::new(),
                    },
                ),
            )
            .await
            .expect("trash+reuse rollback must succeed");
        let e_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == e).unwrap(),
            &rb.receipt,
        )
        .await;
        let f_after = note_metadata_at(
            store,
            &scope,
            rb.value.restored.iter().find(|r| r.note == f).unwrap(),
            &rb.receipt,
        )
        .await;
        assert_eq!(e_after.lifecycle, Lifecycle::Active);
        assert_eq!(e_after.slug, "reuse-slug");
        assert_eq!(f_after.lifecycle, Lifecycle::Trashed);
    }
}

async fn run_board_unmoved_run_touched_neighbor_rollback_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(47);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(47),
        sample_incarnation(47),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let view1_note = sample_note_id(220);
    let view1_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view1_note.clone(),
                    parent: None,
                    slug: "unranked-neighbor-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Unranked Board\n---\n# Unranked Board\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create view1");
    let view1 = ViewRef {
        note: view1_note,
        key: ViewKey::from_bytes([0x67; 16]),
    };

    let view2_note = sample_note_id(221);
    let view2_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view2_note.clone(),
                    parent: None,
                    slug: "pma-neighbor-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: PMA Board\n---\n# PMA Board\n".to_owned(),
                },
            ),
        )
        .await
        .expect("create view2");
    let view2 = ViewRef {
        note: view2_note,
        key: ViewKey::from_bytes([0x68; 16]),
    };

    let e1 = sample_note_id(222);
    let t1 = sample_note_id(223);
    let n1 = sample_note_id(224);
    let e2 = sample_note_id(225);
    let t2 = sample_note_id(226);
    let n2 = sample_note_id(227);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            e1.clone(),
            t1.clone(),
            n1.clone(),
            e2.clone(),
            t2.clone(),
            n2.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let doing_grp = GroupKey::Value(ScalarValue::String("doing".to_owned()));

    // Case 1: Unranked group materialization.
    // All three notes start unranked in `todo` with order `[e1, t1, n1]` (note_id tiebreak).
    for (nid, slug, title) in [
        (&e1, "unranked-e1", "Unranked E1"),
        (&t1, "unranked-t1", "Unranked T1"),
        (&n1, "unranked-n1", "Unranked N1"),
    ] {
        store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {title}\nstatus: todo\n---\n# {title}\n"),
                    },
                ),
            )
            .await
            .expect("create unranked case note");
    }
    let t1_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: t1.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("t1 snap");

    let run1 = sample_run_id(220);
    let run1_ctx = agent_run_ctx(&human_ctx, run1.clone());
    // Run edits E1 metadata/body (no board move on view1) and moves T1 from `todo` -> `doing`.
    let e1_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: e1.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("e1 snap");
    let e1_plan = extract::finalize_document(
        e1_snap
            .document
            .explicit_read(human_ctx.auth())
            .expect("read e1"),
        DocClass::UserDoc,
        &e1,
        &[FieldEdit::Set {
            key: "agent_touched".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("e1 plan");
    let e1_edited = store
        .edit_note(
            run1_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: e1.clone(),
                    plan: e1_plan,
                },
            ),
        )
        .await
        .expect("run1 edits e1");
    let t1_moved = store
        .move_board_card(
            run1_ctx,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view1.clone(),
                    note: t1.clone(),
                    group: doing_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: t1_snap.document.revision().clone(),
                    expected_view: view1_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("run1 moves t1 to doing");
    let run1_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run1)
        .await
        .unwrap()
        .unwrap();
    let cur_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view1)
        .await
        .unwrap();
    assert!(
        !cur_ov1.contains_key(&e1) && !cur_ov1.contains_key(&n1),
        "e1 and n1 must start unranked before rollback"
    );
    store
        .rollback_agent_run(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run: run1,
                    expected_run_revision: run1_rev,
                    expected_entities: vec![e1_edited.value, t1_moved.value.revision.clone()],
                    associated_board_expectations: vec![AssociatedBoardExpectation {
                        view: view1.clone(),
                        note: t1.clone(),
                        expected_rank: RankExpectation::Existing(cur_ov1[&t1].rank_rev_id.clone()),
                        expected_placement_revision: cur_ov1[&t1].placement_revision.clone(),
                    }],
                },
            ),
        )
        .await
        .expect("unranked neighbor rollback must succeed");
    let post_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view1)
        .await
        .unwrap();
    assert!(
        post_ov1.contains_key(&e1) && post_ov1.contains_key(&t1) && post_ov1.contains_key(&n1),
        "rollback must materialize overlay rank for run-touched unmoved neighbor e1: {post_ov1:?}"
    );
    assert!(
        post_ov1[&e1].sort_rank_lexo < post_ov1[&t1].sort_rank_lexo
            && post_ov1[&t1].sort_rank_lexo < post_ov1[&n1].sort_rank_lexo,
        "restored order must preserve [e1, t1, n1], got e1={} t1={} n1={}",
        post_ov1[&e1].sort_rank_lexo,
        post_ov1[&t1].sort_rank_lexo,
        post_ov1[&n1].sort_rank_lexo
    );

    // Case 2: Window-PMA rank rebalance for adjacent extreme ranks (`e2 = RANK_SPACE - 2`,
    // `n2 = RANK_SPACE - 1`) while `e2` is body-edited by the run (not moved on view2).
    let mut c2_revs = BTreeMap::new();
    for (nid, slug, title) in [
        (&e2, "pma-e2", "PMA E2"),
        (&t2, "pma-t2", "PMA T2"),
        (&n2, "pma-n2", "PMA N2"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {title}\nstatus: todo\n---\n# {title}\n"),
                    },
                ),
            )
            .await
            .expect("create pma case note");
        c2_revs.insert(nid.clone(), c.value.revision);
    }
    // Materialize initial overlays for e2, t2, n2 in `todo` on view2.
    let t2_init_mv = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view2.clone(),
                    note: t2.clone(),
                    group: todo_grp.clone(),
                    before: Some(RankNeighbor {
                        note: n2.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: Some(RankNeighbor {
                        note: e2.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    fields: BTreeMap::new(),
                    expected_note: c2_revs[&t2].clone(),
                    expected_view: view2_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("materialize view2 todo ranks");

    let run2 = sample_run_id(221);
    let run2_ctx = agent_run_ctx(&human_ctx, run2.clone());
    // Run edits e2 metadata/body (no board move on view2) and moves t2 from `todo` -> `doing`.
    let e2_snap = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: e2.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("e2 snap");
    let e2_plan = extract::finalize_document(
        e2_snap
            .document
            .explicit_read(human_ctx.auth())
            .expect("read e2"),
        DocClass::UserDoc,
        &e2,
        &[FieldEdit::Set {
            key: "agent_touched".to_owned(),
            value: YamlValue::Bool(true),
        }],
    )
    .expect("e2 plan");
    let e2_edited = store
        .edit_note(
            run2_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                EditNote {
                    note: e2.clone(),
                    plan: e2_plan,
                },
            ),
        )
        .await
        .expect("run2 edits e2");
    let t2_moved = store
        .move_board_card(
            run2_ctx,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view2.clone(),
                    note: t2.clone(),
                    group: doing_grp,
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: t2_init_mv.value.revision.revision.clone(),
                    expected_view: view2_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(t2_init_mv.value.rank_revision),
                },
            ),
        )
        .await
        .expect("run2 moves t2 to doing");
    // Compress `e2` and `n2` to adjacent extreme base36 ranks so inserting `t2` between
    // them during rollback MUST trigger Window-PMA neighbor rebalancing on both `e2` and `n2`.
    let max_minus_1 = "zzzzzzzzzzzy";
    let max_rank = "zzzzzzzzzzzz";
    for (nid, extreme) in [(&e2, max_minus_1), (&n2, max_rank)] {
        let updated = store
            .execute_diagnostic_write_sql_for_test(&format!(
                "UPDATE view_rank_overlays SET sort_rank_lexo='{extreme}' \
                 WHERE space_id='{}' AND view_note_id='{}' AND view_key='{}' AND target_note_id='{}'",
                scope.space_id.as_str(),
                view2.note.as_str(),
                view2.key.as_str(),
                nid.as_str(),
            ))
            .await
            .expect("seed adjacent extreme ranks");
        assert_eq!(updated, 1);
    }
    let run2_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run2)
        .await
        .unwrap()
        .unwrap();
    let cur_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view2)
        .await
        .unwrap();
    store
        .rollback_agent_run(
            human_ctx,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run: run2,
                    expected_run_revision: run2_rev,
                    expected_entities: vec![e2_edited.value, t2_moved.value.revision.clone()],
                    associated_board_expectations: vec![AssociatedBoardExpectation {
                        view: view2.clone(),
                        note: t2.clone(),
                        expected_rank: RankExpectation::Existing(cur_ov2[&t2].rank_rev_id.clone()),
                        expected_placement_revision: cur_ov2[&t2].placement_revision.clone(),
                    }],
                },
            ),
        )
        .await
        .expect("PMA neighbor rollback must succeed");
    let post_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view2)
        .await
        .unwrap();
    assert_ne!(
        post_ov2[&e2].sort_rank_lexo, max_minus_1,
        "Window-PMA rebalance must persist updated rank for run-touched unmoved neighbor e2"
    );
    assert!(
        post_ov2[&e2].sort_rank_lexo < post_ov2[&t2].sort_rank_lexo
            && post_ov2[&t2].sort_rank_lexo < post_ov2[&n2].sort_rank_lexo,
        "PMA-rebalanced rollback must preserve strict order [e2, t2, n2], got e2={} t2={} n2={}",
        post_ov2[&e2].sort_rank_lexo,
        post_ov2[&t2].sort_rank_lexo,
        post_ov2[&n2].sort_rank_lexo
    );
}

async fn run_board_restored_note_and_group_reconciliation_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(61);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(61),
        sample_incarnation(61),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let view_note = sample_note_id(230);
    let view_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view_note.clone(),
                    parent: None,
                    slug: "reconcile-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Reconcile Board\n---\n# Reconcile Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view = ViewRef {
        note: view_note,
        key: ViewKey::from_bytes([0x69; 16]),
    };

    let n_trashed = sample_note_id(231);
    let n_ranked = sample_note_id(232);
    let n_anchor = sample_note_id(233);
    let m_card = sample_note_id(234);
    let n_outside = sample_note_id(235);
    let d_card = sample_note_id(236);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            n_trashed.clone(),
            n_ranked.clone(),
            n_anchor.clone(),
            m_card.clone(),
            n_outside.clone(),
            d_card.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let doing_grp = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let done_grp = GroupKey::Value(ScalarValue::String("done".to_owned()));

    // Case 1: Agent run restores a pre-existing trashed note and moves it on board V.
    // Rollback must succeed (retiring the note back to Trashed) instead of failing InvalidState.
    let n_trashed_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: n_trashed.clone(),
                    parent: None,
                    slug: "was-trashed".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Was Trashed\nstatus: todo\n---\nBody\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let n_trashed_del = store
        .delete_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                notarium_core::ports::DeleteNote {
                    note: n_trashed.clone(),
                    disposition: notarium_core::ports::DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert_ne!(n_trashed_c.value.revision, n_trashed_del.value.revision);

    let run1 = sample_run_id(231);
    let run1_ctx = agent_run_ctx(&human_ctx, run1.clone());
    let n_restored = store
        .delete_note(
            run1_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                notarium_core::ports::DeleteNote {
                    note: n_trashed.clone(),
                    disposition: notarium_core::ports::DeleteDisposition::Restore,
                },
            ),
        )
        .await
        .unwrap();
    let n_moved = store
        .move_board_card(
            run1_ctx,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n_trashed.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: n_restored.value.revision.clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let run1_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run1)
        .await
        .unwrap()
        .unwrap();
    let ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    assert!(ov1.contains_key(&n_trashed));
    let rb1 = store
        .rollback_agent_run(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run: run1,
                    expected_run_revision: run1_rev,
                    expected_entities: vec![n_moved.value.revision.clone()],
                    associated_board_expectations: vec![AssociatedBoardExpectation {
                        view: view.clone(),
                        note: n_trashed.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov1[&n_trashed].rank_rev_id.clone(),
                        ),
                        expected_placement_revision: ov1[&n_trashed].placement_revision.clone(),
                    }],
                },
            ),
        )
        .await
        .expect("rollback of restored-from-trash moved board card must succeed");
    let post_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    assert!(
        !post_ov1.contains_key(&n_trashed),
        "retired restored-from-trash card must have its overlay removed"
    );
    let post_n_trashed = note_metadata_at(
        store,
        &scope,
        rb1.value
            .restored
            .iter()
            .find(|r| r.note == n_trashed)
            .unwrap(),
        &rb1.receipt,
    )
    .await;
    assert_eq!(post_n_trashed.lifecycle, Lifecycle::Trashed);

    // Case 2 (Traces A, B, C combined):
    // - n_ranked, n_anchor, m_card start with persisted overlays in `todo`: [n_ranked, n_anchor, m_card].
    // - d_card starts unranked in `doing`.
    // - n_outside starts with `status: archived` (OutsideView, unranked).
    // In run2:
    // - move_board_card moves m_card `todo -> done` (before_placement pred=n_anchor) and d_card `doing -> done`.
    // - edit_note edits n_ranked `todo -> doing` (Trace A: must keep original `(todo, r0)`, never materialize in `doing` when d_card rolls back into `doing`).
    // - edit_note edits n_anchor `todo -> doing` (Trace C: must reconcile back to `todo` so m_card finds pred=n_anchor).
    // - edit_note edits n_outside `archived -> todo` (Trace B: must be excluded from `todo`, never getting a phantom overlay when m_card rolls back into `todo`).
    let mut created_revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for (nid, slug, status) in [
        (&n_ranked, "n-ranked", "todo"),
        (&n_anchor, "n-anchor", "todo"),
        (&m_card, "m-card", "todo"),
        (&n_outside, "n-outside", "archived"),
        (&d_card, "d-card", "doing"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: {status}\n---\nBody\n"),
                    },
                ),
            )
            .await
            .unwrap();
        created_revs.insert(nid.clone(), c.value.revision);
    }
    // Materialize initial overlays for [n_ranked, n_anchor, m_card] in `todo`.
    store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n_anchor.clone(),
                    group: todo_grp.clone(),
                    before: Some(RankNeighbor {
                        note: m_card.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: Some(RankNeighbor {
                        note: n_ranked.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    fields: BTreeMap::new(),
                    expected_note: created_revs[&n_anchor].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .expect("materialize todo ranks");

    let pre_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    let n_ranked_pre_rank = pre_ov2[&n_ranked].sort_rank_lexo.clone();
    let n_ranked_pre_group = pre_ov2[&n_ranked].group.clone();
    assert_eq!(n_ranked_pre_group, todo_grp);
    assert!(
        pre_ov2[&n_ranked].sort_rank_lexo < pre_ov2[&n_anchor].sort_rank_lexo
            && pre_ov2[&n_anchor].sort_rank_lexo < pre_ov2[&m_card].sort_rank_lexo
    );
    assert!(!pre_ov2.contains_key(&n_outside));
    assert!(!pre_ov2.contains_key(&d_card));

    let run2 = sample_run_id(232);
    let run2_ctx = agent_run_ctx(&human_ctx, run2.clone());
    // Step 1: move m_card `todo -> done` and d_card `doing -> done`.
    let m_moved = store
        .move_board_card(
            run2_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: m_card.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: created_revs[&m_card].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(pre_ov2[&m_card].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    let d_moved = store
        .move_board_card(
            run2_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: d_card.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: created_revs[&d_card].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();

    // Step 2: edit n_ranked (`todo -> doing`), n_anchor (`todo -> doing`), n_outside (`archived -> todo`).
    let mut edited_revs = Vec::new();
    for (nid, new_status) in [
        (&n_ranked, "doing"),
        (&n_anchor, "doing"),
        (&n_outside, "todo"),
    ] {
        let snap = store
            .get_note(
                run2_ctx.clone(),
                GetNote {
                    note: nid.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let raw = snap.document.explicit_read(run2_ctx.auth()).unwrap();
        let plan = extract::finalize_document(
            raw,
            DocClass::UserDoc,
            nid,
            &[FieldEdit::Set {
                key: "status".to_owned(),
                value: YamlValue::String(new_status.to_owned()),
            }],
        )
        .unwrap();
        let ed = store
            .edit_note(
                run2_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    EditNote {
                        note: nid.clone(),
                        plan,
                    },
                ),
            )
            .await
            .unwrap();
        edited_revs.push(ed.value);
    }

    let run2_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run2)
        .await
        .unwrap()
        .unwrap();
    let cur_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    let mut expected_entities = edited_revs;
    expected_entities.push(m_moved.value.revision.clone());
    expected_entities.push(d_moved.value.revision.clone());
    store
        .rollback_agent_run(
            human_ctx,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run: run2,
                    expected_run_revision: run2_rev,
                    expected_entities,
                    associated_board_expectations: vec![
                        AssociatedBoardExpectation {
                            view: view.clone(),
                            note: m_card.clone(),
                            expected_rank: RankExpectation::Existing(
                                cur_ov2[&m_card].rank_rev_id.clone(),
                            ),
                            expected_placement_revision: cur_ov2[&m_card]
                                .placement_revision
                                .clone(),
                        },
                        AssociatedBoardExpectation {
                            view: view.clone(),
                            note: d_card.clone(),
                            expected_rank: RankExpectation::Existing(
                                cur_ov2[&d_card].rank_rev_id.clone(),
                            ),
                            expected_placement_revision: cur_ov2[&d_card]
                                .placement_revision
                                .clone(),
                        },
                    ],
                },
            ),
        )
        .await
        .expect("board rollback reconciling non-moved edited notes must succeed");

    let post_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    // Trace A: n_ranked keeps its exact original `(todo, r0)` overlay (never corrupted to `doing`).
    assert_eq!(post_ov2[&n_ranked].group, n_ranked_pre_group);
    assert_eq!(post_ov2[&n_ranked].sort_rank_lexo, n_ranked_pre_rank);
    // Trace B: n_outside has NO phantom overlay row in view_rank_overlays.
    assert!(
        !post_ov2.contains_key(&n_outside),
        "note restored outside board view must not receive a phantom rank overlay"
    );
    // Trace C: m_card restored cleanly into `todo` strictly after `n_anchor`, and d_card back in `doing`.
    assert_eq!(post_ov2[&m_card].group, todo_grp);
    assert_eq!(post_ov2[&n_anchor].group, todo_grp);
    assert_eq!(post_ov2[&d_card].group, doing_grp);
    assert!(
        post_ov2[&n_ranked].sort_rank_lexo < post_ov2[&n_anchor].sort_rank_lexo
            && post_ov2[&n_anchor].sort_rank_lexo < post_ov2[&m_card].sort_rank_lexo,
        "restored todo order must remain [n_ranked, n_anchor, m_card]"
    );
}

async fn run_board_mixed_traces_and_untouched_columns_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(62);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(62),
        sample_incarnation(62),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let view_note = sample_note_id(240);
    let view_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view_note.clone(),
                    parent: None,
                    slug: "mixed-traces-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: Mixed Traces Board\n---\n# Mixed Traces Board\n"
                        .to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view = ViewRef {
        note: view_note,
        key: ViewKey::from_bytes([0x6A; 16]),
    };

    // Untouched column `backlog` cards (must receive zero overlays or rank revisions).
    let u_back_1 = sample_note_id(241);
    let u_back_2 = sample_note_id(242);
    // Trace A: run creates `new_a` in `todo`, then moves `b_a` out of `todo`.
    let new_a = sample_note_id(243);
    let b_a = sample_note_id(244);
    // Trace B: run edits `e_b` (`archived -> todo`), then moves `b_b` out of `todo`.
    let e_b = sample_note_id(245);
    let b_b = sample_note_id(246);
    // Trace C: run edits `c_unranked` (`archived -> doing`) and `c_ranked` (`todo -> doing`),
    // then moves both `doing -> done`.
    let c_unranked = sample_note_id(247);
    let c_ranked = sample_note_id(248);
    // Trace D: unranked `d_a < d_b < d_c` in `todo`; run moves `d_b` (`pred=d_a, succ=d_c`)
    // to `done`, edits `d_a` to `archived`, and ranks `d_c` in `todo`.
    let d_a = sample_note_id(249);
    let d_b = sample_note_id(250);
    let d_c = sample_note_id(251);
    // Retired view note created during the run.
    let v_new_note = sample_note_id(252);
    let v_new = ViewRef {
        note: v_new_note.clone(),
        key: ViewKey::from_bytes([0x6B; 16]),
    };

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            u_back_1.clone(),
            u_back_2.clone(),
            new_a.clone(),
            b_a.clone(),
            e_b.clone(),
            b_b.clone(),
            c_unranked.clone(),
            c_ranked.clone(),
            d_a.clone(),
            d_b.clone(),
            d_c.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let todo_grp = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let doing_grp = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let done_grp = GroupKey::Value(ScalarValue::String("done".to_owned()));

    let mut revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for (nid, slug, status) in [
        (&u_back_1, "u-back-1", "backlog"),
        (&u_back_2, "u-back-2", "backlog"),
        (&b_a, "b-a", "todo"),
        (&e_b, "e-b", "archived"),
        (&b_b, "b-b", "todo"),
        (&c_unranked, "c-unranked", "archived"),
        (&c_ranked, "c-ranked", "todo"),
        (&d_a, "d-a", "todo"),
        (&d_b, "d-b", "todo"),
        (&d_c, "d-c", "todo"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: {status}\n---\nBody\n"),
                    },
                ),
            )
            .await
            .unwrap();
        revs.insert(nid.clone(), c.value.revision);
    }

    // Give `c_ranked` a pre-run persisted overlay in `todo` (leaving `d_a/d_b/d_c` unranked
    // by moving `c_ranked` before `b_a`? Actually moving `c_ranked` into `doing` then back
    // into `todo` before `b_a`? Wait: placing `c_ranked` in its own pre-run column `ready`
    // avoids ranking `d_a/d_b/d_c` in `todo`!).
    let ready_grp = GroupKey::Value(ScalarValue::String("ready".to_owned()));
    let c_ranked_ready = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: c_ranked.clone(),
                    group: ready_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("ready".to_owned())),
                    )]),
                    expected_note: revs[&c_ranked].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(c_ranked.clone(), c_ranked_ready.value.revision.revision);
    let pre_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    let pre_c_ranked_rank = pre_ov[&c_ranked].sort_rank_lexo.clone();
    assert!(!pre_ov.contains_key(&u_back_1));
    assert!(!pre_ov.contains_key(&u_back_2));
    assert!(!pre_ov.contains_key(&d_a));
    assert!(!pre_ov.contains_key(&d_b));
    assert!(!pre_ov.contains_key(&d_c));

    let run = sample_run_id(242);
    let run_ctx = agent_run_ctx(&human_ctx, run.clone());
    let mut latest_revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();

    // Trace D step 1 (before any ranking in `todo`): move `d_b` `todo -> done` (pred=d_a, succ=d_c).
    let d_b_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: d_b.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&d_b].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(d_b.clone(), d_b_moved.value.revision.revision);

    // Trace A: create `new_a` in `todo`, then move `b_a` `todo -> done` (neighboring `new_a`).
    let new_a_c = store
        .create_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: new_a.clone(),
                    parent: None,
                    slug: "new-a".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: new-a\nstatus: todo\n---\nBody\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(new_a.clone(), new_a_c.value.revision);
    let b_a_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: b_a.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&b_a].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(b_a.clone(), b_a_moved.value.revision.revision);

    // Trace B: edit `e_b` (`archived -> todo`), then move `b_b` `todo -> done` (neighboring `e_b`).
    // Trace C step 1: edit `c_unranked` (`archived -> doing`) and `c_ranked` (`ready -> doing`).
    // Trace D step 2: edit `d_a` (`todo -> archived`).
    for (nid, new_status) in [
        (&e_b, "todo"),
        (&c_unranked, "doing"),
        (&c_ranked, "doing"),
        (&d_a, "archived"),
    ] {
        let snap = store
            .get_note(
                run_ctx.clone(),
                GetNote {
                    note: nid.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let raw = snap.document.explicit_read(run_ctx.auth()).unwrap();
        let plan = extract::finalize_document(
            raw,
            DocClass::UserDoc,
            nid,
            &[FieldEdit::Set {
                key: "status".to_owned(),
                value: YamlValue::String(new_status.to_owned()),
            }],
        )
        .unwrap();
        let ed = store
            .edit_note(
                run_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    EditNote {
                        note: nid.clone(),
                        plan,
                    },
                ),
            )
            .await
            .unwrap();
        latest_revs.insert(nid.clone(), ed.value.revision);
    }

    let b_b_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: b_b.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&b_b].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(b_b.clone(), b_b_moved.value.revision.revision);

    // Trace C step 2: move `c_unranked` (`doing -> done`) and `c_ranked` (`doing -> done`).
    let c_unranked_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: c_unranked.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: latest_revs[&c_unranked].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(c_unranked.clone(), c_unranked_moved.value.revision.revision);
    let c_ranked_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: c_ranked.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: latest_revs[&c_ranked].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(pre_ov[&c_ranked].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(c_ranked.clone(), c_ranked_moved.value.revision.revision);

    // Trace D step 3: rank `d_c` in `todo` (so `d_c` has a persisted overlay while `d_a` does not).
    let d_c_ranked = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: d_c.clone(),
                    group: todo_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&d_c].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(d_c.clone(), d_c_ranked.value.revision.revision);

    // Retired view: run creates `v_new` and moves `b_a` onto `v_new`.
    let v_new_c = store
        .create_note(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: v_new_note.clone(),
                    parent: None,
                    slug: "v-new-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: New Board\n---\n# New Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(v_new_note.clone(), v_new_c.value.revision.clone());
    let b_a_vnew = store
        .move_board_card(
            run_ctx,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: v_new.clone(),
                    note: b_a.clone(),
                    group: done_grp.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: latest_revs[&b_a].clone(),
                    expected_view: v_new_c.value.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest_revs.insert(b_a.clone(), b_a_vnew.value.revision.revision);

    let run_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let cur_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    let cur_vnew_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &v_new)
        .await
        .unwrap();
    let mut expectations = Vec::new();
    for nid in [&d_b, &b_a, &b_b, &c_unranked, &c_ranked, &d_c] {
        expectations.push(AssociatedBoardExpectation {
            view: view.clone(),
            note: nid.clone(),
            expected_rank: RankExpectation::Existing(cur_ov[nid].rank_rev_id.clone()),
            expected_placement_revision: cur_ov[nid].placement_revision.clone(),
        });
    }
    expectations.push(AssociatedBoardExpectation {
        view: v_new.clone(),
        note: b_a.clone(),
        expected_rank: RankExpectation::Existing(cur_vnew_ov[&b_a].rank_rev_id.clone()),
        expected_placement_revision: cur_vnew_ov[&b_a].placement_revision.clone(),
    });
    let expected_entities: Vec<NoteRevision> = latest_revs
        .into_iter()
        .map(|(note, revision)| NoteRevision { note, revision })
        .collect();

    store
        .rollback_agent_run(
            human_ctx,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run,
                    expected_run_revision: run_rev,
                    expected_entities,
                    associated_board_expectations: expectations,
                },
            ),
        )
        .await
        .expect("mixed create/edit/move/retired-view board rollback must succeed");

    let post_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    // Untouched `backlog` column cards must never receive materialized overlays.
    assert!(!post_ov.contains_key(&u_back_1));
    assert!(!post_ov.contains_key(&u_back_2));
    // Retired/archived cards must have zero overlays.
    assert!(!post_ov.contains_key(&new_a));
    assert!(!post_ov.contains_key(&e_b));
    assert!(!post_ov.contains_key(&c_unranked));
    // Trace C pre-run ranked card restored into its pre-run `ready` column with original rank.
    assert_eq!(post_ov[&c_ranked].group, ready_grp);
    assert_eq!(post_ov[&c_ranked].sort_rank_lexo, pre_c_ranked_rank);
    // Traces A, B, D targets restored cleanly into `todo`.
    assert_eq!(post_ov[&b_a].group, todo_grp);
    assert_eq!(post_ov[&b_b].group, todo_grp);
    assert_eq!(post_ov[&d_b].group, todo_grp);
    // Retired view has all overlays cleaned up.
    assert!(
        store
            .inspect_view_overlays_for_test(&scope.space_id, &v_new)
            .await
            .unwrap()
            .is_empty()
    );
    let _ = doing_grp;
}

async fn run_board_prerun_pma_and_stale_non_moved_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(63);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(63),
        sample_incarnation(63),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let view_note = sample_note_id(253);
    let view_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view_note.clone(),
                    parent: None,
                    slug: "prerun-stale-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: PreRun Stale Board\n---\n# Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view = ViewRef {
        note: view_note,
        key: ViewKey::from_bytes([0x6C; 16]),
    };

    // N1 < N2 (non-moved eligible notes in G1 pre-run: N1 unranked, N2 ranked in G1).
    // M (moved target in G3 -> G2 that materializes neighbor overlays for N1 & N2 in G2).
    // T1 < T2 (both restore into G1: T1 via ReconcilePreRun, T2 via Replayed, sharing rank space).
    let n1 = NoteId::from_bytes([0x01; 16]);
    let n2 = NoteId::from_bytes([0x02; 16]);
    let t1 = NoteId::from_bytes([0x03; 16]);
    let t2 = NoteId::from_bytes([0x04; 16]);
    let m_card = NoteId::from_bytes([0x05; 16]);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            n1.clone(),
            n2.clone(),
            t1.clone(),
            t2.clone(),
            m_card.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let g1 = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let g2 = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let g3 = GroupKey::Value(ScalarValue::String("done".to_owned()));

    let mut revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for (nid, slug, status) in [
        (&n1, "n1", "todo"),
        (&n2, "n2", "todo"),
        (&t1, "t1", "todo"),
        (&t2, "t2", "todo"),
        (&m_card, "m-card", "done"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: {status}\n---\nBody\n"),
                    },
                ),
            )
            .await
            .unwrap();
        revs.insert(nid.clone(), c.value.revision);
    }

    // Give N2 and T1 pre-run persisted overlays in G1 while keeping N1 unranked
    // (temporarily move N1 to archived, rank N2 & T1 in G1, then restore N1 to todo unranked).
    let scope_ref = &scope;
    let owner_ref = &owner;
    let set_status = |ctx: SpaceContext, nid: NoteId, st: &'static str| async move {
        let snap = store
            .get_note(
                ctx.clone(),
                GetNote {
                    note: nid.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let raw = snap.document.explicit_read(ctx.auth()).unwrap();
        let plan = extract::finalize_document(
            raw,
            DocClass::UserDoc,
            &nid,
            &[FieldEdit::Set {
                key: "status".to_owned(),
                value: YamlValue::String(st.to_owned()),
            }],
        )
        .unwrap();
        store
            .edit_note(
                ctx,
                next_mutation(scope_ref, owner_ref, EditNote { note: nid, plan }),
            )
            .await
            .unwrap()
            .value
            .revision
    };

    revs.insert(
        n1.clone(),
        set_status(human_ctx.clone(), n1.clone(), "archived").await,
    );
    let n2_r = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: n2.clone(),
                    group: g1.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&n2].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(n2.clone(), n2_r.value.revision.revision);
    revs.insert(
        n1.clone(),
        set_status(human_ctx.clone(), n1.clone(), "todo").await,
    );

    let pre_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    assert!(!pre_ov.contains_key(&n1));
    let n2_pre_rank = pre_ov[&n2].sort_rank_lexo.clone();
    let t1_pre_rank = pre_ov[&t1].sort_rank_lexo.clone();

    let run = sample_run_id(243);
    let run_ctx = agent_run_ctx(&human_ctx, run.clone());
    let mut latest: BTreeMap<NoteId, RevisionId> = BTreeMap::new();

    // In-run edits: move N1, N2, T1 from G1 -> G2 (creating stale overlays once M moves into G2).
    for nid in [&n1, &n2, &t1] {
        let rev = set_status(run_ctx.clone(), nid.clone(), "doing").await;
        latest.insert(nid.clone(), rev);
    }
    // Move M from G3 -> G2 (materializes neighbor overlays for N1, N2, T1 in G2!).
    let m_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: m_card.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&m_card].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    latest.insert(m_card.clone(), m_moved.value.revision.revision);

    let mid_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    assert_eq!(mid_ov[&n1].group, g2);
    assert_eq!(mid_ov[&n2].group, g2);
    assert_eq!(mid_ov[&t1].group, g2);

    // Move T1 (G2 -> G3) so T1 settles via ReconcilePreRun back to G1,
    // and move T2 (G1 -> G3) so T2 settles via Replayed back to G1.
    let t1_moved = store
        .move_board_card(
            run_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: t1.clone(),
                    group: g3.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: latest[&t1].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(mid_ov[&t1].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    latest.insert(t1.clone(), t1_moved.value.revision.revision);
    let t2_moved = store
        .move_board_card(
            run_ctx,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view.clone(),
                    note: t2.clone(),
                    group: g3.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&t2].clone(),
                    expected_view: view_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(mid_ov[&t2].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    latest.insert(t2.clone(), t2_moved.value.revision.revision);

    let run_rev = store
        .inspect_agent_run_revision_for_test(&scope.space_id, &run)
        .await
        .unwrap()
        .unwrap();
    let cur_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    let expectations: Vec<AssociatedBoardExpectation> = [&m_card, &t1, &t2]
        .into_iter()
        .map(|nid| AssociatedBoardExpectation {
            view: view.clone(),
            note: nid.clone(),
            expected_rank: RankExpectation::Existing(cur_ov[nid].rank_rev_id.clone()),
            expected_placement_revision: cur_ov[nid].placement_revision.clone(),
        })
        .collect();
    let expected_entities: Vec<NoteRevision> = latest
        .into_iter()
        .map(|(note, revision)| NoteRevision { note, revision })
        .collect();

    store
        .rollback_agent_run(
            human_ctx,
            next_mutation(
                &scope,
                &owner,
                RollbackAgentRun {
                    run,
                    expected_run_revision: run_rev,
                    expected_entities,
                    associated_board_expectations: expectations,
                },
            ),
        )
        .await
        .expect("prerun PMA + stale non-moved board rollback must succeed");

    let post_ov = store
        .inspect_view_overlays_for_test(&scope.space_id, &view)
        .await
        .unwrap();
    assert_eq!(post_ov[&n1].group, g1);
    assert!(
        post_ov[&n1].placement_run_id.is_none(),
        "materialized neighbor overlay must not carry rolled-back run id"
    );
    assert_eq!(post_ov[&n2].group, g1);
    assert_eq!(post_ov[&n2].sort_rank_lexo, n2_pre_rank);
    assert_eq!(
        post_ov[&n2].placement_revision,
        pre_ov[&n2].placement_revision
    );
    assert_eq!(post_ov[&t1].group, g1);
    assert_eq!(
        post_ov[&t1].placement_revision,
        pre_ov[&t1].placement_revision
    );
    let _ = t1_pre_rank;
    assert_eq!(post_ov[&t2].group, g1);
    assert_eq!(post_ov[&m_card].group, g3);
    // Strict uniqueness of sort_rank_lexo across all cards in G1.
    let g1_ranks: BTreeSet<&str> = [&n1, &n2, &t1, &t2]
        .into_iter()
        .map(|id| post_ov[id].sort_rank_lexo.as_str())
        .collect();
    assert_eq!(g1_ranks.len(), 4);
}

async fn run_board_per_note_prerun_and_skipped_moved_view_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(64);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(64),
        sample_incarnation(64),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let view1_note = sample_note_id(254);
    let view2_note = sample_note_id(255);
    let view1_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view1_note.clone(),
                    parent: None,
                    slug: "per-note-prerun-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: per-note-prerun-board\n---\n# Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view2_c = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: view2_note.clone(),
                    parent: None,
                    slug: "skipped-moved-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: skipped-moved-board\n---\n# Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let view1 = ViewRef {
        note: view1_note,
        key: ViewKey::from_bytes([0x6D; 16]),
    };
    let view2 = ViewRef {
        note: view2_note,
        key: ViewKey::from_bytes([0x6E; 16]),
    };

    let early_note = NoteId::from_bytes([0x11; 16]);
    let t_reconcile = NoteId::from_bytes([0x12; 16]);
    let n_stale = NoteId::from_bytes([0x13; 16]);
    let z_non_moved = NoteId::from_bytes([0x14; 16]);
    let m_skipped = NoteId::from_bytes([0x15; 16]);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            early_note.clone(),
            t_reconcile.clone(),
            n_stale.clone(),
            z_non_moved.clone(),
            m_skipped.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let g1 = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let g2 = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let g3 = GroupKey::Value(ScalarValue::String("done".to_owned()));

    let mut revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for (nid, slug, status) in [
        (&early_note, "early-note", "backlog"),
        (&t_reconcile, "t-reconcile", "todo"),
        (&n_stale, "n-stale", "todo"),
        (&z_non_moved, "z-non-moved", "todo"),
        (&m_skipped, "m-skipped", "done"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: {status}\n---\nBody\n"),
                    },
                ),
            )
            .await
            .unwrap();
        revs.insert(nid.clone(), c.value.revision);
    }

    let scope_ref = &scope;
    let owner_ref = &owner;
    let set_status = |ctx: SpaceContext, nid: NoteId, st: &'static str| async move {
        let snap = store
            .get_note(
                ctx.clone(),
                GetNote {
                    note: nid.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let raw = snap.document.explicit_read(ctx.auth()).unwrap();
        let plan = extract::finalize_document(
            raw,
            DocClass::UserDoc,
            &nid,
            &[FieldEdit::Set {
                key: "status".to_owned(),
                value: YamlValue::String(st.to_owned()),
            }],
        )
        .unwrap();
        store
            .edit_note(
                ctx,
                next_mutation(scope_ref, owner_ref, EditNote { note: nid, plan }),
            )
            .await
            .unwrap()
            .value
            .revision
    };

    let run = sample_run_id(244);
    let agent_ctx = agent_run_ctx(&human_ctx, run.clone());

    // Step 1: Agent run R makes its earliest touch on `early_note` at seq T1.
    revs.insert(
        early_note.clone(),
        set_status(agent_ctx.clone(), early_note.clone(), "triage").await,
    );

    // Step 2: AFTER T1 (but BEFORE R ever touches `t_reconcile` or `n_stale`),
    // human ranks both `t_reconcile` and `n_stale` in G1 on `view1`.
    let tr_pre_mv = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view1.clone(),
                    note: t_reconcile.clone(),
                    group: g1.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&t_reconcile].clone(),
                    expected_view: view1_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(t_reconcile.clone(), tr_pre_mv.value.revision.revision);

    let pre_touch_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view1)
        .await
        .unwrap();
    let t_rec_pre_rank = pre_touch_ov1[&t_reconcile].sort_rank_lexo.clone();
    let t_rec_pre_pl = pre_touch_ov1[&t_reconcile].placement_revision.clone();
    let n_stale_pre_rank = pre_touch_ov1[&n_stale].sort_rank_lexo.clone();
    let n_stale_pre_pl = pre_touch_ov1[&n_stale].placement_revision.clone();

    // Step 3: Now run R edits `t_reconcile` and `n_stale` into G2, moves `early_note` into G2
    // on `view1` (materializing G2 neighbor overlays for `t_reconcile` and `n_stale`), and then
    // moves `t_reconcile` on `view1` from G2 into G3 (triggering `ReconcilePreRun` for
    // `t_reconcile` while leaving non-moved `n_stale` with a stale G2 overlay).
    revs.insert(
        t_reconcile.clone(),
        set_status(agent_ctx.clone(), t_reconcile.clone(), "doing").await,
    );
    revs.insert(
        n_stale.clone(),
        set_status(agent_ctx.clone(), n_stale.clone(), "doing").await,
    );
    let early_mv = store
        .move_board_card(
            agent_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view1.clone(),
                    note: early_note.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&early_note].clone(),
                    expected_view: view1_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(early_note.clone(), early_mv.value.revision.revision);
    let mid_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view1)
        .await
        .unwrap();
    assert_eq!(mid_ov1[&t_reconcile].group, g2);
    assert_eq!(mid_ov1[&n_stale].group, g2);

    let tr_mv = store
        .move_board_card(
            agent_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view1.clone(),
                    note: t_reconcile.clone(),
                    group: g3.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&t_reconcile].clone(),
                    expected_view: view1_c.value.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        mid_ov1[&t_reconcile].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(t_reconcile.clone(), tr_mv.value.revision.revision);

    // Step 4: On `view2`, run R edits `z_non_moved` into G2 and moves `m_skipped` into G2
    // (materializing a stale G2 neighbor overlay for `z_non_moved` on `view2`).
    revs.insert(
        z_non_moved.clone(),
        set_status(agent_ctx.clone(), z_non_moved.clone(), "doing").await,
    );

    let m_mv = store
        .move_board_card(
            agent_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view2.clone(),
                    note: m_skipped.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&m_skipped].clone(),
                    expected_view: view2_c.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(m_skipped.clone(), m_mv.value.revision.revision);

    let pre_rb_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view2)
        .await
        .unwrap();
    assert_eq!(
        pre_rb_ov2[&z_non_moved].group, g2,
        "m_skipped move must have materialized a G2 neighbor overlay for z_non_moved on view2"
    );

    // Step 5: Human edits `m_skipped` manually so it is skipped on rollback,
    // leaving `view2` with zero eligible moved targets in `run_board_moves`.
    revs.insert(
        m_skipped.clone(),
        set_status(human_ctx.clone(), m_skipped.clone(), "review").await,
    );
    let _ = revs;

    // Prepare & execute rollback of run R.
    let prepared = store
        .prepare_agent_run_rollback(human_ctx.clone(), run.clone())
        .await
        .expect("prepare rollback must succeed");
    let rb = store
        .rollback_agent_run(human_ctx, next_mutation(&scope, &owner, prepared))
        .await
        .expect("rollback with per-note prerun ranks and skipped-moved view must succeed");
    assert!(
        rb.value.skipped_manual_edits.contains(&m_skipped),
        "m_skipped must be reported as skipped due to manual edit"
    );

    let post_ov1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view1)
        .await
        .unwrap();
    assert_eq!(post_ov1[&t_reconcile].group, g1);
    assert_eq!(post_ov1[&t_reconcile].sort_rank_lexo, t_rec_pre_rank);
    assert_eq!(post_ov1[&t_reconcile].placement_revision, t_rec_pre_pl);
    assert_eq!(post_ov1[&n_stale].group, g1);
    assert_eq!(post_ov1[&n_stale].sort_rank_lexo, n_stale_pre_rank);
    assert_eq!(post_ov1[&n_stale].placement_revision, n_stale_pre_pl);

    let post_ov2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &view2)
        .await
        .unwrap();
    assert!(
        !post_ov2.contains_key(&z_non_moved),
        "stale G2 neighbor overlay on view2 must be removed even though view2's only moved target was skipped"
    );
    assert_eq!(post_ov2[&m_skipped].group, g2);
}

#[tokio::test]
async fn l6_rollback_board_per_note_prerun_and_skipped_moved_view_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-pernote-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(21), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_per_note_prerun_and_skipped_moved_view_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6per");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(22), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_per_note_prerun_and_skipped_moved_view_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

async fn run_board_neighbor_order_and_trashed_view_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(65);
    let (scope, _root) = seed_space(
        store,
        sample_space_id(65),
        sample_incarnation(65),
        owner.clone(),
    )
    .await;
    let human_ctx = owner_ctx(&scope, owner.clone());

    let g1 = GroupKey::Value(ScalarValue::String("todo".to_owned()));
    let g2 = GroupKey::Value(ScalarValue::String("doing".to_owned()));
    let g3 = GroupKey::Value(ScalarValue::String("done".to_owned()));

    let v1_note = sample_note_id(241);
    let v2_note = sample_note_id(242);
    let v3_note = sample_note_id(243);
    let v4_note = sample_note_id(244);
    let m_1a = NoteId::from_bytes([0x21; 16]);
    let s_1a = NoteId::from_bytes([0x22; 16]);
    let a_1a = NoteId::from_bytes([0x23; 16]);
    let x_1a = NoteId::from_bytes([0x24; 16]);
    let m_1b = NoteId::from_bytes([0x25; 16]);
    let t_1b = NoteId::from_bytes([0x26; 16]);
    let card_2a = NoteId::from_bytes([0x27; 16]);
    let card_2b = NoteId::from_bytes([0x28; 16]);
    let card_2c = NoteId::from_bytes([0x29; 16]);
    let card_2d = NoteId::from_bytes([0x2A; 16]);

    let planner = CanonicalTestBoardPlanner::new(
        store.clone(),
        [
            m_1a.clone(),
            s_1a.clone(),
            a_1a.clone(),
            x_1a.clone(),
            m_1b.clone(),
            t_1b.clone(),
            card_2a.clone(),
            card_2b.clone(),
            card_2c.clone(),
            card_2d.clone(),
        ],
    );
    store
        .register_board_facts_provider(planner)
        .expect("register planner");

    let mut revs: BTreeMap<NoteId, RevisionId> = BTreeMap::new();
    for (nid, slug, status) in [
        (&v1_note, "board-1a", "none"),
        (&v2_note, "board-1b", "none"),
        (&v3_note, "board-human-trash", "none"),
        (&v4_note, "board-run-trash", "none"),
        (&m_1a, "m-1a", "todo"),
        (&s_1a, "s-1a", "todo"),
        (&a_1a, "a-1a", "todo"),
        (&x_1a, "x-1a", "done"),
        (&m_1b, "m-1b", "todo"),
        (&t_1b, "t-1b", "todo"),
        (&card_2a, "card-2a", "todo"),
        (&card_2b, "card-2b", "todo"),
        (&card_2c, "card-2c", "todo"),
    ] {
        let c = store
            .create_note(
                human_ctx.clone(),
                next_mutation(
                    &scope,
                    &owner,
                    CreateNote {
                        folder_page: false,
                        note: nid.clone(),
                        parent: None,
                        slug: slug.to_owned(),
                        class: DocClass::UserDoc,
                        carrier: format!("---\ntitle: {slug}\nstatus: {status}\n---\nBody\n"),
                    },
                ),
            )
            .await
            .unwrap();
        revs.insert(nid.clone(), c.value.revision);
    }

    let scope_ref = &scope;
    let owner_ref = &owner;
    let set_status = |ctx: SpaceContext, nid: NoteId, st: &'static str| async move {
        let snap = store
            .get_note(
                ctx.clone(),
                GetNote {
                    note: nid.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await
            .unwrap();
        let raw = snap.document.explicit_read(ctx.auth()).unwrap();
        let plan = extract::finalize_document(
            raw,
            DocClass::UserDoc,
            &nid,
            &[FieldEdit::Set {
                key: "status".to_owned(),
                value: YamlValue::String(st.to_owned()),
            }],
        )
        .unwrap();
        store
            .edit_note(
                ctx,
                next_mutation(scope_ref, owner_ref, EditNote { note: nid, plan }),
            )
            .await
            .unwrap()
            .value
            .revision
    };

    let view_1a = ViewRef {
        note: v1_note.clone(),
        key: ViewKey::from_bytes([0x71; 16]),
    };
    let view_1b = ViewRef {
        note: v2_note.clone(),
        key: ViewKey::from_bytes([0x72; 16]),
    };
    let view_human_trash = ViewRef {
        note: v3_note.clone(),
        key: ViewKey::from_bytes([0x73; 16]),
    };
    let view_run_trash = ViewRef {
        note: v4_note.clone(),
        key: ViewKey::from_bytes([0x74; 16]),
    };

    // --- Trace 1A: Stale non-moved neighbor `s_1a` in `[m_1a, s_1a, a_1a]` ---
    // Seed G1 on `view_1a` so order is strictly `[m_1a, s_1a, a_1a]`.
    let r = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1a.clone(),
                    note: m_1a.clone(),
                    group: g1.clone(),
                    before: Some(RankNeighbor {
                        note: s_1a.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&m_1a].clone(),
                    expected_view: revs[&v1_note].clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(m_1a.clone(), r.value.revision.revision);
    let pre_1a = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_1a)
        .await
        .unwrap();
    assert!(pre_1a[&m_1a].sort_rank_lexo < pre_1a[&s_1a].sort_rank_lexo);
    assert!(pre_1a[&s_1a].sort_rank_lexo < pre_1a[&a_1a].sort_rank_lexo);

    let run_1a = sample_run_id(245);
    let agent_1a = agent_run_ctx(&human_ctx, run_1a.clone());
    // Move `m_1a` G1 -> G2 (recording successor `s_1a`), edit `s_1a` G1 -> G2, move `x_1a` -> G2.
    let r = store
        .move_board_card(
            agent_1a.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1a.clone(),
                    note: m_1a.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&m_1a].clone(),
                    expected_view: revs[&v1_note].clone(),
                    expected_rank: RankExpectation::Existing(pre_1a[&m_1a].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(m_1a.clone(), r.value.revision.revision);
    revs.insert(
        s_1a.clone(),
        set_status(agent_1a.clone(), s_1a.clone(), "doing").await,
    );
    let r = store
        .move_board_card(
            agent_1a,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1a.clone(),
                    note: x_1a.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&x_1a].clone(),
                    expected_view: revs[&v1_note].clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(x_1a.clone(), r.value.revision.revision);
    let mid_1a = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_1a)
        .await
        .unwrap();
    assert_eq!(mid_1a[&s_1a].group, g2);

    let prep_1a = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_1a)
        .await
        .unwrap();
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_1a))
        .await
        .expect("Trace 1A rollback must succeed");
    let post_1a = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_1a)
        .await
        .unwrap();
    assert_eq!(post_1a[&m_1a].group, g1);
    assert_eq!(post_1a[&s_1a].group, g1);
    assert_eq!(post_1a[&a_1a].group, g1);
    assert!(
        post_1a[&m_1a].sort_rank_lexo < post_1a[&s_1a].sort_rank_lexo
            && post_1a[&s_1a].sort_rank_lexo < post_1a[&a_1a].sort_rank_lexo,
        "Trace 1A must preserve [m_1a, s_1a, a_1a] order, got m={}, s={}, a={}",
        post_1a[&m_1a].sort_rank_lexo,
        post_1a[&s_1a].sort_rank_lexo,
        post_1a[&a_1a].sort_rank_lexo
    );

    // --- Trace 1B: `ReconcilePreRun` neighbor `t_1b` in `[m_1b, t_1b]` ---
    let r = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1b.clone(),
                    note: m_1b.clone(),
                    group: g1.clone(),
                    before: Some(RankNeighbor {
                        note: t_1b.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&m_1b].clone(),
                    expected_view: revs[&v2_note].clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(m_1b.clone(), r.value.revision.revision);
    let pre_1b = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_1b)
        .await
        .unwrap();
    assert!(pre_1b[&m_1b].sort_rank_lexo < pre_1b[&t_1b].sort_rank_lexo);

    let run_1b = sample_run_id(246);
    let agent_1b = agent_run_ctx(&human_ctx, run_1b.clone());
    // Move `m_1b` G1 -> G2 (recording successor `t_1b`), edit `t_1b` G1 -> G2, move `t_1b` G2 -> G3.
    let r = store
        .move_board_card(
            agent_1b.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1b.clone(),
                    note: m_1b.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&m_1b].clone(),
                    expected_view: revs[&v2_note].clone(),
                    expected_rank: RankExpectation::Existing(pre_1b[&m_1b].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(m_1b.clone(), r.value.revision.revision);
    revs.insert(
        t_1b.clone(),
        set_status(agent_1b.clone(), t_1b.clone(), "doing").await,
    );
    let r = store
        .move_board_card(
            agent_1b,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_1b.clone(),
                    note: t_1b.clone(),
                    group: g3.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("done".to_owned())),
                    )]),
                    expected_note: revs[&t_1b].clone(),
                    expected_view: revs[&v2_note].clone(),
                    expected_rank: RankExpectation::Existing(pre_1b[&t_1b].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(t_1b.clone(), r.value.revision.revision);
    let prep_1b = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_1b)
        .await
        .unwrap();
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_1b))
        .await
        .expect("Trace 1B rollback must succeed");
    let post_1b = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_1b)
        .await
        .unwrap();
    assert_eq!(post_1b[&m_1b].group, g1);
    assert_eq!(post_1b[&t_1b].group, g1);
    assert!(
        post_1b[&m_1b].sort_rank_lexo < post_1b[&t_1b].sort_rank_lexo,
        "Trace 1B must preserve [m_1b, t_1b] order, got m={}, t={}",
        post_1b[&m_1b].sort_rank_lexo,
        post_1b[&t_1b].sort_rank_lexo
    );

    // --- Trace 2A: Human trashes pre-existing view `v3_note` after run moved `card_2a` ---
    let run_2a = sample_run_id(247);
    let agent_2a = agent_run_ctx(&human_ctx, run_2a.clone());
    let r = store
        .move_board_card(
            agent_2a,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_human_trash.clone(),
                    note: card_2a.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&card_2a].clone(),
                    expected_view: revs[&v3_note].clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(card_2a.clone(), r.value.revision.revision);
    store
        .delete_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: v3_note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    let prep_2a = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_2a)
        .await
        .expect("prepare rollback must succeed after human trashed view note");
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_2a))
        .await
        .expect("rollback must succeed after human trashed view note");
    let card_2a_after = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: card_2a.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        card_2a_after.fields.get("status"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::String("todo".to_owned())
        )))
    );

    // --- Trace 2B: Run creates view `v_created`, moves `card_2b`, then trashes `v_created` ---
    let run_2b = sample_run_id(248);
    let agent_2b = agent_run_ctx(&human_ctx, run_2b.clone());
    let v_created_note = sample_note_id(249);
    let v_created = ViewRef {
        note: v_created_note.clone(),
        key: ViewKey::from_bytes([0x75; 16]),
    };
    let vc = store
        .create_note(
            agent_2b.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: v_created_note.clone(),
                    parent: None,
                    slug: "run-created-board".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: run-created-board\n---\n# Board\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let r = store
        .move_board_card(
            agent_2b.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: v_created.clone(),
                    note: card_2b.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&card_2b].clone(),
                    expected_view: vc.value.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(card_2b.clone(), r.value.revision.revision);
    store
        .delete_note(
            agent_2b,
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: v_created_note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    let prep_2b = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_2b)
        .await
        .expect("prepare rollback must succeed when run trashed its own created view");
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_2b))
        .await
        .expect("rollback must succeed when run trashed its own created view");

    // --- Trace 2C: Run moves `card_2c` on pre-existing `v4_note`, then run trashes `v4_note` ---
    let r = store
        .move_board_card(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_run_trash.clone(),
                    note: card_2c.clone(),
                    group: g1.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: revs[&card_2c].clone(),
                    expected_view: revs[&v4_note].clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(card_2c.clone(), r.value.revision.revision);
    let pre_2c = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_run_trash)
        .await
        .unwrap();
    let run_2c = sample_run_id(249);
    let agent_2c = agent_run_ctx(&human_ctx, run_2c.clone());
    let r = store
        .move_board_card(
            agent_2c.clone(),
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_run_trash.clone(),
                    note: card_2c.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: revs[&card_2c].clone(),
                    expected_view: revs[&v4_note].clone(),
                    expected_rank: RankExpectation::Existing(pre_2c[&card_2c].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    revs.insert(card_2c.clone(), r.value.revision.revision);
    store
        .delete_note(
            agent_2c,
            next_mutation(
                &scope,
                &owner,
                DeleteNote {
                    note: v4_note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    let prep_2c = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_2c)
        .await
        .expect("prepare rollback must succeed when run trashed pre-existing view");
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_2c))
        .await
        .expect("rollback must restore pre-existing view trashed by run");
    let v4_after = store
        .get_note(
            human_ctx.clone(),
            GetNote {
                note: v4_note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .expect("v4_note must be restored to Active");
    assert_eq!(v4_after.document.metadata().lifecycle(), Lifecycle::Active);
    let post_2c = store
        .inspect_view_overlays_for_test(&scope.space_id, &view_run_trash)
        .await
        .unwrap();
    assert_eq!(post_2c[&card_2c].group, g1);

    // --- Trace 2D: Human trashes parent folder of board view `v5_note` (note head stays Active,
    //     effective lifecycle becomes Trashed) -> prepare + rollback must still succeed ---
    let active_epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let f_2d = FolderId::from_bytes([0x2D; 16]);
    let (_, f_2d_rev, _) = store
        .create_folder(notarium_canonical::CreateFolderSpec {
            scope: scope.clone(),
            active_epoch,
            folder_id: f_2d.clone(),
            parent: None,
            slug: "view-parent-2d".to_owned(),
            display_name: "View Parent 2D".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let v5_note = sample_note_id(245);
    let view_2d = ViewRef {
        note: v5_note.clone(),
        key: ViewKey::from_bytes([0x76; 16]),
    };
    let v5_created = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: v5_note.clone(),
                    parent: Some(f_2d.clone()),
                    slug: "board-parent-trashed".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: board-parent-trashed\nstatus: none\n---\nBody\n"
                        .to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let card_2d_created = store
        .create_note(
            human_ctx.clone(),
            next_mutation(
                &scope,
                &owner,
                CreateNote {
                    folder_page: false,
                    note: card_2d.clone(),
                    parent: None,
                    slug: "card-2d".to_owned(),
                    class: DocClass::UserDoc,
                    carrier: "---\ntitle: card-2d\nstatus: todo\n---\nBody\n".to_owned(),
                },
            ),
        )
        .await
        .unwrap();
    let run_2d = sample_run_id(250);
    let agent_2d = agent_run_ctx(&human_ctx, run_2d.clone());
    store
        .move_board_card(
            agent_2d,
            next_mutation(
                &scope,
                &owner,
                MoveBoardCard {
                    view: view_2d,
                    note: card_2d.clone(),
                    group: g2.clone(),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".to_owned(),
                        Some(YamlValue::String("doing".to_owned())),
                    )]),
                    expected_note: card_2d_created.value.revision,
                    expected_view: v5_created.value.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    store
        .set_folder_lifecycle(
            &scope,
            active_epoch,
            &f_2d,
            &f_2d_rev,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .unwrap();
    let prep_2d = store
        .prepare_agent_run_rollback(human_ctx.clone(), run_2d)
        .await
        .expect("prepare rollback must succeed after human trashed view's parent folder");
    store
        .rollback_agent_run(human_ctx.clone(), next_mutation(&scope, &owner, prep_2d))
        .await
        .expect("rollback must succeed after human trashed view's parent folder");
    let card_2d_after = store
        .get_note(
            human_ctx,
            GetNote {
                note: card_2d,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        card_2d_after.fields.get("status"),
        Some(&FieldObservation::Ok(FieldValue::Scalar(
            ScalarValue::String("todo".to_owned())
        )))
    );
    let _ = revs;
}

#[tokio::test]
async fn l6_rollback_board_neighbor_order_and_trashed_view_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-nbr-view-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(23), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_neighbor_order_and_trashed_view_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6nv");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(24), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_neighbor_order_and_trashed_view_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_board_prerun_pma_and_stale_non_moved_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-prerun-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(19), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_prerun_pma_and_stale_non_moved_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6pre");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(20), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_prerun_pma_and_stale_non_moved_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_board_restored_note_and_non_moved_group_reconciliation_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-rec-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(15), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_restored_note_and_group_reconciliation_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6rec");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(16), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_restored_note_and_group_reconciliation_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_board_mixed_traces_and_untouched_columns_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-mix-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(17), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_mixed_traces_and_untouched_columns_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6mix");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(18), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_mixed_traces_and_untouched_columns_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_board_unmoved_run_touched_neighbor_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-nbr-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(13), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_board_unmoved_run_touched_neighbor_rollback_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6nbr");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(14), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_board_unmoved_run_touched_neighbor_rollback_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn l6_rollback_sibling_slug_swap_and_chains_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-swap-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(11), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        run_sibling_slug_swap_rollback_suite(&store).await;
        runtime.shutdown().await.expect("shutdown sqlite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let bucket = fixtures.fresh_s3_bucket("l6swp");
        let s3_cfg = fixtures.s3_config(&bucket, S3BucketModePolicy::DetectFromBucket);
        admin_ensure_bucket(&s3_cfg, Some("Enabled"))
            .await
            .expect("ensure S3 bucket");
        let cfg = fixtures.pg_s3_config(sample_installation_id(12), &schema, s3_cfg);
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open pg+s3");
        run_sibling_slug_swap_rollback_suite(&store).await;
        runtime.shutdown().await.expect("shutdown pg+s3");
        fixtures.drop_pg_schema(&schema).await;
    }
}

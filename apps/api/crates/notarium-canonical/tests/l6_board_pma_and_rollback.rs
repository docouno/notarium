#![forbid(unsafe_code)]

#[path = "l6_board_pma_and_rollback/applied.rs"]
mod applied;
#[path = "l6_board_pma_and_rollback/board_deadline.rs"]
mod board_deadline;
#[path = "l6_board_pma_and_rollback/pg_deadline.rs"]
mod pg_deadline;
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
        Cancellation, CreateNote, EditNote, EvaluatedBoardGroup, EvaluatedBoardRow, GetNote,
        GroupKey, MoveBoardCard, Mutation, NoteRevision, NoteWritePort, PortFuture, Preconditions,
        RankExpectation, RankNeighbor, RenameNote, RollbackAgentRun, RollbackBoardFacts,
        RollbackBoardFactsRequest, SemanticPlacement, SpaceContext, ViewRef,
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

/// Real canonical-reading test `BoardMutationFactsProvider` that evaluates board membership by reading
/// `status` frontmatter from canonical notes (excluding `status == "archived"` as `OutsideView`),
/// sorts each column by `(overlay_rank_or_unranked, slug, note_id)`, and supports deterministic
/// fault injection (`forge_authority_once`, `inject_stale_cutoff_once`).
struct CanonicalTestBoardPlanner {
    store: CanonicalStore,
    tracked_notes: Mutex<BTreeSet<NoteId>>,
    forge_authority_once: AtomicBool,
    inject_stale_cutoff_once: AtomicBool,
    evaluate_move_calls: AtomicUsize,
    move_waits: Mutex<Option<Vec<std::time::Duration>>>,
}

impl CanonicalTestBoardPlanner {
    fn new(store: CanonicalStore, tracked_notes: impl IntoIterator<Item = NoteId>) -> Arc<Self> {
        Arc::new(Self {
            store,
            tracked_notes: Mutex::new(tracked_notes.into_iter().collect()),
            forge_authority_once: AtomicBool::new(false),
            inject_stale_cutoff_once: AtomicBool::new(false),
            evaluate_move_calls: AtomicUsize::new(0),
            move_waits: Mutex::new(None),
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
                let Ok(snap) = self
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
                else {
                    continue;
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
                let status_opt = match snap.fields.get("status") {
                    Some(FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(s)))) => {
                        Some(s.as_str())
                    }
                    _ => None,
                };
                let grp_opt = Self::group_from_status_str(status_opt);
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
                    group_field_kind: BoardGroupFieldKind::String,
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
                let view_rev = view_snap.document.metadata().revision().clone();
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
                    let Ok(snap) = self
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
                    else {
                        continue;
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

    applied::check(store, &ctx, &view, view_created.value.revision, &planner).await;

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
    check_rollback_destination_authority(store, &scope, &owner).await;
}

#[tokio::test]
async fn l6_move_board_card_planner_cutoff_and_pma_dual_dialect_parity() {
    {
        let root = TempDataRoot::new("l6-move-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(1), root.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open sqlite");
        let evidence = run_move_board_card_suite(&store).await;
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
        let evidence = run_move_board_card_suite(&store).await;
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
        matches!(denied, Err(PortError::Domain(DomainError::SpaceReadOnly))),
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
        let cfg = fixtures.pg_s3_config(sample_installation_id(2), &schema, s3_cfg);
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

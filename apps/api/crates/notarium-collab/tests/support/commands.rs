use super::*;

use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use notarium_core::{
    DomainError,
    ports::{
        BoardGroupFieldKind, BoardMoveFacts, BoardMoveFactsSpec, BoardMutationFactsProvider,
        BoardPlannerAuthority, Cancellation, EvaluatedBoardGroup, EvaluatedBoardRow, GroupKey,
        MoveBoardCard, PortFuture, RankExpectation, SemanticPlacement, SpaceContext, ViewRef,
    },
    value::{ScalarValue, YamlValue},
};
use notarium_syntax::frontmatter;
use yrs::{Any, Map, Out, Transact};

struct OneCardPlanner {
    store: CanonicalStore,
    attempts: AtomicUsize,
}

fn group(value: &str) -> GroupKey {
    GroupKey::Value(ScalarValue::String(value.to_owned()))
}

impl BoardMutationFactsProvider for OneCardPlanner {
    fn evaluate_move<'a>(
        &'a self,
        authority: &'a BoardPlannerAuthority,
        ctx: SpaceContext,
        cutoff: Option<SpaceSeq>,
        card: MoveBoardCard,
    ) -> PortFuture<'a, BoardMoveFacts> {
        Box::pin(async move {
            let (_, carrier) = note_head(&self.store, &ctx, &card.note).await;
            let header = frontmatter::analyze(&carrier, DocClass::UserDoc)?;
            let fields = header.fields.expect("writable card YAML");
            let Some(YamlValue::String(status)) = fields.get("status") else {
                panic!("fixture card has status")
            };
            let before = group(status);
            let binding = notarium_syntax::content_digest(card.note.as_str());
            let current = self.store.read_space(&ctx.scope().space_id).await?.last_seq;
            let attempt = self.attempts.fetch_add(1, Ordering::SeqCst);
            let cutoff = if attempt == 0 {
                SpaceSeq::new(current.get() - 1)?
            } else {
                cutoff.unwrap_or(current)
            };
            let after_eligible_in_group = match card.fields.get("status") {
                None => before == card.group,
                Some(Some(YamlValue::String(status))) => group(status) == card.group,
                _ => false,
            };
            let mut groups = vec![EvaluatedBoardGroup {
                group: before.clone(),
                rows: vec![EvaluatedBoardRow {
                    note: card.note,
                    expected_note: card.expected_note,
                    expected_rank: card.expected_rank,
                    base_order_binding: binding,
                }],
            }];
            if before != card.group {
                groups.push(EvaluatedBoardGroup {
                    group: card.group,
                    rows: Vec::new(),
                });
            }
            Ok(BoardMoveFacts::attest(
                authority,
                BoardMoveFactsSpec {
                    scope: ctx.scope().clone(),
                    cutoff,
                    view: card.view,
                    view_revision: card.expected_view,
                    schema_revision: None,
                    descriptor_fingerprint: ContentDigest::from_bytes([0; 32]),
                    group_field: "status".to_owned(),
                    group_field_kind: BoardGroupFieldKind::String,
                    groups,
                    before_placement: SemanticPlacement::InGroup {
                        group: before,
                        predecessor: None,
                        successor: None,
                    },
                    base_order_binding: binding,
                    after_eligible_in_group,
                },
            ))
        })
    }
}

pub async fn board_move(store: &CanonicalStore, hub: &CollabHub, owner: &SpaceContext) {
    let card = create_note(
        store,
        owner,
        62,
        "---\nstatus: todo # status comment\n---\nCard.\n",
        None,
    )
    .await;
    let view = create_note(store, owner, 63, "# Board\n", None).await;
    let (mut peer, _) = synced_client(hub, owner, &card.note, 141).await;
    let planner = Arc::new(OneCardPlanner {
        store: store.clone(),
        attempts: AtomicUsize::new(0),
    });
    store
        .register_board_facts_provider(planner.clone())
        .unwrap();

    let view_ref = ViewRef {
        note: view.note,
        key: ViewKey::from_bytes([11; 16]),
    };
    let request = mutation(
        owner,
        MoveBoardCard {
            view: view_ref.clone(),
            note: card.note.clone(),
            group: group("done"),
            before: None,
            after: None,
            fields: BTreeMap::from([("status".into(), Some(YamlValue::String("done".into())))]),
            expected_note: card.revision,
            expected_view: view.revision.clone(),
            expected_rank: RankExpectation::Absent,
        },
    );
    let committed = store
        .move_board_card(owner.clone(), request.clone())
        .await
        .unwrap();
    let replay = store.move_board_card(owner.clone(), request).await.unwrap();
    assert_eq!(committed.receipt, replay.receipt);
    assert_eq!(planner.attempts.load(Ordering::SeqCst), 2);
    assert_eq!(committed.value.group, group("done"));
    assert_eq!(
        note_head(store, owner, &card.note).await.1,
        "---\nstatus: done # status comment\n---\nCard.\n",
    );
    peer.sync().await;
    assert_eq!(
        peer.fields.get(&peer.doc.transact(), "status"),
        Some(Out::Any(Any::from("done"))),
    );

    // The canonical planner still sees "done", but the room has an ACKed
    // move to "archived". A rank-only drag has no field edits to intersect
    // with pending overrides, so the materialized target must be checked.
    let update = peer.update(|txn| {
        peer.fields.insert(txn, "status", "archived");
    });
    peer.send_update(&update).await;
    peer.ack().await;
    let prior = committed.value.revision.revision;
    assert_eq!(note_head(store, owner, &card.note).await.0, prior);
    let result = store
        .move_board_card(
            owner.clone(),
            mutation(
                owner,
                MoveBoardCard {
                    view: view_ref.clone(),
                    note: card.note.clone(),
                    group: group("done"),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: prior.clone(),
                    expected_view: view.revision,
                    expected_rank: RankExpectation::Existing(committed.value.rank_revision.clone()),
                },
            ),
        )
        .await;
    let (current, carrier) = note_head(store, owner, &card.note).await;
    assert_ne!(current, prior);
    assert!(matches!(
        result,
        Err(PortError::Domain(DomainError::RevisionConflict { current: reported, .. }))
            if reported == current
    ));
    assert_eq!(
        carrier,
        "---\nstatus: archived # status comment\n---\nCard.\n"
    );
    let overlays = store
        .inspect_view_overlays_for_test(&owner.scope().space_id, &view_ref)
        .await
        .unwrap();
    assert_eq!(
        overlays[&card.note].rank_rev_id,
        committed.value.rank_revision
    );
}

pub async fn rollback(
    store: &CanonicalStore,
    hub: &CollabHub,
    owner: &SpaceContext,
    close_before_rollback: bool,
) {
    let case = if close_before_rollback { 64 } else { 65 };
    let seed = "---\nstatus: todo # retained\n---\nHuman initial.\n";
    let note = create_note(store, owner, case, seed, None).await.note;
    let (mut writer, _) = synced_client(hub, owner, &note, u64::from(case)).await;
    let run = AgentRunId::from_bytes([case; 16]);
    let actor = agent_context(owner, &run);
    assert!(matches!(
        hub.connect(
            actor.clone(),
            note.clone(),
            test_auth(&Cancellation::default(), None)
        )
        .await,
        Err(PortError::Domain(DomainError::AccessDenied))
    ));
    let human_edit = "Human live edit. 🧑\n";
    writer.send_update(&writer.append(human_edit)).await;
    writer.ack().await;
    let head = note_head(store, owner, &note).await;
    assert_eq!(
        head.1, seed,
        "peer update remains separate from the later agent revision"
    );
    let start = seed.find("todo").unwrap();
    let _agent_edit = store
        .edit_note(
            actor.clone(),
            edit(
                &actor,
                &note,
                seed,
                CarrierEditOrigin::Header,
                start,
                start + 4,
                "done",
            ),
        )
        .await
        .unwrap();
    writer.sync().await;
    assert!(writer.text().ends_with(human_edit));
    assert_eq!(
        writer.fields.get(&writer.doc.transact(), "status"),
        Some(Out::Any(Any::from("done"))),
    );

    if close_before_rollback {
        drop(writer);
        wait_until(async || {
            store
                .read_collab_session(None, owner.scope(), &note)
                .await
                .unwrap()
                .unwrap()
                .session
                .room_state
                == notarium_canonical::CollabRoomState::Closed
        })
        .await;
    }

    let rollback = store
        .rollback_agent_run_by_id(owner.clone(), mutation(owner, run))
        .await
        .unwrap()
        .value;
    let carrier = note_head(store, owner, &note).await.1;
    assert!(carrier.ends_with(human_edit));
    if close_before_rollback {
        assert!(rollback.skipped_room_active.is_empty());
        assert_eq!(rollback.restored.len(), 1);
        assert_eq!(carrier, format!("{seed}{human_edit}"));
    } else {
        assert_eq!(rollback.skipped_room_active, [note]);
        assert!(rollback.restored.is_empty());
        assert!(carrier.contains("status: done # retained"));
    }
}

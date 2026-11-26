use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

use notarium_canonical::{CreateFolderSpec, domain::common::MAX_FOLDER_DEPTH};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, SpaceLifecycle, SpaceRole},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{AgentRunId, FolderId, LeaseEpoch, NoteId, ViewKey},
    patch::CarrierEditOrigin,
    ports::{
        BoardDelta, ChangeRead, ChangeReadResult, CreateNote, EditNote, EventBusPort, GroupCount,
        GroupKey, MaintenanceContext, MoveBoardCard, MoveNote, NoteRevision, NoteWritePort,
        PageLimit, RankExpectation, RollbackAgentRun, ServiceAuthority, ServicePurpose,
        SpaceContext, SpaceEvent, SpaceEventKind, StructuralReadPort, ViewGraphPort, ViewQuery,
        ViewRef, ViewResult,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::{AwaitWatermarks, CausalBasis, ChangeCursor},
    value::{ScalarValue, YamlValue},
};
use notarium_projections::ProjectionEngine;

use super::{CanonicalStore, ProjectorRuntime, budget, mutation, open_space, random_bytes, sync};

pub(super) async fn exercise(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    implicit_root_source(store, runtime).await;
    stale_board_aggregate(store, runtime).await;
    hidden_stale_board_aggregate(store, runtime).await;
    hidden_board_overflow(store, runtime).await;
    graph_settlement_requires_full_space_access(store, runtime).await;
    scoped_board_refresh(store, runtime).await;
    ack_retry_delivers_the_published_change(store, runtime).await;
    reopened_feed_refreshes_the_published_command(store, runtime).await;
    first_change_racing_projection_subscription_is_delivered(store, runtime).await;
    purge_reseed_refreshes_only_after_readiness(store, runtime).await;
    Box::pin(rollback_trashed_and_edited_board_view_through_real_planner(
        store, runtime,
    ))
    .await;
    Box::pin(rollback_retired_widened_unranked_and_trashed_board_views(
        store, runtime,
    ))
    .await;
    Box::pin(rollback_skipped_replay_and_oracle_views(store, runtime)).await;
    Box::pin(rollback_case_7f_materialization_and_partial_retry(
        store, runtime,
    ))
    .await;
    Box::pin(keeper_readonly_abilities_isolation_on_changes_events_and_graph(store, runtime)).await;
}

async fn ack_retry_delivers_the_published_change(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    let (scope, owner) = open_space(store).await;
    sync(store, runtime, &scope).await;
    let engine = runtime.engine();
    let after = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let seq = after.checked_next().unwrap();
    let mut stream = engine
        .event_bus()
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after,
            },
        )
        .await
        .unwrap();
    let failed = engine.fail_projection_ack_for_test(&scope, seq).unwrap();
    let note = create_note(store, &owner, None, "one-change", "One change".into()).await;
    tokio::time::timeout(Duration::from_secs(5), failed)
        .await
        .expect("the published command reaches its injected ACK failure")
        .unwrap();
    engine
        .wait_for_projected(&scope, seq, &budget())
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = stream.next().await.unwrap().unwrap();
            if event.seq == seq
                && matches!(event.kind, SpaceEventKind::Changed(change)
                    if change.entity == notarium_core::ports::EntityId::Note(note.note.clone()))
            {
                break;
            }
        }
    })
    .await
    .expect("retrying ACK delivers the existing change without another write");
}

async fn reopened_feed_refreshes_the_published_command(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    let (scope, owner) = open_space(store).await;
    let visible = folder(store, &owner, None, "visible", true).await.unwrap();
    let hidden = folder(store, &owner, None, "hidden", true).await.unwrap();
    sync(store, runtime, &scope).await;
    let engine = runtime.engine();
    let after = ChangeCursor {
        scope: scope.clone(),
        after: store.read_space(&scope.space_id).await.unwrap().last_seq,
    };
    let bus = engine.event_bus();
    let mut interested = bus
        .subscribe(project_pat(&owner, &visible), after.clone())
        .await
        .unwrap();
    let mut unrelated = bus
        .subscribe(project_pat(&owner, &hidden), after)
        .await
        .unwrap();

    let mut recovered = Vec::new();
    for (after_publish, slug) in [(false, "ack-reset"), (true, "post-publish-reset")] {
        let seq = store
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq
            .checked_next()
            .unwrap();
        let failed = if after_publish {
            engine.fail_projection_after_publish_for_test(&scope, seq)
        } else {
            engine.fail_projection_ack_with_internal_for_test(&scope, seq)
        }
        .unwrap();
        create_note(
            store,
            &owner,
            Some(visible.clone()),
            slug,
            "# Visible".into(),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(5), failed)
            .await
            .expect("the durable command reaches the injected connection failure")
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = interested.next().await.unwrap().unwrap();
                if event.seq == seq {
                    assert!(matches!(event.kind, SpaceEventKind::ResyncRequired));
                    break;
                }
            }
        })
        .await
        .expect("reopening a feed refreshes the affected reader without a later write");
        recovered.push(seq);
    }

    // A later write gives the unrelated stream a deterministic queue boundary.
    let note = create_note(store, &owner, Some(hidden), "next-change", "# Next".into()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = unrelated.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Changed(_) | SpaceEventKind::ResyncRequired
                    if recovered.contains(&event.seq) =>
                {
                    panic!("the recovery exposed a different project's command");
                }
                SpaceEventKind::Changed(change)
                    if change.entity == notarium_core::ports::EntityId::Note(note.note.clone()) =>
                {
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("the reopened feed delivers later authorized changes");
}

async fn first_change_racing_projection_subscription_is_delivered(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::ids::{SpaceId, SpaceSeq};

    let space_id = SpaceId::from_bytes(random_bytes());
    let engine = runtime.engine();
    let mut pause = engine
        .pause_before_zero_feed_subscription_for_test(&space_id)
        .unwrap();
    let (scope, owner) = super::open_space_with_id(store, space_id).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        pause.reached_feed_boundary_for_test(),
    )
    .await
    .expect("the empty cut is published before opening the internal feed")
    .unwrap();
    let mut stream = engine
        .event_bus()
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope,
                after: SpaceSeq::ZERO,
            },
        )
        .await
        .unwrap();
    let note = create_note(store, &owner, None, "first-change", "# First".into()).await;
    let first = SpaceSeq::ZERO.checked_next().unwrap();
    assert_eq!(
        store
            .read_space(&owner.scope().space_id)
            .await
            .unwrap()
            .last_seq,
        first
    );
    pause.resume_for_test().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = stream.next().await.unwrap().unwrap();
            if event.seq == first {
                assert!(matches!(event.kind, SpaceEventKind::Changed(change)
                    if change.entity == notarium_core::ports::EntityId::Note(note.note.clone())));
                break;
            }
        }
    })
    .await
    .expect("the first change reaches the existing subscriber without a later write");
}

async fn purge_reseed_refreshes_only_after_readiness(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::{
        ids::{SpaceId, SpaceSeq},
        ports::{DeleteDisposition, DeleteNote},
    };

    let engine = runtime.engine();
    let space_id = SpaceId::from_bytes(random_bytes());
    let mut first_subscribe = engine
        .pause_before_zero_feed_subscription_for_test(&space_id)
        .unwrap();
    let (scope, owner) = super::open_space_with_id(store, space_id).await;
    tokio::time::timeout(
        Duration::from_secs(5),
        first_subscribe.reached_feed_boundary_for_test(),
    )
    .await
    .unwrap()
    .unwrap();
    let mut stream = engine
        .event_bus()
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: SpaceSeq::ZERO,
            },
        )
        .await
        .unwrap();
    let erased = create_note(store, &owner, None, "erased-note", "# Erased".into()).await;
    let retained = create_note(store, &owner, None, "retained-note", "# Retained".into()).await;
    let mut trash = mutation(
        &owner,
        DeleteNote {
            note: erased.note.clone(),
            disposition: DeleteDisposition::Trash,
        },
    );
    trash.preconditions.revision = Some(erased.revision);
    let trashed = store.delete_note(owner.clone(), trash).await.unwrap();
    let mut purge = mutation(
        &owner,
        DeleteNote {
            note: erased.note.clone(),
            disposition: DeleteDisposition::Purge,
        },
    );
    purge.preconditions.revision = Some(trashed.value.revision);
    let purged = store.delete_note(owner.clone(), purge).await.unwrap();
    let mut reseed = engine.pause_before_recovery_for_test(&scope).unwrap();
    first_subscribe.resume_for_test().await.unwrap();
    tokio::time::timeout(
        Duration::from_secs(5),
        reseed.reached_feed_boundary_for_test(),
    )
    .await
    .expect("the erased journal requires a reseed")
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), stream.next())
            .await
            .is_err(),
        "the stream waits until the replacement cut can serve reads"
    );
    reseed.resume_for_test().await.unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .expect("the reseed wakes the subscriber without a later command")
        .unwrap()
        .unwrap();
    assert!(matches!(ready.kind, SpaceEventKind::ResyncRequired));
    assert_eq!(ready.seq, SpaceSeq::ZERO);
    let snapshot = engine.acquire_snapshot(owner, causal()).await.unwrap();
    assert_eq!(snapshot.cut().projected_seq, purged.receipt.seq());
    assert!(snapshot.lookup(&retained.note).unwrap().is_some());
    assert!(snapshot.lookup(&erased.note).unwrap().is_none());
}

async fn implicit_root_source(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "project", true).await.unwrap();
    let implicit = create_view(
        store,
        &owner,
        &project,
        "implicit-root",
        "table",
        "{scope: space, recursive: false}",
        "filter: {exists: probe}\n",
    )
    .await;
    let explicit = create_view(
        store,
        &owner,
        &project,
        "explicit-root",
        "table",
        r#"{scope: folder, folder: "/", recursive: false}"#,
        "filter: {exists: probe}\n",
    )
    .await;
    let root_card = create_note(
        store,
        &owner,
        None,
        "root-card",
        "---\nprobe: root\n---\n".into(),
    )
    .await;
    create_note(
        store,
        &owner,
        Some(project.clone()),
        "project-card",
        "---\nprobe: project\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    // Changing entry authorization must keep the actual source root-direct.
    let engine = runtime.engine();
    let broad = query(&engine, owner.clone(), implicit.0.clone())
        .await
        .unwrap();
    assert_eq!(broad.rows.items.len(), 1);
    assert_eq!(
        broad.rows.items[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        root_card.note
    );

    let keeper = owner
        .auth()
        .for_keeper(
            AgentRunId::from_bytes(random_bytes()),
            scope.space_id.clone(),
            Some(project.clone()),
            BTreeSet::new(),
        )
        .unwrap();
    for reader in [
        project_pat(&owner, &project),
        SpaceContext::new(keeper, scope, budget()).unwrap(),
    ] {
        let page = query(&engine, reader.clone(), implicit.0.clone())
            .await
            .expect("an implicit Space source enters through the project grant");
        assert!(
            page.rows.items.is_empty(),
            "the source still selects root children"
        );
        assert!(matches!(
            query(&engine, reader, explicit.0.clone()).await,
            Err(PortError::Domain(DomainError::ResourceNotFound)),
        ));
    }
}

async fn stale_board_aggregate(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "project", true).await.unwrap();
    let (view, _) = create_view(
        store,
        &owner,
        &project,
        "event-board",
        "board",
        "{scope: project}",
        "group_by: status\n",
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let subscriber = project_pat(&owner, &project);
    let after = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let mut events = bus
        .subscribe(
            subscriber.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after,
            },
        )
        .await
        .unwrap();

    let card = create_note(
        store,
        &owner,
        Some(project.clone()),
        "unranked-contributor",
        "---\nstatus: before-revocation\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    // Capture event authority while the old cut is current.
    let old = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert!(old > after);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.next().await.unwrap().unwrap();
            if event.seq == old && matches!(event.kind, SpaceEventKind::Changed(_)) {
                break;
            }
        }
    })
    .await
    .expect("receive the change before queuing the board event");
    bus.publish(
        event_publication(),
        SpaceEvent {
            scope: scope.clone(),
            seq: old,
            kind: SpaceEventKind::Board(BoardDelta {
                scope: scope.clone(),
                seq: old,
                view,
                groups: vec![GroupCount {
                    group: group("before-revocation"),
                    count: 1,
                }],
                ranks: Vec::new(),
            }),
        },
    )
    .await
    .unwrap();

    let mut pause = engine.pause_before_projection_for_test(&scope, 1).unwrap();
    let mut request = mutation(
        &owner,
        MoveNote {
            note: card.note.clone(),
            parent: None,
            slug: "outside-project".into(),
        },
    );
    request.preconditions.revision = Some(card.revision);
    let moved = store.move_note(owner.clone(), request).await.unwrap();
    assert!(
        !engine
            .is_live_visible(&subscriber, &card.note)
            .await
            .unwrap()
    );
    {
        let held = tokio::time::timeout(Duration::from_secs(5), pause.reached())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(held.last_seq, moved.receipt.seq());
        let mut pending = Box::pin(async {
            loop {
                let event = events.next().await.unwrap().unwrap();
                if !matches!(event.kind, SpaceEventKind::GraphSettled { .. }) {
                    return event;
                }
            }
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), &mut pending)
                .await
                .is_err(),
            "the board delivery waits for a current source"
        );
        // A canonical write can finish while this delivery is waiting.
        create_note(
            store,
            &owner,
            None,
            "outside-project-while-paused",
            "outside the board source\n".into(),
        )
        .await;
        drop(pending);
        drop(pause);
    }
    sync(store, runtime, &scope).await;
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert!(head >= moved.receipt.seq());
    bus.publish(
        event_publication(),
        SpaceEvent {
            scope,
            seq: head,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
        },
    )
    .await
    .unwrap();

    let resync = tokio::time::timeout(Duration::from_secs(5), async {
        let mut resync = false;
        loop {
            let event = events.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("a revoked contributor's group escaped"),
                SpaceEventKind::ResyncRequired if event.seq == old => resync = true,
                SpaceEventKind::Lifecycle(SpaceLifecycle::Active) => return resync,
                _ => {}
            }
        }
    })
    .await
    .expect("receive the marker without a stale BoardDelta");
    assert!(
        resync,
        "a new receive still yields the payload-free refresh"
    );
}

async fn hidden_stale_board_aggregate(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "visible-project", true)
        .await
        .unwrap();
    let hidden = folder(store, &owner, None, "hidden-project", true)
        .await
        .unwrap();
    let local_source = "{scope: project}";
    let hidden_source = "{scope: folder, folder: /hidden-project}";
    let body = "group_by: status\nfilter: {exists: status}\n";
    let (hidden_view, _) = create_view(
        store,
        &owner,
        &hidden,
        "hidden-board",
        "board",
        local_source,
        body,
    )
    .await;
    let (cross_project, _) = create_view(
        store,
        &owner,
        &project,
        "cross-project-board",
        "board",
        hidden_source,
        body,
    )
    .await;
    let (retargeted, carrier) = create_view(
        store,
        &owner,
        &project,
        "retargeted-board",
        "board",
        local_source,
        body,
    )
    .await;
    create_note(
        store,
        &owner,
        Some(project.clone()),
        "project-contributor",
        "---\nstatus: visible\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let subscriber = project_pat(&owner, &project);
    assert!(
        !engine
            .is_live_visible(&subscriber, &hidden_view.note)
            .await
            .unwrap()
    );
    assert!(
        engine
            .is_live_visible(&subscriber, &cross_project.note)
            .await
            .unwrap()
    );
    assert!(
        query(&engine, subscriber.clone(), retargeted.clone())
            .await
            .is_ok()
    );
    let after = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let mut events = bus
        .subscribe(
            subscriber.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after,
            },
        )
        .await
        .unwrap();

    create_note(
        store,
        &owner,
        Some(hidden.clone()),
        "hidden-contributor",
        "---\nstatus: hidden\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let retained = engine
        .acquire_snapshot(owner.clone(), causal())
        .await
        .unwrap();
    let old = retained.cut().projected_seq;
    assert!(old > after);
    for (view, value) in [
        (hidden_view, "hidden"),
        (cross_project, "hidden"),
        (retargeted.clone(), "visible"),
    ] {
        let groups = query(&engine, owner.clone(), view.clone())
            .await
            .unwrap()
            .groups;
        assert_eq!(
            groups,
            vec![GroupCount {
                group: group(value),
                count: 1,
            }]
        );
        bus.publish(
            event_publication(),
            SpaceEvent {
                scope: scope.clone(),
                seq: old,
                kind: SpaceEventKind::Board(BoardDelta {
                    scope: scope.clone(),
                    seq: old,
                    view,
                    groups,
                    ranks: Vec::new(),
                }),
            },
        )
        .await
        .unwrap();
    }

    // The last board's old source is visible, but its current source is not.
    let old_carrier = view_carrier(&retargeted.key, "board", local_source, body);
    let new_carrier = view_carrier(&retargeted.key, "board", hidden_source, body);
    let span = notarium_syntax::frontmatter::analyze(&old_carrier, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &old_carrier,
        span,
        vec![(CarrierEditOrigin::Body, span, new_carrier)],
    )
    .unwrap();
    let mut edit = mutation(
        &owner,
        EditNote {
            note: carrier.note,
            plan,
        },
    );
    edit.preconditions.revision = Some(carrier.revision);
    store.edit_note(owner.clone(), edit).await.unwrap();
    sync(store, runtime, &scope).await;
    assert!(matches!(
        query(&engine, subscriber, retargeted).await,
        Err(PortError::Domain(DomainError::ResourceNotFound)),
    ));
    let current = store.read_space(&scope.space_id).await.unwrap().last_seq;
    assert!(current > old);
    bus.publish(
        event_publication(),
        SpaceEvent {
            scope,
            seq: current,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
        },
    )
    .await
    .unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = events.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("a hidden board's payload escaped"),
                SpaceEventKind::Changed(_) | SpaceEventKind::ResyncRequired if event.seq == old => {
                    panic!("a hidden board's sequence escaped");
                }
                SpaceEventKind::Lifecycle(SpaceLifecycle::Active) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("receive the marker without exposing a hidden board's sequence");
    drop(retained);
}

async fn hidden_board_overflow(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let visible = folder(store, &owner, None, "visible-project", true)
        .await
        .unwrap();
    let hidden = folder(store, &owner, None, "hidden-project", true)
        .await
        .unwrap();
    let columns = (0..201)
        .map(|i| format!("column-{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let (view, carrier) = create_view(
        store,
        &owner,
        &hidden,
        "oversized-event-board",
        "board",
        "{scope: project}",
        &format!(
            "group_by: status\nfilter: {{exists: status}}\noptions: {{columns: [{columns}]}}\n"
        ),
    )
    .await;
    let card = create_note(
        store,
        &owner,
        Some(hidden.clone()),
        "hidden-card",
        "---\nstatus: column-0\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let after = ChangeCursor {
        scope: scope.clone(),
        after: store.read_space(&scope.space_id).await.unwrap().last_seq,
    };
    let mut allowed = bus
        .subscribe(project_pat(&owner, &hidden), after.clone())
        .await
        .unwrap();
    let mut excluded = bus
        .subscribe(project_pat(&owner, &visible), after)
        .await
        .unwrap();
    let request = mutation(
        &owner,
        MoveBoardCard {
            view,
            note: card.note,
            group: group("column-1"),
            before: None,
            after: None,
            fields: BTreeMap::from([("status".into(), Some(YamlValue::String("column-1".into())))]),
            expected_note: card.revision,
            expected_view: carrier.revision,
            expected_rank: RankExpectation::Absent,
        },
    );
    let moved = store.move_board_card(owner, request).await.unwrap();
    let seq = moved.receipt.seq();
    sync(store, runtime, &scope).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = allowed.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("oversized board event escaped"),
                SpaceEventKind::ResyncRequired if event.seq == seq => break,
                _ => {}
            }
        }
    })
    .await
    .expect("the hidden board's own project receives its refresh");

    // Enqueue the sentinel strictly after the worker's own board notification.
    bus.publish(
        event_publication(),
        SpaceEvent {
            scope,
            seq,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = excluded.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("a hidden board's payload escaped"),
                SpaceEventKind::Changed(_) | SpaceEventKind::ResyncRequired if event.seq == seq => {
                    panic!("an oversized hidden board's sequence escaped");
                }
                SpaceEventKind::Lifecycle(SpaceLifecycle::Active) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("another project receives no board refresh");
}

async fn scoped_board_refresh(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "visible-project", true)
        .await
        .unwrap();
    let outside = folder(store, &owner, None, "hidden-project", true)
        .await
        .unwrap();
    let (view, carrier) = create_view(
        store,
        &owner,
        &project,
        "space-board",
        "board",
        "{scope: space, classes: [user-doc, profile]}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let visible = create_note(
        store,
        &owner,
        Some(project.clone()),
        "visible-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let hidden = create_note(
        store,
        &owner,
        Some(outside),
        "hidden-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let mut grants = owner.auth().spaces().clone();
    let grant = grants.get_mut(&scope.space_id).unwrap();
    grant.project_root = Some(project);
    grant.role = SpaceRole::Viewer;
    grant.read_classes = BTreeSet::from([DocClass::UserDoc]);
    let auth = owner.auth().for_pat(grants).unwrap();
    let subscriber = SpaceContext::new(auth, scope.clone(), budget()).unwrap();
    let page = query(&engine, subscriber.clone(), view.clone())
        .await
        .unwrap();
    assert_eq!(page.rows.items.len(), 1);
    assert_eq!(
        page.rows.items[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        visible.note
    );
    let after = ChangeCursor {
        scope: scope.clone(),
        after: store.read_space(&scope.space_id).await.unwrap().last_seq,
    };
    let mut scoped = bus.subscribe(subscriber, after.clone()).await.unwrap();
    let mut unrestricted = bus.subscribe(owner.clone(), after).await.unwrap();

    let move_card = async |card: &NoteRevision, status: &str| {
        let mut input = super::move_card(card, &carrier, view.key.clone());
        input.group = group(status);
        input
            .fields
            .insert("status".into(), Some(YamlValue::String(status.into())));
        store
            .move_board_card(owner.clone(), mutation(&owner, input))
            .await
            .unwrap()
            .receipt
            .seq()
    };
    let mut await_unrestricted = async |seq| {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = unrestricted.next().await.unwrap().unwrap();
                if event.seq == seq
                    && matches!(
                        event.kind,
                        SpaceEventKind::Board(_) | SpaceEventKind::ResyncRequired
                    )
                {
                    break;
                }
            }
        })
        .await
        .expect("the unrestricted subscriber observes the board notification");
    };

    let visible_seq = move_card(&visible, "doing").await;
    await_unrestricted(visible_seq).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = scoped.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("a scoped subscriber received the full board"),
                SpaceEventKind::ResyncRequired if event.seq == visible_seq => break,
                _ => {}
            }
        }
    })
    .await
    .expect("a visible changed card refreshes the scoped board");

    // The full aggregate still includes the visible rank from the first move.
    // It cannot authorize a signal for the second move's hidden target.
    let seq = move_card(&hidden, "done").await;
    await_unrestricted(seq).await;
    bus.publish(
        event_publication(),
        SpaceEvent {
            scope,
            seq,
            kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = scoped.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::Board(_) => panic!("a scoped subscriber received the full board"),
                SpaceEventKind::Changed(_) | SpaceEventKind::ResyncRequired if event.seq == seq => {
                    panic!("a hidden changed card's sequence escaped");
                }
                SpaceEventKind::Lifecycle(SpaceLifecycle::Active) => break,
                _ => {}
            }
        }
    })
    .await
    .expect("another project's card does not refresh the scoped board");
}

pub(super) struct OverflowFixture {
    owner: SpaceContext,
    project: FolderId,
    excluded: FolderId,
    run: AgentRunId,
    expected: Vec<NoteRevision>,
}

pub(super) async fn prepare_overflow(store: &CanonicalStore) -> OverflowFixture {
    let (_, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "visible", true).await.unwrap();
    let outside = folder(store, &owner, None, "outside", true).await.unwrap();
    let excluded = folder(store, &owner, None, "excluded", true).await.unwrap();
    let run = AgentRunId::from_bytes(random_bytes());
    let runner = super::agent(&owner, run.clone(), ChatAudience::Personal);
    let ids: BTreeSet<_> = (0..258)
        .map(|index: u128| NoteId::from_bytes(index.to_be_bytes()))
        .collect();
    let last = ids.last().unwrap();
    let mut writes = tokio::task::JoinSet::new();
    let mut expected = Vec::with_capacity(ids.len());
    for (index, id) in ids.iter().enumerate() {
        let store = store.clone();
        let runner = runner.clone();
        let request = mutation(
            &runner,
            CreateNote {
                folder_page: false,
                note: id.clone(),
                parent: Some(if id == last {
                    project.clone()
                } else {
                    outside.clone()
                }),
                slug: format!("overflow-card-{index}"),
                class: DocClass::UserDoc,
                carrier: "---\nstatus: todo\n---\n".into(),
            },
        );
        writes.spawn(async move { store.create_note(runner, request).await.unwrap().value });
        if writes.len() == 32 {
            expected.push(writes.join_next().await.unwrap().unwrap());
        }
    }
    while let Some(note) = writes.join_next().await {
        expected.push(note.unwrap());
    }
    OverflowFixture {
        owner,
        project,
        excluded,
        run,
        expected,
    }
}

impl OverflowFixture {
    pub(super) async fn exercise(self, store: &CanonicalStore, runtime: &ProjectorRuntime) {
        let scope = self.owner.scope().clone();
        sync(store, runtime, &scope).await;
        let bus = runtime.engine().event_bus();
        let after = ChangeCursor {
            scope: scope.clone(),
            after: store.read_space(&scope.space_id).await.unwrap().last_seq,
        };
        let reader = project_pat(&self.owner, &self.project);
        let mut visible = bus.subscribe(reader.clone(), after.clone()).await.unwrap();
        let mut hidden = bus
            .subscribe(project_pat(&self.owner, &self.excluded), after.clone())
            .await
            .unwrap();

        let revision = store
            .read_entity_revision_at_cutoff(&scope, "agent_run", self.run.as_str(), None)
            .await
            .unwrap()
            .unwrap()
            .revision_id;
        let expected = self.expected.len() as u64;
        let rolled = store
            .rollback_agent_run(
                self.owner.clone(),
                mutation(
                    &self.owner,
                    RollbackAgentRun {
                        run: self.run,
                        expected_run_revision: revision,
                        expected_entities: self.expected,
                        associated_board_expectations: Vec::new(),
                    },
                ),
            )
            .await
            .unwrap();
        let end = rolled.receipt.seq();
        assert_eq!(rolled.value.trashed.len() as u64, expected);
        assert_eq!(end.get() - after.after.get(), expected);

        // Rollback writes note changes in NoteId order. The only visible card
        // follows both the producer cap and multiple authorization-filtered pages.
        let ChangeReadResult::Log(first) = store
            .read_changes(
                reader,
                ChangeRead::Log {
                    after,
                    through: end,
                    limit: PageLimit::new(64).unwrap(),
                },
            )
            .await
            .unwrap()
        else {
            panic!("expected an authorized change page");
        };
        assert!(!first.complete && first.changes.is_empty());
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = visible.next().await.unwrap().unwrap();
                if event.seq == end && matches!(event.kind, SpaceEventKind::ResyncRequired) {
                    break;
                }
            }
        })
        .await
        .expect("the affected project receives its proven command refresh");

        // The already-observed refresh establishes that this sentinel follows it.
        bus.publish(
            event_publication(),
            SpaceEvent {
                scope,
                seq: end,
                kind: SpaceEventKind::Lifecycle(SpaceLifecycle::Active),
            },
        )
        .await
        .unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let event = hidden.next().await.unwrap().unwrap();
                match event.kind {
                    SpaceEventKind::Changed(_) | SpaceEventKind::ResyncRequired
                        if event.seq == end =>
                    {
                        panic!("an entirely hidden command's sequence escaped");
                    }
                    SpaceEventKind::Lifecycle(SpaceLifecycle::Active) => break,
                    _ => {}
                }
            }
        })
        .await
        .expect("the excluded project receives no command refresh");
    }
}

pub(super) struct DepthFixture {
    owner: SpaceContext,
    view: ViewRef,
    view_revision: NoteRevision,
    card: NoteRevision,
}

/// Create canonical history before starting the projector to exercise the cold
/// seed path without projecting each intermediate folder command.
pub(super) async fn prepare_depth(store: &CanonicalStore) -> DepthFixture {
    let (_, owner) = open_space(store).await;
    let mut deepest = None;
    for depth in 0..MAX_FOLDER_DEPTH {
        deepest = Some(
            folder(store, &owner, deepest, "d", depth == 0)
                .await
                .unwrap(),
        );
    }
    let deepest = deepest.expect("a positive depth limit");
    assert!(matches!(
        folder(store, &owner, Some(deepest.clone()), "d", false).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::InvalidState,
    ));

    let (view, view_revision) = create_view(
        store,
        &owner,
        &deepest,
        "boundary-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let card = create_note(
        store,
        &owner,
        Some(deepest),
        "boundary-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    DepthFixture {
        owner,
        view,
        view_revision,
        card,
    }
}

impl DepthFixture {
    pub(super) async fn exercise(self, store: &CanonicalStore, runtime: &ProjectorRuntime) {
        sync(store, runtime, self.owner.scope()).await;
        let engine = runtime.engine();
        let result = query(&engine, self.owner.clone(), self.view.clone())
            .await
            .expect("read a view 256 edges beneath the root");
        assert_eq!(result.rows.items.len(), 1);
        let card = &result.rows.items[0].card;
        assert_eq!(
            card.document.provenance().reference().note_id,
            self.card.note
        );
        assert!(card.path.contains("boundary-card"));

        let target = group("doing");
        let request = mutation(
            &self.owner,
            MoveBoardCard {
                view: self.view,
                note: self.card.note,
                group: target.clone(),
                before: None,
                after: None,
                fields: BTreeMap::from([(
                    "status".into(),
                    Some(YamlValue::String("doing".into())),
                )]),
                expected_note: self.card.revision,
                expected_view: self.view_revision.revision,
                expected_rank: RankExpectation::Absent,
            },
        );
        let moved = store
            .move_board_card(self.owner, request)
            .await
            .expect("plan a board move at the canonical depth limit");
        assert_eq!(moved.value.group, target);
    }
}

fn causal() -> CausalBasis {
    CausalBasis::Await(AwaitWatermarks::default())
}

fn event_publication() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::EventPublication),
        budget: budget(),
    }
}

fn group(value: &str) -> GroupKey {
    GroupKey::Value(ScalarValue::String(value.into()))
}

async fn graph_settlement_requires_full_space_access(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    let (scope, owner) = open_space(store).await;
    let project = folder(store, &owner, None, "graph-project", true)
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let after = ChangeCursor {
        scope: scope.clone(),
        after: store.read_space(&scope.space_id).await.unwrap().last_seq,
    };
    let bus = runtime.engine().event_bus();
    let mut full = bus.subscribe(owner.clone(), after.clone()).await.unwrap();
    let project_stream = bus
        .subscribe(project_pat(&owner, &project), after.clone())
        .await
        .unwrap();
    let mut grants = owner.auth().spaces().clone();
    let limited = grants.get_mut(&scope.space_id).unwrap();
    limited.role = SpaceRole::Viewer;
    limited.read_classes = BTreeSet::from([DocClass::Profile]);
    let principal = owner.auth().for_pat(grants).unwrap();
    let ctx = SpaceContext::new(principal, scope.clone(), budget()).unwrap();
    let class_stream = bus.subscribe(ctx, after).await.unwrap();

    create_note(store, &owner, None, "hidden-graph-note", "# Hidden".into()).await;
    let hidden = store.read_space(&scope.space_id).await.unwrap().last_seq;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = full.next().await.unwrap().unwrap();
            if event.seq == hidden && matches!(event.kind, SpaceEventKind::GraphSettled { .. }) {
                break;
            }
        }
    })
    .await
    .expect("the whole-Space subscriber receives the actual settlement");

    let visible = NoteId::from_bytes(random_bytes());
    store
        .create_note(
            owner.clone(),
            mutation(
                &owner,
                CreateNote {
                    folder_page: false,
                    note: visible.clone(),
                    parent: Some(project),
                    slug: "visible-graph-note".into(),
                    class: DocClass::Profile,
                    carrier: "# Visible".into(),
                },
            ),
        )
        .await
        .unwrap();
    for mut stream in [project_stream, class_stream] {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let event = stream.next().await.unwrap().unwrap();
                match event.kind {
                    SpaceEventKind::GraphSettled { .. } => {
                        panic!("a restricted subscriber observed whole-Space graph settlement");
                    }
                    SpaceEventKind::Changed(change)
                        if change.entity
                            == notarium_core::ports::EntityId::Note(visible.clone()) =>
                    {
                        break;
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("restricted subscriptions still receive visible entity changes");
    }
}

fn project_pat(owner: &SpaceContext, project: &FolderId) -> SpaceContext {
    let mut grants = owner.auth().spaces().clone();
    let grant = grants.get_mut(&owner.scope().space_id).unwrap();
    grant.project_root = Some(project.clone());
    grant.role = SpaceRole::Viewer;
    let auth = owner.auth().for_pat(grants).unwrap();
    SpaceContext::new(auth, owner.scope().clone(), budget()).unwrap()
}

async fn query(
    engine: &ProjectionEngine,
    reader: SpaceContext,
    view: ViewRef,
) -> Result<ViewResult, PortError> {
    engine
        .query_view(
            reader,
            ReadRequest::Open {
                query: ViewQuery {
                    view,
                    filter: FieldFilterAstV1 {
                        version: 1,
                        predicate: Predicate::All(Vec::new()),
                    },
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(5).unwrap(),
                },
                causal: causal(),
            },
        )
        .await
}

async fn folder(
    store: &CanonicalStore,
    owner: &SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
    is_project: bool,
) -> Result<FolderId, PortError> {
    let folder_id = FolderId::from_bytes(random_bytes());
    store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: folder_id.clone(),
            parent,
            slug: slug.into(),
            display_name: slug.into(),
            is_project,
            project_slug: is_project.then(|| slug.to_owned()),
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await?;
    Ok(folder_id)
}

async fn create_note(
    store: &CanonicalStore,
    owner: &SpaceContext,
    parent: Option<FolderId>,
    slug: &str,
    carrier: String,
) -> NoteRevision {
    store
        .create_note(
            owner.clone(),
            mutation(
                owner,
                CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes(random_bytes()),
                    parent,
                    slug: slug.into(),
                    class: DocClass::UserDoc,
                    carrier,
                },
            ),
        )
        .await
        .unwrap()
        .value
}

async fn create_view(
    store: &CanonicalStore,
    owner: &SpaceContext,
    parent: &FolderId,
    slug: &str,
    kind: &str,
    source: &str,
    body: &str,
) -> (ViewRef, NoteRevision) {
    let key = ViewKey::from_bytes(random_bytes());
    let note = create_note(
        store,
        owner,
        Some(parent.clone()),
        slug,
        view_carrier(&key, kind, source, body),
    )
    .await;
    (
        ViewRef {
            note: note.note.clone(),
            key,
        },
        note,
    )
}

fn view_carrier(key: &ViewKey, kind: &str, source: &str, body: &str) -> String {
    format!("```nota\nid: {key}\ntype: {kind}\nsource: {source}\n{body}```\n")
}

async fn rollback_trashed_and_edited_board_view_through_real_planner(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::{
        model::Lifecycle,
        ports::{DeleteDisposition, DeleteNote, GetNote, RankNeighbor},
        receipt::ReceiptSet,
    };

    let (scope, owner) = open_space(store).await;
    let engine = runtime.engine();

    // Subcase A: Agent run moves a card on a pre-existing board view, then trashes that view.
    // Real `ProjectionBoardPlanner` (`BoardCut::load`, `hydrate_candidates`, `evaluate_rollback`,
    // and `check_live`) must restore the view and preserve pre-run card order.
    let proj_a = folder(store, &owner, None, "rb-view-trash-proj", true)
        .await
        .unwrap();
    let (v1, v1_rev) = create_view(
        store,
        &owner,
        &proj_a,
        "rb-trashed-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let c1 = create_note(
        store,
        &owner,
        Some(proj_a.clone()),
        "rb-card-1",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let c2 = create_note(
        store,
        &owner,
        Some(proj_a.clone()),
        "rb-card-2",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let c1_moved_pre = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v1.clone(),
                    note: c1.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: c2.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: c1.revision.clone(),
                    expected_view: v1_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let run1 = AgentRunId::from_bytes(random_bytes());
    let agent1 = super::agent(&owner, run1.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent1.clone(),
            mutation(
                &agent1,
                MoveBoardCard {
                    view: v1.clone(),
                    note: c1.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c1_moved_pre.value.revision.revision.clone(),
                    expected_view: v1_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        c1_moved_pre.value.rank_revision.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    store
        .delete_note(
            agent1.clone(),
            mutation(
                &agent1,
                DeleteNote {
                    note: v1_rev.note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    // Advance Space head past the projection cut with an unrelated note so
    // `BoardCut::replay` catches the lagging projection up to the live head.
    let _unrelated = create_note(store, &owner, None, "rb-head-bump", "bump".into()).await;
    let prep1 = store
        .prepare_agent_run_rollback(owner.clone(), run1)
        .await
        .expect("prepare rollback must succeed through real planner on run-trashed view");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep1))
        .await
        .expect("rollback must succeed through real planner on run-trashed view");
    sync(store, runtime, &scope).await;

    let v1_after = store
        .get_note(
            owner.clone(),
            GetNote {
                note: v1_rev.note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(v1_after.document.metadata().lifecycle(), Lifecycle::Active);
    let v1_rows = query(&engine, owner.clone(), v1).await.unwrap();
    let v1_ids: Vec<NoteId> = v1_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(v1_ids, vec![c1.note, c2.note]);

    // Subcase B: Agent run moves a card on a pre-existing board view, then edits that view
    // to narrow its filter so the card no longer matches the edited view. Real planner must
    // hydrate candidates from the restored view definition and restore pre-run card order.
    let proj_b = folder(store, &owner, None, "rb-view-edit-proj", true)
        .await
        .unwrap();
    let v2_body = "group_by: status\nfilter: {exists: status}\n";
    let (v2, v2_rev) = create_view(
        store,
        &owner,
        &proj_b,
        "rb-edited-board",
        "board",
        "{scope: project}",
        v2_body,
    )
    .await;
    let c3 = create_note(
        store,
        &owner,
        Some(proj_b.clone()),
        "rb-card-3",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let c4 = create_note(
        store,
        &owner,
        Some(proj_b),
        "rb-card-4",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let c3_moved_pre = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v2.clone(),
                    note: c3.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: c4.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: c3.revision.clone(),
                    expected_view: v2_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let run2 = AgentRunId::from_bytes(random_bytes());
    let agent2 = super::agent(&owner, run2.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent2.clone(),
            mutation(
                &agent2,
                MoveBoardCard {
                    view: v2.clone(),
                    note: c3.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c3_moved_pre.value.revision.revision.clone(),
                    expected_view: v2_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        c3_moved_pre.value.rank_revision.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    let old_v2 = view_carrier(&v2.key, "board", "{scope: project}", v2_body);
    let narrowed_v2 = view_carrier(
        &v2.key,
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {eq: {key: status, value: done}}\n",
    );
    let span = notarium_syntax::frontmatter::analyze(&old_v2, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &old_v2,
        span,
        vec![(CarrierEditOrigin::Body, span, narrowed_v2)],
    )
    .unwrap();
    let mut edit_v2 = mutation(
        &agent2,
        EditNote {
            note: v2_rev.note.clone(),
            plan,
        },
    );
    edit_v2.preconditions.revision = Some(v2_rev.revision);
    store.edit_note(agent2, edit_v2).await.unwrap();
    sync(store, runtime, &scope).await;

    let prep2 = store
        .prepare_agent_run_rollback(owner.clone(), run2)
        .await
        .expect("prepare rollback must succeed through real planner on run-edited view");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep2))
        .await
        .expect("rollback must succeed through real planner on run-edited view");
    sync(store, runtime, &scope).await;

    let v2_rows = query(&engine, owner, v2).await.unwrap();
    let v2_ids: Vec<NoteId> = v2_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(v2_ids, vec![c3.note, c4.note]);
}

async fn rollback_retired_widened_unranked_and_trashed_board_views(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::ports::{DeleteDisposition, DeleteNote, GetNote, RankNeighbor};
    use notarium_core::receipt::ReceiptSet;

    let (scope, owner) = open_space(store).await;
    let engine = runtime.engine();

    // Case 1: Agent run adds a board block `K` to a pre-existing active plain note `V`
    // and moves a card on `(V, K)`. Rollback restores `V` without `K` and retires the overlay.
    let proj1 = folder(store, &owner, None, "rb-added-block-proj", true)
        .await
        .unwrap();
    let plain_carrier = "Plain pre-existing note.\n".to_owned();
    let v_added = create_note(
        store,
        &owner,
        Some(proj1.clone()),
        "rb-plain-to-board",
        plain_carrier.clone(),
    )
    .await;
    let c_added = create_note(
        store,
        &owner,
        Some(proj1.clone()),
        "rb-added-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_add = AgentRunId::from_bytes(random_bytes());
    let agent_add = super::agent(&owner, run_add.clone(), ChatAudience::Personal);
    let added_key = ViewKey::from_bytes(random_bytes());
    let added_body = "group_by: status\nfilter: {exists: status}\n";
    let added_carrier = view_carrier(&added_key, "board", "{scope: project}", added_body);
    let span = notarium_syntax::frontmatter::analyze(&plain_carrier, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &plain_carrier,
        span,
        vec![(CarrierEditOrigin::Body, span, added_carrier.clone())],
    )
    .unwrap();
    let mut edit_add = mutation(
        &agent_add,
        EditNote {
            note: v_added.note.clone(),
            plan,
        },
    );
    edit_add.preconditions.revision = Some(v_added.revision.clone());
    let v_added_board = store
        .edit_note(agent_add.clone(), edit_add)
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    let v_added_ref = ViewRef {
        note: v_added.note.clone(),
        key: added_key.clone(),
    };
    store
        .move_board_card(
            agent_add.clone(),
            mutation(
                &agent_add,
                MoveBoardCard {
                    view: v_added_ref.clone(),
                    note: c_added.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c_added.revision.clone(),
                    expected_view: v_added_board.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let prep_add = store
        .prepare_agent_run_rollback(owner.clone(), run_add)
        .await
        .expect("prepare rollback must succeed when run-added board block is removed by restore");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_add))
        .await
        .expect("rollback must succeed when run-added board block is removed by restore");
    sync(store, runtime, &scope).await;
    let v_added_after = store
        .get_note(
            owner.clone(),
            GetNote {
                note: v_added.note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        v_added_after.document.explicit_read(owner.auth()).unwrap(),
        plain_carrier
    );

    // Case 2: Human changes a pre-existing board block to `table` after an agent run
    // moved a card on it. Rollback treats the retired board view cleanly and clears overlays.
    let proj2 = folder(store, &owner, None, "rb-retired-view-proj", true)
        .await
        .unwrap();
    let v2_body = "group_by: status\nfilter: {exists: status}\n";
    let (v2, v2_rev) = create_view(
        store,
        &owner,
        &proj2,
        "rb-board-to-table",
        "board",
        "{scope: project}",
        v2_body,
    )
    .await;
    let c2 = create_note(
        store,
        &owner,
        Some(proj2.clone()),
        "rb-retired-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_ret = AgentRunId::from_bytes(random_bytes());
    let agent_ret = super::agent(&owner, run_ret.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_ret.clone(),
            mutation(
                &agent_ret,
                MoveBoardCard {
                    view: v2.clone(),
                    note: c2.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c2.revision.clone(),
                    expected_view: v2_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let old_v2 = view_carrier(&v2.key, "board", "{scope: project}", v2_body);
    let table_v2 = view_carrier(
        &v2.key,
        "table",
        "{scope: project}",
        "filter: {exists: status}\n",
    );
    let span = notarium_syntax::frontmatter::analyze(&old_v2, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &old_v2,
        span,
        vec![(CarrierEditOrigin::Body, span, table_v2)],
    )
    .unwrap();
    let mut edit_table = mutation(
        &owner,
        EditNote {
            note: v2_rev.note.clone(),
            plan,
        },
    );
    edit_table.preconditions.revision = Some(v2_rev.revision);
    store.edit_note(owner.clone(), edit_table).await.unwrap();
    sync(store, runtime, &scope).await;

    let prep_ret = store
        .prepare_agent_run_rollback(owner.clone(), run_ret)
        .await
        .expect("prepare rollback must succeed when human converted board block to table");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_ret))
        .await
        .expect("rollback must succeed when human converted board block to table");
    sync(store, runtime, &scope).await;

    // Case 3A: Agent widens a board filter to include an untouched card `X` ahead of `A`,
    // then moves `A`. Rollback restores the narrower filter without failing InvalidState
    // on `before_placement` citing `X`.
    let proj3 = folder(store, &owner, None, "rb-widen-proj", true)
        .await
        .unwrap();
    let narrow_body = "group_by: status\nfilter: {eq: {key: team, value: alpha}}\n";
    let (v3, v3_rev) = create_view(
        store,
        &owner,
        &proj3,
        "rb-widen-board",
        "board",
        "{scope: project}",
        narrow_body,
    )
    .await;
    let card_x = create_note(
        store,
        &owner,
        Some(proj3.clone()),
        "a-untouched-beta",
        "---\nteam: beta\nstatus: todo\n---\n".into(),
    )
    .await;
    let card_a = create_note(
        store,
        &owner,
        Some(proj3.clone()),
        "z-alpha-card",
        "---\nteam: alpha\nstatus: todo\n---\n".into(),
    )
    .await;
    let _ = card_x;
    sync(store, runtime, &scope).await;

    let run_widen = AgentRunId::from_bytes(random_bytes());
    let agent_widen = super::agent(&owner, run_widen.clone(), ChatAudience::Personal);
    let old_v3 = view_carrier(&v3.key, "board", "{scope: project}", narrow_body);
    let wide_v3 = view_carrier(
        &v3.key,
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    );
    let span = notarium_syntax::frontmatter::analyze(&old_v3, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &old_v3,
        span,
        vec![(CarrierEditOrigin::Body, span, wide_v3)],
    )
    .unwrap();
    let mut edit_wide = mutation(
        &agent_widen,
        EditNote {
            note: v3_rev.note.clone(),
            plan,
        },
    );
    edit_wide.preconditions.revision = Some(v3_rev.revision);
    let v3_wide_rev = store
        .edit_note(agent_widen.clone(), edit_wide)
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    store
        .move_board_card(
            agent_widen.clone(),
            mutation(
                &agent_widen,
                MoveBoardCard {
                    view: v3.clone(),
                    note: card_a.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: card_a.revision.clone(),
                    expected_view: v3_wide_rev.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let prep_widen = store
        .prepare_agent_run_rollback(owner.clone(), run_widen)
        .await
        .expect("prepare rollback must succeed after run widened board filter");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_widen))
        .await
        .expect("rollback must succeed after run widened board filter");
    sync(store, runtime, &scope).await;
    let v3_rows = query(&engine, owner.clone(), v3).await.unwrap();
    let v3_ids: Vec<NoteId> = v3_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(v3_ids, vec![card_a.note]);

    // Case 3B: Agent changes `group_by` from `status` to `priority` and moves `gb_a` twice
    // (`p1 -> p2` adjacent to untouched `gb_u`, then `p2 -> p3`) so the non-earliest move's
    // `before_placement` references non-eligible `gb_u` in temporary group `"p2"`.
    // Rollback must tolerate missing non-eligible neighbors on `view_restored` views,
    // restore `group_by: status` + `priority: p1`, and clear temporary overlays.
    let proj3b = folder(store, &owner, None, "rb-groupby-proj", true)
        .await
        .unwrap();
    let status_body = "group_by: status\nfilter: {exists: status}\n";
    let (v3b, v3b_rev) = create_view(
        store,
        &owner,
        &proj3b,
        "rb-groupby-board",
        "board",
        "{scope: project}",
        status_body,
    )
    .await;
    let gb_a = create_note(
        store,
        &owner,
        Some(proj3b.clone()),
        "gb-card-a",
        "---\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let gb_u = create_note(
        store,
        &owner,
        Some(proj3b.clone()),
        "gb-card-u",
        "---\nstatus: todo\npriority: p2\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_gb = AgentRunId::from_bytes(random_bytes());
    let agent_gb = super::agent(&owner, run_gb.clone(), ChatAudience::Personal);
    let old_v3b = view_carrier(&v3b.key, "board", "{scope: project}", status_body);
    let prio_v3b = view_carrier(
        &v3b.key,
        "board",
        "{scope: project}",
        "group_by: priority\nfilter: {exists: status}\n",
    );
    let span = notarium_syntax::frontmatter::analyze(&old_v3b, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan = notarium_syntax::patch::plan(
        &old_v3b,
        span,
        vec![(CarrierEditOrigin::Body, span, prio_v3b)],
    )
    .unwrap();
    let mut edit_gb = mutation(
        &agent_gb,
        EditNote {
            note: v3b_rev.note.clone(),
            plan,
        },
    );
    edit_gb.preconditions.revision = Some(v3b_rev.revision);
    let v3b_prio_rev = store
        .edit_note(agent_gb.clone(), edit_gb)
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    let gb_a_mv1 = store
        .move_board_card(
            agent_gb.clone(),
            mutation(
                &agent_gb,
                MoveBoardCard {
                    view: v3b.clone(),
                    note: gb_a.note.clone(),
                    group: group("p2"),
                    before: Some(RankNeighbor {
                        note: gb_u.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::from([(
                        "priority".into(),
                        Some(YamlValue::String("p2".into())),
                    )]),
                    expected_note: gb_a.revision.clone(),
                    expected_view: v3b_prio_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    store
        .move_board_card(
            agent_gb.clone(),
            mutation(
                &agent_gb,
                MoveBoardCard {
                    view: v3b.clone(),
                    note: gb_a.note.clone(),
                    group: group("p3"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "priority".into(),
                        Some(YamlValue::String("p3".into())),
                    )]),
                    expected_note: gb_a_mv1.revision.revision,
                    expected_view: v3b_prio_rev.revision,
                    expected_rank: RankExpectation::Existing(gb_a_mv1.rank_revision),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let prep_gb = store
        .prepare_agent_run_rollback(owner.clone(), run_gb)
        .await
        .expect("prepare rollback must succeed after run changed group_by and moved cards");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_gb))
        .await
        .expect("rollback must succeed after run changed group_by and moved cards");
    sync(store, runtime, &scope).await;
    let gb_a_after = store
        .get_note(
            owner.clone(),
            GetNote {
                note: gb_a.note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert!(
        gb_a_after
            .document
            .explicit_read(owner.auth())
            .unwrap()
            .contains("priority: p1"),
        "rollback must restore gb_a priority back to p1"
    );
    let v3b_rows = query(&engine, owner.clone(), v3b.clone()).await.unwrap();
    let v3b_ids: BTreeSet<NoteId> = v3b_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(v3b_ids, BTreeSet::from([gb_a.note, gb_u.note]));
    let v3b_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &v3b)
        .await
        .unwrap();
    assert!(
        v3b_overlays.is_empty(),
        "rollback must clear temporary priority-column overlays on v3b, found {v3b_overlays:?}"
    );

    // Case 4: Unranked board sorted by `title ASC`. Agent moves `Alpha` out of `todo`
    // and edits `Beta` out of `todo` via `edit_note`. Rollback must restore `[Alpha, Beta, Gamma]`
    // in exact view sort order (never `[Gamma, Alpha, Beta]`).
    let proj4 = folder(store, &owner, None, "rb-unranked-sort-proj", true)
        .await
        .unwrap();
    let sort_body = "group_by: status\nfilter: {exists: status}\nsort: [{field: title, type: string, direction: asc}]\n";
    let (v4, v4_rev) = create_view(
        store,
        &owner,
        &proj4,
        "rb-sorted-board",
        "board",
        "{scope: project}",
        sort_body,
    )
    .await;
    // Choose NoteIds so NoteId order (`c_gamma < c_alpha < c_beta`) disagrees with `title ASC`.
    let mk_sorted = |bytes: [u8; 16], slug: &str, title: &str| {
        let owner = owner.clone();
        let proj4 = proj4.clone();
        let slug = slug.to_owned();
        let carrier = format!("---\nstatus: todo\ntitle: {title}\n---\n");
        async move {
            store
                .create_note(
                    owner.clone(),
                    mutation(
                        &owner,
                        CreateNote {
                            folder_page: false,
                            note: NoteId::from_bytes(bytes),
                            parent: Some(proj4),
                            slug,
                            class: DocClass::UserDoc,
                            carrier,
                        },
                    ),
                )
                .await
                .unwrap()
                .value
        }
    };
    let s_gamma = mk_sorted([0x10; 16], "s-gamma", "Gamma").await;
    let s_alpha = mk_sorted([0x20; 16], "s-alpha", "Alpha").await;
    let s_beta = mk_sorted([0x30; 16], "s-beta", "Beta").await;
    sync(store, runtime, &scope).await;

    let run_sort = AgentRunId::from_bytes(random_bytes());
    let agent_sort = super::agent(&owner, run_sort.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_sort.clone(),
            mutation(
                &agent_sort,
                MoveBoardCard {
                    view: v4.clone(),
                    note: s_alpha.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: s_alpha.revision.clone(),
                    expected_view: v4_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let old_beta = "---\nstatus: todo\ntitle: Beta\n---\n";
    let new_beta = "---\nstatus: doing\ntitle: Beta\n---\n";
    let analyzed = notarium_syntax::frontmatter::analyze(old_beta, DocClass::UserDoc).unwrap();
    let header_span = analyzed.carrier.header.unwrap();
    let plan = notarium_syntax::patch::plan(
        old_beta,
        analyzed.carrier.body,
        vec![(CarrierEditOrigin::Header, header_span, new_beta.into())],
    )
    .unwrap();
    let mut edit_beta = mutation(
        &agent_sort,
        EditNote {
            note: s_beta.note.clone(),
            plan,
        },
    );
    edit_beta.preconditions.revision = Some(s_beta.revision);
    store.edit_note(agent_sort, edit_beta).await.unwrap();
    sync(store, runtime, &scope).await;

    let prep_sort = store
        .prepare_agent_run_rollback(owner.clone(), run_sort)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_sort))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let v4_rows = query(&engine, owner.clone(), v4).await.unwrap();
    let v4_ids: Vec<NoteId> = v4_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        v4_ids,
        vec![s_alpha.note, s_beta.note, s_gamma.note],
        "unranked returning notes must be ordered by view sort descriptor (Alpha, Beta, Gamma)"
    );

    // Case 5: Human trashes board view `V` after agent moved `First` AFTER `Second`
    // (newly materializing a neighbor overlay on `Second` with `placement_run_id = None`),
    // rolls back the run, then restores `V` from trash. Both the moved-target overlay AND
    // the run-materialized neighbor overlay must be deleted so restoring `V` renders `[First, Second]`.
    let proj5 = folder(store, &owner, None, "rb-human-trash-view-proj", true)
        .await
        .unwrap();
    let (v5, v5_rev) = create_view(
        store,
        &owner,
        &proj5,
        "rb-human-trashed-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\nsort: [{field: title, type: string, direction: asc}]\n",
    )
    .await;
    let t_a = create_note(
        store,
        &owner,
        Some(proj5.clone()),
        "t-a",
        "---\nstatus: todo\ntitle: First\n---\n".into(),
    )
    .await;
    let t_b = create_note(
        store,
        &owner,
        Some(proj5),
        "t-b",
        "---\nstatus: todo\ntitle: Second\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_ht = AgentRunId::from_bytes(random_bytes());
    let agent_ht = super::agent(&owner, run_ht.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_ht.clone(),
            mutation(
                &agent_ht,
                MoveBoardCard {
                    view: v5.clone(),
                    note: t_a.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: t_b.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    fields: BTreeMap::new(),
                    expected_note: t_a.revision.clone(),
                    expected_view: v5_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                DeleteNote {
                    note: v5_rev.note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let prep_ht = store
        .prepare_agent_run_rollback(owner.clone(), run_ht)
        .await
        .expect("prepare rollback must succeed on human-trashed board view");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_ht))
        .await
        .expect("rollback must succeed on human-trashed board view");
    let v5_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &v5)
        .await
        .unwrap();
    assert!(
        v5_overlays.is_empty(),
        "rollback of human-trashed view must delete both run-owned and run-materialized neighbor overlays, found {v5_overlays:?}"
    );
    store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                DeleteNote {
                    note: v5_rev.note.clone(),
                    disposition: DeleteDisposition::Restore,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let v5_rows = query(&engine, owner.clone(), v5).await.unwrap();
    let v5_ids: Vec<NoteId> = v5_rows
        .rows
        .items
        .iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        v5_ids,
        vec![t_a.note, t_b.note],
        "restoring human-trashed board view after rollback must not resurrect run-materialized ordering"
    );

    // Case 6: SourceFolder::Id trashed -> retired on rollback; static class authorization and
    // cross-project folder-existence anti-oracle MUST still fail closed before retiring.
    let proj6a = folder(store, &owner, None, "rb-srcid-proj-a", true)
        .await
        .unwrap();
    let proj6b = folder(store, &owner, None, "rb-srcid-proj-b", true)
        .await
        .unwrap();
    let src_id_sub = folder(store, &owner, Some(proj6a.clone()), "src-id-sub", false)
        .await
        .unwrap();
    let v6_init_body = "group_by: status\nfilter: {exists: status}\n";
    let (v6_id, v6_id_rev) = create_view(
        store,
        &owner,
        &proj6a,
        "rb-source-id-board",
        "board",
        "{scope: project}",
        v6_init_body,
    )
    .await;
    let c6 = create_note(
        store,
        &owner,
        Some(proj6a.clone()),
        "rb-srcid-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_srcid = AgentRunId::from_bytes(random_bytes());
    let agent_srcid = super::agent(&owner, run_srcid.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_srcid.clone(),
            mutation(
                &agent_srcid,
                MoveBoardCard {
                    view: v6_id.clone(),
                    note: c6.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c6.revision.clone(),
                    expected_view: v6_id_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let old_v6 = view_carrier(&v6_id.key, "board", "{scope: project}", v6_init_body);
    let new_v6 = view_carrier(
        &v6_id.key,
        "board",
        &format!("{{scope: folder, folder: \"{src_id_sub}\"}}"),
        v6_init_body,
    );
    let span = notarium_syntax::frontmatter::analyze(&old_v6, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let plan =
        notarium_syntax::patch::plan(&old_v6, span, vec![(CarrierEditOrigin::Body, span, new_v6)])
            .unwrap();
    let mut edit_v6 = mutation(
        &owner,
        EditNote {
            note: v6_id_rev.note.clone(),
            plan,
        },
    );
    edit_v6.preconditions.revision = Some(v6_id_rev.revision);
    store.edit_note(owner.clone(), edit_v6).await.unwrap();
    let space_epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let sub_rev = store
        .resolve_folder_path(owner.clone(), Some(src_id_sub.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    store
        .set_folder_lifecycle(
            &scope,
            space_epoch,
            &src_id_sub,
            &sub_rev,
            notarium_core::model::Lifecycle::Trashed,
            owner.auth().principal(),
            None,
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let prep_srcid = store
        .prepare_agent_run_rollback(owner.clone(), run_srcid)
        .await
        .expect("prepare rollback must succeed when SourceFolder::Id is trashed");
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_srcid))
        .await
        .expect("rollback must retire board view whose SourceFolder::Id is trashed");
    let v6_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &v6_id)
        .await
        .unwrap();
    assert!(
        v6_overlays.is_empty(),
        "retiring trashed SourceFolder::Id board must clear run overlay"
    );

    // Anti-oracle & static class auth (differential: fails for constrained actor, succeeds for owner):
    // Both boards and cards stay active inside `proj6a` (`UserDoc`); only the board's declared
    // source is edited by the owner after the run to point to a missing folder with either an
    // unauthorized class (`profile`) or a path outside `proj6a` (`rb-srcid-proj-b/missing-secret`).
    let _ = proj6b;
    let init_body = "group_by: status\nfilter: {exists: status}\n";
    let (v6_cls, v6_cls_rev) = create_view(
        store,
        &owner,
        &proj6a,
        "rb-missing-class-board",
        "board",
        "{scope: project}",
        init_body,
    )
    .await;
    let c6_cls = create_note(
        store,
        &owner,
        Some(proj6a.clone()),
        "rb-cls-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let (v6_xproj, v6_xproj_rev) = create_view(
        store,
        &owner,
        &proj6a,
        "rb-cross-project-missing-board",
        "board",
        "{scope: project}",
        init_body,
    )
    .await;
    let c6_xproj = create_note(
        store,
        &owner,
        Some(proj6a.clone()),
        "rb-xproj-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run_cls = AgentRunId::from_bytes(random_bytes());
    let agent_cls = super::agent(&owner, run_cls.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_cls.clone(),
            mutation(
                &agent_cls,
                MoveBoardCard {
                    view: v6_cls.clone(),
                    note: c6_cls.note,
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c6_cls.revision,
                    expected_view: v6_cls_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();

    let run_xproj = AgentRunId::from_bytes(random_bytes());
    let agent_xproj = super::agent(&owner, run_xproj.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent_xproj.clone(),
            mutation(
                &agent_xproj,
                MoveBoardCard {
                    view: v6_xproj.clone(),
                    note: c6_xproj.note,
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c6_xproj.revision,
                    expected_view: v6_xproj_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();

    for (view_ref, view_rev, new_source) in [
        (
            &v6_cls,
            &v6_cls_rev,
            "{scope: folder, folder: \"rb-srcid-proj-a/no-such-folder\", classes: [user-doc, profile]}",
        ),
        (
            &v6_xproj,
            &v6_xproj_rev,
            "{scope: folder, folder: \"rb-srcid-proj-b/missing-secret\"}",
        ),
    ] {
        let old_text = view_carrier(&view_ref.key, "board", "{scope: project}", init_body);
        let new_text = view_carrier(&view_ref.key, "board", new_source, init_body);
        let span = notarium_syntax::frontmatter::analyze(&old_text, DocClass::UserDoc)
            .unwrap()
            .carrier
            .body;
        let plan = notarium_syntax::patch::plan(
            &old_text,
            span,
            vec![(CarrierEditOrigin::Body, span, new_text)],
        )
        .unwrap();
        let mut edit = mutation(
            &owner,
            EditNote {
                note: view_rev.note.clone(),
                plan,
            },
        );
        edit.preconditions.revision = Some(view_rev.revision.clone());
        store.edit_note(owner.clone(), edit).await.unwrap();
    }
    sync(store, runtime, &scope).await;

    let no_profile = SpaceContext::new(
        owner
            .auth()
            .restrict_read_classes(&scope.space_id, &BTreeSet::from([DocClass::UserDoc]))
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let prep_cls = store
        .prepare_agent_run_rollback(owner.clone(), run_cls.clone())
        .await
        .unwrap();
    let cls_err = store
        .rollback_agent_run(no_profile.clone(), mutation(&no_profile, prep_cls))
        .await;
    assert!(
        matches!(
            cls_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "missing folder must NOT bypass unauthorized class check into Retired, got {cls_err:?}"
    );
    // Differential positive check: owner with full read classes retires the missing-folder view cleanly.
    let prep_cls_ok = store
        .prepare_agent_run_rollback(owner.clone(), run_cls)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_cls_ok))
        .await
        .expect("authorized owner must cleanly retire missing-folder view on rollback");

    let pinned_6a = SpaceContext::new(
        owner
            .auth()
            .restrict_to_project(&notarium_core::model::FolderRef {
                space_id: scope.space_id.clone(),
                folder_id: proj6a,
            })
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let prep_xproj = store
        .prepare_agent_run_rollback(owner.clone(), run_xproj.clone())
        .await
        .unwrap();
    let xproj_err = store
        .rollback_agent_run(pinned_6a.clone(), mutation(&pinned_6a, prep_xproj))
        .await;
    assert!(
        matches!(
            xproj_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "missing folder outside project_root must fail closed ResourceNotFound (no cross-project oracle), got {xproj_err:?}"
    );
    let prep_xproj_ok = store
        .prepare_agent_run_rollback(owner.clone(), run_xproj)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep_xproj_ok))
        .await
        .expect("unpinned owner must cleanly retire missing-folder cross-project view on rollback");
}

#[inline(never)]
async fn rollback_skipped_replay_and_oracle_views(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::ports::RankNeighbor;

    let (scope, owner) = open_space(store).await;
    let engine = runtime.engine();

    // Case 7A: Active board view whose agent-moved target is skipped (`skipped_manual_edits`)
    // must NOT be misclassified into `inactive_or_retired_views` and must preserve the
    // untouched neighbor's overlay and live board ordering `[c7, n7, h7]`.
    let proj7a = folder(store, &owner, None, "rb-skip-active-proj-a", true)
        .await
        .unwrap();
    let proj7b = folder(store, &owner, None, "rb-skip-active-proj-b", true)
        .await
        .unwrap();
    let (v7a, v7a_rev) = create_view(
        store,
        &owner,
        &proj7a,
        "rb-skip-active-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\nsort: [{field: title, type: string, direction: asc}]\n",
    )
    .await;
    let c7 = create_note(
        store,
        &owner,
        Some(proj7a.clone()),
        "z-agent-card",
        "---\ntitle: Zebra\nstatus: todo\n---\n".into(),
    )
    .await;
    let n7 = create_note(
        store,
        &owner,
        Some(proj7a.clone()),
        "a-neighbor-card",
        "---\ntitle: Alpha\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let run7a = AgentRunId::from_bytes(random_bytes());
    let agent7a = super::agent(&owner, run7a.clone(), ChatAudience::Personal);
    let c7_moved = store
        .move_board_card(
            agent7a.clone(),
            mutation(
                &agent7a,
                MoveBoardCard {
                    view: v7a.clone(),
                    note: c7.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: n7.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: c7.revision.clone(),
                    expected_view: v7a_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let n7_ov_before = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7a)
        .await
        .unwrap()
        .get(&n7.note)
        .expect("agent move before unranked n7 must materialize n7 overlay")
        .clone();
    // Human creates h7, edits c7 (making c7 skipped during rollback), and drags h7 after n7 -> [c7, n7, h7].
    let h7 = create_note(
        store,
        &owner,
        Some(proj7a.clone()),
        "m-human-card",
        "---\ntitle: Middle\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let c7_text = "---\ntitle: Zebra\nstatus: todo\n---\n";
    let c7_span = notarium_syntax::frontmatter::analyze(c7_text, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let c7_plan = notarium_syntax::patch::plan(
        c7_text,
        c7_span,
        vec![(CarrierEditOrigin::Body, c7_span, "Human edit.\n".into())],
    )
    .unwrap();
    let mut edit_c7 = mutation(
        &owner,
        EditNote {
            note: c7.note.clone(),
            plan: c7_plan,
        },
    );
    edit_c7.preconditions.revision = Some(c7_moved.revision.revision);
    store.edit_note(owner.clone(), edit_c7).await.unwrap();
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7a.clone(),
                    note: h7.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: n7.note.clone(),
                        expected_rank: RankExpectation::Existing(n7_ov_before.rank_rev_id),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: h7.revision.clone(),
                    expected_view: v7a_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7a = store
        .prepare_agent_run_rollback(owner.clone(), run7a)
        .await
        .unwrap();
    let rb7a = store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7a))
        .await
        .unwrap()
        .value;
    assert_eq!(rb7a.skipped_manual_edits, vec![c7.note.clone()]);
    sync(store, runtime, &scope).await;
    let v7a_overlays = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7a)
        .await
        .unwrap();
    assert!(
        v7a_overlays.contains_key(&n7.note),
        "skipped active view rollback must NOT delete untouched neighbor n7 overlay"
    );
    let v7a_ids: Vec<NoteId> = query(&engine, owner.clone(), v7a)
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        v7a_ids,
        vec![c7.note, n7.note, h7.note],
        "live active board order [c7, n7, h7] must stay intact when agent card is skipped"
    );

    // Case 7B: Idempotent replay of committed rollbacks: (1) succeeds when the rollback itself
    // trashed a run-created board view (`rollback_agent_run`), and (2) `rollback_agent_run_by_id`
    // enforces live active-folder visibility while the folder is trashed and replays once restored.
    let c7b = create_note(
        store,
        &owner,
        Some(proj7a.clone()),
        "rb-replay-card",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let run7b = AgentRunId::from_bytes(random_bytes());
    let agent7b = super::agent(&owner, run7b.clone(), ChatAudience::Personal);
    let (v7b, v7b_rev) = create_view(
        store,
        &agent7b,
        &proj7a,
        "rb-agent-created-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    sync(store, runtime, &scope).await;
    store
        .move_board_card(
            agent7b.clone(),
            mutation(
                &agent7b,
                MoveBoardCard {
                    view: v7b,
                    note: c7b.note,
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: c7b.revision,
                    expected_view: v7b_rev.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7b = store
        .prepare_agent_run_rollback(owner.clone(), run7b)
        .await
        .unwrap();
    let rb7b_cmd = mutation(&owner, prep7b);
    let rb7b_first = store
        .rollback_agent_run(owner.clone(), rb7b_cmd.clone())
        .await
        .expect("initial rollback of run-created board view must succeed");
    let rb7b_replay = store
        .rollback_agent_run(owner.clone(), rb7b_cmd)
        .await
        .expect("idempotent replay of committed rollback with trashed view must succeed");
    assert_eq!(rb7b_replay.receipt, rb7b_first.receipt);

    let sub7b = folder(store, &owner, Some(proj7a.clone()), "rb-trashed-sub", false)
        .await
        .unwrap();
    let n7_sub = create_note(
        store,
        &owner,
        Some(sub7b.clone()),
        "rb-trashed-sub-note",
        "Original.\n".into(),
    )
    .await;
    let run7b_sub = AgentRunId::from_bytes(random_bytes());
    let agent7b_sub = super::agent(&owner, run7b_sub.clone(), ChatAudience::Personal);
    let sub_span = notarium_syntax::frontmatter::analyze("Original.\n", DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let sub_plan = notarium_syntax::patch::plan(
        "Original.\n",
        sub_span,
        vec![(CarrierEditOrigin::Body, sub_span, "Agent edit.\n".into())],
    )
    .unwrap();
    let mut edit_sub = mutation(
        &agent7b_sub,
        EditNote {
            note: n7_sub.note,
            plan: sub_plan,
        },
    );
    edit_sub.preconditions.revision = Some(n7_sub.revision);
    store.edit_note(agent7b_sub, edit_sub).await.unwrap();
    let sub7b_rev = store
        .resolve_folder_path(owner.clone(), Some(sub7b.clone()), String::new())
        .await
        .unwrap()
        .unwrap()
        .revision;
    let space_epoch = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    let by_id_cmd = mutation(&owner, run7b_sub);
    let by_id_first = store
        .rollback_agent_run_by_id(owner.clone(), by_id_cmd.clone())
        .await
        .expect("rollback_agent_run_by_id while folder is active must succeed");
    let (trashed_sub_rev, _) = store
        .set_folder_lifecycle(
            &scope,
            space_epoch,
            &sub7b,
            &sub7b_rev,
            notarium_core::model::Lifecycle::Trashed,
            owner.auth().principal(),
            None,
        )
        .await
        .unwrap();
    assert!(
        matches!(
            store
                .rollback_agent_run_by_id(owner.clone(), by_id_cmd.clone())
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "rollback_agent_run_by_id replay enforces live active-folder visibility while folder is trashed"
    );
    store
        .set_folder_lifecycle(
            &scope,
            space_epoch,
            &sub7b,
            &trashed_sub_rev,
            notarium_core::model::Lifecycle::Active,
            owner.auth().principal(),
            None,
        )
        .await
        .unwrap();
    let by_id_replay = store
        .rollback_agent_run_by_id(owner.clone(), by_id_cmd)
        .await
        .expect("rollback_agent_run_by_id replay must succeed once folder is active again");
    assert_eq!(by_id_replay.receipt, by_id_first.receipt);

    // Case 7C: Anti-oracle authorization ordering in `rollback_agent_run`:
    // (1) Arbitrary `associated_board_expectations` citing an out-of-project note vs a
    //     nonexistent note both return `SourceMismatch` (never probing victim note existence).
    // (2) Probing an unauthorized run in `proj7b` with `expected_entities: []` vs the exact
    //     touched note both return `SpaceReadOnly` (never leaking the touched set).
    let n7_p1 = create_note(
        store,
        &owner,
        Some(proj7a.clone()),
        "rb-oracle-p1",
        "p1\n".into(),
    )
    .await;
    let n7_p2 = create_note(
        store,
        &owner,
        Some(proj7b.clone()),
        "rb-oracle-p2",
        "p2\n".into(),
    )
    .await;
    let run7c_p1 = AgentRunId::from_bytes(random_bytes());
    let agent7c_p1 = super::agent(&owner, run7c_p1.clone(), ChatAudience::Personal);
    let p1_span = notarium_syntax::frontmatter::analyze("p1\n", DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let mut edit_p1 = mutation(
        &agent7c_p1,
        EditNote {
            note: n7_p1.note.clone(),
            plan: notarium_syntax::patch::plan(
                "p1\n",
                p1_span,
                vec![(CarrierEditOrigin::Body, p1_span, "p1-a\n".into())],
            )
            .unwrap(),
        },
    );
    edit_p1.preconditions.revision = Some(n7_p1.revision);
    let n7_p1_after = store.edit_note(agent7c_p1, edit_p1).await.unwrap().value;

    let run7c_p2 = AgentRunId::from_bytes(random_bytes());
    let agent7c_p2 = super::agent(&owner, run7c_p2.clone(), ChatAudience::Personal);
    let p2_span = notarium_syntax::frontmatter::analyze("p2\n", DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let mut edit_p2 = mutation(
        &agent7c_p2,
        EditNote {
            note: n7_p2.note.clone(),
            plan: notarium_syntax::patch::plan(
                "p2\n",
                p2_span,
                vec![(CarrierEditOrigin::Body, p2_span, "p2-a\n".into())],
            )
            .unwrap(),
        },
    );
    edit_p2.preconditions.revision = Some(n7_p2.revision);
    let n7_p2_after = store.edit_note(agent7c_p2, edit_p2).await.unwrap().value;

    let pinned_7a = SpaceContext::new(
        owner
            .auth()
            .restrict_to_project(&notarium_core::model::FolderRef {
                space_id: scope.space_id.clone(),
                folder_id: proj7a,
            })
            .unwrap(),
        scope.clone(),
        budget(),
    )
    .unwrap();
    let prep7c_p1 = store
        .prepare_agent_run_rollback(pinned_7a.clone(), run7c_p1)
        .await
        .unwrap();
    let fake_view_note = NoteId::from_bytes(random_bytes());
    for probe_view in [n7_p2.note.clone(), fake_view_note] {
        let mut forged = prep7c_p1.clone();
        forged.associated_board_expectations.push(
            notarium_core::ports::AssociatedBoardExpectation {
                view: ViewRef {
                    note: probe_view,
                    key: ViewKey::from_bytes(random_bytes()),
                },
                note: n7_p1.note.clone(),
                expected_rank: RankExpectation::Absent,
                expected_placement_revision: n7_p1_after.revision.clone(),
            },
        );
        let probe_err = store
            .rollback_agent_run(pinned_7a.clone(), mutation(&pinned_7a, forged))
            .await;
        assert!(
            matches!(
                probe_err,
                Err(PortError::Domain(DomainError::ValidationFailed { ref diagnostic }))
                    if diagnostic.reason == ValidationReason::SourceMismatch
            ),
            "arbitrary associated_board_expectations view must return SourceMismatch without probing existence, got {probe_err:?}"
        );
    }
    let prep7c_p2 = store
        .prepare_agent_run_rollback(owner.clone(), run7c_p2)
        .await
        .unwrap();
    for probe_entities in [
        Vec::new(),
        vec![NoteRevision {
            note: n7_p2.note,
            revision: n7_p2_after.revision,
        }],
    ] {
        let mut forged = prep7c_p2.clone();
        forged.expected_entities = probe_entities;
        let probe_err = store
            .rollback_agent_run(pinned_7a.clone(), mutation(&pinned_7a, forged))
            .await;
        assert!(
            matches!(
                probe_err,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ),
            "unauthorized P2 run rollback must hide out-of-project touched_set as ResourceNotFound before checking expected_entities, got {probe_err:?}"
        );
    }
    // Case 7D: Stale-group neighbor overlay materialization & rollback restoration/cleanup.
    // Pre-run: human ranks `u_human` before `u_other` in `status=todo`, prior agent run `prior_run`
    // ranks `u_prior_run` after `u_human` in `status=todo` (`placement_run_id == Some(prior_run)`),
    // and `u_plain` is unranked in `status=doing`. Agent run `run7d` changes `group_by` to
    // `priority` and moves `m_agent` before `u_human` in `priority=p1`, replacing both `u_human`'s
    // and `u_prior_run`'s stale `todo` overlays (non-NULL `parent_rev_id`, clearing `placement_run_id`
    // to `None` and minting fresh `placement_revision`) and materializing `u_plain` in `p1`.
    // Rolling back `run7d` must restore `u_human`'s pre-run human overlay, restore `u_prior_run`'s
    // `placement_run_id == Some(prior_run)`, reconcile `m_agent` back to `todo`, and delete
    // `u_plain`'s orphaned `p1` overlay.
    let proj7d = folder(store, &owner, None, "rb-stale-nbr-proj", true)
        .await
        .unwrap();
    let (v7d, v7d_rev) = create_view(
        store,
        &owner,
        &proj7d,
        "rb-stale-nbr-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let u_human = create_note(
        store,
        &owner,
        Some(proj7d.clone()),
        "z-human-ranked",
        "---\ntitle: Z-Human\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_prior_run = create_note(
        store,
        &owner,
        Some(proj7d.clone()),
        "p-prior-run-ranked",
        "---\ntitle: P-PriorRun\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_other = create_note(
        store,
        &owner,
        Some(proj7d.clone()),
        "a-other-todo",
        "---\ntitle: A-Other\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_plain = create_note(
        store,
        &owner,
        Some(proj7d.clone()),
        "b-plain-doing",
        "---\ntitle: B-Plain\nstatus: doing\npriority: p1\n---\n".into(),
    )
    .await;
    let m_agent = create_note(
        store,
        &owner,
        Some(proj7d.clone()),
        "m-agent-card",
        "---\ntitle: M-Agent\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    // Human ranks `u_human` before `u_other` in `status=todo` (creating pre-run human overlays).
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7d.clone(),
                    note: u_human.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: u_other.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: u_human.revision.clone(),
                    expected_view: v7d_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let after_human_7d = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7d)
        .await
        .unwrap();
    let prior_run = AgentRunId::from_bytes(random_bytes());
    let prior_agent = super::agent(&owner, prior_run.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            prior_agent.clone(),
            mutation(
                &prior_agent,
                MoveBoardCard {
                    view: v7d.clone(),
                    note: u_prior_run.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: u_other.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            after_human_7d[&u_other.note].rank_rev_id.clone(),
                        ),
                    }),
                    after: Some(RankNeighbor {
                        note: u_human.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            after_human_7d[&u_human.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: u_prior_run.revision.clone(),
                    expected_view: v7d_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        after_human_7d[&u_prior_run.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let pre_overlays_7d = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7d)
        .await
        .unwrap();
    let u_human_pre_ov = pre_overlays_7d
        .get(&u_human.note)
        .expect("human move must create pre-run overlay for u_human")
        .clone();
    let u_prior_run_pre_ov = pre_overlays_7d
        .get(&u_prior_run.note)
        .expect("prior_run move must create pre-run overlay for u_prior_run")
        .clone();
    assert_eq!(
        u_prior_run_pre_ov.placement_run_id.as_ref(),
        Some(&prior_run),
        "positive control: u_prior_run must carry Some(prior_run) before run7d"
    );
    let m_agent_pre_ov = pre_overlays_7d
        .get(&m_agent.note)
        .expect("human move in todo must materialize m_agent neighbor overlay")
        .clone();
    assert!(!pre_overlays_7d.contains_key(&u_plain.note));

    // Agent run changes `group_by: status` -> `group_by: priority`, then moves `m_agent` in `p1`.
    let run7d = AgentRunId::from_bytes(random_bytes());
    let agent7d = super::agent(&owner, run7d.clone(), ChatAudience::Personal);
    let v7d_text = view_carrier(
        &v7d.key,
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    );
    let v7d_edited_text = view_carrier(
        &v7d.key,
        "board",
        "{scope: project}",
        "group_by: priority\nfilter: {exists: status}\n",
    );
    let v7d_span = notarium_syntax::frontmatter::analyze(&v7d_text, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let v7d_plan = notarium_syntax::patch::plan(
        &v7d_text,
        v7d_span,
        vec![(CarrierEditOrigin::Body, v7d_span, v7d_edited_text)],
    )
    .unwrap();
    let mut edit_v7d = mutation(
        &agent7d,
        EditNote {
            note: v7d.note.clone(),
            plan: v7d_plan,
        },
    );
    edit_v7d.preconditions.revision = Some(v7d_rev.revision.clone());
    let v7d_after_agent = store
        .edit_note(agent7d.clone(), edit_v7d)
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    store
        .move_board_card(
            agent7d.clone(),
            mutation(
                &agent7d,
                MoveBoardCard {
                    view: v7d.clone(),
                    note: m_agent.note.clone(),
                    group: group("p1"),
                    before: Some(RankNeighbor {
                        note: u_human.note.clone(),
                        expected_rank: RankExpectation::Existing(u_human_pre_ov.rank_rev_id),
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: m_agent.revision.clone(),
                    expected_view: v7d_after_agent.revision,
                    expected_rank: RankExpectation::Existing(m_agent_pre_ov.rank_rev_id),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let mid_overlays_7d = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7d)
        .await
        .unwrap();
    assert_eq!(
        mid_overlays_7d.get(&u_human.note).map(|o| &o.group),
        Some(&group("p1"))
    );
    assert_ne!(
        mid_overlays_7d[&u_human.note].placement_revision, u_human_pre_ov.placement_revision,
        "replacing stale-group overlay must mint fresh placement_revision for u_human"
    );
    assert_eq!(
        mid_overlays_7d.get(&u_prior_run.note).map(|o| &o.group),
        Some(&group("p1"))
    );
    assert_ne!(
        mid_overlays_7d[&u_prior_run.note].placement_revision,
        u_prior_run_pre_ov.placement_revision,
        "replacing stale-group overlay must mint fresh placement_revision for u_prior_run"
    );
    assert!(
        mid_overlays_7d[&u_prior_run.note]
            .placement_run_id
            .is_none(),
        "neighbor materialization replacing prior_run's stale-group overlay must clear placement_run_id"
    );
    assert_eq!(
        mid_overlays_7d.get(&u_plain.note).map(|o| &o.group),
        Some(&group("p1"))
    );

    // Roll back `run7d`: `v7d` returns to `group_by: status`, `u_human` restores pre-run `todo`
    // human overlay, `u_prior_run` restores `Some(prior_run)`, `m_agent` reconciles back to
    // `todo`, and `u_plain`'s orphaned `p1` overlay is deleted.
    let prep7d = store
        .prepare_agent_run_rollback(owner.clone(), run7d)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7d))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let post_overlays_7d = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7d)
        .await
        .unwrap();
    let u_human_post_ov = post_overlays_7d
        .get(&u_human.note)
        .expect("u_human must retain restored pre-run todo overlay after rollback");
    assert_eq!(u_human_post_ov.group, group("todo"));
    assert_eq!(
        u_human_post_ov.placement_revision, u_human_pre_ov.placement_revision,
        "u_human must restore its original pre-run human placement_revision"
    );
    assert!(u_human_post_ov.placement_run_id.is_none());
    let u_prior_run_post_ov = post_overlays_7d
        .get(&u_prior_run.note)
        .expect("u_prior_run must retain restored pre-run todo overlay after rollback");
    assert_eq!(u_prior_run_post_ov.group, group("todo"));
    assert_eq!(
        u_prior_run_post_ov.placement_revision, u_prior_run_pre_ov.placement_revision,
        "u_prior_run must restore its pre-run placement_revision"
    );
    assert_eq!(
        u_prior_run_post_ov.placement_run_id.as_ref(),
        Some(&prior_run),
        "u_prior_run must preserve placement_run_id = Some(prior_run) across rollback restoration"
    );
    let m_agent_post_ov = post_overlays_7d
        .get(&m_agent.note)
        .expect("m_agent must reconcile back to its pre-run todo overlay after rollback");
    assert_eq!(m_agent_post_ov.group, group("todo"));
    assert_eq!(
        m_agent_post_ov.placement_revision,
        m_agent_pre_ov.placement_revision
    );
    assert!(m_agent_post_ov.placement_run_id.is_none());
    assert!(
        !post_overlays_7d.contains_key(&u_plain.note),
        "u_plain orphaned run-materialized p1 overlay must be deleted on rollback"
    );
    let todo_ids_7d: Vec<NoteId> = query(&engine, owner.clone(), v7d)
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .filter(|row| row.group == group("todo"))
        .map(|row| row.card.document.provenance().reference().note_id.clone())
        .collect();
    let human_pos = todo_ids_7d
        .iter()
        .position(|id| id == &u_human.note)
        .expect("u_human in todo");
    let prior_pos = todo_ids_7d
        .iter()
        .position(|id| id == &u_prior_run.note)
        .expect("u_prior_run in todo");
    let other_pos = todo_ids_7d
        .iter()
        .position(|id| id == &u_other.note)
        .expect("u_other in todo");
    assert!(
        human_pos < prior_pos && prior_pos < other_pos,
        "todo order must remain [u_human, u_prior_run, u_other] after rollback: {todo_ids_7d:?}"
    );

    // Case 7E: In-run round-trip overlay clobbering (`stale_non_moved` & `stale_untouched`),
    // originally-unranked moved card materialized in-run (`ClearOverlay`), and non-earliest
    // pass-through column anchor mutation (must not abort rollback with `InvalidState`).
    let proj7e = folder(store, &owner, None, "rb-roundtrip-proj", true)
        .await
        .unwrap();
    let (v7e, v7e_rev) = create_view(
        store,
        &owner,
        &proj7e,
        "rb-roundtrip-board",
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let u_rt_nonmoved = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "z-rt-nonmoved",
        "---\ntitle: Z-RtNonMoved\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_rt_untouched = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "y-rt-untouched",
        "---\ntitle: Y-RtUntouched\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_tail = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "a-rt-tail",
        "---\ntitle: A-RtTail\nstatus: todo\npriority: p1\n---\n".into(),
    )
    .await;
    let u_mid = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "d-rt-mid",
        "---\ntitle: D-RtMid\nstatus: review\npriority: p2\n---\n".into(),
    )
    .await;
    let m_helper = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "e-rt-helper",
        "---\ntitle: E-RtHelper\nstatus: doing\npriority: p1\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    // Human pre-run ranks `u_rt_nonmoved` before `u_tail` and `u_rt_untouched` before `u_tail` in `todo`.
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: u_rt_nonmoved.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: u_tail.note.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: u_rt_nonmoved.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let pre_ov_step1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: u_rt_untouched.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: u_tail.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            pre_ov_step1[&u_tail.note].rank_rev_id.clone(),
                        ),
                    }),
                    after: Some(RankNeighbor {
                        note: u_rt_nonmoved.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            pre_ov_step1[&u_rt_nonmoved.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: u_rt_untouched.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: pre_ov_step1
                        .get(&u_rt_untouched.note)
                        .map_or(RankExpectation::Absent, |o| {
                            RankExpectation::Existing(o.rank_rev_id.clone())
                        }),
                },
            ),
        )
        .await
        .unwrap();
    let m_unranked = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "b-rt-unranked",
        "---\ntitle: B-RtUnranked\nstatus: todo\npriority: p2\n---\n".into(),
    )
    .await;
    let m_pass = create_note(
        store,
        &owner,
        Some(proj7e.clone()),
        "c-rt-pass",
        "---\ntitle: C-RtPass\nstatus: todo\npriority: p2\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let pre_ov_7e = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    let rt_nonmoved_pre_ov = pre_ov_7e[&u_rt_nonmoved.note].clone();
    let rt_untouched_pre_ov = pre_ov_7e[&u_rt_untouched.note].clone();
    assert!(!pre_ov_7e.contains_key(&m_unranked.note));

    let run7e = AgentRunId::from_bytes(random_bytes());
    let agent7e = super::agent(&owner, run7e.clone(), ChatAudience::Personal);
    // 1. Agent edits `u_rt_nonmoved` todo -> doing, moves `m_helper` in doing (materializing `u_rt_nonmoved` in doing),
    //    edits `u_rt_nonmoved` back doing -> todo, then moves `m_helper` into todo (clobbering `u_rt_nonmoved` at tail
    //    of todo AND materializing `m_unranked` in todo).
    let rt_text_todo = "---\ntitle: Z-RtNonMoved\nstatus: todo\npriority: p1\n---\n";
    let rt_text_doing = "---\ntitle: Z-RtNonMoved\nstatus: doing\npriority: p1\n---\n";
    let rt_todo_an =
        notarium_syntax::frontmatter::analyze(rt_text_todo, DocClass::UserDoc).unwrap();
    let plan_to_doing = notarium_syntax::patch::plan(
        rt_text_todo,
        rt_todo_an.carrier.body,
        vec![(
            CarrierEditOrigin::Header,
            rt_todo_an.carrier.header.unwrap(),
            rt_text_doing.to_owned(),
        )],
    )
    .unwrap();
    let mut e1 = mutation(
        &agent7e,
        EditNote {
            note: u_rt_nonmoved.note.clone(),
            plan: plan_to_doing,
        },
    );
    e1.preconditions.revision = Some(u_rt_nonmoved.revision.clone());
    let u_rt_in_doing = store.edit_note(agent7e.clone(), e1).await.unwrap().value;
    sync(store, runtime, &scope).await;
    let m_helper_after1 = store
        .move_board_card(
            agent7e.clone(),
            mutation(
                &agent7e,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_helper.note.clone(),
                    group: group("doing"),
                    before: Some(RankNeighbor {
                        note: u_rt_nonmoved.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            rt_nonmoved_pre_ov.rank_rev_id.clone(),
                        ),
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: m_helper.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let rt_doing_an =
        notarium_syntax::frontmatter::analyze(rt_text_doing, DocClass::UserDoc).unwrap();
    let plan_back_todo = notarium_syntax::patch::plan(
        rt_text_doing,
        rt_doing_an.carrier.body,
        vec![(
            CarrierEditOrigin::Header,
            rt_doing_an.carrier.header.unwrap(),
            rt_text_todo.to_owned(),
        )],
    )
    .unwrap();
    let mut e2 = mutation(
        &agent7e,
        EditNote {
            note: u_rt_nonmoved.note.clone(),
            plan: plan_back_todo,
        },
    );
    e2.preconditions.revision = Some(u_rt_in_doing.revision.clone());
    let _ = store.edit_note(agent7e.clone(), e2).await.unwrap().value;
    sync(store, runtime, &scope).await;
    let mid_ov_a = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    store
        .move_board_card(
            agent7e.clone(),
            mutation(
                &agent7e,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_helper.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: u_rt_nonmoved.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            mid_ov_a[&u_rt_nonmoved.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("todo".into())),
                    )]),
                    expected_note: m_helper_after1.revision.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        mid_ov_a[&m_helper.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let mid_ov_b = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    assert_eq!(mid_ov_b[&u_rt_nonmoved.note].group, group("todo"));
    assert_ne!(
        mid_ov_b[&u_rt_nonmoved.note].placement_revision,
        rt_nonmoved_pre_ov.placement_revision
    );
    assert!(mid_ov_b.contains_key(&m_unranked.note));

    // 2. Move originally-unranked `m_unranked` (now run-materialized in todo) from todo -> doing.
    store
        .move_board_card(
            agent7e.clone(),
            mutation(
                &agent7e,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_unranked.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: m_unranked.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        mid_ov_b[&m_unranked.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    // 3. Move `m_pass` todo -> doing (after `u_mid`), then doing -> done.
    let mid_ov_c = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    let m_pass_doing = store
        .move_board_card(
            agent7e.clone(),
            mutation(
                &agent7e,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_pass.note.clone(),
                    group: group("review"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: u_mid.note.clone(),
                        expected_rank: mid_ov_c
                            .get(&u_mid.note)
                            .map_or(RankExpectation::Absent, |o| {
                                RankExpectation::Existing(o.rank_rev_id.clone())
                            }),
                    }),
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("review".into())),
                    )]),
                    expected_note: m_pass.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: mid_ov_c
                        .get(&m_pass.note)
                        .map_or(RankExpectation::Absent, |o| {
                            RankExpectation::Existing(o.rank_rev_id.clone())
                        }),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let mid_ov_d = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    store
        .move_board_card(
            agent7e.clone(),
            mutation(
                &agent7e,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_pass.note.clone(),
                    group: group("done"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("done".into())),
                    )]),
                    expected_note: m_pass_doing.revision.revision.clone(),
                    expected_view: v7e_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        mid_ov_d[&m_pass.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    // Post-run: human trashes unrelated card `u_mid` from pass-through column `doing`.
    store
        .delete_note(
            owner.clone(),
            mutation(
                &owner,
                notarium_core::ports::DeleteNote {
                    note: u_mid.note.clone(),
                    disposition: notarium_core::ports::DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    // Roll back `run7e`: must succeed (ignoring trashed anchor `u_mid` on non-earliest pass-through move),
    // restore `u_rt_nonmoved`'s pre-run human overlay, and clear `m_unranked`'s run-materialized overlay.
    let prep7e = store
        .prepare_agent_run_rollback(owner.clone(), run7e)
        .await
        .unwrap();
    let rb7e = store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7e))
        .await
        .expect("rollback with mutated pass-through anchor must succeed")
        .value;
    let m_helper_after_rb7e = rb7e
        .restored
        .iter()
        .find(|nr| nr.note == m_helper.note)
        .expect("m_helper restored by run7e rollback")
        .revision
        .clone();
    sync(store, runtime, &scope).await;
    let post_ov_7e = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    assert_eq!(
        post_ov_7e
            .get(&u_rt_nonmoved.note)
            .map(|o| (&o.group, &o.placement_revision)),
        Some((&group("todo"), &rt_nonmoved_pre_ov.placement_revision)),
        "round-trip clobbered stale_non_moved card must restore pre-run human placement_revision"
    );
    assert!(
        !post_ov_7e.contains_key(&m_unranked.note),
        "originally-unranked card materialized in-run must have its overlay cleared on rollback: {:?}",
        post_ov_7e.get(&m_unranked.note)
    );

    // 4. Round-trip view edit (`group_by: status -> priority -> status`) clobbering untouched
    //    `u_rt_untouched` in `todo`: rollback must restore `u_rt_untouched`'s pre-run human overlay.
    let run7e_v = AgentRunId::from_bytes(random_bytes());
    let agent7e_v = super::agent(&owner, run7e_v.clone(), ChatAudience::Personal);
    let v7e_status_txt = view_carrier(
        &v7e.key,
        "board",
        "{scope: project}",
        "group_by: status\nfilter: {exists: status}\n",
    );
    let v7e_prio_txt = view_carrier(
        &v7e.key,
        "board",
        "{scope: project}",
        "group_by: priority\nfilter: {exists: status}\n",
    );
    let v_span1 = notarium_syntax::frontmatter::analyze(&v7e_status_txt, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let mut ve1 = mutation(
        &agent7e_v,
        EditNote {
            note: v7e.note.clone(),
            plan: notarium_syntax::patch::plan(
                &v7e_status_txt,
                v_span1,
                vec![(CarrierEditOrigin::Body, v_span1, v7e_prio_txt.clone())],
            )
            .unwrap(),
        },
    );
    ve1.preconditions.revision = Some(v7e_rev.revision.clone());
    let v7e_prio_rev = store.edit_note(agent7e_v.clone(), ve1).await.unwrap().value;
    sync(store, runtime, &scope).await;
    let ov_v1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    let mh_v1 = store
        .move_board_card(
            agent7e_v.clone(),
            mutation(
                &agent7e_v,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_helper.note.clone(),
                    group: group("p1"),
                    before: Some(RankNeighbor {
                        note: u_rt_untouched.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_v1[&u_rt_untouched.note].rank_rev_id.clone(),
                        ),
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: m_helper_after_rb7e,
                    expected_view: v7e_prio_rev.revision.clone(),
                    expected_rank: ov_v1
                        .get(&m_helper.note)
                        .map_or(RankExpectation::Absent, |o| {
                            RankExpectation::Existing(o.rank_rev_id.clone())
                        }),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let v_span2 = notarium_syntax::frontmatter::analyze(&v7e_prio_txt, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let mut ve2 = mutation(
        &agent7e_v,
        EditNote {
            note: v7e.note.clone(),
            plan: notarium_syntax::patch::plan(
                &v7e_prio_txt,
                v_span2,
                vec![(CarrierEditOrigin::Body, v_span2, v7e_status_txt)],
            )
            .unwrap(),
        },
    );
    ve2.preconditions.revision = Some(v7e_prio_rev.revision.clone());
    let v7e_back_rev = store.edit_note(agent7e_v.clone(), ve2).await.unwrap().value;
    sync(store, runtime, &scope).await;
    let ov_v2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    store
        .move_board_card(
            agent7e_v.clone(),
            mutation(
                &agent7e_v,
                MoveBoardCard {
                    view: v7e.clone(),
                    note: m_helper.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: u_rt_untouched.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_v2[&u_rt_untouched.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("todo".into())),
                    )]),
                    expected_note: mh_v1.revision.revision,
                    expected_view: v7e_back_rev.revision,
                    expected_rank: RankExpectation::Existing(
                        ov_v2[&m_helper.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7e_v = store
        .prepare_agent_run_rollback(owner.clone(), run7e_v)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7e_v))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let post_ov_7e_v = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7e)
        .await
        .unwrap();
    assert_eq!(
        post_ov_7e_v
            .get(&u_rt_untouched.note)
            .map(|o| (&o.group, &o.placement_revision)),
        Some((&group("todo"), &rt_untouched_pre_ov.placement_revision)),
        "round-trip view-edit clobbered stale_untouched card must restore pre-run human placement_revision"
    );
    let _ = proj7b;
}

#[inline(never)]
async fn rollback_case_7f_materialization_and_partial_retry(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::ports::RankNeighbor;

    let (scope, owner) = open_space(store).await;
    let engine = runtime.engine();

    // Case 7F: Board rollback overlay ordering & partial-retry invariants:
    //   (a) Single-move rollback on unranked `[B, A]` restores `[B, A]` (never flips to `[A, B]`).
    //   (b) Untouched column `[B, C]` with subsequent human `D` between `B` and `C` keeps `[B, D, C]`
    //       when rolled-back `A` returns to `doing`.
    //   (c) Clearing an originally-unranked anchor `A` in `[H (human-ranked), A, B]` restores `[H, A, B]`
    //       without jumping `B` to index 0 ahead of `H`.
    //   (d) Retrying a partial rollback (after an active collab room on `B` closes) skips already-rolled-back
    //       same-column rank-only move on `A` and preserves intervening human placement `[X, C, A]`.
    let proj7f = folder(store, &owner, None, "rb-7f-proj", true)
        .await
        .unwrap();
    let v7f_body = "group_by: status\nfilter: {exists: status}\n";
    let (v7f_a, v7f_a_rev) = create_view(
        store,
        &owner,
        &proj7f,
        "rb-7f-a",
        "board",
        "{scope: project}",
        v7f_body,
    )
    .await;
    let f1a_b = create_note(
        store,
        &owner,
        Some(proj7f.clone()),
        "f1a-01-b",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let f1a_a = create_note(
        store,
        &owner,
        Some(proj7f.clone()),
        "f1a-02-a",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let pre_7fa: Vec<NoteId> = query(&engine, owner.clone(), v7f_a.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(pre_7fa.len(), 2);
    let (first_7fa, second_7fa) = (pre_7fa[0].clone(), pre_7fa[1].clone());
    let second_7fa_rev = if second_7fa == f1a_a.note {
        f1a_a.revision.clone()
    } else {
        f1a_b.revision.clone()
    };
    let run7fa = AgentRunId::from_bytes(random_bytes());
    let agent7fa = super::agent(&owner, run7fa.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent7fa.clone(),
            mutation(
                &agent7fa,
                MoveBoardCard {
                    view: v7f_a.clone(),
                    note: second_7fa.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: first_7fa.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: second_7fa_rev,
                    expected_view: v7f_a_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7fa = store
        .prepare_agent_run_rollback(owner.clone(), run7fa)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7fa))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let post_7fa: Vec<NoteId> = query(&engine, owner.clone(), v7f_a.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        post_7fa,
        vec![first_7fa, second_7fa],
        "single-move rollback on unranked [B, A] must restore exact order [B, A]"
    );

    // 7F(b): Untouched column [B, C] + human D between B and C preserves [B, D, C].
    let proj7fb = folder(store, &owner, None, "rb-7fb-proj", true)
        .await
        .unwrap();
    let (v7f_b, v7f_b_rev) = create_view(
        store,
        &owner,
        &proj7fb,
        "rb-7f-b",
        "board",
        "{scope: project}",
        v7f_body,
    )
    .await;
    let fb_b = create_note(
        store,
        &owner,
        Some(proj7fb.clone()),
        "fb-01-b",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fb_c = create_note(
        store,
        &owner,
        Some(proj7fb.clone()),
        "fb-02-c",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fb_a = create_note(
        store,
        &owner,
        Some(proj7fb.clone()),
        "fb-03-a",
        "---\nstatus: doing\n---\n".into(),
    )
    .await;
    let fb_d = create_note(
        store,
        &owner,
        Some(proj7fb.clone()),
        "fb-04-d",
        "---\nstatus: backlog\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let pre_todo_7fb: Vec<NoteId> = query(&engine, owner.clone(), v7f_b.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .filter(|r| r.group == group("todo"))
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(pre_todo_7fb.len(), 2);
    let (tb0, tb1) = (pre_todo_7fb[0].clone(), pre_todo_7fb[1].clone());
    let run7fb = AgentRunId::from_bytes(random_bytes());
    let agent7fb = super::agent(&owner, run7fb.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent7fb.clone(),
            mutation(
                &agent7fb,
                MoveBoardCard {
                    view: v7f_b.clone(),
                    note: fb_a.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: tb0.clone(),
                        expected_rank: RankExpectation::Absent,
                    }),
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("todo".into())),
                    )]),
                    expected_note: fb_a.revision.clone(),
                    expected_view: v7f_b_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let ov_7fb = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_b)
        .await
        .unwrap();
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_b.clone(),
                    note: fb_d.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: tb1.clone(),
                        expected_rank: RankExpectation::Existing(ov_7fb[&tb1].rank_rev_id.clone()),
                    }),
                    after: Some(RankNeighbor {
                        note: tb0.clone(),
                        expected_rank: RankExpectation::Existing(ov_7fb[&tb0].rank_rev_id.clone()),
                    }),
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("todo".into())),
                    )]),
                    expected_note: fb_d.revision.clone(),
                    expected_view: v7f_b_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7fb = store
        .prepare_agent_run_rollback(owner.clone(), run7fb)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7fb))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let post_todo_7fb: Vec<NoteId> = query(&engine, owner.clone(), v7f_b.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .filter(|r| r.group == group("todo"))
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        post_todo_7fb,
        vec![tb0, fb_d.note.clone(), tb1],
        "rollback returning A to doing must preserve human D between materialized B and C"
    );
    let _ = (fb_b, fb_c);

    // 7F(c): [H (human-ranked), A (unranked), B (unranked)] -> R moves B before H, then A to doing ->
    // rollback restores [H, A, B] without jumping B ahead of H.
    let proj7fc = folder(store, &owner, None, "rb-7fc-proj", true)
        .await
        .unwrap();
    let (v7f_c, v7f_c_rev) = create_view(
        store,
        &owner,
        &proj7fc,
        "rb-7f-c",
        "board",
        "{scope: project}",
        v7f_body,
    )
    .await;
    let fc_h = create_note(
        store,
        &owner,
        Some(proj7fc.clone()),
        "fc-00-h",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fc_h_moved = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_c.clone(),
                    note: fc_h.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: fc_h.revision.clone(),
                    expected_view: v7f_c_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    let fc_1 = create_note(
        store,
        &owner,
        Some(proj7fc.clone()),
        "fc-01-a",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fc_2 = create_note(
        store,
        &owner,
        Some(proj7fc.clone()),
        "fc-02-b",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let pre_7fc: Vec<NoteId> = query(&engine, owner.clone(), v7f_c.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(pre_7fc[0], fc_h.note);
    let (fc_a_id, fc_b_id) = (pre_7fc[1].clone(), pre_7fc[2].clone());
    let (fc_a_rev, fc_b_rev) = if fc_a_id == fc_1.note {
        (fc_1.revision.clone(), fc_2.revision.clone())
    } else {
        (fc_2.revision.clone(), fc_1.revision.clone())
    };
    let run7fc = AgentRunId::from_bytes(random_bytes());
    let agent7fc = super::agent(&owner, run7fc.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent7fc.clone(),
            mutation(
                &agent7fc,
                MoveBoardCard {
                    view: v7f_c.clone(),
                    note: fc_b_id.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: fc_h.note.clone(),
                        expected_rank: RankExpectation::Existing(fc_h_moved.rank_revision.clone()),
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: fc_b_rev,
                    expected_view: v7f_c_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let ov_7fc = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_c)
        .await
        .unwrap();
    store
        .move_board_card(
            agent7fc.clone(),
            mutation(
                &agent7fc,
                MoveBoardCard {
                    view: v7f_c.clone(),
                    note: fc_a_id.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: fc_a_rev,
                    expected_view: v7f_c_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(ov_7fc[&fc_a_id].rank_rev_id.clone()),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7fc = store
        .prepare_agent_run_rollback(owner.clone(), run7fc)
        .await
        .unwrap();
    store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7fc))
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let post_7fc: Vec<NoteId> = query(&engine, owner.clone(), v7f_c.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .filter(|r| r.group == group("todo"))
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        post_7fc,
        vec![fc_h.note.clone(), fc_a_id, fc_b_id],
        "ClearOverlay on anchor A must restore [H, A, B] without jumping B above H"
    );

    // 7F(d): Partial rollback retry must skip an already-rolled-back same-column rank-only move
    // and preserve intervening human placements [X, C, A].
    let proj7fd = folder(store, &owner, None, "rb-7fd-proj", true)
        .await
        .unwrap();
    let (v7f_d, v7f_d_rev) = create_view(
        store,
        &owner,
        &proj7fd,
        "rb-7f-d",
        "board",
        "{scope: project}",
        v7f_body,
    )
    .await;
    let fd_x = create_note(
        store,
        &owner,
        Some(proj7fd.clone()),
        "fd-01-x",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fd_a = create_note(
        store,
        &owner,
        Some(proj7fd.clone()),
        "fd-02-a",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fd_c = create_note(
        store,
        &owner,
        Some(proj7fd.clone()),
        "fd-03-c",
        "---\nstatus: todo\n---\n".into(),
    )
    .await;
    let fd_b_body = "---\nstatus: backlog\n---\nOriginal B.\n".to_owned();
    let fd_b = create_note(
        store,
        &owner,
        Some(proj7fd.clone()),
        "fd-04-b",
        fd_b_body.clone(),
    )
    .await;
    sync(store, runtime, &scope).await;
    // Human establishes ranked [X, A, C] in `todo`.
    let fd_x_m = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_d.clone(),
                    note: fd_x.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: fd_x.revision.clone(),
                    expected_view: v7f_d_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let ov_fd1 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_d)
        .await
        .unwrap();
    let fd_a_m = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_d.clone(),
                    note: fd_a.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: fd_x.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_fd1[&fd_x.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: fd_a.revision.clone(),
                    expected_view: v7f_d_rev.revision.clone(),
                    expected_rank: ov_fd1.get(&fd_a.note).map_or(RankExpectation::Absent, |o| {
                        RankExpectation::Existing(o.rank_rev_id.clone())
                    }),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let ov_fd2 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_d)
        .await
        .unwrap();
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_d.clone(),
                    note: fd_c.note.clone(),
                    group: group("todo"),
                    before: None,
                    after: Some(RankNeighbor {
                        note: fd_a.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_fd2[&fd_a.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: fd_c.revision.clone(),
                    expected_view: v7f_d_rev.revision.clone(),
                    expected_rank: ov_fd2.get(&fd_c.note).map_or(RankExpectation::Absent, |o| {
                        RankExpectation::Existing(o.rank_rev_id.clone())
                    }),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let ov_fd3 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_d)
        .await
        .unwrap();

    // Run `run7fd`: same-column rank-only move of `A` before `X`, plus body edit on `B`.
    let run7fd = AgentRunId::from_bytes(random_bytes());
    let agent7fd = super::agent(&owner, run7fd.clone(), ChatAudience::Personal);
    store
        .move_board_card(
            agent7fd.clone(),
            mutation(
                &agent7fd,
                MoveBoardCard {
                    view: v7f_d.clone(),
                    note: fd_a.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: fd_x.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_fd3[&fd_x.note].rank_rev_id.clone(),
                        ),
                    }),
                    after: None,
                    fields: BTreeMap::new(),
                    expected_note: fd_a_m.revision.revision.clone(),
                    expected_view: v7f_d_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        ov_fd3[&fd_a.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    let b_span = notarium_syntax::frontmatter::analyze(&fd_b_body, DocClass::UserDoc)
        .unwrap()
        .carrier
        .body;
    let mut edit_b = mutation(
        &agent7fd,
        EditNote {
            note: fd_b.note.clone(),
            plan: notarium_syntax::patch::plan(
                &fd_b_body,
                b_span,
                vec![(CarrierEditOrigin::Body, b_span, "Agent edited B.\n".into())],
            )
            .unwrap(),
        },
    );
    edit_b.preconditions.revision = Some(fd_b.revision.clone());
    let fd_b_edited = store
        .edit_note(agent7fd.clone(), edit_b)
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    // Open an active collab room on `B` so Rollback #1 restores `A` and skips `B`.
    let opened_b = store
        .open_collab_session(
            &budget(),
            notarium_canonical::OpenCollabSession {
                scope: scope.clone(),
                note: fd_b.note.clone(),
                owner_id: "room-7fd".into(),
                expected_carrier_rev: fd_b_edited.revision.clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: None,
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let prep7fd_1 = store
        .prepare_agent_run_rollback(owner.clone(), run7fd.clone())
        .await
        .unwrap();
    let rb7fd_1 = store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7fd_1))
        .await
        .unwrap()
        .value;
    assert_eq!(rb7fd_1.skipped_room_active, vec![fd_b.note.clone()]);
    sync(store, runtime, &scope).await;

    // Intervening human moves `C` between `X` and `A` -> `[X, C, A]`.
    let ov_fd4 = store
        .inspect_view_overlays_for_test(&scope.space_id, &v7f_d)
        .await
        .unwrap();
    store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: v7f_d.clone(),
                    note: fd_c.note.clone(),
                    group: group("todo"),
                    before: Some(RankNeighbor {
                        note: fd_a.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_fd4[&fd_a.note].rank_rev_id.clone(),
                        ),
                    }),
                    after: Some(RankNeighbor {
                        note: fd_x.note.clone(),
                        expected_rank: RankExpectation::Existing(
                            ov_fd4[&fd_x.note].rank_rev_id.clone(),
                        ),
                    }),
                    fields: BTreeMap::new(),
                    expected_note: fd_c.revision.clone(),
                    expected_view: v7f_d_rev.revision.clone(),
                    expected_rank: RankExpectation::Existing(
                        ov_fd4[&fd_c.note].rank_rev_id.clone(),
                    ),
                },
            ),
        )
        .await
        .unwrap();
    // Close `B`'s collab session and retry Rollback #2.
    store
        .close_collab_session(
            &budget(),
            notarium_canonical::CloseCollabSession {
                unchanged_carrier_digest: None,
                scope: scope.clone(),
                note: fd_b.note.clone(),
                owner_id: Some("room-7fd".into()),
                expected_lease: opened_b.lease_epoch,
                expected_lineage: opened_b.lineage_epoch,
                final_yrs_snapshot: None,
                compacted_through_update_seq: None,
                carrier_settlement: None,
            },
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;
    let prep7fd_2 = store
        .prepare_agent_run_rollback(owner.clone(), run7fd)
        .await
        .unwrap();
    let rb7fd_2 = store
        .rollback_agent_run(owner.clone(), mutation(&owner, prep7fd_2))
        .await
        .unwrap()
        .value;
    assert!(
        rb7fd_2.skipped_manual_edits.contains(&fd_a.note),
        "partial rollback retry must skip already-rolled-back rank-only board move A: {rb7fd_2:?}"
    );
    sync(store, runtime, &scope).await;
    let post_todo_7fd: Vec<NoteId> = query(&engine, owner.clone(), v7f_d.clone())
        .await
        .unwrap()
        .rows
        .items
        .into_iter()
        .filter(|r| r.group == group("todo"))
        .map(|r| r.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(
        post_todo_7fd,
        vec![fd_x.note, fd_c.note, fd_a.note],
        "partial rollback retry must preserve intervening human placement [X, C, A]"
    );
    let _ = fd_x_m;
}

async fn keeper_readonly_abilities_isolation_on_changes_events_and_graph(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
) {
    use notarium_core::ports::{DeleteDisposition, DeleteNote, EntityId, GraphQuery, GraphTier};

    let (scope, owner) = open_space(store).await;
    let proj = folder(store, &owner, None, "keeper-iso-proj", true)
        .await
        .unwrap();
    let (skill_board, skill_board_rev) = create_view(
        store,
        &owner,
        &proj,
        "keeper-skill-board",
        "board",
        "{scope: space, classes: [user-doc, agent-memory, skill]}",
        "group_by: status\nfilter: {exists: status}\n",
    )
    .await;
    let mem_card = store
        .create_note(
            owner.clone(),
            mutation(
                &owner,
                CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes(random_bytes()),
                    parent: Some(proj.clone()),
                    slug: "keeper-mem-card".into(),
                    class: DocClass::AgentMemory,
                    carrier: "---\nstatus: todo\n---\nMemory card.\n".into(),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    let skill_author_auth = notarium_core::auth::EngineAuthContext::for_human(
        notarium_core::auth::VerifiedHuman::attest(
            owner.auth().principal().clone(),
            notarium_core::ids::GrantId::from_bytes(random_bytes()),
            owner.auth().spaces().clone(),
            true,
        )
        .with_human_management(true),
    );
    let skill_author = SpaceContext::new(skill_author_auth, scope.clone(), budget()).unwrap();
    // Create one unapproved Skill note before `after` so its subsequent Purge row
    // falls inside `after..=end` without an erased Create payload inside that window.
    let unapproved_skill_purged = store
        .create_note(
            skill_author.clone(),
            mutation(
                &skill_author,
                CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes(random_bytes()),
                    parent: Some(proj.clone()),
                    slug: "unapproved-purged-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nstatus: todo\n---\nPurged secret skill.\n".into(),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;

    let keeper_auth = owner
        .auth()
        .for_keeper(
            AgentRunId::from_bytes(random_bytes()),
            scope.space_id.clone(),
            None,
            BTreeSet::new(),
        )
        .unwrap();
    let keeper = SpaceContext::new(keeper_auth, scope.clone(), budget()).unwrap();
    let after_seq = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let after = ChangeCursor {
        scope: scope.clone(),
        after: after_seq,
    };
    let engine = runtime.engine();
    let bus = engine.event_bus();
    let mut keeper_stream = bus.subscribe(keeper.clone(), after.clone()).await.unwrap();

    // Create a live unapproved Skill note, move BOTH the unapproved Skill note and a
    // visible AgentMemory card on `skill_board` while `keeper_stream` is open (exercising
    // `keeper_skill_scoped` in `board_events`), purge the pre-existing unapproved Skill note,
    // then create a visible UserDoc note.
    let unapproved_skill_live = store
        .create_note(
            skill_author.clone(),
            mutation(
                &skill_author,
                CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes(random_bytes()),
                    parent: Some(proj.clone()),
                    slug: "unapproved-secret-skill".into(),
                    class: DocClass::Skill,
                    carrier: "---\nstatus: todo\n---\nSecret skill body.\n".into(),
                },
            ),
        )
        .await
        .unwrap()
        .value;
    sync(store, runtime, &scope).await;
    let _skill_moved = store
        .move_board_card(
            skill_author.clone(),
            mutation(
                &skill_author,
                MoveBoardCard {
                    view: skill_board.clone(),
                    note: unapproved_skill_live.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: unapproved_skill_live.revision.clone(),
                    expected_view: skill_board_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap();
    let mem_card_moved = store
        .move_board_card(
            owner.clone(),
            mutation(
                &owner,
                MoveBoardCard {
                    view: skill_board.clone(),
                    note: mem_card.note.clone(),
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: mem_card.revision.clone(),
                    expected_view: skill_board_rev.revision.clone(),
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    let mem_card = mem_card_moved.revision;
    store
        .delete_note(
            skill_author.clone(),
            mutation(
                &skill_author,
                DeleteNote {
                    note: unapproved_skill_purged.note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    let visible_doc = create_note(
        store,
        &owner,
        Some(proj),
        "visible-keeper-doc",
        "---\nstatus: todo\n---\nVisible.\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;
    let end = store.read_space(&scope.space_id).await.unwrap().last_seq;

    // 1. Canonical change log must hide both Create and Purge of unapproved Skill notes.
    let ChangeReadResult::Log(page) = store
        .read_changes(
            keeper.clone(),
            ChangeRead::Log {
                after,
                through: end,
                limit: PageLimit::new(64).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected authorized change log for whole-space Keeper");
    };
    assert!(
        page.changes
            .iter()
            .any(|c| c.entity == EntityId::Note(visible_doc.note.clone())),
        "Keeper must still observe visible UserDoc change"
    );
    assert!(
        !page.changes.iter().any(|c| {
            c.entity == EntityId::Note(unapproved_skill_live.note.clone())
                || c.entity == EntityId::Note(unapproved_skill_purged.note.clone())
        }),
        "whole-space Keeper must not observe unapproved Skill create or purge in read_changes"
    );

    // 2. Projection event stream must not deliver GraphSettled, full Board deltas for
    //    Skill-including boards, or Changed events for unapproved Skill notes, while
    //    converting the visible `mem_card` board move on `skill_board` into ResyncRequired.
    let mut saw_resync = false;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = keeper_stream.next().await.unwrap().unwrap();
            match event.kind {
                SpaceEventKind::GraphSettled { .. } => {
                    panic!("whole-space Keeper must not receive Space-wide GraphSettled");
                }
                SpaceEventKind::Board(_) => {
                    panic!("whole-space Keeper must not receive full Board delta for Skill-sourced board");
                }
                SpaceEventKind::ResyncRequired => {
                    saw_resync = true;
                }
                SpaceEventKind::Changed(change)
                    if change.entity == EntityId::Note(unapproved_skill_live.note.clone())
                        || change.entity == EntityId::Note(unapproved_skill_purged.note.clone()) =>
                {
                    panic!("whole-space Keeper must not observe unapproved Skill change event");
                }
                SpaceEventKind::Changed(change)
                    if change.entity == EntityId::Note(visible_doc.note.clone()) =>
                {
                    break;
                }
                _ => {}
            }
        }
    })
    .await
    .expect("whole-space Keeper still receives visible UserDoc event");
    assert!(
        saw_resync,
        "moving mem_card on Skill-sourced board must emit ResyncRequired (never Board delta) to Keeper"
    );

    // 3. Superclusters graph tier must not bypass Keeper Skill isolation.
    let graph_err = engine
        .query_graph(
            keeper.clone(),
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: FieldFilterAstV1 {
                    version: 1,
                    predicate: Predicate::All(Vec::new()),
                },
                causal: None,
            },
        )
        .await;
    assert!(
        matches!(
            graph_err,
            Err(PortError::Domain(
                DomainError::ResourceNotFound | DomainError::AccessDenied
            ))
        ),
        "whole-space Keeper must not bypass Skill isolation on Superclusters graph, got {graph_err:?}"
    );

    // 4. Board planner must not admit a Keeper onto a board sourcing DocClass::Skill.
    let move_err = store
        .move_board_card(
            keeper.clone(),
            mutation(
                &keeper,
                MoveBoardCard {
                    view: skill_board,
                    note: mem_card.note,
                    group: group("doing"),
                    before: None,
                    after: None,
                    fields: BTreeMap::from([(
                        "status".into(),
                        Some(YamlValue::String("doing".into())),
                    )]),
                    expected_note: mem_card.revision,
                    expected_view: skill_board_rev.revision,
                    expected_rank: RankExpectation::Absent,
                },
            ),
        )
        .await;
    assert!(
        matches!(
            move_err,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "Keeper must not plan moves on a board sourcing DocClass::Skill, got {move_err:?}"
    );
}

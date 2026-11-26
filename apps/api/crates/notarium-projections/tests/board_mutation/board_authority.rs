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
    rollback_trashed_and_edited_board_view_through_real_planner(store, runtime).await;
    rollback_retired_widened_unranked_and_trashed_board_views(store, runtime).await;
    keeper_readonly_abilities_isolation_on_changes_events_and_graph(store, runtime).await;
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

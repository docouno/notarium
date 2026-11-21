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
    assert!(snapshot.lookup(&retained.note).is_some());
    assert!(snapshot.lookup(&erased.note).is_none());
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
    assert!(!engine.is_live_visible(&subscriber, &card.note).unwrap());
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
            .unwrap()
    );
    assert!(
        engine
            .is_live_visible(&subscriber, &cross_project.note)
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

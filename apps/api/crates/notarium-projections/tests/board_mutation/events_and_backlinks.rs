use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::SpaceLifecycle,
    model::NoteRef,
    ports::{
        AppendChat, BackupParticipantPort, BoardDelta, ChatEntryKind, ChatInputBody, ChatPort,
        ChatThreadKind, ContentJob, ContentJobKind, CreateChat, DeleteDisposition, DeleteNote,
        EntityId, EventBusPort, JobState, PageLimit, PortStream, RedactChatEntry, SpaceEvent,
        SpaceEventKind,
    },
    receipt::{AwaitWatermarks, ChangeCursor},
};

use super::*;

fn subscriber(
    owner: &SpaceContext,
    principal: PrincipalId,
    project: Option<FolderId>,
) -> SpaceContext {
    let mut grants = owner.auth().spaces().clone();
    let entry = grants.get_mut(&owner.scope().space_id).unwrap();
    entry.project_root = project;
    entry.role = SpaceRole::Viewer;
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        principal,
        GrantId::from_bytes(random_bytes()),
        grants,
        false,
    ));
    SpaceContext::new(auth, owner.scope().clone(), budget()).unwrap()
}

async fn next(stream: &mut dyn PortStream<SpaceEvent>) -> SpaceEvent {
    tokio::time::timeout(Duration::from_secs(4), stream.next())
        .await
        .unwrap()
        .unwrap()
        .expect("event stream is open")
}

async fn publish(bus: &dyn EventBusPort, event: SpaceEvent) {
    bus.publish(
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::EventPublication),
            budget: budget(),
        },
        event,
    )
    .await
    .unwrap();
}

async fn project_note(
    store: &CanonicalStore,
    owner: &SpaceContext,
    project: &FolderId,
    slug: &str,
    carrier: String,
) -> NoteId {
    store
        .create_note(
            owner.clone(),
            mutation(
                owner,
                CreateNote {
                    folder_page: false,
                    note: NoteId::from_bytes(random_bytes()),
                    parent: Some(project.clone()),
                    slug: slug.into(),
                    class: DocClass::UserDoc,
                    carrier,
                },
            ),
        )
        .await
        .unwrap()
        .value
        .note
}

pub(super) async fn exercise(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = FolderId::from_bytes(random_bytes());
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: project.clone(),
            parent: None,
            slug: "event-project".into(),
            display_name: "Event project".into(),
            is_project: true,
            project_slug: Some("event-project".into()),
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let target = project_note(
        store,
        &owner,
        &project,
        "backlink-target",
        "# Target\n".into(),
    )
    .await;
    let key = ViewKey::from_bytes([17; 16]);
    let board = project_note(
        store,
        &owner,
        &project,
        "event-board",
        format!("\x60\x60\x60nota\nid: {key}\ntype: board\ngroup_by: status\n\x60\x60\x60\n"),
    )
    .await;
    let outsider = subscriber(&owner, PrincipalId::from_bytes(random_bytes()), None);
    let scoped_owner = subscriber(
        &owner,
        owner.auth().principal().clone(),
        Some(project.clone()),
    );
    let thread = ChatThreadId::from_bytes(random_bytes());
    store
        .create_chat(
            owner.clone(),
            mutation(
                &owner,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: owner.auth().principal().clone(),
                    project_folder: Some(project),
                    title: "Private backlink source".into(),
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let bus = engine.event_bus();
    let after = ChangeCursor {
        scope: scope.clone(),
        after: store.read_space(&scope.space_id).await.unwrap().last_seq,
    };
    let mut allowed = bus.subscribe(owner.clone(), after.clone()).await.unwrap();
    let mut hidden = bus
        .subscribe(outsider.clone(), after.clone())
        .await
        .unwrap();
    let mut scoped = bus.subscribe(scoped_owner.clone(), after).await.unwrap();
    let reference = NoteRef {
        space_id: scope.space_id.clone(),
        note_id: target.clone(),
    };
    let appended = store
        .append_chat(
            owner.clone(),
            mutation(
                &owner,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("See the target".into()),
                    referenced_notes: vec![reference.clone(), reference],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    let seq = appended.receipt.seq();
    sync(store, runtime, &scope).await;

    loop {
        if let SpaceEventKind::Changed(change) = next(&mut *allowed).await.kind {
            assert_eq!(change.entity, EntityId::Thread(thread.clone()));
            break;
        }
    }
    let scope_event = |kind| SpaceEvent {
        scope: scope.clone(),
        seq,
        kind,
    };
    let marker = || scope_event(SpaceEventKind::Lifecycle(SpaceLifecycle::Active));
    let board_delta = scope_event(SpaceEventKind::Board(BoardDelta {
        scope: scope.clone(),
        seq,
        view: ViewRef { note: board, key },
        groups: Vec::new(),
        ranks: vec![(target.clone(), "a".into())],
    }));
    let job = scope_event(SpaceEventKind::Job(ContentJob {
        id: JobId::from_bytes(random_bytes()),
        kind: ContentJobKind::Export {
            notes: vec![target.clone()],
            encrypted: false,
        },
        state: JobState::Queued,
        completed_units: 0,
        total_units: None,
        lease: LeaseEpoch::new(1).unwrap(),
        artifacts: Vec::new(),
    }));
    assert!(bus.publish(projection_context(), marker()).await.is_err());
    publish(&bus, board_delta).await;
    publish(&bus, job).await;
    publish(&bus, marker()).await;

    let count =
        |event: &SpaceEventKind| matches!(event, SpaceEventKind::Board(_) | SpaceEventKind::Job(_));
    let mut author_events = 0;
    loop {
        let event = next(&mut *allowed).await;
        if matches!(event.kind, SpaceEventKind::Lifecycle(_)) {
            break;
        }
        author_events += usize::from(count(&event.kind));
    }
    assert_eq!(author_events, 2);
    loop {
        let event = next(&mut *hidden).await;
        if matches!(event.kind, SpaceEventKind::Lifecycle(_)) {
            break;
        }
        assert!(
            !matches!(event.kind, SpaceEventKind::Changed(change) if change.entity == EntityId::Thread(thread.clone()))
        );
    }
    loop {
        let event = next(&mut *scoped).await;
        if matches!(event.kind, SpaceEventKind::Lifecycle(_)) {
            break;
        }
        assert!(!count(&event.kind));
    }

    let causal = CausalBasis::Exact(ReceiptSet::new([appended.receipt]).unwrap());
    let allowed_links = engine
        .chat_backlinks(scoped_owner, &target, causal)
        .await
        .unwrap();
    assert_eq!(allowed_links.links.len(), 1);
    assert_eq!(allowed_links.links[0].thread.id, thread);
    assert_eq!(allowed_links.links[0].entry, appended.value.seq);
    assert_eq!(allowed_links.links[0].title, "Private backlink source");
    let latest = || CausalBasis::Await(AwaitWatermarks::default());
    let invisible = engine
        .chat_backlinks_page(
            outsider,
            &target,
            latest(),
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert!(invisible.links.is_empty() && invisible.next.is_none());

    let latest_thread = store
        .read_projection_chat_head(&projection_context(), &scope, None, &thread)
        .await
        .unwrap()
        .unwrap()
        .thread;
    store
        .redact_chat_entry(
            owner.clone(),
            mutation(
                &owner,
                RedactChatEntry {
                    thread,
                    entry: appended.value.seq,
                    expected_thread_revision: latest_thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        engine
            .chat_backlinks(owner, &target, latest())
            .await
            .unwrap()
            .links
            .is_empty()
    );
}

pub(super) async fn exercise_restored_target(
    store: &CanonicalStore,
    runtime: &ProjectorRuntime,
    derived: &DerivedStore,
) {
    let (source, source_owner) = open_space(store).await;
    let (target, target_owner) = open_space(store).await;
    let (unrelated, unrelated_owner) = open_space(store).await;
    let restored_note = note(
        store,
        &target_owner,
        "restored-target",
        DocClass::UserDoc,
        "# Restored target\n".into(),
    )
    .await
    .note;
    let purged_note = note(
        store,
        &target_owner,
        "purged-target",
        DocClass::UserDoc,
        "# Purged target\n".into(),
    )
    .await
    .note;
    let unrelated_note = note(
        store,
        &unrelated_owner,
        "unrelated-target",
        DocClass::UserDoc,
        "# Unrelated target\n".into(),
    )
    .await
    .note;

    let mut grants = source_owner.auth().spaces().clone();
    grants.extend(target_owner.auth().spaces().clone());
    grants.extend(unrelated_owner.auth().spaces().clone());
    let viewer = EngineAuthContext::for_human(VerifiedHuman::attest(
        source_owner.auth().principal().clone(),
        GrantId::from_bytes(random_bytes()),
        grants,
        false,
    ));
    let viewer_at =
        |scope: &HistoryScope| SpaceContext::new(viewer.clone(), scope.clone(), budget()).unwrap();
    let source_ctx = viewer_at(&source);
    let thread = ChatThreadId::from_bytes(random_bytes());
    store
        .create_chat(
            source_ctx.clone(),
            mutation(
                &source_ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: source_ctx.auth().principal().clone(),
                    project_folder: None,
                    title: "Unchanged source".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = store
        .append_chat(
            source_ctx.clone(),
            mutation(
                &source_ctx,
                AppendChat {
                    tool_calls: Vec::new(),
                    interruption: None,
                    provenance: None,
                    proposed_diff: None,
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Three links".into()),
                    referenced_notes: vec![
                        NoteRef {
                            space_id: target.space_id.clone(),
                            note_id: restored_note.clone(),
                        },
                        NoteRef {
                            space_id: target.space_id.clone(),
                            note_id: purged_note.clone(),
                        },
                        NoteRef {
                            space_id: unrelated.space_id.clone(),
                            note_id: unrelated_note.clone(),
                        },
                    ],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &source).await;
    sync(store, runtime, &target).await;
    sync(store, runtime, &unrelated).await;
    let engine = runtime.engine();
    let latest = || CausalBasis::Await(AwaitWatermarks::default());
    let original = engine
        .chat_backlinks(viewer_at(&target), &restored_note, latest())
        .await
        .unwrap();
    assert_eq!(original.links.len(), 1);
    assert_eq!(original.links[0].thread.id, thread);

    store
        .delete_note(
            target_owner.clone(),
            mutation(
                &target_owner,
                DeleteNote {
                    note: purged_note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &target).await;
    let cutoff = store.read_space(&target.space_id).await.unwrap().last_seq;
    let replacement = HistoryScope {
        space_id: target.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(random_bytes()),
    };
    store
        .restore_cursors(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            vec![ChangeCursor {
                scope: replacement.clone(),
                after: cutoff,
            }],
        )
        .await
        .unwrap();
    assert!(
        engine
            .chat_backlinks(viewer_at(&target), &restored_note, latest())
            .await
            .is_err()
    );
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            match engine
                .wait_for_projected(&replacement, cutoff, &budget())
                .await
            {
                Ok(cut) => {
                    assert_eq!(cut.projected_seq, cutoff);
                    break;
                }
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason
                        == notarium_core::error::ValidationReason::HistoryIncarnationMismatch =>
                {
                    tokio::task::yield_now().await;
                }
                Err(error) => panic!("restored target failed to seed: {error:?}"),
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(
        store.read_space(&source.space_id).await.unwrap().last_seq,
        appended.receipt.seq()
    );

    let reseeded = engine
        .chat_backlinks(viewer_at(&replacement), &restored_note, latest())
        .await
        .unwrap();
    assert_eq!(reseeded.links, original.links);
    let other = engine
        .chat_backlinks(viewer_at(&unrelated), &unrelated_note, latest())
        .await
        .unwrap();
    assert_eq!(other.links, original.links);
    assert!(
        derived
            .chat_ref_page(
                &replacement,
                &purged_note,
                None,
                PageLimit::new(10).unwrap()
            )
            .await
            .unwrap()
            .is_empty()
    );

    // The unseeded candidate still has the pre-restore purge guard and no
    // watermark. A committed purge finds that guard before writing its marker.
    let new_owner =
        SpaceContext::new(target_owner.auth().clone(), replacement.clone(), budget()).unwrap();
    store
        .delete_note(
            new_owner.clone(),
            mutation(
                &new_owner,
                DeleteNote {
                    note: restored_note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &replacement).await;
    assert!(
        derived
            .chat_ref_page(
                &replacement,
                &restored_note,
                None,
                PageLimit::new(10).unwrap()
            )
            .await
            .unwrap()
            .is_empty()
    );
}

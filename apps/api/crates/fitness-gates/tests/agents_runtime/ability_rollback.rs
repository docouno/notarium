use super::*;
use notarium_agents::chats::{AgentRunSupervisor, ExclusiveDataRoot};
use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    auth::ChatAudience,
    classes::{AbilityKind, DocClass},
    model::FolderRef,
};

fn command<T>(ctx: &SpaceContext, tag: u8, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes([tag; 16]),
            hash: ContentDigest::from_bytes([tag; 32]),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

async fn publish(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    folder: &FolderId,
    slug: &str,
    tag: u8,
) -> NoteId {
    let note = NoteId::from_bytes([tag; 16]);
    let created = store
        .create_note(
            ctx.clone(),
            command(
                ctx,
                tag,
                CreateNote {
                    note: note.clone(),
                    parent: Some(folder.clone()),
                    folder_page: false,
                    slug: slug.into(),
                    class: DocClass::Skill,
                    carrier: "---\nclass: skill\ntitle: Audit\n---\n# Audit\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    store
        .publish_ability_package(
            ctx.clone(),
            command(
                ctx,
                tag + 1,
                PublishAbilityPackage {
                    ability: AbilityId::from_bytes([tag; 16]),
                    kind: AbilityKind::Skill,
                    entrypoint: note.clone(),
                    expected_entrypoint_revision: Some(created.value.revision),
                    expected_package_revision: None,
                    files: vec![AbilityFile {
                        path: "guide.md".into(),
                        content: "Guide".into(),
                        digest: notarium_syntax::content_digest("Guide"),
                    }],
                    attached_skills: vec![],
                    requires_explicit_binding: false,
                },
            ),
        )
        .await
        .unwrap();
    note
}

#[tokio::test]
async fn sqlite_rollback_preserves_unique_project_ability_slot() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(false).await;
}

#[tokio::test]
async fn postgres_rollback_preserves_unique_project_ability_slot() {
    let _fixture = support::AUTH_TEST_LOCK.lock().await;
    exercise(true).await;
}

async fn exercise(pg: bool) {
    let fixture = Box::pin(RuntimeFixture::open_named(pg, "ability_rollback")).await;
    Box::pin(historical_ability_move(&fixture)).await;
    fixture.close().await;
}

async fn historical_ability_move(fixture: &RuntimeFixture) {
    let store = &fixture.canonical;
    let ctx = fixture.personal_scope().await;
    let space = &ctx.scope().space_id;
    let epoch = store.read_space(space).await.unwrap().active_epoch;
    let a = FolderId::from_bytes([1; 16]);
    let b = FolderId::from_bytes([2; 16]);
    let archive = FolderId::from_bytes([3; 16]);
    let c = FolderId::from_bytes([4; 16]);
    let a_other = FolderId::from_bytes([5; 16]);
    let b_other = FolderId::from_bytes([6; 16]);
    for (folder, slug, parent) in [
        (&a, "first", None),
        (&b, "second", None),
        (&archive, "archive", Some(a.clone())),
        (&c, "third", None),
        (&a_other, "other", Some(a.clone())),
        (&b_other, "other", Some(b.clone())),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: ctx.scope().clone(),
                active_epoch: epoch,
                folder_id: folder.clone(),
                is_project: parent.is_none(),
                project_slug: parent.is_none().then(|| slug.into()),
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                actor: ctx.auth().principal().clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let note = publish(store, &ctx, &a, "audit", 80).await;
    let relocate = |note: &NoteId, parent: &FolderId, tag| {
        store.move_note(
            ctx.clone(),
            command(
                &ctx,
                tag,
                MoveNote {
                    note: note.clone(),
                    parent: Some(parent.clone()),
                    slug: "audit".into(),
                },
            ),
        )
    };
    let get = |note: &NoteId| {
        store.get_note(
            ctx.clone(),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Exact(Default::default()),
            },
        )
    };
    // The first move records an active revision already bound to the published package.
    relocate(&note, &archive, 82).await.unwrap();
    let moved = relocate(&note, &b, 83).await.unwrap().value;
    let run = AgentRunId::from_bytes([84; 16]);
    tag_historical_note(store, space, &run, &moved).await;
    append_note(fixture, &run_context(&ctx, &run), 85).await;
    let other = publish(store, &ctx, &a, "audit", 86).await;

    let supervisor = AgentRunSupervisor::new_local(
        fixture.registry.clone(),
        fixture.revocations.clone(),
        ExclusiveDataRoot::attest_open_writer(),
    );
    let rollback = |run: &AgentRunId, tag| {
        supervisor.rollback_run(
            fixture.human.clone(),
            ctx.scope().clone(),
            run.clone(),
            CommandKey::from_bytes([tag; 16]),
        )
    };
    let assert_conflict = |error: PortError| {
        assert!(
            matches!(&error, PortError::Domain(DomainError::PathConflict { target })
            if target.space_id == *space && target.parent.as_ref() == Some(&a) && target.component == "audit"),
            "{error:?}"
        );
    };
    // An independent package retains its slot across the attempted restore.
    let before = store.read_space(space).await.unwrap().last_seq;
    assert_conflict(rollback(&run, 88).await.unwrap_err());
    assert_eq!(store.read_space(space).await.unwrap().last_seq, before);
    assert_eq!(
        get(&note).await.unwrap().document.revision(),
        &moved.revision
    );

    // Both packages would return to different folders in the same vacant project slot.
    relocate(&other, &a_other, 89).await.unwrap();
    let departed = relocate(&other, &c, 90).await.unwrap().value;
    tag_historical_note(store, space, &run, &departed).await;
    append_note(fixture, &run_context(&ctx, &run), 91).await;
    let before = store.read_space(space).await.unwrap().last_seq;
    assert_conflict(rollback(&run, 92).await.unwrap_err());
    assert_eq!(store.read_space(space).await.unwrap().last_seq, before);
    for head in [&moved, &departed] {
        assert_eq!(
            get(&head.note).await.unwrap().document.revision(),
            &head.revision
        );
    }

    // The other package leaves the destination project in the same successful rollback.
    let exchange = AgentRunId::from_bytes([93; 16]);
    let arrival = relocate(&note, &archive, 94).await.unwrap().value;
    tag_historical_note(store, space, &exchange, &arrival).await;
    let arrival = relocate(&other, &b_other, 95).await.unwrap().value;
    tag_historical_note(store, space, &exchange, &arrival).await;
    append_note(fixture, &run_context(&ctx, &exchange), 96).await;
    let restored = rollback(&exchange, 97).await.unwrap().value.restored;
    assert_eq!(restored.len(), 2);
    for (note, parent) in [(&note, &b), (&other, &c)] {
        let snapshot = get(note).await.unwrap();
        assert_eq!(snapshot.parent.as_ref(), Some(parent));
        assert!(restored.iter().any(|entry| &entry.note == note && &entry.revision == snapshot.document.revision()));
    }
    Box::pin(historical_package_changes(
        fixture,
        &ctx,
        &supervisor,
        &a,
        &archive,
    ))
    .await;
}

async fn tag_historical_note(
    store: &CanonicalStore,
    space: &SpaceId,
    run: &AgentRunId,
    moved: &NoteRevision,
) {
    // Model an imported tagged package move. Current agents cannot author packages.
    // A later ordinary run mutation supplies its genuine run head and receipt.
    let tagged = store.execute_diagnostic_write_sql_for_test(&format!(
        "UPDATE revisions SET agent_run_id='{run}' WHERE space_id='{space}' AND rev_id='{}' AND entity_type='note' AND entity_key='{}'",
        moved.revision, moved.note,
    )).await.unwrap();
    assert_eq!(tagged, 1);
}

fn run_context(ctx: &SpaceContext, run: &AgentRunId) -> SpaceContext {
    let auth = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            ctx.scope().space_id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    SpaceContext::new(auth, ctx.scope().clone(), budget()).unwrap()
}

async fn historical_package_changes(
    fixture: &RuntimeFixture,
    ctx: &SpaceContext,
    supervisor: &AgentRunSupervisor,
    project: &FolderId,
    archive: &FolderId,
) {
    let store = &fixture.canonical;
    let space = &ctx.scope().space_id;
    let placement = AbilityPlacement::OwnedProject(FolderRef {
        space_id: space.clone(),
        folder_id: project.clone(),
    });
    let current = |tag| {
        store.current_ability(
            fixture.human.clone(),
            AbilityIdentity {
                id: AbilityId::from_bytes([tag; 16]),
                placement: placement.clone(),
            },
        )
    };
    let rollback = |run: &AgentRunId, tag| {
        supervisor.rollback_run(
            fixture.human.clone(),
            ctx.scope().clone(),
            run.clone(),
            CommandKey::from_bytes([tag; 16]),
        )
    };
    let change_lifecycle = |note: &NoteId, disposition, tag| {
        store.delete_note(
            ctx.clone(),
            command(
                ctx,
                tag,
                DeleteNote {
                    note: note.clone(),
                    disposition,
                },
            ),
        )
    };
    let note = publish(store, ctx, project, "audit", 110).await;
    let published = current(110).await.unwrap();
    let rename_run = AgentRunId::from_bytes([112; 16]);
    // The predecessor of this first post-publication rename has no embedded ability ID.
    let rename = store
        .rename_note(
            ctx.clone(),
            command(
                ctx,
                112,
                RenameNote {
                    note: note.clone(),
                    slug: "review".into(),
                    title: None,
                },
            ),
        )
        .await
        .unwrap()
        .value;
    tag_historical_note(store, space, &rename_run, &rename).await;
    append_note(fixture, &run_context(ctx, &rename_run), 113).await;
    let occupied = publish(store, ctx, archive, "audit", 114).await;
    let before = store.read_space(space).await.unwrap().last_seq;
    let error = rollback(&rename_run, 116).await.unwrap_err();
    assert!(
        matches!(error, PortError::Domain(DomainError::PathConflict { target })
        if target.parent.as_ref() == Some(project) && target.component == "audit")
    );
    assert_eq!(store.read_space(space).await.unwrap().last_seq, before);
    assert_eq!(current(110).await.unwrap().name, "review");

    change_lifecycle(&occupied, DeleteDisposition::Trash, 117)
        .await
        .unwrap();
    assert_eq!(
        rollback(&rename_run, 118).await.unwrap().value.restored[0].note,
        note
    );
    let restored = current(110).await.unwrap();
    assert_eq!(restored.reference, published.reference);
    assert_eq!(restored.name, "audit");
    assert_eq!(restored.auxiliary_files, ["guide.md"]);
    let names = |name: &str| {
        store.abilities(
            fixture.human.clone(),
            AbilityQuery {
                page: ControlPageRequest::new(32, None).unwrap(),
                project: Some(FolderRef {
                    space_id: space.clone(),
                    folder_id: project.clone(),
                }),
                kind: Some(AbilityKind::Skill),
                name: Some(name.to_owned()),
                authoring: true,
            },
        )
    };
    assert!(names("review").await.unwrap().items.is_empty());
    assert_eq!(
        names("audit").await.unwrap().items[0].reference,
        published.reference
    );

    let trash_run = AgentRunId::from_bytes([120; 16]);
    let trashed = change_lifecycle(&note, DeleteDisposition::Trash, 120)
        .await
        .unwrap()
        .value;
    tag_historical_note(store, space, &trash_run, &trashed).await;
    append_note(fixture, &run_context(ctx, &trash_run), 121).await;
    assert!(names("audit").await.unwrap().items.is_empty());
    rollback(&trash_run, 122).await.unwrap();
    assert_eq!(current(110).await.unwrap().reference, published.reference);

    change_lifecycle(&note, DeleteDisposition::Trash, 123)
        .await
        .unwrap();
    let restore_run = AgentRunId::from_bytes([124; 16]);
    let activated = change_lifecycle(&note, DeleteDisposition::Restore, 124)
        .await
        .unwrap()
        .value;
    tag_historical_note(store, space, &restore_run, &activated).await;
    append_note(fixture, &run_context(ctx, &restore_run), 125).await;
    rollback(&restore_run, 126).await.unwrap();
    assert!(matches!(
        current(110).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    for (tag, run_publication) in [(130, false), (140, true)] {
        let name = format!("package-{tag}");
        let created = publish(store, ctx, archive, &name, tag).await;
        let descriptor = current(tag).await.unwrap();
        let snapshot = store
            .get_note(
                ctx.clone(),
                GetNote {
                    note: created.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(Default::default()),
                },
            )
            .await
            .unwrap();
        let run = AgentRunId::from_bytes([tag + 2; 16]);
        tag_historical_note(
            store,
            space,
            &run,
            &NoteRevision {
                note: created.clone(),
                revision: snapshot.document.revision().clone(),
            },
        )
        .await;
        if run_publication {
            let sql = format!(
                "UPDATE revisions SET agent_run_id='{run}' WHERE space_id='{space}'
                AND entity_type='ability' AND entity_key='{}' AND rev_id='{}'",
                descriptor.reference.id, descriptor.reference.revision
            );
            assert_eq!(
                store
                    .execute_diagnostic_write_sql_for_test(&sql)
                    .await
                    .unwrap(),
                1
            );
        }
        append_note(fixture, &run_context(ctx, &run), tag + 3).await;
        let result = rollback(&run, tag + 4).await.unwrap().value;
        if run_publication {
            assert!(result.trashed.iter().any(|item| item.note == created));
            assert!(matches!(
                current(tag).await,
                Err(PortError::Domain(DomainError::ResourceNotFound))
            ));
            // A stale active package row would still occupy this project's slot.
            publish(store, ctx, project, &name, tag + 5).await;
        } else {
            assert_eq!(result.skipped_manual_edits, [created]);
            assert_eq!(current(tag).await.unwrap().reference, descriptor.reference);
        }
    }
}

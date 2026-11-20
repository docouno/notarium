use super::*;
use notarium_core::ports::EnsureFolderPath;

pub(super) async fn check(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    schema_revision: &RevisionId,
) {
    let ctx = owner_ctx(scope, owner.clone(), true, true);
    let before_covers = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let path = next_mutation(
        scope,
        owner,
        EnsureFolderPath {
            base: None,
            path: "covers/Left".into(),
        },
    );
    let left = store
        .ensure_folder_path(ctx.clone(), path.clone())
        .await
        .unwrap();
    assert_eq!(
        store
            .ensure_folder_path(ctx.clone(), path.clone())
            .await
            .unwrap(),
        left
    );
    let wrong_retry = Mutation {
        input: EnsureFolderPath {
            base: None,
            path: "covers/not-created".into(),
        },
        ..path
    };
    assert_eq!(
        store
            .ensure_folder_path(ctx.clone(), wrong_retry)
            .await
            .unwrap_err(),
        PortError::Domain(DomainError::IdempotencyKeyReused),
    );
    let right = store
        .ensure_folder_path(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                EnsureFolderPath {
                    base: None,
                    path: "covers/Right".into(),
                },
            ),
        )
        .await
        .unwrap();
    let cover = |parent: FolderId, note: NoteId, slug: &str, folder_page| CreateNote {
        parent: Some(parent),
        note,
        slug: slug.into(),
        folder_page,
        class: DocClass::UserDoc,
        carrier: "# Cover\n\nBody\n".into(),
    };
    let left_note = sample_note_id(235);
    let right_note = sample_note_id(236);
    let bare_index = store
        .create_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                cover(left.folder_id.clone(), left_note.clone(), "INDEX", false),
            ),
        )
        .await;
    assert_validation_err(&bare_index, ValidationReason::InvalidPathComponent);
    for (folder, note) in [(&left, &left_note), (&right, &right_note)] {
        store
            .create_note(
                ctx.clone(),
                next_mutation(
                    scope,
                    owner,
                    cover(folder.folder_id.clone(), note.clone(), "index", true),
                ),
            )
            .await
            .unwrap();
    }
    let cover_at = async |folder: &FolderRef| {
        store
            .resolve_folder_path(ctx.clone(), Some(folder.folder_id.clone()), String::new())
            .await
            .unwrap()
            .unwrap()
            .cover_note
    };
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));
    assert_eq!(cover_at(&right).await.as_ref(), Some(&right_note));

    for (note, parent, slug) in [
        (
            left_note.clone(),
            right.folder_id.clone(),
            "relocated-schema",
        ),
        (left_note.clone(), left.folder_id.clone(), "renamed-schema"),
        (sample_note_id(237), left.folder_id.clone(), "INDEX"),
    ] {
        let request = next_mutation(
            scope,
            owner,
            UpdateSpaceSchema {
                schema_note: note,
                parent: Some(parent),
                slug: slug.into(),
                carrier: "# Schema\n".into(),
                schema: BTreeMap::new(),
                expected_schema_revision: Some(schema_revision.clone()),
            },
        );
        assert_validation_err(
            &store.update_space_schema(ctx.clone(), request).await,
            ValidationReason::InvalidPathComponent,
        );
    }
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));

    let rename = store
        .rename_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                RenameNote {
                    note: left_note.clone(),
                    slug: "index".into(),
                    title: Some("Renamed cover".into()),
                },
            ),
        )
        .await
        .unwrap();
    let metadata = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: left_note.clone(),
                revision: Some(rename.value.revision),
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap()
        .provenance
        .unwrap();
    assert_eq!(metadata.title, "Renamed cover");
    assert_eq!(metadata.path, "covers/Left/index.md");
    assert!(metadata.folder_page);

    let move_left = MoveNote {
        note: left_note.clone(),
        parent: Some(right.folder_id.clone()),
        slug: "index".into(),
    };
    assert!(matches!(
        store
            .move_note(ctx.clone(), next_mutation(scope, owner, move_left.clone()))
            .await,
        Err(PortError::Domain(DomainError::PathConflict { .. })),
    ));
    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await, None);

    let run = sample_run_id(235);
    let agent_auth = ctx
        .auth()
        .for_agent_run(
            run.clone(),
            scope.space_id.clone(),
            ChatAudience::Personal,
            ctx.auth().spaces().clone(),
        )
        .unwrap();
    let agent = SpaceContext::new(agent_auth, scope.clone(), make_budget()).unwrap();
    store
        .move_note(agent, next_mutation(scope, owner, move_left))
        .await
        .unwrap();
    assert_eq!(cover_at(&left).await, None);
    assert_eq!(cover_at(&right).await.as_ref(), Some(&left_note));

    let plan = store
        .prepare_agent_run_rollback(ctx.clone(), run)
        .await
        .unwrap();
    let result = store
        .rollback_agent_run(ctx.clone(), next_mutation(scope, owner, plan))
        .await
        .unwrap();
    assert_eq!(result.value.restored[0].note, left_note);
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));
    assert_eq!(cover_at(&right).await, None);

    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Restore,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await.as_ref(), Some(&right_note));
    store
        .delete_note(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                DeleteNote {
                    note: right_note.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(cover_at(&right).await, None);
    let updated = store
        .update_space_schema(
            ctx.clone(),
            next_mutation(
                scope,
                owner,
                UpdateSpaceSchema {
                    schema_note: left_note.clone(),
                    parent: Some(left.folder_id.clone()),
                    slug: "index".into(),
                    carrier: "# Schema cover\n".into(),
                    schema: BTreeMap::new(),
                    expected_schema_revision: Some(schema_revision.clone()),
                },
            ),
        )
        .await
        .unwrap();
    let note = store
        .get_note(
            ctx.clone(),
            GetNote {
                note: left_note.clone(),
                revision: Some(updated.value.note_revision),
                causal: CausalBasis::Exact(Default::default()),
            },
        )
        .await
        .unwrap();
    assert!(note.provenance.unwrap().folder_page);
    assert_eq!(cover_at(&left).await.as_ref(), Some(&left_note));

    // Purging a note erases its old effects. Activity still includes the surviving
    // cover with its authorized metadata; delta consumers must reseed.
    let query = ChangeRead::Log {
        after: ChangeCursor {
            scope: scope.clone(),
            after: before_covers,
        },
        through: store.read_space(&scope.space_id).await.unwrap().last_seq,
        limit: PageLimit::new(200).unwrap(),
    };
    assert_validation_err(
        &store.read_changes(ctx.clone(), query.clone()).await,
        ValidationReason::PurgeResync,
    );
    let ChangeReadResult::Log(activity) = store.recent_activity(ctx, query).await.unwrap() else {
        panic!("expected activity log");
    };
    assert!(activity.changes.iter().any(|row| row.entity
        == notarium_core::ports::EntityId::Note(left_note.clone())
        && row.provenance.is_some()));
    assert!(activity.changes.iter().all(|row| row.entity
        != notarium_core::ports::EntityId::Note(right_note.clone())
        || row.provenance.is_none()));
}

use super::*;

pub(super) async fn check(
    store: &CanonicalStore,
    ctx: &SpaceContext,
    note: &NoteId,
    stale: &RevisionId,
    current: &RevisionId,
    project: &FolderId,
    locked: bool,
) {
    let scope = ctx.scope();
    let actor = ctx.auth().principal();
    let assert_conflict = |error: PortError| {
        if locked {
            assert_eq!(error, PortError::Domain(DomainError::SpaceReadOnly));
        } else {
            assert!(
                matches!(error, PortError::Domain(DomainError::RevisionConflict {
                current: found, ..
            }) if found == *current)
            );
        }
    };
    let rename = RenameNote {
        note: note.clone(),
        slug: "authorized-conflict".into(),
        title: None,
    };
    let mov = MoveNote {
        note: note.clone(),
        parent: Some(project.clone()),
        slug: rename.slug.clone(),
    };
    let link = Link {
        target_title: None,
        source: note.clone(),
        target: LinkTarget::Folder(project.clone()),
        relation: "related".into(),
    };
    assert_conflict(
        store
            .rename_note(
                ctx.clone(),
                next_mutation_rev(scope, actor, stale.clone(), rename),
            )
            .await
            .unwrap_err(),
    );
    assert_conflict(
        store
            .move_note(
                ctx.clone(),
                next_mutation_rev(scope, actor, stale.clone(), mov.clone()),
            )
            .await
            .unwrap_err(),
    );
    assert_conflict(
        store
            .link(
                ctx.clone(),
                next_mutation_rev(scope, actor, stale.clone(), link.clone()),
            )
            .await
            .unwrap_err(),
    );
    let before = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let links = store
        .link_many(
            ctx.clone(),
            LinkBatch {
                items: vec![next_mutation_rev(scope, actor, stale.clone(), link)],
            },
        )
        .await
        .unwrap();
    assert_eq!(links.committed_high_watermark, before);
    assert_conflict(links.items.into_iter().next().unwrap().unwrap_err().into());

    let create = CreateNote {
        folder_page: false,
        note: note.clone(),
        parent: None,
        slug: "collision".into(),
        class: DocClass::UserDoc,
        carrier: "# Existing note\n".into(),
    };
    assert_conflict(
        store
            .create_note(ctx.clone(), next_mutation(scope, actor, create.clone()))
            .await
            .unwrap_err(),
    );
    let mut batch = vec![next_mutation_rev(
        scope,
        actor,
        stale.clone(),
        BatchItem::Move(mov),
    )];
    batch.push(next_mutation(scope, actor, BatchItem::Create(create)));
    for disposition in [
        DeleteDisposition::Trash,
        DeleteDisposition::Restore,
        DeleteDisposition::Purge,
    ] {
        let delete = DeleteNote {
            note: note.clone(),
            disposition,
        };
        assert_conflict(
            store
                .delete_note(
                    ctx.clone(),
                    next_mutation_rev(scope, actor, stale.clone(), delete.clone()),
                )
                .await
                .unwrap_err(),
        );
        if disposition != DeleteDisposition::Purge {
            batch.push(next_mutation_rev(
                scope,
                actor,
                stale.clone(),
                BatchItem::Delete(delete),
            ));
        }
    }
    let results = store
        .accept_batch(ctx.clone(), AcceptBatch { items: batch })
        .await
        .unwrap();
    assert_eq!(results.committed_high_watermark, before);
    for item in results.items {
        assert_conflict(item.unwrap_err().into());
    }
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        before
    );
}

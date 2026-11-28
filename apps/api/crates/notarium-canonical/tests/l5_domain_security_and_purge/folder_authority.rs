use super::*;

pub(super) async fn check(store: &CanonicalStore, scope: &HistoryScope, owner: &PrincipalId) {
    let human = make_human_ctx(
        scope,
        owner.clone(),
        SpaceGrant {
            role: SpaceRole::Editor,
            read_classes: DocClass::all(),
            write_classes: DocClass::all(),
            project_root: None,
        },
        false,
        false,
    );
    let project = sample_folder_id(221);
    let child = sample_folder_id(222);
    let sibling = sample_folder_id(223);
    for (folder, parent, slug, is_project) in [
        (project.clone(), None, "folder-authority", true),
        (child.clone(), Some(project.clone()), "child", false),
        (sibling.clone(), Some(project.clone()), "sibling", false),
    ] {
        store
            .create_folder(CreateFolderSpec {
                scope: scope.clone(),
                active_epoch: LeaseEpoch::new(1).unwrap(),
                folder_id: folder,
                parent,
                slug: slug.into(),
                display_name: slug.into(),
                is_project,
                project_slug: is_project.then(|| slug.into()),
                actor: owner.clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let keeper = SpaceContext::new(
        human
            .auth()
            .for_keeper(
                sample_run_id(221),
                scope.space_id.clone(),
                Some(project.clone()),
                BTreeSet::new(),
            )
            .unwrap(),
        scope.clone(),
        make_budget(),
    )
    .unwrap();
    let move_child = next_mutation(
        scope,
        owner,
        MoveFolder {
            folder: child.clone(),
            new_parent: Some(sibling),
        },
    );
    let rename_child = next_mutation(
        scope,
        owner,
        RenameFolder {
            folder: child,
            name: "renamed-child".into(),
        },
    );
    let rename_project = next_mutation(
        scope,
        owner,
        RenameProject {
            folder: project.clone(),
            name: "renamed-project".into(),
            display_name: Some("Renamed project".into()),
        },
    );
    assert!(matches!(
        store.move_folder(keeper.clone(), move_child.clone()).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert!(matches!(
        store
            .rename_folder(keeper.clone(), rename_child.clone())
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    assert!(matches!(
        store
            .rename_project(keeper.clone(), rename_project.clone())
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    store
        .move_folder(human.clone(), move_child.clone())
        .await
        .unwrap();
    store
        .rename_folder(human.clone(), rename_child.clone())
        .await
        .unwrap();
    store
        .rename_project(human.clone(), rename_project.clone())
        .await
        .unwrap();
    assert!(matches!(
        store.move_folder(keeper.clone(), move_child.clone()).await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    store
        .set_folder_write_lock(human.clone(), project.clone(), true)
        .await
        .unwrap();
    let stale = RevisionId::from_bytes([91; 16]);
    let move_stale = next_mutation_rev(scope, owner, stale.clone(), move_child.input);
    let folder_stale = next_mutation_rev(scope, owner, stale.clone(), rename_child.input);
    let project_stale = next_mutation_rev(scope, owner, stale, rename_project.input);
    let cut = store.read_space(&scope.space_id).await.unwrap().last_seq;
    for result in [
        store
            .move_folder(human.clone(), move_stale.clone())
            .await
            .map(|_| ()),
        store
            .rename_folder(human.clone(), folder_stale.clone())
            .await
            .map(|_| ()),
        store
            .rename_project(human.clone(), project_stale.clone())
            .await
            .map(|_| ()),
    ] {
        assert_eq!(
            result.unwrap_err(),
            PortError::Domain(DomainError::SpaceReadOnly)
        );
    }
    assert_eq!(
        store.read_space(&scope.space_id).await.unwrap().last_seq,
        cut
    );
    assert!(matches!(
        store
            .set_folder_write_lock(keeper, project.clone(), false)
            .await,
        Err(PortError::Domain(DomainError::SpaceReadOnly))
    ));
    store
        .set_folder_write_lock(human.clone(), project, false)
        .await
        .unwrap();
    for result in [
        store
            .move_folder(human.clone(), move_stale)
            .await
            .map(|_| ()),
        store
            .rename_folder(human.clone(), folder_stale)
            .await
            .map(|_| ()),
        store.rename_project(human, project_stale).await.map(|_| ()),
    ] {
        assert!(matches!(
            result,
            Err(PortError::Domain(DomainError::RevisionConflict { .. }))
        ));
    }
}

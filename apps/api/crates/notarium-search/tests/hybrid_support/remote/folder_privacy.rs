use super::*;
use crate::storage::{
    sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
};
use notarium_core::{
    model::Lifecycle,
    ports::{MoveFolder, NoteWritePort, ServicePurpose},
};
use notarium_search::vector::MutableBuffer;

pub async fn folder_eligibility(store: Arc<CanonicalStore>, root: DataRoot) {
    let tag = 0xb3;
    let owner = sample_principal_id(tag);
    let folder = sample_folder_id(tag);
    let parent = sample_folder_id(tag + 1);
    let child = sample_folder_id(tag + 2);
    let lease = LeaseEpoch::new(1).unwrap();
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(tag),
            incarnation: sample_incarnation(tag),
            root_folder_id: folder.clone(),
            slug: "remote-folder-lifecycle".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let folder_spec = |id: &FolderId, ancestor: &FolderId, name: &str| CreateFolderSpec {
        scope: scope.clone(),
        active_epoch: lease,
        folder_id: id.clone(),
        parent: Some(ancestor.clone()),
        slug: name.into(),
        display_name: name.into(),
        is_project: false,
        project_slug: None,
        actor: owner.clone(),
        timestamp: None,
    };
    let (_, revision, _) = store
        .create_folder(folder_spec(&parent, &folder, "parent"))
        .await
        .unwrap();
    store
        .create_folder(folder_spec(&child, &parent, "child"))
        .await
        .unwrap();
    let id = sample_note_id(tag);
    let (written, _) = store
        .commit_synthetic_note_batch_for_test(
            &scope,
            lease,
            &owner,
            vec![note(&id, &child, "Child note", "unique nested text")],
        )
        .await
        .unwrap();
    let (trashed, hidden_cut) = store
        .set_folder_lifecycle(
            &scope,
            lease,
            &parent,
            &revision,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .unwrap();
    let ctx = context(&scope, &owner);
    let authority = ServiceAuthority::admit(ServicePurpose::Search);
    let carrier_at = |cut| {
        store.read_note_documents_at_cutoff(
            &authority,
            ctx.budget.clone(),
            scope.clone(),
            cut,
            vec![id.clone()],
        )
    };
    assert!(
        !carrier_at(written.last_seq).await.unwrap()[0]
            .1
            .as_ref()
            .unwrap()
            .remote_indexable
    );
    assert!(
        !store
            .can_index_remote_search_note(
                &authority,
                ctx.budget.clone(),
                scope.clone(),
                id.clone(),
                None
            )
            .await
            .unwrap()
    );
    let mut view = View::new(scope.clone(), folder.clone());
    view.folder(parent.clone(), folder.clone());
    view.folder(child.clone(), parent.clone());
    view.index(id.clone(), child.clone());
    view.advance(hidden_cut);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::new(BTreeSet::from([id.clone()])),
    });
    let provider = Arc::new(ModelProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(Arc::new(SwitchingResolver::new(5, 512)));
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(scope.clone()).unwrap();
    let hidden = acknowledged(&store, &root, &scope, hidden_cut).await;
    assert_eq!(provider.parts.load(Ordering::SeqCst), 0);
    let (_, restored_cut) = store
        .set_folder_lifecycle(
            &scope,
            lease,
            &parent,
            &trashed,
            Lifecycle::Active,
            &owner,
            None,
        )
        .await
        .unwrap();
    assert!(
        !carrier_at(hidden_cut).await.unwrap()[0]
            .1
            .as_ref()
            .unwrap()
            .remote_indexable
    );
    let restored = acknowledged(&store, &root, &scope, restored_cut).await;
    assert_eq!(hidden.tantivy_commit, restored.tantivy_commit);
    tokio::time::timeout(Duration::from_secs(10), async {
        while provider.parts.load(Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    engine.shutdown().await;

    let project = FolderRef {
        space_id: scope.space_id.clone(),
        folder_id: sample_folder_id(tag + 3),
    };
    let mut spec = folder_spec(&project.folder_id, &folder, "selected");
    spec.is_project = true;
    spec.project_slug = Some("selected".into());
    store.create_folder(spec).await.unwrap();
    let destination = sample_folder_id(tag + 4);
    let (_, _, created) = store
        .create_folder(folder_spec(&destination, &project.folder_id, "sibling"))
        .await
        .unwrap();
    {
        let mut view = projection.snapshot.write().unwrap();
        view.project(project.folder_id.clone(), folder.clone());
        view.folder(destination.clone(), project.folder_id.clone());
        view.advance(created);
    }
    let resolver = Arc::new(SwitchingResolver::new(5, 512));
    *resolver.project.write().unwrap() = Some(project.clone());
    let provider = Arc::new(ModelProvider::default());
    let scoped_root = DataRoot::new(root.root().join("project-folder-moves"));
    std::fs::create_dir(scoped_root.root()).unwrap();
    let layout = SearchLayout::open(&scoped_root, scope.clone()).unwrap();
    let mut deps = SearchDependencies::new(store.clone(), projection.clone());
    deps.model_resolver = Some(resolver.clone());
    deps.providers = Some(provider.clone());
    let engine = SearchEngine::start(
        SearchConfig::new(scoped_root.clone(), VectorMode::RemoteOnly),
        deps,
    );
    engine.start_space(scope.clone()).unwrap();
    let ready = async |cut| {
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let Some(manifest) = layout.search_manifest().unwrap()
                    && manifest.tantivy_seq >= cut
                    && manifest.active_model == Some(resolver.current_target())
                    && manifest.vector_seq.is_some()
                    && !manifest.embeddings_pending
                {
                    break manifest;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    };
    let initial = ready(created).await;
    assert_eq!(provider.parts.load(Ordering::SeqCst), 0);
    let move_to = async |destination: &FolderId| {
        let moved = store
            .move_folder(
                ctx.clone(),
                crate::mutation(
                    &ctx,
                    MoveFolder {
                        folder: parent.clone(),
                        new_parent: Some(destination.clone()),
                    },
                ),
            )
            .await
            .unwrap();
        let mut view = projection.snapshot.write().unwrap();
        view.folder(parent.clone(), destination.clone());
        view.advance(moved.receipt.seq());
        moved.receipt.seq()
    };

    // The grant starts inside the project. Move the whole subtree back out
    // before the queued embedding can hand those bytes to the provider.
    resolver.hold_grant.store(true, Ordering::SeqCst);
    move_to(&project.folder_id).await;
    tokio::time::timeout(Duration::from_secs(12), resolver.grant_started.notified())
        .await
        .unwrap();
    let outside = move_to(&folder).await;
    assert!(
        !store
            .can_index_remote_search_note(
                &authority,
                ctx.budget.clone(),
                scope.clone(),
                id.clone(),
                Some(project.folder_id.clone())
            )
            .await
            .unwrap()
    );
    resolver.release_grant.notify_one();
    ready(outside).await;
    assert_eq!(provider.parts.load(Ordering::SeqCst), 0);

    // The note revision stays unchanged across both moves. A newly admitted
    // descendant gets a real slot and leaves the searchable vector set on exit.
    let entered = ready(move_to(&project.folder_id).await).await;
    assert_eq!(entered.tantivy_commit, initial.tantivy_commit);
    assert_eq!(provider.parts.load(Ordering::SeqCst), 1);
    let vector_dir = scoped_root.search(&scope.space_id, SearchIndexKind::Vector);
    let epoch = std::fs::read_dir(&vector_dir)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let slots = || {
        MutableBuffer::open(&epoch, 64)
            .unwrap()
            .chunks()
            .filter(|chunk| chunk.metadata.note == id)
            .count()
    };
    assert_eq!(slots(), 1);
    let mut semantic = query("vectorprobe");
    semantic.folder = Some(project.folder_id.clone());
    let hits = engine.search(ctx.clone(), semantic).await.unwrap().hits;
    assert_eq!(hits[0].card.title, "Child note");

    let before = crate::files(&vector_dir);
    let within = ready(move_to(&destination).await).await;
    assert_eq!(within.tantivy_commit, initial.tantivy_commit);
    assert_eq!(crate::files(&vector_dir), before);
    assert_eq!(provider.parts.load(Ordering::SeqCst), 1);

    let left = ready(move_to(&folder).await).await;
    assert_eq!(left.tantivy_commit, initial.tantivy_commit);
    assert_eq!(slots(), 0);
    assert_eq!(provider.parts.load(Ordering::SeqCst), 1);
    engine.shutdown().await;
}

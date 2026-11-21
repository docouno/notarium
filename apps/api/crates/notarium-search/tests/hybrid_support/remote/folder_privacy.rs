use super::*;
use crate::storage::{
    sample_folder_id, sample_incarnation, sample_note_id, sample_principal_id, sample_space_id,
};
use notarium_core::{model::Lifecycle, ports::ServicePurpose};

pub async fn trashed_ancestor(store: Arc<CanonicalStore>, root: DataRoot) {
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
            .can_index_remote_search_note(&authority, ctx.budget.clone(), scope.clone(), id.clone())
            .await
            .unwrap()
    );
    let mut view = View::new(scope.clone(), folder);
    view.advance(hidden_cut);
    let projection = Arc::new(Projection {
        store: store.clone(),
        snapshot: RwLock::new(view),
        live: RwLock::default(),
    });
    let provider = Arc::new(ModelProvider::default());
    let mut deps = SearchDependencies::new(store.clone(), projection);
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
}

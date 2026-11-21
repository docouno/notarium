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
    let denied = sample_folder_id(tag + 5);
    for (id, slug) in [(&project.folder_id, "selected"), (&denied, "denied")] {
        let mut spec = folder_spec(id, &folder, slug);
        spec.is_project = true;
        spec.project_slug = Some(slug.into());
        store.create_folder(spec).await.unwrap();
    }
    let destination = sample_folder_id(tag + 4);
    let (_, _, created) = store
        .create_folder(folder_spec(&destination, &project.folder_id, "sibling"))
        .await
        .unwrap();
    {
        let mut view = projection.snapshot.write().unwrap();
        view.project(project.folder_id.clone(), folder.clone());
        view.project(denied.clone(), folder.clone());
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
    // Two newly eligible descendants lie on distinct 16-note repair pages.
    // Canonical edits to a note outside this project keep arriving on both.
    let padding: Vec<_> = (1..=15)
        .map(|offset| sample_note_id(tag + offset))
        .collect();
    let last = sample_note_id(tag + 16);
    let mut batch = vec![
        note(&id, &child, "First repaired", "first repaired source"),
        note(&last, &child, "Last repaired", "last repaired source"),
    ];
    batch.extend(
        padding
            .iter()
            .map(|other| note(other, &folder, "Outside", "irrelevant")),
    );
    let (added, _) = store
        .commit_synthetic_note_batch_for_test(&scope, lease, &owner, batch)
        .await
        .unwrap();
    {
        let mut view = projection.snapshot.write().unwrap();
        let mut live = projection.live.write().unwrap();
        for other in &padding {
            view.index(other.clone(), folder.clone());
            live.insert(other.clone());
        }
        view.index(last.clone(), child.clone());
        live.insert(last.clone());
        view.advance(added.last_seq);
    }
    ready(added.last_seq).await;
    let baseline = provider.parts.load(Ordering::SeqCst);
    provider.block_next_part.store(true, Ordering::SeqCst);
    move_to(&project.folder_id).await;
    let commit_edit = async |edit| {
        let (range, _) = store
            .commit_synthetic_note_batch_for_test(&scope, lease, &owner, vec![edit])
            .await
            .unwrap();
        projection.snapshot.write().unwrap().advance(range.last_seq);
        tokio::time::timeout(Duration::from_secs(3), async {
            while layout.search_manifest().unwrap().unwrap().tantivy_seq < range.last_seq {
                tokio::time::sleep(Duration::from_millis(8)).await;
            }
        })
        .await
        .unwrap();
        range.last_seq
    };
    let await_part = async |phase| {
        tokio::time::timeout(Duration::from_secs(8), async {
            let mut revision = 0;
            while tokio::time::timeout(Duration::from_millis(20), provider.part_started.notified())
                .await
                .is_err()
            {
                let text = format!("between repair pages {phase} mutation {revision}");
                commit_edit(note(&padding[0], &folder, "Outside", &text)).await;
                revision += 1;
            }
        })
        .await
        .unwrap();
    };
    let mut latest = added.last_seq;
    for page in 0..2 {
        await_part(page).await;
        for revision in 0..3 {
            let edit = if page == 1 && revision == 2 {
                note(&last, &child, "Last repaired", "newer text after dispatch")
            } else {
                let text = format!("unrelated page {page} mutation {revision}");
                note(&padding[0], &folder, "Outside", &text)
            };
            latest = commit_edit(edit).await;
        }
        provider.block_next_part.store(true, Ordering::SeqCst);
        provider.release_part.notify_one();
    }
    await_part(2).await;
    let interim: BTreeSet<_> = MutableBuffer::open(&epoch, 64)
        .unwrap()
        .chunks()
        .map(|chunk| chunk.metadata.note.clone())
        .collect();
    assert_eq!(interim, BTreeSet::from([id.clone()]));
    provider.release_part.notify_one();
    ready(latest).await;
    assert_eq!(provider.parts.load(Ordering::SeqCst), baseline + 3);
    let repaired: BTreeSet<_> = MutableBuffer::open(&epoch, 64)
        .unwrap()
        .chunks()
        .map(|chunk| chunk.metadata.note.clone())
        .collect();
    assert_eq!(repaired, BTreeSet::from([id, last]));

    // The model covers the whole Space, but a note's grant still depends on
    // its actual project. The query below has no folder or lexical matches.
    *resolver.grant_project.write().unwrap() = Some(project.clone());
    *resolver.project.write().unwrap() = None;
    let baseline = provider.parts.load(Ordering::SeqCst);
    let initial = ready(move_to(&denied).await).await;
    let semantic = async || {
        engine
            .search(ctx.clone(), query("vectorprobe"))
            .await
            .unwrap()
            .hits
    };
    let active_epoch = std::fs::read_dir(&vector_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| *path != epoch)
        .unwrap();
    let slots = || MutableBuffer::open(&active_epoch, 64).unwrap().len();
    assert_eq!(slots(), 0);
    assert!(semantic().await.is_empty());
    assert_eq!(provider.parts.load(Ordering::SeqCst), baseline);

    resolver.hold_grant.store(true, Ordering::SeqCst);
    move_to(&project.folder_id).await;
    tokio::time::timeout(Duration::from_secs(12), resolver.grant_started.notified())
        .await
        .unwrap();
    let outside = move_to(&denied).await;
    resolver.release_grant.notify_one();
    ready(outside).await;
    assert_eq!(provider.parts.load(Ordering::SeqCst), baseline);

    let entered = ready(move_to(&project.folder_id).await).await;
    assert_eq!(entered.tantivy_commit, initial.tantivy_commit);
    assert_eq!(provider.parts.load(Ordering::SeqCst), baseline + 2);
    assert_eq!(slots(), 2);
    let hits: BTreeSet<_> = semantic()
        .await
        .into_iter()
        .map(|hit| hit.card.document.provenance().reference().note_id.clone())
        .collect();
    assert_eq!(hits, repaired);
    let left = ready(move_to(&denied).await).await;
    assert_eq!(left.tantivy_commit, initial.tantivy_commit);
    assert!(semantic().await.is_empty());
    assert_eq!(slots(), 0);
    assert_eq!(provider.parts.load(Ordering::SeqCst), baseline + 2);
    engine.shutdown().await;
}

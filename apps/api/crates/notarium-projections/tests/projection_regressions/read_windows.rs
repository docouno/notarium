use super::*;

#[tokio::test]
async fn listings_hydrate_both_deepest_supported_folder_levels() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
        root.clone(),
    ))
    .await
    .expect("open local SQLite");
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;

    let mut parent = None;
    let mut test_folders = Vec::new();
    for depth in 1..=256 {
        let (folder, _) = create_folder(&store, &owner, parent.take(), "d", false).await;
        if depth >= 255 {
            let card = create_note(
                &store,
                &owner,
                Some(folder.clone()),
                "card",
                DocClass::UserDoc,
                format!("# Card at depth {depth}\n"),
            )
            .await;
            store
                .get_note(
                    owner.clone(),
                    notarium_core::ports::GetNote {
                        note: card.note.clone(),
                        revision: Some(card.revision.clone()),
                        causal: CausalBasis::Await(AwaitWatermarks::default()),
                    },
                )
                .await
                .expect("canonical point read of the committed revision");
            test_folders.push((depth, folder.clone(), card.note));
        }
        parent = Some(folder);
    }
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .expect("start local projection");
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let settle = CallBudget {
        remaining: Duration::from_secs(90),
        ..budget()
    };
    runtime
        .engine()
        .wait_for_projected(&scope, head, &settle)
        .await
        .unwrap();

    let port = ProjectedNoteReadPort::new(runtime.engine());
    for (depth, folder, expected) in test_folders {
        let result = port
            .list_notes(
                owner.clone(),
                ReadRequest::Open {
                    query: NoteQuery {
                        folder: Some(folder),
                        recursive: false,
                        classes: BTreeSet::from([DocClass::UserDoc]),
                        lifecycle: LifecycleMask::Active,
                        filter: empty_filter(),
                        sort: SortSpec::default(),
                        limit: PageLimit::new(1).unwrap(),
                    },
                    causal: CausalBasis::Await(AwaitWatermarks::default()),
                },
            )
            .await;
        let page =
            result.unwrap_or_else(|err| panic!("list direct child at depth {depth}: {err:?}"));
        assert_eq!(page.children.items.len(), 1);
        assert_eq!(
            page.children.items[0].document.reference().note_id,
            expected
        );
    }
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn retained_large_board_filter_evicts_the_oldest_cursor_by_bytes() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(rand16()),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store, SpaceKind::Personal).await;
    let key = ViewKey::from_bytes(rand16());
    let payload = "x".repeat(960 * 1024);
    // The first disjunct accepts every row, but the executable descriptor still
    // owns the second predicate on every retained cut.
    let body = format!(
        "```nota\nid: {key}\ntype: list\nfilter:\n  any:\n    - all: []\n    - eq: {{key: label, value: {payload}}}\n```\n"
    );
    let board = create_note(
        &store,
        &owner,
        None,
        "large-filter",
        DocClass::UserDoc,
        body,
    )
    .await;
    create_note(
        &store,
        &owner,
        None,
        "second",
        DocClass::UserDoc,
        "Body".into(),
    )
    .await;
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_ctx(),
        root,
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig {
            retained_read_lifetime: Duration::from_secs(600),
            ..ProjectionConfig::default()
        },
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();
    let request = ReadRequest::Open {
        query: ViewQuery {
            view: ViewRef {
                note: board.note,
                key,
            },
            filter: empty_filter(),
            sort: None,
            group_by: None,
            limit: PageLimit::new(1).unwrap(),
        },
        causal: CausalBasis::Await(AwaitWatermarks::default()),
    };
    let first = engine
        .query_view(owner.clone(), request.clone())
        .await
        .unwrap()
        .rows
        .next
        .unwrap();
    let mut newest = first.clone();
    for _ in 1..69 {
        newest = engine
            .query_view(owner.clone(), request.clone())
            .await
            .unwrap()
            .rows
            .next
            .unwrap();
    }
    assert!(matches!(
        engine.query_view(owner.clone(), ReadRequest::Continue { cursor: first }).await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
    ));
    assert!(
        engine
            .query_view(owner, ReadRequest::Continue { cursor: newest })
            .await
            .is_ok()
    );
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

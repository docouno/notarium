use std::{collections::BTreeSet, time::Duration};

use notarium_canonical::CreateFolderSpec;
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceRole, VerifiedHuman},
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, GrantId, LeaseEpoch, NoteId, PrincipalId, ViewKey},
    model::Lifecycle,
    patch::CarrierEditOrigin,
    ports::{
        CreateNote, DeleteDisposition, DeleteNote, EditNote, GraphNodeId, GraphQuery, GraphTier,
        MoveFolder, MoveNote, NoteRevision, NoteWritePort, PageLimit, RenameNote, SpaceContext,
        StructuralReadPort, ViewGraphPort, ViewQuery, ViewRef, ViewRow,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::{AwaitWatermarks, CausalBasis},
    value::{ScalarValue, YamlValue},
};
use notarium_projections::{NoteLinkDirection, ProjectionEngine};

use super::{
    CanonicalStore, ProjectorRuntime, budget, mutation, note, open_space, random_bytes, sync,
};

pub(super) async fn exercise(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    scoped_graph(store, runtime).await;
    retained_structural_snapshot(store, runtime).await;
    let (scope, owner) = open_space(store).await;
    let view_key = ViewKey::from_bytes([18; 16]);
    let view = note(
        store,
        &owner,
        "retained-view",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {view_key}\ntype: table\nfilter: {{exists: estimate}}\n\
             sort: [{{field: estimate, type: number, direction: asc}}]\n```\n"
        ),
    )
    .await;
    let beta = note(
        store,
        &owner,
        "beta",
        DocClass::UserDoc,
        "---\ntitle: Beta before rename\nestimate: 2\n---\n\n# Beta before rename\n".into(),
    )
    .await;
    let alpha = note(
        store,
        &owner,
        "alpha",
        DocClass::UserDoc,
        format!("---\ntitle: Alpha\nestimate: 1\n---\n\n[[{}]]\n", beta.note),
    )
    .await;
    let gamma = note(
        store,
        &owner,
        "gamma",
        DocClass::UserDoc,
        format!(
            "---\ntitle: Gamma\nestimate: 3\n---\n\n[[{}]]\n",
            alpha.note
        ),
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let graph = engine
        .query_graph(
            owner.clone(),
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: beta.note.clone(),
                    hops: 2,
                },
                filter: filter(),
            },
        )
        .await
        .expect("read the real two-hop projection");
    assert_eq!(
        graph
            .nodes
            .into_iter()
            .map(|node| node.id)
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            GraphNodeId::Note(alpha.note.clone()),
            GraphNodeId::Note(beta.note.clone()),
            GraphNodeId::Note(gamma.note.clone()),
        ])
    );
    let graph_edges: BTreeSet<_> = graph
        .edges
        .into_iter()
        .map(|edge| (edge.source, edge.target))
        .collect();
    assert_eq!(
        graph_edges,
        BTreeSet::from([
            (
                GraphNodeId::Note(alpha.note.clone()),
                GraphNodeId::Note(beta.note.clone())
            ),
            (
                GraphNodeId::Note(gamma.note.clone()),
                GraphNodeId::Note(alpha.note.clone())
            ),
        ])
    );
    assert_eq!(graph.hidden_count, 0);

    let first = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: ViewQuery {
                    view: ViewRef {
                        note: view.note.clone(),
                        key: view_key.clone(),
                    },
                    filter: filter(),
                    sort: None,
                    group_by: None,
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .expect("open the first view page");
    assert_eq!(note_id(&first.rows.items[0]), &alpha.note);
    let old_cut = first.rows.projected_seq;
    let first_token = first.rows.next.expect("first continuation");

    let mut rename = mutation(
        &owner,
        RenameNote {
            note: beta.note.clone(),
            slug: "beta-renamed".into(),
            title: Some("Beta after rename".into()),
        },
    );
    rename.preconditions.revision = Some(beta.revision.clone());
    let renamed = store
        .rename_note(owner.clone(), rename)
        .await
        .expect("rename the second note");
    sync(store, runtime, &scope).await;
    assert!(renamed.receipt.seq() > old_cut);

    // Without 40-table temporal MVCC, advancing derived past the cursor cut
    // cleanly returns CursorStale so callers reopen on the current cut.
    assert!(matches!(
        engine
            .query_view(
                owner.clone(),
                ReadRequest::Continue {
                    cursor: first_token,
                },
            )
            .await,
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == ValidationReason::CursorStale
    ));

    let view_query = ViewQuery {
        view: ViewRef {
            note: view.note,
            key: view_key,
        },
        filter: filter(),
        sort: None,
        group_by: None,
        limit: PageLimit::new(1).unwrap(),
    };
    let reopened = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: view_query,
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .expect("reopen the view on the updated cut");
    assert_eq!(reopened.rows.projected_seq, renamed.receipt.seq());
    assert_eq!(note_id(&reopened.rows.items[0]), &alpha.note);
    let reopened_token = reopened.rows.next.expect("first continuation on new cut");

    let second = engine
        .query_view(
            owner.clone(),
            ReadRequest::Continue {
                cursor: reopened_token,
            },
        )
        .await
        .expect("continue on an unchanged cut");
    assert_eq!(second.rows.projected_seq, renamed.receipt.seq());
    assert_eq!(second.rows.items.len(), 1);
    let current_beta = &second.rows.items[0];
    assert_eq!(note_id(current_beta), &beta.note);
    assert_eq!(
        current_beta.card.document.provenance().revision(),
        &renamed.value.revision
    );
    assert_eq!(current_beta.card.title, "Beta after rename");
    assert!(current_beta.card.path.contains("beta-renamed"));
    let second_token = second.rows.next.expect("second continuation");

    let snapshot = engine
        .acquire_snapshot(
            owner.clone(),
            CausalBasis::Await(AwaitWatermarks::default()),
        )
        .await
        .expect("hold the graph cut across the request");
    let focal = snapshot
        .lookup(&gamma.note)
        .unwrap()
        .expect("active before trash");
    assert!(snapshot.outgoing(focal).unwrap().next().is_some());
    let mut retained_edges = snapshot
        .outgoing(focal)
        .expect("start traversing before trash");

    // Hold derived on the current cut while canonical trashes gamma so we
    // verify the live tombstone fence independently of cursor staleness.
    let _hold_projection = engine.pause_before_projection_for_test(&scope, 1).unwrap();
    let mut trash = mutation(
        &owner,
        DeleteNote {
            note: gamma.note.clone(),
            disposition: DeleteDisposition::Trash,
        },
    );
    trash.preconditions.revision = Some(gamma.revision);
    // Poll through the first visibility batch, then commit while the reader
    // has yielded its permit for the tail. Every flag must reflect one head.
    let repeated = vec![gamma.note.clone(); 33];
    let mut visibility = engine.filter_live_visible(&owner, &repeated);
    tokio::select! {
        biased;
        result = &mut visibility => panic!("visibility check did not yield between batches: {result:?}"),
        () = std::future::ready(()) => {}
    }
    let trashed = store
        .delete_note(owner.clone(), trash)
        .await
        .expect("trash the final note");
    assert_eq!(visibility.await.unwrap(), vec![false; repeated.len()]);
    let mut waiting = owner.clone();
    waiting.budget.remaining = Duration::from_millis(120);
    let watermark = AwaitWatermarks::from_receipts([trashed.receipt]);
    assert!(matches!(
        engine
            .acquire_snapshot(waiting, CausalBasis::Await(watermark))
            .await,
        Err(PortError::DeadlineExceeded(_))
    ));
    assert_eq!(
        snapshot.doc_class(focal),
        Err(DomainError::ResourceNotFound)
    );
    assert!(
        !engine
            .is_live_visible(&owner, &gamma.note)
            .await
            .expect("consult the owner fence")
    );
    assert!(
        retained_edges.next().is_none(),
        "the old source no longer authorizes an edge"
    );
    let last = engine
        .query_view(
            owner,
            ReadRequest::Continue {
                cursor: second_token,
            },
        )
        .await
        .expect("continue the retained read through the live tombstone fence");
    assert!(last.rows.items.is_empty());
    assert!(last.rows.next.is_none());
}

async fn retained_structural_snapshot(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let engine = runtime.engine();
    engine.bucket_list_at_checkpoint_for_test(&scope, "labels");
    let project = create_project(store, &owner).await;
    let child = FolderId::from_bytes(random_bytes());
    store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: child.clone(),
            parent: Some(project.clone()),
            slug: "moving".into(),
            display_name: "Moving".into(),
            is_project: false,
            project_slug: None,
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();

    let carrier = "---\nlabels: [entry-0]\n---\n# Target\n";
    let target = note(store, &owner, "target", DocClass::UserDoc, carrier.into()).await;
    // Packed string values use the first 12 low bits of their typed digest.
    let bucket = |value: &str| {
        let hash = blake3::hash(&[&[2][..], value.as_bytes()].concat());
        u16::from_be_bytes([hash.as_bytes()[0], hash.as_bytes()[1]]) & 0x0fff
    };
    let collision = (1..65_536)
        .map(|i| format!("entry-{i}"))
        .find(|value| bucket(value) == bucket("entry-0"))
        .unwrap();
    let decoy = note(
        store,
        &owner,
        "decoy",
        DocClass::UserDoc,
        format!("---\nlabels: [{collision}]\n---\n# Decoy\n"),
    )
    .await;
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    sync(store, runtime, &scope).await;
    engine.checkpoint_for_test(&scope, head).await.unwrap();
    let old = engine
        .acquire_snapshot(owner.clone(), CausalBasis::Exact(Default::default()))
        .await
        .unwrap();
    assert_eq!(old.cut().projected_seq, head);

    let plan = notarium_syntax::frontmatter::set_field(
        carrier,
        DocClass::UserDoc,
        "labels",
        YamlValue::Sequence(vec![YamlValue::String(collision)]),
    )
    .unwrap();
    let mut edit = mutation(
        &owner,
        EditNote {
            note: target.note.clone(),
            plan,
        },
    );
    edit.preconditions.revision = Some(target.revision);
    store.edit_note(owner.clone(), edit).await.unwrap();
    store
        .move_folder(
            owner.clone(),
            mutation(
                &owner,
                MoveFolder {
                    folder: child.clone(),
                    new_parent: None,
                },
            ),
        )
        .await
        .unwrap();
    sync(store, runtime, &scope).await;

    let filter = FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::Contains {
            key: "labels".into(),
            value: ScalarValue::String("entry-0".into()),
        },
    };
    assert_eq!(
        old.folder_descendants(&project).await.unwrap(),
        vec![project.clone(), child.clone()]
    );
    assert_eq!(
        old.enclosing_project(&child).await.unwrap(),
        Some(project.clone())
    );
    let (matched, rest) = (
        old.lookup(&target.note).unwrap().unwrap(),
        old.lookup(&decoy.note).unwrap().unwrap(),
    );
    let historical = old
        .filter_notes(&filter)
        .await
        .unwrap()
        .unwrap()
        .collect::<Vec<_>>();
    assert_eq!(historical, vec![matched]);
    assert!(!historical.contains(&rest));

    let new = engine
        .acquire_snapshot(owner, CausalBasis::Exact(Default::default()))
        .await
        .unwrap();
    assert!(new.cut().projected_seq > head);
    assert_eq!(
        new.folder_descendants(&project).await.unwrap(),
        vec![project]
    );
    assert_eq!(new.enclosing_project(&child).await.unwrap(), None);
    assert!(
        new.filter_notes(&filter)
            .await
            .unwrap()
            .unwrap()
            .next()
            .is_none()
    );
}

async fn scoped_graph(store: &CanonicalStore, runtime: &ProjectorRuntime) {
    let (scope, owner) = open_space(store).await;
    let project = create_project(store, &owner).await;
    let child = FolderId::from_bytes(random_bytes());
    let (_, child_revision, _) = store
        .create_folder(CreateFolderSpec {
            scope: scope.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: child.clone(),
            parent: Some(project.clone()),
            slug: "nested".into(),
            display_name: "Nested".into(),
            is_project: false,
            project_slug: None,
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let focal = project_note(store, &owner, &project, "focal", "# Focal\n".into()).await;
    let outside = note(
        store,
        &owner,
        "outside-project",
        DocClass::UserDoc,
        format!("[[{focal}]]\n"),
    )
    .await;
    let source = project_note(
        store,
        &owner,
        &project,
        "project-source",
        format!(
            "---\ntags: [Rust]\n---\n\n[[{}]]\n[[{focal}]]\n",
            outside.note
        ),
    )
    .await;
    sync(store, runtime, &scope).await;

    let scoped = scoped_reader(&owner, &project);
    let engine = runtime.engine();
    let snapshot = engine
        .acquire_snapshot(scoped.clone(), CausalBasis::Await(Default::default()))
        .await
        .unwrap();
    assert_eq!(
        snapshot.folder_descendants(&project).await.unwrap(),
        vec![project.clone(), child.clone()]
    );
    assert_eq!(
        snapshot.enclosing_project(&child).await.unwrap(),
        Some(project.clone())
    );
    let root = store
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .root_folder_id;
    assert!(matches!(
        snapshot.folder_descendants(&root).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert_eq!(
        snapshot
            .doc_class(snapshot.lookup(&focal).unwrap().unwrap())
            .unwrap(),
        DocClass::UserDoc
    );
    let predicate = FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::Not(Box::new(Predicate::IsAbsent { key: "tags".into() })),
    };
    let filtered: Vec<_> = snapshot
        .filter_notes(&predicate)
        .await
        .unwrap()
        .unwrap()
        .map(|node| snapshot.note_id(node).unwrap())
        .collect();
    assert_eq!(filtered, vec![source.clone()]);
    assert!(snapshot.filter_notes(&filter()).await.unwrap().is_none());
    {
        let _hold = engine.pause_before_projection_for_test(&scope, 1).unwrap();
        store
            .set_folder_lifecycle(
                &scope,
                LeaseEpoch::new(1).unwrap(),
                &child,
                &child_revision,
                Lifecycle::Trashed,
                owner.auth().principal(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            snapshot.folder_descendants(&project).await.unwrap(),
            vec![project.clone()]
        );
        assert!(matches!(
            snapshot.enclosing_project(&child).await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
    }
    sync(store, runtime, &scope).await;
    let allowed = BTreeSet::from([
        GraphNodeId::Note(source.clone()),
        GraphNodeId::Note(focal.clone()),
    ]);
    let result = engine
        .query_graph(
            scoped.clone(),
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: focal.clone(),
                    hops: 2,
                },
                filter: filter(),
            },
        )
        .await
        .expect("a project grant can enter its own graph");
    assert_eq!(
        result
            .nodes
            .iter()
            .map(|node| node.id.clone())
            .collect::<BTreeSet<_>>(),
        allowed
    );
    assert_eq!(
        result.hidden_count, 0,
        "unauthorized notes outside the project grant must never leak via hidden_count"
    );
    assert_eq!(result.edges.len(), 1);
    assert_eq!(result.edges[0].source, GraphNodeId::Note(source.clone()));
    assert_eq!(result.edges[0].target, GraphNodeId::Note(focal.clone()));

    let filtered_neighborhood = engine
        .query_graph(
            scoped.clone(),
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: focal.clone(),
                    hops: 2,
                },
                filter: FieldFilterAstV1 {
                    version: 1,
                    predicate: Predicate::IsAbsent { key: "tags".into() },
                },
            },
        )
        .await
        .expect("user filter hides authorized neighbors via hidden_count");
    assert_eq!(filtered_neighborhood.nodes.len(), 1);
    assert_eq!(filtered_neighborhood.hidden_count, 1);

    let lens = engine
        .query_graph(
            scoped.clone(),
            GraphQuery {
                tier: GraphTier::Lens {
                    cluster: None,
                    project: Some(project),
                    tags: vec!["RUST".into()],
                },
                filter: filter(),
            },
        )
        .await
        .unwrap();
    assert_eq!(lens.nodes.len(), 1);
    assert_eq!(lens.nodes[0].id, GraphNodeId::Note(source.clone()));

    let first = engine
        .note_links(
            scoped.clone(),
            &source,
            NoteLinkDirection::Outgoing,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.links.len(), 1);
    assert_eq!(first.links[0].raw_target, outside.note.as_str());
    assert_eq!(first.links[0].target, None);
    assert_eq!(first.links[0].resolved_tier, None);
    let second = engine
        .note_links(
            scoped.clone(),
            &source,
            NoteLinkDirection::Outgoing,
            first.next.as_ref(),
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(second.links[0].target, Some(focal.clone()));
    let incoming = engine
        .note_links(
            scoped.clone(),
            &focal,
            NoteLinkDirection::Incoming,
            None,
            PageLimit::new(20).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(incoming.links.len(), 1);
    assert_eq!(incoming.links[0].source, source);

    let denied_superclusters = engine
        .query_graph(
            scoped.clone(),
            GraphQuery {
                tier: GraphTier::Superclusters,
                filter: filter(),
            },
        )
        .await;
    assert!(
        matches!(
            denied_superclusters,
            Err(PortError::Domain(DomainError::AccessDenied))
        ),
        "project-scoped callers must not observe Space-wide Leiden superclusters: {denied_superclusters:?}"
    );

    let settled = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let graph = engine
                .query_graph(
                    owner.clone(),
                    GraphQuery {
                        tier: GraphTier::Superclusters,
                        filter: filter(),
                    },
                )
                .await
                .unwrap();
            if graph
                .nodes
                .iter()
                .map(|node| node.member_count)
                .sum::<u64>()
                == 3
            {
                break graph;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("the graph settles without another canonical edit");
    assert!(settled.nodes.iter().all(|node| node.card.is_none()));
    assert_eq!(settled.hidden_count, 0);

    let mut trash = mutation(
        &owner,
        DeleteNote {
            note: outside.note,
            disposition: DeleteDisposition::Trash,
        },
    );
    trash.preconditions.revision = Some(outside.revision);
    store.delete_note(owner, trash).await.unwrap();
    let trashed = engine
        .query_graph(
            scoped,
            GraphQuery {
                tier: GraphTier::Neighborhood {
                    note: focal,
                    hops: 2,
                },
                filter: filter(),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        trashed.hidden_count, 0,
        "trash no longer contributes to the hidden count"
    );
    assert_eq!(trashed.edges.len(), 1);
}

const OLD_LINK_TARGET: &str = "Private Link Spelling";

pub(super) struct StaleLinks {
    owner: SpaceContext,
    project: FolderId,
    focal: NoteId,
    bridge: NoteId,
    outside: NoteRevision,
    old_carrier: String,
}

impl StaleLinks {
    pub(super) async fn prepare(store: &CanonicalStore, runtime: &ProjectorRuntime) -> Self {
        let (scope, owner) = open_space(store).await;
        let project = create_project(store, &owner).await;
        let focal = project_note(
            store,
            &owner,
            &project,
            "target",
            format!("---\naliases: [{OLD_LINK_TARGET}]\n---\n\n# Target\n"),
        )
        .await;
        let old_carrier = format!("# Source outside the project\n\n[[{OLD_LINK_TARGET}]]\n");
        let outside = note(
            store,
            &owner,
            "moved-source",
            DocClass::UserDoc,
            old_carrier.clone(),
        )
        .await;
        let bridge = project_note(
            store,
            &owner,
            &project,
            "bridge",
            format!("[[{}]]\n", outside.note),
        )
        .await;
        sync(store, runtime, &scope).await;
        Self {
            owner,
            project,
            focal,
            bridge,
            outside,
            old_carrier,
        }
    }

    pub(super) fn scope(&self) -> &notarium_core::model::HistoryScope {
        self.owner.scope()
    }

    pub(super) async fn exercise(self, store: &CanonicalStore, stopped: &ProjectionEngine) {
        let visible = scoped_reader(&self.owner, &self.project);
        let limit = PageLimit::new(20).unwrap();
        assert!(
            !stopped
                .is_live_visible(&visible, &self.outside.note)
                .await
                .unwrap()
        );

        // Remove the authored link while the note is still outside the project.
        let body = notarium_syntax::frontmatter::analyze(&self.old_carrier, DocClass::UserDoc)
            .unwrap()
            .carrier
            .body;
        let plan = notarium_syntax::patch::plan(
            &self.old_carrier,
            body,
            vec![(CarrierEditOrigin::Body, body, "# Published source\n".into())],
        )
        .unwrap();
        let mut edit = mutation(
            &self.owner,
            EditNote {
                note: self.outside.note.clone(),
                plan,
            },
        );
        edit.preconditions.revision = Some(self.outside.revision);
        let edited = store.edit_note(self.owner.clone(), edit).await.unwrap();
        let mut move_note = mutation(
            &self.owner,
            MoveNote {
                note: self.outside.note.clone(),
                parent: Some(self.project),
                slug: "published-source".into(),
            },
        );
        move_note.preconditions.revision = Some(edited.value.revision);
        let moved = store
            .move_note(self.owner.clone(), move_note)
            .await
            .unwrap();
        assert!(
            stopped
                .is_live_visible(&visible, &self.outside.note)
                .await
                .unwrap()
        );

        let owner_incoming = stopped
            .note_links(
                self.owner,
                &self.focal,
                NoteLinkDirection::Incoming,
                None,
                limit,
            )
            .await
            .unwrap();
        assert!(owner_incoming.cut.projected_seq < moved.receipt.seq());
        assert_eq!(owner_incoming.links.len(), 1);
        assert_eq!(owner_incoming.links[0].source, self.outside.note);
        assert_eq!(owner_incoming.links[0].raw_target, OLD_LINK_TARGET);

        assert!(matches!(
            stopped
                .note_links(
                    visible.clone(),
                    &self.outside.note,
                    NoteLinkDirection::Outgoing,
                    None,
                    limit
                )
                .await,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ));
        let incoming = stopped
            .note_links(
                visible.clone(),
                &self.focal,
                NoteLinkDirection::Incoming,
                None,
                limit,
            )
            .await
            .unwrap();
        assert!(
            incoming.links.is_empty(),
            "a moved source cannot disclose an earlier raw target"
        );
        let bridge = stopped
            .note_links(
                visible,
                &self.bridge,
                NoteLinkDirection::Outgoing,
                None,
                limit,
            )
            .await
            .unwrap();
        assert_eq!(bridge.links.len(), 1);
        assert_eq!(bridge.links[0].raw_target, self.outside.note.as_str());
        assert_eq!(bridge.links[0].target, None);
        assert_eq!(bridge.links[0].resolved_tier, None);
    }
}

async fn create_project(store: &CanonicalStore, owner: &SpaceContext) -> FolderId {
    let project = FolderId::from_bytes(random_bytes());
    store
        .create_folder(CreateFolderSpec {
            scope: owner.scope().clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            folder_id: project.clone(),
            parent: None,
            slug: "graph-project".into(),
            display_name: "Graph project".into(),
            is_project: true,
            project_slug: Some("graph-project".into()),
            actor: owner.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    project
}

fn scoped_reader(owner: &SpaceContext, project: &FolderId) -> SpaceContext {
    let mut grants = owner.auth().spaces().clone();
    let grant = grants.get_mut(&owner.scope().space_id).unwrap();
    grant.project_root = Some(project.clone());
    grant.role = SpaceRole::Viewer;
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        PrincipalId::from_bytes(random_bytes()),
        GrantId::from_bytes(random_bytes()),
        grants,
        false,
    ));
    SpaceContext::new(auth, owner.scope().clone(), budget()).unwrap()
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

fn filter() -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(Vec::new()),
    }
}

fn note_id(row: &ViewRow) -> &NoteId {
    &row.card.document.provenance().reference().note_id
}

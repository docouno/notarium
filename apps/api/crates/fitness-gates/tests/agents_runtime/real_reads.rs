//! Exercise MCP reads against current and deliberately lagging projections.
use super::*;
use notarium_canonical::CreateFolderSpec;
use notarium_core::model::FolderRef;
use notarium_projections::{
    ProjectedNoteReadPort, ProjectionConfig, ProjectionEngine, ProjectorRuntime,
};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
};

pub(super) struct DerivedReads {
    pub projection_calls: std::sync::Mutex<Vec<(std::time::Duration, Option<SpaceSeq>)>>,
    pub notes: ProjectedNoteReadPort,
    pub projection: Arc<ProjectionEngine>,
    pub search: Arc<SearchEngine>,
}

async fn create(
    fixture: &RuntimeFixture,
    key: u8,
    project: &str,
    title: &str,
    body: &str,
) -> Value {
    let created = call(
        fixture,
        &fixture.human,
        key,
        "create_note",
        json!({"project": project, "title": title, "body": body}),
    )
    .await
    .unwrap();
    created.structured_content["noteId"].clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn project_scoped_mcp_reads_follow_committed_changes() {
    let fixture = RuntimeFixture::open_named(false, "mcp_derived_reads").await;
    let space = fixture.personal_scope().await;
    let root = DataRoot::new(fixture.storage.root.as_ref().unwrap());
    let projector = ProjectorRuntime::start_sqlite(
        fixture.canonical.clone(),
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Projection),
            budget: budget(),
        },
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let projection = projector.engine();
    let search = Arc::new(SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(Arc::new(fixture.canonical.clone()), projection.clone()),
    ));
    search.start_space(space.scope().clone()).unwrap();
    assert!(
        fixture
            .projections
            .real
            .set(DerivedReads {
                projection_calls: Default::default(),
                notes: projection.note_reads(),
                projection: projection.clone(),
                search: search.clone(),
            })
            .is_ok()
    );

    let home = fixture
        .canonical
        .read_space(&space.scope().space_id)
        .await
        .unwrap();
    let project_id = FolderId::from_bytes([61; 16]);
    for (id, slug) in [
        (project_id.clone(), "guides"),
        (FolderId::from_bytes([62; 16]), "private"),
    ] {
        fixture
            .canonical
            .create_folder(CreateFolderSpec {
                scope: space.scope().clone(),
                active_epoch: home.active_epoch,
                folder_id: id,
                parent: None,
                slug: slug.into(),
                display_name: slug.into(),
                is_project: true,
                project_slug: Some(slug.into()),
                actor: fixture.human.auth().principal().clone(),
                timestamp: None,
            })
            .await
            .unwrap();
    }
    let project = format!("{}/guides", home.slug);
    let sibling = format!("{}/private", home.slug);
    let views = [64, 65]
        .into_iter()
        .map(|byte| {
            let key = ViewKey::from_bytes([byte; 16]);
            format!(
                "```nota\nid: {key}\ntype: table\nsource: {{scope: space, tags: [library]}}\n```\n"
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let view = create(&fixture, 1, &project, "Reading list", &views).await;
    let body = "---\ntags: [library]\n---\nA concordance for archival research.\n";
    let inside = create(&fixture, 2, &project, "Available", body).await;
    let outside = create(&fixture, 3, &sibling, "Restricted", body).await;
    let reader = fixture.pat(BearerScope::Read, false).await;
    let scoped = AccountContext::new(
        reader
            .auth()
            .restrict_to_project(&FolderRef {
                space_id: home.space.id.clone(),
                folder_id: project_id.clone(),
            })
            .unwrap(),
        budget(),
    );
    let denied = call(&fixture, &scoped, 4, "get_note", json!({"ref": outside})).await;
    assert!(matches!(
        denied,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));

    let bootstrap = call(
        &fixture,
        &scoped,
        12,
        "start_session",
        json!({"project":project, "acknowledge":false}),
    )
    .await
    .unwrap();
    let overview = &bootstrap.structured_content["project"];
    assert_eq!(overview["index"]["noteCount"], 2);
    assert_eq!(overview["knownValues"]["tags"], json!(["library"]));

    let directory = call(
        &fixture,
        &scoped,
        5,
        "list_notes",
        json!({"project": project, "tag":"library"}),
    )
    .await
    .unwrap();
    assert_eq!(directory.structured_content["total"], 1);
    assert_eq!(directory.structured_content["items"][0]["noteId"], inside);
    let rendered = call(&fixture, &scoped, 6, "get_note", json!({"ref": view}))
        .await
        .unwrap();
    let table = &rendered.structured_content["views"][0];
    assert_eq!(table["status"], "ready", "{table}");
    assert_eq!(table["rows"].as_array().unwrap().len(), 1);
    assert_eq!(table["rows"][0]["id"], inside);

    for (key, tool, field) in [(7, "search", "results"), (8, "recall", "sources")] {
        let mut input = json!({"query":"concordance", "project":project});
        if tool == "recall" {
            input["depth"] = json!(3);
        }
        let result = call(&fixture, &scoped, key, tool, input).await.unwrap();
        let hits = result.structured_content[field].as_array().unwrap();
        assert_eq!(hits.len(), 1, "{hits:?}");
        assert_eq!(hits[0]["noteId"], inside);
    }

    let mut pause = projection
        .pause_before_projection_for_test(space.scope(), 1)
        .unwrap();
    let added = create(
        &fixture,
        13,
        &project,
        "Further reading",
        "---\ntags: [library]\n---\nNew material.\n",
    )
    .await;
    let held = tokio::time::timeout(budget().remaining, pause.reached())
        .await
        .unwrap()
        .unwrap();

    // View evaluation waits briefly for the newly added member. The graph's
    // best-effort port can still return its older cut during this same call.
    let observed = &fixture.projections.real.get().unwrap().projection_calls;
    observed.lock().unwrap().clear();
    let pending = call(&fixture, &scoped, 14, "get_note", json!({"ref":view}))
        .await
        .unwrap();
    assert_eq!(
        pending.structured_content["views"][0]["status"],
        "incomplete"
    );
    assert_eq!(pending.structured_content["links"]["status"], "incomplete");
    {
        let calls = observed.lock().unwrap();
        assert_eq!(calls.len(), 3, "two views followed by a graph request");
        assert_eq!(calls[0].1, Some(held.last_seq));
        assert_eq!(calls[1].1, Some(held.last_seq));
        assert_eq!(calls[2].1, None);
        assert!(
            calls.windows(2).all(|pair| pair[1].0 < pair[0].0),
            "each read must receive only the remaining call budget"
        );
    }
    pause.resume_for_test().await.unwrap();

    call(
        &fixture,
        &fixture.human,
        9,
        "delete_note",
        json!({"ref":inside}),
    )
    .await
    .unwrap();
    let after = call(
        &fixture,
        &scoped,
        10,
        "search",
        json!({"query":"concordance", "project":project}),
    )
    .await
    .unwrap();
    assert_eq!(after.structured_content["results"], json!([]));
    let after = call(&fixture, &scoped, 11, "get_note", json!({"ref": view}))
        .await
        .unwrap();
    let table = &after.structured_content["views"][0];
    assert_eq!(table["status"], "ready");
    assert_eq!(table["rows"].as_array().unwrap().len(), 1);
    assert_eq!(table["rows"][0]["id"], added);
    assert_eq!(after.structured_content["links"]["status"], "ready");

    recall_packs_after_recipient_consent(&fixture, &space, &project, &project_id).await;

    search.shutdown().await;
    projector.shutdown().await.unwrap();
    fixture.close().await;
}

async fn recall_packs_after_recipient_consent(
    fixture: &RuntimeFixture,
    space: &SpaceContext,
    project: &str,
    project_id: &FolderId,
) {
    use notarium_core::{auth::ChatAudience, classes::DocClass};
    use runtime_ability_cases::{approve_disclosure, loopback_provider};
    let allowed = NoteId::from_bytes([73; 16]);
    let mut creates = Vec::new();
    for (tag, class, title, extra) in [
        (
            71,
            DocClass::AgentMemory,
            "Recallrank triorank alpha",
            "triorank",
        ),
        (
            72,
            DocClass::AgentMemory,
            "Recallrank triorank bravo",
            "triorank",
        ),
        (73, DocClass::UserDoc, "Available evidence", "triorank"),
    ]
    .into_iter()
    .chain((100..198).map(|tag| (tag, DocClass::AgentMemory, "Recallrank memory", "")))
    {
        creates.push(Mutation {
            identity: CommandIdentity {
                scope: space.scope().clone(),
                actor: space.auth().principal().clone(),
                key: CommandKey::from_bytes([tag; 16]),
                hash: ContentDigest::from_bytes([tag; 32]),
            },
            preconditions: Preconditions::default(),
            input: BatchItem::Create(CreateNote {
                note: NoteId::from_bytes([tag; 16]),
                parent: Some(project_id.clone()),
                slug: format!("ranked-{tag}"),
                class,
                carrier: format!(
                    "# {title}\n\nrecallrank {extra} {}\n",
                    "evidence ".repeat(18)
                ),
                folder_page: false,
            }),
        });
    }
    let mut head = SpaceSeq::ZERO;
    for items in creates.chunks(50) {
        let batch = fixture
            .canonical
            .accept_batch(
                space.clone(),
                AcceptBatch {
                    items: items.to_vec(),
                },
            )
            .await
            .unwrap();
        assert!(batch.items.iter().all(Result::is_ok), "{:?}", batch.items);
        head = batch.committed_high_watermark;
    }
    let reads = fixture.projections.real.get().unwrap();
    reads
        .projection
        .wait_for_projected(space.scope(), head, &budget())
        .await
        .unwrap();
    let query = SearchQuery {
        text: "recallrank".into(),
        filter: notarium_core::query::FieldFilterAstV1 {
            version: 1,
            predicate: notarium_core::query::Predicate::All(vec![]),
        },
        classes: [DocClass::AgentMemory, DocClass::UserDoc].into(),
        folder: Some(project_id.clone()),
        causal: CausalBasis::Await(notarium_core::receipt::AwaitWatermarks::at(
            space.scope().clone(),
            head,
        )),
        include_chats: false,
        top_k: PageLimit::new(200).unwrap(),
        model: None,
    };
    let all = reads
        .search
        .search(space.clone(), query.clone())
        .await
        .unwrap();
    assert_eq!(all.hits.len(), 101);
    assert_eq!(
        all.hits[100].card.document.provenance().reference().note_id,
        allowed
    );
    assert!(!all.truncated);

    struct OnlyClass(DocClass);
    impl SearchRecipient for OnlyClass {
        fn admit<'a>(
            &'a self,
            card: &'a notarium_core::classes::ClassifiedMetadata,
        ) -> PortFuture<'a, bool> {
            Box::pin(async move { Ok(card.class() == self.0) })
        }
    }
    let first = SearchQuery {
        text: "triorank".into(),
        top_k: PageLimit::new(1).unwrap(),
        ..query
    };
    for (class, has_more) in [(DocClass::UserDoc, false), (DocClass::AgentMemory, true)] {
        let admitted = reads
            .search
            .search_for(space.clone(), first.clone(), Some(&OnlyClass(class)))
            .await
            .unwrap();
        assert_eq!(admitted.hits.len(), 1);
        assert_eq!(admitted.hits[0].card.document.provenance().class(), class);
        assert_eq!(admitted.truncated, has_more);
    }

    let all = call(
        fixture,
        &fixture.human,
        74,
        "search",
        json!({"query":"triorank", "project":project}),
    )
    .await
    .unwrap();
    let ranked = all.structured_content["results"].as_array().unwrap();
    assert_eq!(ranked.len(), 3);
    assert_eq!(ranked[2]["noteId"], json!(allowed));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = loopback_provider(fixture, &fixture.human, &listener, 75, true).await;
    approve_disclosure(
        fixture,
        &fixture.human,
        &local,
        78,
        ProviderAttachmentTarget::Personal {
            owner: fixture.human.auth().principal().clone(),
            space: space.scope().space_id.clone(),
        },
        [DocClass::UserDoc].into(),
    )
    .await;
    let run = fixture
        .human
        .auth()
        .for_agent_run(
            AgentRunId::from_bytes([81; 16]),
            space.scope().space_id.clone(),
            ChatAudience::Personal,
            fixture.human.auth().spaces().clone(),
        )
        .unwrap();
    for (tag, name, field) in [(82, "search", "results"), (83, "recall", "sources")] {
        let args = if name == "recall" {
            json!({"query":"recallrank", "project":project, "depth":0, "budgetTokens":200, "maxPerSource":100})
        } else {
            json!({"query":"triorank", "project":project, "limit":1})
        };
        let result = local
            .registry
            .call_tool(
                McpInvocationContext {
                    account: AccountContext::new(run.clone(), budget()),
                    target: EgressTarget::InAppProvider {
                        provider: local.resource.id.clone(),
                        model: local.model.clone(),
                        primary_project: None,
                    },
                    request_key: CommandKey::from_bytes([tag; 16]),
                },
                name,
                args,
            )
            .await
            .unwrap()
            .structured_content;
        let hits = result[field].as_array().unwrap();
        assert_eq!(hits.len(), 1, "{result}");
        assert_eq!(hits[0]["noteId"], json!(allowed));
        if name == "recall" {
            assert!(
                result["context"]
                    .as_str()
                    .unwrap()
                    .contains("Available evidence")
            );
            let tokens = result["tokens"].as_u64().unwrap();
            assert!((100..=200).contains(&tokens), "{result}");
        }
    }

    // A retained search cut still applies the current folder boundary after a move.
    fixture
        .canonical
        .move_note(
            space.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope().clone(),
                    actor: space.auth().principal().clone(),
                    key: CommandKey::from_bytes([84; 16]),
                    hash: ContentDigest::from_bytes([84; 32]),
                },
                preconditions: Preconditions::default(),
                input: MoveNote {
                    note: allowed.clone(),
                    parent: None,
                    slug: "moved-evidence".into(),
                },
            },
        )
        .await
        .unwrap();
    let metadata = fixture
        .canonical
        .read_search_candidate_metadata(space, head, vec![allowed.clone()])
        .await
        .unwrap();
    let moved = metadata[&allowed].provenance();
    assert_eq!(moved.current_project(), None);
    assert!(!moved.in_project(&FolderRef {
        space_id: space.scope().space_id.clone(),
        folder_id: project_id.clone()
    }));
}

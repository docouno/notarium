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
        assert_eq!(calls[2].1, Some(held.last_seq));
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
    let ranked = [
        (
            71,
            DocClass::AgentMemory,
            "Recallrank triorank alpha",
            "triorank closedquorum",
        ),
        (
            72,
            DocClass::AgentMemory,
            "Recallrank triorank bravo",
            "triorank closedquorum",
        ),
        (73, DocClass::UserDoc, "Available evidence", "triorank"),
    ]
    .into_iter()
    .chain((100..198).map(|tag| {
        let extra = match tag {
            100..110 => "tenquorum",
            110 => "onlyweaklink [[ranked-00000000000000000000000000000001]]",
            _ => "",
        };
        (tag, DocClass::AgentMemory, "Recallrank memory", extra)
    }))
    .map(|(tag, class, title, extra)| {
        let body = format!(
            "recallrank {extra} windowprobe exactprobe {}",
            "evidence ".repeat(18)
        );
        ([tag; 16], class, title, body)
    });
    // Of 801 notes matching windowprobe, exactly 800 also match exactprobe.
    let boundary = (1_u128..=700).map(|index| {
        let body = if index < 700 {
            "windowprobe exactprobe"
        } else {
            "windowprobe"
        };
        (
            index.to_be_bytes(),
            DocClass::AgentMemory,
            "Memory",
            body.to_owned(),
        )
    });
    for (key, class, title, body) in ranked.chain(boundary) {
        let note = NoteId::from_bytes(key);
        creates.push(Mutation {
            identity: CommandIdentity {
                scope: space.scope().clone(),
                actor: space.auth().principal().clone(),
                key: CommandKey::from_bytes(key),
                hash: ContentDigest::from_bytes(*blake3::hash(&key).as_bytes()),
            },
            preconditions: Preconditions::default(),
            input: BatchItem::Create(CreateNote {
                slug: format!("ranked-{:032x}", u128::from_be_bytes(key)),
                note,
                parent: Some(project_id.clone()),
                class,
                carrier: format!("# {title}\n\n{body}\n"),
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

    struct OnlyClass {
        class: DocClass,
        inspected: std::sync::atomic::AtomicUsize,
    }
    impl OnlyClass {
        fn new(class: DocClass) -> Self {
            Self {
                class,
                inspected: Default::default(),
            }
        }
    }
    impl SearchRecipient for OnlyClass {
        fn admit<'a>(
            &'a self,
            card: &'a notarium_core::classes::ClassifiedMetadata,
        ) -> PortFuture<'a, bool> {
            self.inspected
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Box::pin(async move { Ok(card.class() == self.class) })
        }
    }
    recipient_graph_paths(
        fixture,
        space,
        project_id,
        &query,
        &OnlyClass::new(DocClass::UserDoc),
    )
    .await;
    let first = SearchQuery {
        top_k: PageLimit::new(1).unwrap(),
        ..query
    };
    for text in [
        "recallrank neverpresentz neverpresentq",
        "recallrank closedquorum neverpresentq",
    ] {
        // The best admitted one-clause match ranks behind 100 closed notes.
        let recipient = OnlyClass::new(DocClass::UserDoc);
        let relaxed = reads
            .search
            .search_for(
                space.clone(),
                SearchQuery {
                    text: text.into(),
                    ..first.clone()
                },
                Some(&recipient),
            )
            .await
            .unwrap();
        assert_eq!(relaxed.hits.len(), 1, "{text}");
        assert_eq!(
            relaxed.hits[0]
                .card
                .document
                .provenance()
                .reference()
                .note_id,
            allowed
        );
        assert!(!relaxed.truncated);
        assert_eq!(recipient.inspected.into_inner(), 101);
    }
    for (term, depth) in [("neverpresentz", 0), ("closedquorum", 0), ("tenquorum", 1)] {
        let recipient = OnlyClass::new(DocClass::AgentMemory);
        let mixed = reads
            .search
            .recall_for(
                space.clone(),
                RecallQuery {
                    query: SearchQuery {
                        text: format!("recallrank {term} neverpresentq"),
                        top_k: PageLimit::new(20).unwrap(),
                        ..first.clone()
                    },
                    graph_depth: depth,
                    token_budget: 32_768,
                    max_per_source: None,
                },
                Some(&recipient),
            )
            .await
            .unwrap();
        // Zero, two, or ten strict notes fill the same floor. Once full,
        // additional weak matches cannot contribute RRF votes or graph seeds.
        assert_eq!(mixed.hits.len(), 10, "{term}");
        assert!(!mixed.truncated, "{term}");
        if term == "tenquorum" {
            let ids: BTreeSet<_> = mixed
                .hits
                .iter()
                .map(|hit| hit.card.document.provenance().reference().note_id.clone())
                .collect();
            assert_eq!(
                ids,
                (100..110)
                    .map(|tag| NoteId::from_bytes([tag; 16]))
                    .collect()
            );
            assert_eq!(recipient.inspected.into_inner(), 10);
        }
    }
    let recalled = reads
        .search
        .recall_for(
            space.clone(),
            RecallQuery {
                query: first.clone(),
                graph_depth: 0,
                token_budget: 4096,
                max_per_source: None,
            },
            Some(&OnlyClass::new(DocClass::UserDoc)),
        )
        .await
        .unwrap();
    assert_eq!(recalled.hits.len(), 1);
    assert_eq!(
        recalled.hits[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        allowed
    );
    assert!(!recalled.truncated);
    for (text, overflow) in [("exactprobe", false), ("windowprobe", true)] {
        // The extra note is only a rank witness and never reaches admission.
        let recipient = OnlyClass::new(DocClass::Skill);
        let denied = reads
            .search
            .search_for(
                space.clone(),
                SearchQuery {
                    text: text.into(),
                    ..first.clone()
                },
                Some(&recipient),
            )
            .await
            .unwrap();
        assert!(denied.hits.is_empty());
        assert_eq!(denied.truncated, overflow, "{text}");
        assert_eq!(recipient.inspected.into_inner(), 800);
    }
    let first = SearchQuery {
        text: "triorank".into(),
        ..first
    };
    for (class, has_more) in [(DocClass::UserDoc, false), (DocClass::AgentMemory, true)] {
        let admitted = reads
            .search
            .search_for(space.clone(), first.clone(), Some(&OnlyClass::new(class)))
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
            json!({"query":"recallrank closedquorum neverpresentq", "project":project, "depth":0, "budgetTokens":200, "maxPerSource":100})
        } else {
            json!({"query":"recallrank neverpresentz neverpresentq", "project":project, "limit":1})
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
        assert!(result.get("truncated").is_none());
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

async fn recipient_graph_paths(
    fixture: &RuntimeFixture,
    space: &SpaceContext,
    folder: &FolderId,
    base: &SearchQuery,
    recipient: &dyn SearchRecipient,
) {
    use notarium_core::classes::DocClass::{AgentMemory, UserDoc};
    let id = |n: u8| NoteId::from_bytes((10_000 + u128::from(n)).to_be_bytes());
    let nodes = [
        (1, UserDoc, "exit", "End", ""),
        (
            2,
            AgentMemory,
            "hidden-seed",
            "Hiddenseedmarker",
            "[[gated-exit]]",
        ),
        (3, UserDoc, "deep-exit", "Deep exit", ""),
        (4, AgentMemory, "bridge", "Bridge", "[[gated-deep-exit]]"),
        (5, UserDoc, "friend", "Friend", ""),
        (
            6,
            UserDoc,
            "start",
            "Visiblepathmarker",
            "[[gated-bridge]] [[gated-friend]]",
        ),
        (7, UserDoc, "late-exit", "Late exit", ""),
        (
            8,
            UserDoc,
            "late-start",
            "Late start",
            "lateseedmarker latecontrol [[gated-late-exit]]",
        ),
    ];
    let notes = nodes
        .into_iter()
        .map(|(n, class, slug, title, body)| (n, class, slug.to_owned(), title, body))
        .chain((16..32).map(|n| {
            (
                n,
                AgentMemory,
                format!("closed-{n}"),
                "Lateseedmarker",
                "lateseedmarker",
            )
        }));
    let items = notes
        .map(|(n, class, slug, title, body)| {
            let key = (10_000 + u128::from(n)).to_be_bytes();
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope().clone(),
                    actor: space.auth().principal().clone(),
                    key: CommandKey::from_bytes(key),
                    hash: ContentDigest::from_bytes(*blake3::hash(&key).as_bytes()),
                },
                preconditions: Preconditions::default(),
                input: BatchItem::Create(CreateNote {
                    note: id(n),
                    parent: Some(folder.clone()),
                    slug: format!("gated-{slug}"),
                    class,
                    carrier: format!("---\ntitle: {title}\n---\n{body}\n"),
                    folder_page: false,
                }),
            }
        })
        .collect();
    let committed = fixture
        .canonical
        .accept_batch(space.clone(), AcceptBatch { items })
        .await
        .unwrap();
    assert!(
        committed.items.iter().all(Result::is_ok),
        "{:?}",
        committed.items
    );
    let engine = &fixture.projections.real.get().unwrap().search;
    let query = |text: &str| SearchQuery {
        text: text.into(),
        causal: CausalBasis::Await(notarium_core::receipt::AwaitWatermarks::at(
            space.scope().clone(),
            committed.committed_high_watermark,
        )),
        ..base.clone()
    };
    let ranked = engine
        .search(space.clone(), query("lateseedmarker"))
        .await
        .unwrap();
    assert_eq!(ranked.hits.len(), 17);
    assert_eq!(
        ranked.hits[16]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        id(8)
    );
    for (text, depth, ordinary_goal, expected) in [
        ("hiddenseedmarker", 1, 1, vec![]),
        ("visiblepathmarker", 2, 3, vec![5, 6]),
        ("visiblepathmarker", 3, 3, vec![5, 6]),
        ("latecontrol", 1, 7, vec![7, 8]),
        ("lateseedmarker", 1, 8, vec![7, 8]),
    ] {
        let request = RecallQuery {
            query: query(text),
            graph_depth: depth,
            token_budget: 16_384,
            max_per_source: None,
        };
        let ordinary = engine.recall(space.clone(), request.clone()).await.unwrap();
        assert!(
            ordinary
                .hits
                .iter()
                .any(|hit| hit.card.document.provenance().reference().note_id == id(ordinary_goal)),
            "ordinary {text}"
        );
        let delivered = engine
            .recall_for(space.clone(), request, Some(recipient))
            .await
            .unwrap();
        let ids: BTreeSet<_> = delivered
            .hits
            .iter()
            .map(|hit| hit.card.document.provenance().reference().note_id.clone())
            .collect();
        assert_eq!(
            ids,
            expected.into_iter().map(id).collect(),
            "{text} at depth {depth}"
        );
        if text == "visiblepathmarker" {
            let friend = delivered
                .hits
                .iter()
                .find(|hit| hit.card.document.provenance().reference().note_id == id(5))
                .unwrap();
            let expected_score = 0.25_f64 / (61.0 * (1.0 + 2.0_f64.ln()));
            assert!(
                (friend.score - expected_score).abs() < 1e-9,
                "a denied neighbor must not affect the boost"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sqlite_incremental_folder_cover_and_predicates() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    exercise_incremental_folder_cover_and_predicates(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn postgres_incremental_folder_cover_and_predicates() {
    let _guard = support::AUTH_TEST_LOCK.lock().await;
    exercise_incremental_folder_cover_and_predicates(true).await;
}

async fn exercise_incremental_folder_cover_and_predicates(pg: bool) {
    let fixture = RuntimeFixture::open_named(pg, "mcp_incremental_cover").await;
    let space = fixture.personal_scope().await;
    let root = DataRoot::new(
        fixture
            .storage
            .root
            .as_ref()
            .or(fixture.temporary_blob_root.as_ref())
            .unwrap(),
    );
    let mut pg_pool = None;
    let projector = if pg {
        let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../.artifacts/control-db-fixture/active.json");
        let desc: Value = serde_json::from_slice(&std::fs::read(descriptor).unwrap()).unwrap();
        let socket = desc["socket"].as_str().unwrap();
        let options = sqlx::postgres::PgConnectOptions::new_without_pgpass()
            .socket(socket)
            .port(5432)
            .username("postgres")
            .database("auth_mcp_incremental_cover");
        let pool = sqlx::PgPool::connect_with(options).await.unwrap();
        let proj = ProjectorRuntime::start_postgres_ephemeral(
            fixture.canonical.clone(),
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Projection),
                budget: budget(),
            },
            pool.clone(),
            "proj_inc_cover",
            root.clone(),
            ProjectionGeneration::new(1).unwrap(),
            ProjectionConfig::default(),
        )
        .await
        .unwrap();
        pg_pool = Some(pool);
        proj
    } else {
        ProjectorRuntime::start_sqlite(
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
        .unwrap()
    };
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
    let project_id = FolderId::from_bytes([71; 16]);
    fixture
        .canonical
        .create_folder(CreateFolderSpec {
            scope: space.scope().clone(),
            active_epoch: home.active_epoch,
            folder_id: project_id.clone(),
            parent: None,
            slug: "atlas".into(),
            display_name: "Atlas".into(),
            is_project: true,
            project_slug: Some("atlas".into()),
            actor: fixture.human.auth().principal().clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let project = format!("{}/atlas", home.slug);

    // 1. Space-root cover note must surface `folderPage.status == "present"` in `get_note`.
    let root_cover_id = NoteId::from_bytes([72; 16]);
    fixture
        .canonical
        .create_note(
            space.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope().clone(),
                    actor: fixture.human.auth().principal().clone(),
                    key: CommandKey::from_bytes([72; 16]),
                    hash: ContentDigest::from_bytes([72; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: root_cover_id.clone(),
                    parent: None,
                    slug: "index".into(),
                    class: notarium_core::classes::DocClass::UserDoc,
                    carrier: "# Space Home\n\nRoot cover.\n".into(),
                    folder_page: true,
                },
            },
        )
        .await
        .unwrap();
    let root_get = call(
        &fixture,
        &fixture.human,
        72,
        "get_note",
        json!({"ref": root_cover_id}),
    )
    .await
    .unwrap();
    assert_eq!(
        root_get.structured_content["folderPage"]["status"],
        "present"
    );

    // 2. Project folder page assignment must propagate incrementally via `"folder"` change_log event.
    let cover = call(
        &fixture,
        &fixture.human,
        73,
        "create_note",
        json!({
            "project": project,
            "path": "docs",
            "title": "Docs Cover",
            "body": "# Docs Cover\n",
            "folderPage": true,
        }),
    )
    .await
    .unwrap();
    let cover_id = cover.structured_content["noteId"]
        .as_str()
        .unwrap()
        .to_owned();
    let listed = call(
        &fixture,
        &fixture.human,
        74,
        "list_notes",
        json!({"project": project, "path": "docs"}),
    )
    .await
    .unwrap();
    assert_eq!(
        listed.structured_content["folderPage"]["status"], "present",
        "{}",
        listed.structured_content
    );
    assert_eq!(listed.structured_content["folderPage"]["noteId"], cover_id);
    assert_eq!(listed.structured_content["items"], json!([]));
    assert_eq!(listed.structured_content["total"], 0);

    // Trashing the cover note clears projected_folders.cover_note_id incrementally.
    call(
        &fixture,
        &fixture.human,
        75,
        "delete_note",
        json!({"ref": cover_id}),
    )
    .await
    .unwrap();
    let after_trash = call(
        &fixture,
        &fixture.human,
        76,
        "list_notes",
        json!({"project": project, "path": "docs"}),
    )
    .await
    .unwrap();
    assert_eq!(
        after_trash.structured_content["folderPage"]["status"],
        "missing"
    );

    // 3. Real #5 field predicates + keyset pagination cursors on both SQLite and PG16.
    fixture
        .canonical
        .update_space_schema(
            space.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: space.scope().clone(),
                    actor: fixture.human.auth().principal().clone(),
                    key: CommandKey::from_bytes([76; 16]),
                    hash: ContentDigest::from_bytes([76; 32]),
                },
                preconditions: Preconditions::default(),
                input: notarium_canonical::UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes([76; 16]),
                    parent: None,
                    slug: "schema".into(),
                    carrier: "---\ntitle: Schema\n---\n".into(),
                    schema: std::collections::BTreeMap::from([(
                        "status".into(),
                        notarium_core::query::FieldSchema {
                            kind: notarium_core::query::FieldType::Scalar(
                                notarium_core::query::ScalarType::String,
                            ),
                            nullable: false,
                        },
                    )]),
                    expected_schema_revision: None,
                },
            },
        )
        .await
        .unwrap();
    let n1 = create(
        &fixture,
        77,
        &project,
        "Alpha",
        "---\nstatus: open\n---\nAlpha body.\n",
    )
    .await;
    let n2 = create(
        &fixture,
        78,
        &project,
        "Beta",
        "---\nstatus: open\n---\nBeta body.\n",
    )
    .await;
    let _n3 = create(
        &fixture,
        79,
        &project,
        "Gamma",
        "---\nstatus: closed\n---\nGamma body.\n",
    )
    .await;
    let page1 = call(
        &fixture,
        &fixture.human,
        80,
        "list_notes",
        json!({"project": project, "field": ["note.status:open"], "limit": 1}),
    )
    .await
    .unwrap();
    assert_eq!(page1.structured_content["total"], 2);
    assert_eq!(
        page1.structured_content["items"].as_array().unwrap().len(),
        1
    );
    let next_cursor = page1.structured_content["nextCursor"].as_str().unwrap();
    let page2 = call(
        &fixture,
        &fixture.human,
        81,
        "list_notes",
        json!({"project": project, "field": ["note.status:open"], "limit": 1, "cursor": next_cursor}),
    )
    .await
    .unwrap();
    assert_eq!(
        page2.structured_content["items"].as_array().unwrap().len(),
        1
    );
    let collected: BTreeSet<String> = [
        page1.structured_content["items"][0]["noteId"]
            .as_str()
            .unwrap()
            .to_owned(),
        page2.structured_content["items"][0]["noteId"]
            .as_str()
            .unwrap()
            .to_owned(),
    ]
    .into_iter()
    .collect();
    let expected_ids: BTreeSet<String> = [
        n1.as_str().unwrap().to_owned(),
        n2.as_str().unwrap().to_owned(),
    ]
    .into_iter()
    .collect();
    assert_eq!(collected, expected_ids);

    search.shutdown().await;
    projector.shutdown().await.unwrap();
    if let Some(pool) = pg_pool {
        for stmt in [
            "DROP SCHEMA IF EXISTS \"proj_inc_cover_g1\" CASCADE",
            "DROP SCHEMA IF EXISTS \"proj_inc_cover_ctrl\" CASCADE",
        ] {
            let _ = sqlx::query(stmt).execute(&pool).await;
        }
        pool.close().await;
    }
    fixture.close().await;
}

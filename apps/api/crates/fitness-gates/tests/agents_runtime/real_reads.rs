//! Read through MCP after both derived readers have observed a canonical write.
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
    pub notes: ProjectedNoteReadPort,
    pub projection: Arc<ProjectionEngine>,
    pub search: Arc<SearchEngine>,
}

async fn wait_for_projection(
    fixture: &RuntimeFixture,
    engine: &ProjectionEngine,
    space: &SpaceContext,
) {
    let head = fixture
        .canonical
        .read_space(&space.scope().space_id)
        .await
        .unwrap();
    engine
        .wait_for_projected(space.scope(), head.last_seq, &budget())
        .await
        .unwrap();
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
    let key = ViewKey::from_bytes([64; 16]);
    let view = create(
        &fixture,
        1,
        &project,
        "Reading list",
        &format!(
            "```nota\nid: {key}\ntype: table\nsource: {{scope: space, tags: [library]}}\n```\n"
        ),
    )
    .await;
    let body = "---\ntags: [library]\n---\nA concordance for archival research.\n";
    let inside = create(&fixture, 2, &project, "Available", body).await;
    let outside = create(&fixture, 3, &sibling, "Restricted", body).await;
    wait_for_projection(&fixture, &projection, &space).await;
    let reader = fixture.pat(BearerScope::Read, false).await;
    let scoped = AccountContext::new(
        reader
            .auth()
            .restrict_to_project(&FolderRef {
                space_id: home.space.id.clone(),
                folder_id: project_id,
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

    call(
        &fixture,
        &fixture.human,
        9,
        "delete_note",
        json!({"ref":inside}),
    )
    .await
    .unwrap();
    wait_for_projection(&fixture, &projection, &space).await;
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
    assert_eq!(after.structured_content["views"][0]["rows"], json!([]));

    search.shutdown().await;
    projector.shutdown().await.unwrap();
    fixture.close().await;
}

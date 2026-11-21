//! Exercise search against the production structural reader on both storage backends.
#[path = "../../notarium-canonical/tests/support/mod.rs"]
mod support;

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    S3BucketModePolicy, UpdateSpaceSchema, blobs::s3::admin_ensure_bucket,
    build_pg_connect_options,
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::{AbilityKind, DocClass},
    epoch::DataRoot,
    ids::*,
    model::{HistoryScope, Lifecycle},
    ports::{
        CreateNote, Mutation, NoteWritePort, PageLimit, PublishAbilityPackage, RecallQuery,
        SearchPort, SearchQuery, SearchResult, ServicePurpose, SpaceContext,
    },
    query::{FieldFilterAstV1, FieldSchema, FieldType, Predicate, ScalarType},
    receipt::{AwaitWatermarks, CausalBasis, CommandIdentity, MutationReceiptToken},
    value::ScalarValue,
};
use notarium_projections::{ProjectionConfig, ProjectorRuntime};
use notarium_search::{
    SearchDependencies, SearchEngine,
    config::{SearchConfig, VectorMode},
};
use std::{collections::BTreeMap, sync::Arc};
use support::{StorageTestFixtures, TempDataRoot, maintenance_ctx, random_bytes_16};

fn mutation<T>(owner: &SpaceContext, input: T) -> Mutation<T> {
    let key = CommandKey::from_bytes(random_bytes_16());
    Mutation {
        identity: CommandIdentity {
            scope: owner.scope().clone(),
            actor: owner.auth().principal().clone(),
            hash: ContentDigest::from_bytes(*blake3::hash(key.as_str().as_bytes()).as_bytes()),
            key,
        },
        preconditions: Default::default(),
        input,
    }
}

fn query(scope: &HistoryScope, after: SpaceSeq, text: &str) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        causal: CausalBasis::Await(AwaitWatermarks::from_receipts([MutationReceiptToken::new(
            scope.clone(),
            after,
        )
        .unwrap()])),
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(Vec::new()),
        },
        classes: Default::default(),
        folder: None,
        model: None,
        include_chats: false,
        top_k: PageLimit::new(10).unwrap(),
    }
}

fn ids(result: &SearchResult) -> Vec<&NoteId> {
    result
        .hits
        .iter()
        .map(|hit| &hit.card.document.provenance().reference().note_id)
        .collect()
}

async fn create_note(
    store: &CanonicalStore,
    owner: &SpaceContext,
    folder: Option<&FolderId>,
    class: DocClass,
    slug: &str,
    carrier: &str,
) -> NoteId {
    store
        .create_note(
            owner.clone(),
            mutation(
                owner,
                CreateNote {
                    note: NoteId::from_bytes(random_bytes_16()),
                    parent: folder.cloned(),
                    class,
                    slug: slug.to_owned(),
                    carrier: carrier.to_owned(),
                },
            ),
        )
        .await
        .unwrap()
        .value
        .note
}

async fn exercise(store: CanonicalStore, root: DataRoot, projector: ProjectorRuntime) {
    let principal = PrincipalId::from_bytes(random_bytes_16());
    let lease = LeaseEpoch::new(1).unwrap();
    let space = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes(random_bytes_16()),
            incarnation: HistoryIncarnation::from_bytes(random_bytes_16()),
            root_folder_id: FolderId::from_bytes(random_bytes_16()),
            slug: "search-space".into(),
            kind: SpaceKind::Personal,
            owner: principal.clone(),
            active_epoch: lease,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let owner = SpaceContext::new(
        EngineAuthContext::for_human(
            VerifiedHuman::attest(
                principal.clone(),
                GrantId::from_bytes(random_bytes_16()),
                BTreeMap::from([(
                    space.scope.space_id.clone(),
                    SpaceGrant {
                        role: SpaceRole::Owner,
                        read_classes: DocClass::all(),
                        write_classes: DocClass::all(),
                        project_root: None,
                    },
                )]),
                true,
            )
            .with_human_management(true),
        ),
        space.scope.clone(),
        maintenance_ctx(ServicePurpose::Search).budget,
    )
    .unwrap();
    let project = FolderId::from_bytes(random_bytes_16());
    let (_, folder_rev, _) = store
        .create_folder(CreateFolderSpec {
            scope: space.scope.clone(),
            active_epoch: lease,
            folder_id: project.clone(),
            parent: None,
            slug: "project".into(),
            display_name: "Project".into(),
            is_project: true,
            project_slug: Some("project".into()),
            actor: principal.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    let inside = create_note(
        &store,
        &owner,
        Some(&project),
        DocClass::UserDoc,
        "inside",
        "---\ntitle: Inside\nweight: 7\n---\nThe concordance marker.\n",
    )
    .await;
    let outside = create_note(
        &store,
        &owner,
        None,
        DocClass::UserDoc,
        "outside",
        "---\ntitle: Outside\nweight: malformed\n---\nThe concordance marker.\n",
    )
    .await;
    store
        .update_space_schema(
            owner.clone(),
            mutation(
                &owner,
                UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes(random_bytes_16()),
                    parent: None,
                    slug: "schema".into(),
                    carrier: "---\ntitle: Schema\n---\n".into(),
                    schema: BTreeMap::from([(
                        "weight".into(),
                        FieldSchema {
                            kind: FieldType::Scalar(ScalarType::Number),
                            nullable: false,
                        },
                    )]),
                    expected_schema_revision: None,
                },
            ),
        )
        .await
        .unwrap();
    let skill = create_note(
        &store,
        &owner,
        None,
        DocClass::Skill,
        "handbook",
        "---\nclass: skill\ntitle: Handbook\n---\npinnedhandbook\n",
    )
    .await;
    let ability = AbilityId::from_bytes(random_bytes_16());
    store
        .publish_ability_package(
            owner.clone(),
            mutation(
                &owner,
                PublishAbilityPackage {
                    ability: ability.clone(),
                    kind: AbilityKind::Skill,
                    entrypoint: skill.clone(),
                    files: Vec::new(),
                    expected_package_revision: None,
                },
            ),
        )
        .await
        .unwrap();

    let seq = store
        .read_space(&space.scope.space_id)
        .await
        .unwrap()
        .last_seq;
    let search = SearchEngine::start(
        SearchConfig::new(root, VectorMode::Disabled),
        SearchDependencies::new(Arc::new(store.clone()), projector.engine()),
    );
    let mut filtered = query(&space.scope, seq, "concordance");
    filtered.folder = Some(project.clone());
    filtered.filter.predicate = Predicate::Eq {
        key: "weight".into(),
        value: ScalarValue::Number(7_i64.into()),
    };
    let found = search
        .search(owner.clone(), filtered.clone())
        .await
        .unwrap();
    assert!(found.cut.projected_seq >= seq);
    assert_eq!(ids(&found), [&inside]);
    let recall = search
        .recall(
            owner.clone(),
            RecallQuery {
                query: filtered.clone(),
                graph_depth: 0,
                token_budget: 128,
            },
        )
        .await
        .unwrap();
    assert_eq!(ids(&recall), [&inside]);
    assert!(
        recall.hits[0]
            .chunks
            .iter()
            .any(|part| part.text().contains("concordance"))
    );
    filtered.folder = None;
    filtered.filter.predicate = Predicate::IsBad {
        key: "weight".into(),
    };
    assert_eq!(
        ids(&search.search(owner.clone(), filtered).await.unwrap()),
        [&outside]
    );

    let keeper = SpaceContext::new(
        owner
            .auth()
            .for_keeper(
                AgentRunId::from_bytes(random_bytes_16()),
                space.scope.space_id.clone(),
                Some(project.clone()),
                [ability].into(),
            )
            .unwrap(),
        space.scope.clone(),
        owner.budget.clone(),
    )
    .unwrap();
    let mut external = query(&space.scope, seq, "pinnedhandbook");
    external.classes = [DocClass::Skill].into();
    assert_eq!(
        ids(&search
            .search(keeper.clone(), external.clone())
            .await
            .unwrap()),
        [&skill]
    );
    external.folder = Some(project.clone());
    assert!(
        search
            .search(keeper.clone(), external)
            .await
            .unwrap()
            .hits
            .is_empty()
    );
    assert_eq!(
        ids(&search
            .search(keeper, query(&space.scope, seq, "concordance"))
            .await
            .unwrap()),
        [&inside]
    );

    // Even a query guaranteed to have no hits must honor its requested cut.
    // Hold the next publication beyond the projection's partial-page wait.
    let mut empty = query(&space.scope, seq.checked_next().unwrap(), "concordance");
    empty.classes = [DocClass::EncryptedNote].into();
    let mut waiting = search.search(owner.clone(), empty);
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(120), &mut waiting)
            .await
            .is_err()
    );
    let (_, trashed) = store
        .set_folder_lifecycle(
            &space.scope,
            lease,
            &project,
            &folder_rev,
            Lifecycle::Trashed,
            &principal,
            None,
        )
        .await
        .unwrap();
    let empty = waiting.await.unwrap();
    assert!(empty.cut.projected_seq >= trashed);
    assert!(empty.hits.is_empty());
    let visible = search
        .search(owner, query(&space.scope, trashed, "concordance"))
        .await
        .unwrap();
    assert!(visible.cut.projected_seq >= trashed);
    assert_eq!(ids(&visible), [&outside]);
    search.shutdown().await;
    projector.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_search_uses_the_projected_scope() {
    let temp = TempDataRoot::new("search-projections");
    let root = temp.data_root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(random_bytes_16()), root.clone());
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let projector = ProjectorRuntime::start_sqlite(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    exercise(store, root, projector).await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn postgres_search_uses_the_projected_scope() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let prefix = fixtures.fresh_pg_schema();
    let s3 = fixtures.s3_config(
        fixtures.fresh_s3_bucket("search-projection"),
        S3BucketModePolicy::DetectFromBucket,
    );
    admin_ensure_bucket(&s3, Some("Enabled")).await.unwrap();
    let config = fixtures.pg_s3_config(InstallationId::from_bytes(random_bytes_16()), &schema, s3);
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let temp = TempDataRoot::new("search-projections-pg");
    let root = temp.data_root();
    let pool = sqlx::PgPool::connect_with(build_pg_connect_options(&fixtures.pg_connect_config()))
        .await
        .unwrap();
    let projector = ProjectorRuntime::start_postgres_ephemeral(
        store.clone(),
        maintenance_ctx(ServicePurpose::Projection),
        pool.clone(),
        &prefix,
        root.clone(),
        ProjectionGeneration::new(1).unwrap(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    exercise(store, root, projector).await;
    runtime.shutdown().await.unwrap();
    pool.close().await;
    for schema in [schema, format!("{prefix}_g1"), format!("{prefix}_ctrl")] {
        fixtures.drop_pg_schema(&schema).await;
    }
}

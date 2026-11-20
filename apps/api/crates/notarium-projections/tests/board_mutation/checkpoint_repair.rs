use std::{
    fs::{self, File},
    io::Read,
    num::NonZeroUsize,
    time::Duration,
};

use notarium_core::{
    error::ValidationReason,
    ports::{PageLimit, PortStream, SpaceEvent, StructuralReadPort},
};

use super::*;

#[tokio::test]
async fn quiet_checkpoint_repair_sqlite() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(random_bytes()),
        root.clone(),
    ))
    .await
    .unwrap();
    let derived = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(1).unwrap())
        .await
        .unwrap();
    exercise(&store, derived, &root).await;
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn quiet_checkpoint_repair_postgres() {
    let fixture = PgFixture::required();
    let scratch = Scratch::new();
    let root = scratch.root();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_repair_{id}");
    let derived_schema = format!("test_repair_{id}_d");
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: root.clone(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    })
    .await
    .unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let derived = DerivedStore::open_postgres(
        pool.clone(),
        &derived_schema,
        ProjectionGeneration::new(1).unwrap(),
    )
    .await
    .unwrap();
    exercise(&store, derived, &root).await;
    canonical.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{derived_schema}_g1"),
        format!("{derived_schema}_ctrl"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
            .execute(&pool)
            .await
            .unwrap();
    }
}

async fn exercise(store: &CanonicalStore, derived: DerivedStore, root: &DataRoot) {
    let generation = derived.generation();
    let (scope, owner) = open_space(store).await;
    let (other_scope, other_owner) = open_space(store).await;
    let target = note(
        store,
        &owner,
        "quiet",
        DocClass::UserDoc,
        "# Quiet projection checkpoint\n".into(),
    )
    .await;
    let seq = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let runtime = ProjectorRuntime::start_for_test(
        store.clone(),
        projection_context(),
        derived,
        root.clone(),
        ProjectionConfig {
            max_open_spaces: NonZeroUsize::MIN,
            ..ProjectionConfig::default()
        },
    )
    .await
    .unwrap();
    sync(store, &runtime, &scope).await;
    sync(store, &runtime, &other_scope).await;
    let engine = runtime.engine();
    let path = root.space_fast_index(generation, &scope.space_id, seq);
    let source = store
        .read_projection_notes_page(
            &projection_context(),
            &scope,
            seq,
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    let digest = source.rows[0].metadata.content_digest.unwrap();
    let blob = root.blob(&scope.space_id, digest);
    let hidden = blob.with_extension("hidden-during-checkpoint-repair");
    fs::rename(&blob, &hidden).unwrap();

    for corrupt in [false, true] {
        let mut stream = engine
            .event_bus()
            .subscribe(
                owner.clone(),
                ChangeCursor {
                    scope: scope.clone(),
                    after: seq,
                },
            )
            .await
            .unwrap();
        let mut initial = engine
            .event_bus()
            .subscribe(
                owner.clone(),
                ChangeCursor {
                    scope: scope.clone(),
                    after: SpaceSeq::ZERO,
                },
            )
            .await
            .unwrap();
        let mut hold = engine.pause_before_recovery_for_test(&scope).unwrap();
        let retained = engine
            .acquire_snapshot(owner.clone(), CausalBasis::Await(Default::default()))
            .await
            .unwrap();
        assert!(retained.lookup(&target.note).is_some());
        let other = engine
            .acquire_snapshot(other_owner.clone(), CausalBasis::Await(Default::default()))
            .await
            .unwrap();
        drop(other);

        // Keep the original inode readable while replacing its published name.
        // The pool now opens the target cold, so the failed open reaches the
        // production repair notifier even though this old snapshot still lives.
        let mut original = File::open(&path).unwrap();
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(&path).unwrap();
        if corrupt {
            let mut forged = bytes.clone();
            let footer = forged.len() - 32;
            forged[footer - 1] ^= 1;
            let checksum = blake3::hash(&forged[..footer]);
            forged[footer..].copy_from_slice(checksum.as_bytes());
            fs::write(&path, forged).unwrap();
            let mut mode = fs::metadata(&path).unwrap().permissions();
            mode.set_readonly(true);
            fs::set_permissions(&path, mode).unwrap();
        }
        let failure = engine
            .acquire_snapshot(owner.clone(), CausalBasis::Await(Default::default()))
            .await;
        assert!(
            matches!(
                failure,
                Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
                    if diagnostic.reason == ValidationReason::NotReady
            ),
            "an unusable published checkpoint must close new reads"
        );
        let mut restricted = {
            tokio::time::timeout(
                Duration::from_secs(5),
                hold.reached_feed_boundary_for_test(),
            )
            .await
            .expect("repair withdraws the failed cut before building a replacement")
            .unwrap();
            assert!(
                tokio::time::timeout(Duration::from_millis(30), next_resync(stream.as_mut()))
                    .await
                    .is_err(),
                "a quiet repair must not announce readiness while the cut is withdrawn"
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(30), next_resync(initial.as_mut()))
                    .await
                    .is_err(),
                "a queued initial refresh must wait for the repaired cut"
            );
            let reader = SpaceContext::new(
                EngineAuthContext::for_human(VerifiedHuman::attest(
                    owner.auth().principal().clone(),
                    GrantId::from_bytes(random_bytes()),
                    BTreeMap::from([(
                        scope.space_id.clone(),
                        SpaceGrant {
                            role: SpaceRole::Viewer,
                            read_classes: [DocClass::UserDoc].into_iter().collect(),
                            write_classes: Default::default(),
                            project_root: None,
                        },
                    )]),
                    false,
                )),
                scope.clone(),
                budget(),
            )
            .unwrap();
            let during_repair = engine
                .event_bus()
                .subscribe(
                    reader,
                    ChangeCursor {
                        scope: scope.clone(),
                        after: SpaceSeq::ZERO,
                    },
                )
                .await
                .expect("subscribe with class-restricted access while the cut is withdrawn");
            hold.resume_for_test().await.unwrap();
            during_repair
        };
        let notice = tokio::time::timeout(Duration::from_secs(8), next_resync(stream.as_mut()))
            .await
            .expect("a quiet repair wakes the existing subscriber without a canonical mutation");
        assert_eq!(notice.seq, seq);
        let first = tokio::time::timeout(Duration::from_secs(8), next_resync(initial.as_mut()))
            .await
            .expect("the existing initial refresh follows the repaired cut");
        assert_eq!(first.seq, seq);
        {
            let first =
                tokio::time::timeout(Duration::from_secs(8), next_resync(restricted.as_mut()))
                    .await
                    .expect("the class-restricted initial refresh follows the repaired cut");
            assert_eq!(first.seq, SpaceSeq::ZERO);
        }
        let repaired = engine
            .acquire_snapshot(owner.clone(), CausalBasis::Await(Default::default()))
            .await
            .expect("the replacement is immediately usable without reading the CAS");
        assert_eq!(repaired.cut().projected_seq, seq);
        assert!(repaired.lookup(&target.note).is_some());
        assert_eq!(
            store.read_space(&scope.space_id).await.unwrap().last_seq,
            seq
        );

        let mut original_bytes = Vec::new();
        original.read_to_end(&mut original_bytes).unwrap();
        assert_eq!(original_bytes, bytes);
        drop(retained);
        assert!(
            path.is_file(),
            "retiring the old mapping cannot unlink its replacement"
        );
    }
    fs::rename(&hidden, &blob).unwrap();
    runtime.shutdown().await.unwrap();
}

async fn next_resync(stream: &mut dyn PortStream<SpaceEvent>) -> SpaceEvent {
    loop {
        let event = stream.next().await.unwrap().unwrap();
        if matches!(event.kind, SpaceEventKind::ResyncRequired) {
            return event;
        }
    }
}

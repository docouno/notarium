use std::{
    io::{Cursor, Read, Write},
    sync::Arc,
    time::Duration,
};

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore, codec};
use notarium_control::{
    service::{AuthenticationMode, ControlConfig, ControlService, SystemClock},
    store::ControlStore,
};
use notarium_core::{
    DomainError,
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    error::PortError,
    ids::*,
    model::HistoryScope,
    ports::*,
    receipt::CommandIdentity,
};
use notarium_jobs::{ArchiveJobs, ArchiveStorage, ImportLimits, JobWorkerConfig};

struct FixtureRoot(DataRoot);

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.root());
    }
}

struct TestRegistry;
struct TestLease;

impl RevocationLease for TestLease {
    fn check(&self) -> Result<(), PortError> {
        Ok(())
    }
}

impl SessionRevocationPort for TestRegistry {
    fn register_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
        _: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(TestLease) as Box<dyn RevocationLease>) })
    }

    fn fence_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(TestLease) as Box<dyn RevocationLease>) })
    }

    fn fence_inactive_provider(
        &self,
        _: MaintenanceContext,
        _: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(Some(Box::new(TestLease) as Box<dyn RevocationLease>)) })
    }

    fn revoke(
        &self,
        _: MaintenanceContext,
        _: RevocationSelector,
        _: RevocationReason,
    ) -> PortFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(codec::ordered_id_16().unwrap()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(10),
    }
}

fn mutation<T>(ctx: &SpaceContext, input: T) -> Mutation<T> {
    Mutation {
        identity: CommandIdentity {
            scope: ctx.scope().clone(),
            actor: ctx.auth().principal().clone(),
            key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
            hash: ContentDigest::from_bytes([0; 32]),
        },
        preconditions: Preconditions::default(),
        input,
    }
}

fn zip(entries: impl IntoIterator<Item = (String, String)>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, content) in entries {
        zip.start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(content.as_bytes()).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

async fn terminal(store: &CanonicalStore, ctx: &SpaceContext, job: &ContentJob) -> ContentJob {
    let mut read_timeouts = 0;
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let current = match store.get_job(ctx.clone(), job.id.clone()).await {
                Ok(current) => current,
                Err(PortError::DeadlineExceeded(_) | PortError::Unavailable(_)) => {
                    read_timeouts += 1;
                    tokio::time::sleep(Duration::from_millis(25)).await;
                    continue;
                }
                Err(err) => panic!("cannot observe {}: {err:?}", job.id),
            };
            if !matches!(current.state, JobState::Queued | JobState::Running) {
                eprintln!("job {} read timeouts: {read_timeouts}", job.id);
                break current;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "job did not finish: {} ({read_timeouts} read timeouts)",
            job.id
        )
    })
}

async fn import(
    jobs: &ArchiveJobs,
    store: &CanonicalStore,
    ctx: &SpaceContext,
    zip: &[u8],
) -> ContentJob {
    let artifact = jobs.stage_import(ctx.clone(), zip).await.unwrap();
    let job = jobs
        .enqueue(
            ctx.clone(),
            mutation(ctx, ContentJobKind::Import { artifact }),
        )
        .await
        .unwrap()
        .value;
    terminal(store, ctx, &job).await
}

fn note_count(root: &DataRoot, scope: &HistoryScope) -> i64 {
    rusqlite::Connection::open(root.canonical())
        .unwrap()
        .query_row(
            "SELECT count(*) FROM note_heads WHERE space_id=?1",
            [scope.space_id.as_str()],
            |row| row.get(0),
        )
        .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn local_archive_worker_preflights_and_revokes_downloads() {
    exercise_local_archive_worker(201).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "large archive acceptance workload"]
async fn ten_thousand_linked_notes_import_and_export() {
    exercise_local_archive_worker(10_000).await;
}

async fn exercise_local_archive_worker(entries: usize) {
    let fixture = FixtureRoot(DataRoot::new(
        std::env::temp_dir()
            .join(codec::new_prefixed_hex_id("notarium_archive_worker_test_").unwrap()),
    ));
    let root = &fixture.0;
    std::fs::create_dir_all(root.root().join("v1")).unwrap();
    let installation = InstallationId::from_bytes([11; 16]);
    let control = ControlStore::sqlite(root).await.unwrap();
    rusqlite::Connection::open(root.control()).unwrap().execute(
        "INSERT INTO v1_storage_epoch(singleton, epoch_version, state, installation_id) VALUES(1,1,'ready',?1)",
        [installation.as_str()],
    ).unwrap();
    let (store, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    let owner = PrincipalId::from_bytes([12; 16]);
    let control_service = Arc::new(
        ControlService::open(
            control.clone(),
            Arc::new(store.clone()),
            Arc::new(TestRegistry),
            Arc::new(SystemClock),
            ControlConfig {
                authentication: AuthenticationMode::TrustedNone { owner },
                resource_uri: "https://notarium.example/".into(),
                max_auth_spaces: 10,
                schedule_limits: notarium_core::ports::control::RunLimits::HARD_CEILING,
            },
            budget(),
        )
        .await
        .unwrap(),
    );
    let account = control_service
        .bootstrap(
            EmptyRootAuthorization::from_classification(
                installation.clone(),
                EpochClassification {
                    state: StorageEpochState::EmptyRoot,
                    reason: EpochReason::ConfirmedEmpty,
                },
            )
            .unwrap(),
            budget(),
            BootstrapAccount {
                username: "operator".into(),
                email: None,
                display_name: "Operator".into(),
                password: None,
            },
        )
        .await
        .unwrap()
        .account;
    let scope = store
        .read_space(account.personal_space.as_ref().unwrap())
        .await
        .unwrap()
        .scope;
    let auth = control_service
        .trusted_none(PerimeterAttestation::attest_checked(), budget())
        .await
        .unwrap();
    let ctx = SpaceContext::new(auth, scope.clone(), budget()).unwrap();
    let jobs = Arc::new(
        ArchiveJobs::new(
            store.clone(),
            control_service,
            ArchiveStorage::local(root, installation).unwrap(),
            ImportLimits::default(),
        )
        .unwrap(),
    );
    let stop = Cancellation::default();
    let running = tokio::spawn(
        jobs.runner(JobWorkerConfig {
            idle_poll: Duration::from_millis(15),
            ..Default::default()
        })
        .unwrap()
        .run(stop.clone()),
    );

    let valid = || {
        (0..entries).map(|index| {
            (
                format!("documents/entry-{index:05}.md"),
                format!(
                    "# Note {index}\n\nSee [[entry-{:05}]].\n",
                    (index + 1) % entries
                ),
            )
        })
    };
    let invalid = zip(valid().chain(std::iter::once((
        "../last.md".to_owned(),
        "# Forbidden\n".to_owned(),
    ))));
    let rejected = import(&jobs, &store, &ctx, &invalid).await;
    assert_eq!(
        (rejected.state, rejected.completed_units),
        (JobState::Failed, 0)
    );
    assert_eq!(note_count(root, &scope), 0);

    let started = std::time::Instant::now();
    let input = jobs
        .stage_import(ctx.clone(), zip(valid()).as_slice())
        .await
        .unwrap();
    let command = mutation(
        &ctx,
        ContentJobKind::Import {
            artifact: input.clone(),
        },
    );
    let accepted_job = jobs
        .enqueue(ctx.clone(), command.clone())
        .await
        .unwrap()
        .value;
    let accepted = terminal(&store, &ctx, &accepted_job).await;
    eprintln!("import of {entries} linked notes: {:?}", started.elapsed());
    assert_eq!(accepted.state, JobState::Succeeded);
    assert_eq!(note_count(root, &scope), entries as i64);

    let started = std::time::Instant::now();
    let artifact = jobs
        .enqueue(
            ctx.clone(),
            mutation(&ctx, ContentJobKind::ExportSpace { encrypted: false }),
        )
        .await
        .unwrap()
        .value;
    let exported = terminal(&store, &ctx, &artifact).await;
    eprintln!("export of {entries} linked notes: {:?}", started.elapsed());
    assert_eq!(exported.state, JobState::Succeeded);
    let id = &exported.artifacts[0];
    let download = jobs.open_export(ctx.clone(), id).await.unwrap();
    let metadata = download.metadata();
    let last = download
        .read_chunk(budget(), metadata.bytes - 5, 5)
        .await
        .unwrap();
    let mut bytes = Vec::new();
    while (bytes.len() as u64) < metadata.bytes {
        let part = download
            .read_chunk(budget(), bytes.len() as u64, 128 * 1024)
            .await
            .unwrap();
        assert!(!part.is_empty());
        bytes.extend_from_slice(&part);
    }
    assert!(bytes.ends_with(&last));
    assert_eq!(metadata.etag.as_bytes(), blake3::hash(&bytes).as_bytes());
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut carrier = String::new();
    archive
        .by_name("documents/entry-00000.md")
        .unwrap()
        .read_to_string(&mut carrier)
        .unwrap();
    assert!(carrier.contains("[["));
    assert!(!carrier.contains("[[entry-00001]]"));
    assert_eq!(archive.len(), entries);

    let db = rusqlite::Connection::open(root.canonical()).unwrap();
    let note = db
        .query_row(
            "SELECT note_id FROM note_heads WHERE space_id=?1 LIMIT 1",
            [scope.space_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    store
        .delete_note(
            ctx.clone(),
            mutation(
                &ctx,
                DeleteNote {
                    note: NoteId::parse(&note).unwrap(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert!(matches!(
        download.read_chunk(budget(), 0, 1).await,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
    assert!(jobs.open_export(ctx.clone(), id).await.is_err());

    db.execute(
        "UPDATE archive_artifacts SET expires_at_ms=0 WHERE artifact_id=?1",
        [id.as_str()],
    )
    .unwrap();
    db.execute(
        "UPDATE archive_uploads SET source_deadline_ms=0 WHERE artifact_id=?1",
        [input.as_str()],
    )
    .unwrap();
    jobs.sweep_maintenance(&stop).await.unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM archive_uploads WHERE artifact_id=?1",
            [input.as_str()],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0,
    );
    assert_eq!(
        jobs.enqueue(ctx.clone(), command).await.unwrap().value.id,
        accepted.id
    );
    assert!(
        jobs.enqueue(
            ctx.clone(),
            mutation(&ctx, ContentJobKind::Import { artifact: input })
        )
        .await
        .is_err()
    );
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM archive_artifacts WHERE artifact_id=?1",
            [id.as_str()],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    assert!(
        !std::fs::read_dir(root.root().join("staging/archives/objects"))
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().contains(id.as_str()))
    );
    stop.cancel();
    running.await.unwrap().unwrap();
    control.close().await;
    runtime.shutdown().await.unwrap();
}

use std::{
    process::{Child, Command, Stdio},
    sync::Arc,
};

use notarium_control::{
    service::{AuthenticationMode, ControlConfig, ControlService, SystemClock},
    store::PostgresConfig,
};
use notarium_jobs::{ArchiveJobs, ArchiveStorage, ImportLimits, JobWorkerConfig};
use serde::{Deserialize, Serialize};
use sqlx::{Connection, PgConnection};

use super::*;

struct Registry;
struct Lease;

impl RevocationLease for Lease {
    fn check(&self) -> Result<(), notarium_core::error::PortError> {
        Ok(())
    }
}

impl SessionRevocationPort for Registry {
    fn register_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
        _: Cancellation,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(Lease) as Box<dyn RevocationLease>) })
    }
    fn fence_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::new(Lease) as Box<dyn RevocationLease>) })
    }
    fn fence_inactive_provider(
        &self,
        _: MaintenanceContext,
        _: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(Some(Box::new(Lease) as Box<dyn RevocationLease>)) })
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

async fn control_service(
    store: &CanonicalStore,
    db: ControlStore,
    owner: PrincipalId,
) -> Arc<ControlService> {
    Arc::new(
        ControlService::open(
            db,
            Arc::new(store.clone()),
            Arc::new(Registry),
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
    )
}

#[derive(Clone, Serialize, Deserialize)]
struct Worker {
    root: PathBuf,
    database: String,
    bucket: String,
    installation: InstallationId,
    owner: PrincipalId,
    space: SpaceId,
    epoch: u64,
}

struct WorkerProcess(Child);
impl WorkerProcess {
    fn start(config: &Worker) -> Self {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "cloud_takeover::worker_child", "--nocapture"])
            .env(
                "NOTARIUM_CLOUD_ARCHIVE_WORKER",
                serde_json::to_string(config).unwrap(),
            )
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        Self(child)
    }
    fn kill(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Drop for WorkerProcess {
    fn drop(&mut self) {
        self.kill();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_child() {
    let Ok(config) = std::env::var("NOTARIUM_CLOUD_ARCHIVE_WORKER") else {
        return;
    };
    let config: Worker = serde_json::from_str(&config).unwrap();
    let root = DataRoot::new(config.root);
    fs::create_dir(root.root()).unwrap();
    let fixture = StorageFixture::load();
    let mut database = fixture.database();
    database.database = config.database;
    let sql = notarium_canonical::build_pg_connect_options(&database);
    let (canonical, _runtime) = CanonicalRuntime::open(cloud_config(
        config.installation.clone(),
        database,
        fixture.s3("source-content", config.bucket.clone()),
    ))
    .await
    .unwrap();
    let scope = canonical.read_space(&config.space).await.unwrap().scope;
    canonical
        .advance_space_lease(
            &authority(ServicePurpose::Revocation),
            &scope,
            LeaseEpoch::new(config.epoch).unwrap(),
        )
        .await
        .unwrap();
    let db = ControlStore::postgres(PostgresConfig::from_connect_options(sql))
        .await
        .unwrap();
    let control = control_service(&canonical, db, config.owner).await;
    let storage = ArchiveStorage::cloud(
        &root,
        config.installation,
        fixture.s3("archive-operations", config.bucket),
    )
    .await
    .unwrap();
    Arc::new(ArchiveJobs::new(canonical, control, storage, ImportLimits::default()).unwrap())
        .runner(JobWorkerConfig {
            exports: 0,
            idle_poll: Duration::from_millis(25),
            ..Default::default()
        })
        .unwrap()
        .run(Cancellation::default())
        .await
        .unwrap();
}

pub(super) async fn exercise(
    canonical: &CanonicalStore,
    control: ControlStore,
    source: &notarium_canonical::PgConnectConfig,
    installation: &InstallationId,
    bucket: &str,
    root: &Path,
) {
    let Ok(entries) = std::env::var("NOTARIUM_CLOUD_ARCHIVE_TAKEOVER") else {
        return;
    };
    let entries: usize = entries.parse().unwrap();
    assert!((201..=10_000).contains(&entries));
    let owner = PrincipalId::from_bytes([90; 16]);
    let control = control_service(canonical, control, owner.clone()).await;
    let account = control
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
                username: "archive-runner".into(),
                email: None,
                display_name: "Archive worker".into(),
                password: None,
            },
        )
        .await
        .unwrap()
        .account;
    let space = account.personal_space.unwrap();
    let scope = canonical.read_space(&space).await.unwrap().scope;
    let auth = control
        .trusted_none(PerimeterAttestation::attest_checked(), budget())
        .await
        .unwrap();
    let ctx = SpaceContext::new(auth, scope.clone(), budget()).unwrap();
    let gateway = DataRoot::new(root.join("archive-gateway"));
    fs::create_dir(gateway.root()).unwrap();
    let staged = ArchiveStorage::cloud(
        &gateway,
        installation.clone(),
        StorageFixture::load().s3("archive-operations", bucket.to_owned()),
    )
    .await
    .unwrap();
    let jobs =
        ArchiveJobs::new(canonical.clone(), control, staged, ImportLimits::default()).unwrap();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for index in 0..entries {
        zip.start_file(
            format!("linked/entry-{index:05}.md"),
            zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
        writeln!(
            zip,
            "# Entry {index}\n\n[[entry-{:05}]]",
            (index + 1) % entries
        )
        .unwrap();
    }
    let zip = zip.finish().unwrap().into_inner();
    let artifact = jobs
        .stage_import(ctx.clone(), zip.as_slice())
        .await
        .unwrap();
    let job = jobs
        .enqueue(
            ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: ctx.auth().principal().clone(),
                    key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
                    hash: ContentDigest::from_bytes([0; 32]),
                },
                preconditions: Preconditions::default(),
                input: ContentJobKind::Import { artifact },
            },
        )
        .await
        .unwrap()
        .value;

    let mut backstop =
        PgConnection::connect_with(&notarium_canonical::build_pg_connect_options(source))
            .await
            .unwrap();
    sqlx::query("SELECT pg_advisory_lock(6292502014)")
        .execute(&mut backstop)
        .await
        .unwrap();
    sqlx::raw_sql(
        "CREATE FUNCTION v1_canonical.fixture_stop_archive_at_201() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN
         IF NEW.completed_units>201 AND NEW.job_kind='import' THEN
             PERFORM pg_advisory_xact_lock(6292502014);
         END IF;
         RETURN NEW;
         END $$;
         CREATE TRIGGER fixture_stop_archive_at_201 BEFORE UPDATE OF completed_units
         ON v1_canonical.content_jobs FOR EACH ROW EXECUTE FUNCTION v1_canonical.fixture_stop_archive_at_201();",
    ).execute(&mut backstop).await.unwrap();
    let first = Worker {
        root: root.join("archive-worker-a"),
        database: source.database.clone(),
        bucket: bucket.to_owned(),
        installation: installation.clone(),
        owner,
        space: space.clone(),
        epoch: 2,
    };
    let mut a = WorkerProcess::start(&first);
    let first_job = wait_for(&mut backstop, &space, &job.id, 201, false).await;
    assert_eq!(first_job, ("running".into(), 201));
    let read_notes = async |db: &mut PgConnection| -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT slug,note_id FROM v1_canonical.note_heads WHERE space_id=$1 ORDER BY slug",
        )
        .bind(space.as_str())
        .fetch_all(db)
        .await
        .unwrap()
    };
    let committed = read_notes(&mut backstop).await;
    assert_eq!(committed.len(), 200);
    a.kill();
    fs::remove_dir_all(&first.root).unwrap();
    // A server may still be inside the statement when its client dies.
    // Roll that transaction back before making the test barrier available.
    sqlx::query(
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity
         WHERE datname=current_database() AND wait_event='advisory'
            AND query LIKE '%UPDATE content_jobs SET completed_units%'",
    )
    .execute(&mut backstop)
    .await
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity
                   WHERE datname=current_database() AND wait_event='advisory'
                     AND query LIKE '%UPDATE content_jobs SET completed_units%')",
            )
            .fetch_one(&mut backstop)
            .await
            .unwrap();
            if !waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    sqlx::query("SELECT pg_advisory_unlock(6292502014)")
        .execute(&mut backstop)
        .await
        .unwrap();
    sqlx::raw_sql(
        "DROP TRIGGER fixture_stop_archive_at_201 ON v1_canonical.content_jobs;
         DROP FUNCTION v1_canonical.fixture_stop_archive_at_201();",
    )
    .execute(&mut backstop)
    .await
    .unwrap();
    let second = Worker {
        root: root.join("archive-worker-b"),
        epoch: 3,
        ..first
    };
    assert!(!second.root.exists());
    let mut b = WorkerProcess::start(&second);
    assert_eq!(
        wait_for(&mut backstop, &space, &job.id, entries as i64 + 1, true).await,
        ("succeeded".into(), entries as i64 + 1)
    );
    let all = read_notes(&mut backstop).await;
    assert_eq!(all.len(), entries);
    assert_eq!(&all[..200], committed.as_slice());
    b.kill();
    backstop.close().await.unwrap();
    eprintln!(
        "Cloud takeover retained {} committed note IDs through loss of worker storage and finished {entries} linked notes",
        committed.len()
    );
}

async fn wait_for(
    db: &mut PgConnection,
    space: &SpaceId,
    job: &JobId,
    ordinal: i64,
    terminal: bool,
) -> (String, i64) {
    tokio::time::timeout(Duration::from_secs(900), async {
        loop {
            let state: (String, i64) = sqlx::query_as(
                "SELECT state,completed_units FROM v1_canonical.content_jobs WHERE space_id=$1 AND job_id=$2",
            ).bind(space.as_str()).bind(job.as_str()).fetch_one(&mut *db).await.unwrap();
            let settled = !matches!(state.0.as_str(), "queued" | "running");
            if settled || (!terminal && state.1 >= ordinal) {
                return state;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }).await.expect("Cloud import did not reach its durable boundary")
}

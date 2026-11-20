use std::{
    process::{Child, Command, Stdio},
    sync::Arc,
};

use notarium_canonical::writer::ArchiveAckGate;
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
    pause_ack: bool,
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
    if config.pause_ack {
        let gate = Arc::new(ArchiveAckGate::new(200));
        *canonical.writer_faults().unwrap().archive_ack.lock().await = Some(gate.clone());
        let witness = root.root().join("durable-before-ack");
        tokio::spawn(async move {
            gate.wait_until_durable().await;
            fs::write(witness, b"durable").unwrap();
        });
    }
    Arc::new(ArchiveJobs::new(canonical, control, storage, ImportLimits::default()).unwrap())
        .runner(JobWorkerConfig {
            exports: usize::from(!config.pause_ack),
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
    let jobs = Arc::new(
        ArchiveJobs::new(
            canonical.clone(),
            control.clone(),
            staged,
            ImportLimits::default(),
        )
        .unwrap(),
    );
    let exported_note = NoteId::from_bytes(codec::ordered_id_16().unwrap());
    let export_bytes = "# Opened from a separate node\n";
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
    canonical
        .create_note(
            ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
                    hash: ContentDigest::from_bytes([0; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: exported_note.clone(),
                    parent: None,
                    slug: "cross-node".into(),
                    class: DocClass::UserDoc,
                    carrier: export_bytes.into(),
                },
            },
        )
        .await
        .unwrap();
    let export_job = jobs
        .enqueue(
            ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
                    hash: ContentDigest::from_bytes([0; 32]),
                },
                preconditions: Preconditions::default(),
                input: ContentJobKind::Export {
                    notes: vec![exported_note],
                    encrypted: false,
                },
            },
        )
        .await
        .unwrap()
        .value;

    let mut backstop =
        PgConnection::connect_with(&notarium_canonical::build_pg_connect_options(source))
            .await
            .unwrap();
    let event = RequestId::from_bytes(codec::ordered_id_16().unwrap());
    let selector = serde_json::json!({
        "version": 1,
        "selector": RevocationSelector::Principal(owner.clone()),
    });
    sqlx::query(
        "INSERT INTO v1_control.revocation_events
            (event_id,selector,reason,authority_version,committed_at,attempts)
         VALUES($1,$2,'permission_changed',1,1,0)",
    )
    .bind(event.as_str())
    .bind(selector.to_string())
    .execute(&mut backstop)
    .await
    .unwrap();
    let mut effect = backstop.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(ARCHIVE_REVOCATION_FENCE)
        .execute(&mut *effect)
        .await
        .unwrap();
    let mut delivery = tokio::spawn(async move {
        control
            .drain_revocations(authority(ServicePurpose::Revocation), 1)
            .await
    });
    let mut observer =
        PgConnection::connect_with(&notarium_canonical::build_pg_connect_options(source))
            .await
            .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_locks
                   WHERE locktype='advisory' AND NOT granted
                     AND classid=$1::bigint::oid AND objid=$2::bigint::oid)",
            )
            .bind(ARCHIVE_REVOCATION_FENCE >> 32)
            .bind(ARCHIVE_REVOCATION_FENCE & 0xffff_ffff)
            .fetch_one(&mut observer)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("revocation waits for the database effect to settle");
    assert!(!delivery.is_finished());
    effect.commit().await.unwrap();
    let settled = tokio::time::timeout(Duration::from_secs(5), &mut delivery)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(settled.delivered, 1);
    observer.close().await.unwrap();
    let first = Worker {
        root: root.join("archive-worker-a"),
        database: source.database.clone(),
        bucket: bucket.to_owned(),
        installation: installation.clone(),
        owner,
        space: space.clone(),
        epoch: 2,
        pause_ack: true,
    };
    let mut a = WorkerProcess::start(&first);
    let first_job = wait_for(&mut backstop, &space, &job.id, 201, false).await;
    assert_eq!(first_job, ("running".into(), 201));
    tokio::time::timeout(Duration::from_secs(10), async {
        while !first.root.join("durable-before-ack").exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the first process paused before the commit reply");
    let read_notes = async |db: &mut PgConnection| -> Vec<(String, String)> {
        sqlx::query_as(
            "SELECT slug,note_id FROM v1_canonical.note_heads
             WHERE space_id=$1 AND slug LIKE 'entry-%' ORDER BY slug",
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
    let second = Worker {
        root: root.join("archive-worker-b"),
        epoch: 3,
        pause_ack: false,
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
    for index in [0, 199, entries - 1] {
        let digest: Vec<u8> = sqlx::query_scalar(
            "SELECT content_blake3 FROM v1_canonical.note_heads WHERE space_id=$1 AND note_id=$2",
        )
        .bind(space.as_str())
        .bind(&all[index].1)
        .fetch_one(&mut backstop)
        .await
        .unwrap();
        let digest = ContentDigest::from_bytes(digest.try_into().unwrap());
        let carrier = canonical.read_verified_blob(&scope, digest).await.unwrap();
        let target = &all[(index + 1) % entries].1;
        assert!(
            std::str::from_utf8(&carrier)
                .unwrap()
                .contains(&format!("[[{target}]]"))
        );
    }
    assert_eq!(
        wait_for(&mut backstop, &space, &export_job.id, 1, true)
            .await
            .0,
        "succeeded",
    );
    let export = canonical.get_job(ctx.clone(), export_job.id).await.unwrap();
    b.kill();
    fs::remove_dir_all(&second.root).unwrap();
    let output = jobs
        .open_export(ctx.clone(), &export.artifacts[0])
        .await
        .unwrap();
    let bytes = output.read_chunk(budget(), 0, 64 * 1024).await.unwrap();
    assert_eq!(bytes.len() as u64, output.metadata().bytes);
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
    let mut read = String::new();
    zip.by_name("cross-node.md")
        .unwrap()
        .read_to_string(&mut read)
        .unwrap();
    assert_eq!(read, export_bytes);
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

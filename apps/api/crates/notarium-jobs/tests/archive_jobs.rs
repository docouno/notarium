use std::{
    io::{Cursor, Read, Seek, SeekFrom, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering},
    },
    time::Duration,
};

use notarium_canonical::{CanonicalConfig, CanonicalRuntime, CanonicalStore, codec};
use notarium_control::{
    service::{AuthenticationMode, ControlClock, ControlConfig, ControlService, SystemClock},
    store::ControlStore,
};
use notarium_core::{
    DomainError,
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    error::{PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::*,
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use notarium_jobs::{
    ArchiveDownload, ArchiveInput, ArchiveJobs, ArchiveStorage, BackupOptions, FsckInput,
    ImportLimits, JobWorkerConfig, run_fsck,
};

struct FixtureRoot(DataRoot);

impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(self.0.root());
    }
}

struct TestClock {
    now: AtomicI64,
    delay_once_ms: AtomicU64,
}

impl ControlClock for TestClock {
    fn now_ms(&self) -> Result<i64, PortError> {
        let delay = self.delay_once_ms.swap(0, Ordering::SeqCst);
        if delay > 0 {
            std::thread::sleep(Duration::from_millis(delay));
        }
        Ok(self.now.load(Ordering::SeqCst))
    }
}

struct TestRegistry {
    clock: Arc<TestClock>,
    advance_at_handoff: Mutex<Option<i64>>,
}

#[derive(Default)]
struct TestLease {
    expiry: Option<(Arc<TestClock>, i64)>,
    admitted: AtomicBool,
}

impl RevocationLease for TestLease {
    fn check(&self) -> Result<(), PortError> {
        if let Some((clock, expires)) = &self.expiry
            && self.admitted.swap(true, Ordering::SeqCst)
        {
            clock.now.store(*expires, Ordering::SeqCst);
        }
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
        let advance = self.advance_at_handoff.lock().unwrap().take();
        Box::pin(async move {
            Ok(Box::new(TestLease {
                expiry: advance.map(|time| (self.clock.clone(), time)),
                ..Default::default()
            }) as Box<dyn RevocationLease>)
        })
    }

    fn fence_provider(
        &self,
        _: MaintenanceContext,
        _: Vec<RevocationSelector>,
    ) -> PortFuture<'_, Box<dyn RevocationLease>> {
        Box::pin(async { Ok(Box::<TestLease>::default() as Box<dyn RevocationLease>) })
    }

    fn fence_inactive_provider(
        &self,
        _: MaintenanceContext,
        _: RequestId,
    ) -> PortFuture<'_, Option<Box<dyn RevocationLease>>> {
        Box::pin(async { Ok(Some(Box::<TestLease>::default() as Box<dyn RevocationLease>)) })
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
    tokio::time::timeout(Duration::from_secs(900), async {
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "foreground throughput acceptance workload"]
async fn fifty_thousand_imports_with_foreground_saves() {
    exercise_local_archive_worker(50_000).await;
}

async fn sample_foreground(
    store: CanonicalStore,
    mut ctx: SpaceContext,
    limit: usize,
) -> serde_json::Value {
    const CARRIER: &str = "# Foreground save\n\nNote saved through the canonical writer.\n";
    let mut saves = Vec::with_capacity(limit);
    let mut reads = Vec::with_capacity(limit);
    let mut save_errors = 0;
    let mut read_errors = 0;
    for _ in 0..limit {
        let id = NoteId::from_bytes(codec::ordered_id_16().unwrap());
        ctx.budget = budget();
        let request = mutation(
            &ctx,
            CreateNote {
                note: id.clone(),
                parent: None,
                slug: format!("foreground-{}", id.as_str()),
                class: notarium_core::classes::DocClass::UserDoc,
                carrier: CARRIER.into(),
            },
        );
        let start = std::time::Instant::now();
        let saved = store.create_note(ctx.clone(), request).await;
        saves.push(start.elapsed().as_nanos() as u64);
        if let Ok(saved) = saved {
            ctx.budget = budget();
            let request = GetNote {
                note: id,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::new(vec![saved.receipt]).unwrap()),
            };
            let start = std::time::Instant::now();
            let verified = store
                .get_note(ctx.clone(), request)
                .await
                .is_ok_and(|snapshot| {
                    snapshot
                        .document
                        .explicit_read(ctx.auth())
                        .is_ok_and(|body| body == CARRIER)
                });
            reads.push(start.elapsed().as_nanos() as u64);
            read_errors += usize::from(!verified);
        } else {
            save_errors += 1;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let distribution = |mut samples: Vec<u64>, errors| {
        samples.sort_unstable();
        let rank = |p: usize| samples.get((samples.len() * p).div_ceil(100).saturating_sub(1));
        serde_json::json!({
            "count": samples.len(), "errors": errors, "p50_ns": rank(50), "p95_ns": rank(95),
            "p99_ns": rank(99), "max_ns": samples.last(),
        })
    };
    let mut saves = distribution(saves, save_errors);
    saves["read"] = distribution(reads, read_errors);
    saves
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
    let mut config = CanonicalConfig::local_default(installation.clone(), root.clone());
    if entries == 201 {
        config.writer.max_staged_bytes = 4096;
    }
    let (store, runtime) = CanonicalRuntime::open(config).await.unwrap();
    let owner = PrincipalId::from_bytes([12; 16]);
    let clock = Arc::new(TestClock {
        now: AtomicI64::new(SystemClock.now_ms().unwrap()),
        delay_once_ms: AtomicU64::new(0),
    });
    let registry = Arc::new(TestRegistry {
        clock: clock.clone(),
        advance_at_handoff: Mutex::new(None),
    });
    let control_service = Arc::new(
        ControlService::open(
            control.clone(),
            Arc::new(store.clone()),
            registry.clone(),
            clock.clone(),
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
        .trusted_none(
            PerimeterAttestation::attest_checked()
                .with_human_management()
                .with_ability_write(),
            budget(),
        )
        .await
        .unwrap();
    let ctx = SpaceContext::new(auth, scope.clone(), budget()).unwrap();
    let jobs = Arc::new(
        ArchiveJobs::new(
            store.clone(),
            control_service.clone(),
            ArchiveStorage::local(root, installation).unwrap(),
            ImportLimits::default(),
        )
        .unwrap(),
    );
    if entries == 201 {
        stage_import_shares_the_upload_deadline(&jobs, &ctx, &clock, root).await;
    }
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
    if entries < 50_000 {
        let invalid = zip(valid().chain(std::iter::once((
            "../last.md".to_owned(),
            "# Forbidden\n".to_owned(),
        ))));
        let rejected = import(&jobs, &store, &ctx, &invalid).await;
        assert_eq!(
            (rejected.state, rejected.completed_units),
            (JobState::Failed, 0)
        );
        assert_eq!(
            rejected.import_diagnostic,
            Some(ImportDiagnostic {
                reason: ValidationReason::InvalidPathComponent,
                path: None,
            })
        );
    }
    if entries == 201 {
        let rejected = import(
            &jobs,
            &store,
            &ctx,
            &zip([
                ("first.md".into(), "# First".into()),
                ("Folder/Cafe\u{301}.TXT".into(), "private content".into()),
            ]),
        )
        .await;
        assert_eq!(rejected.completed_units, 0);
        assert_eq!(
            rejected.import_diagnostic,
            Some(ImportDiagnostic {
                reason: ValidationReason::UnsupportedArchiveEntry,
                path: Some("Folder/Café.TXT".into()),
            })
        );

        use notarium_core::auth::{EngineAuthContext, VerifiedHuman};
        let reader = VerifiedHuman::attest(
            PrincipalId::from_bytes([90; 16]),
            GrantId::from_bytes([91; 16]),
            ctx.auth().spaces().clone(),
            false,
        );
        let reader = SpaceContext::new(
            EngineAuthContext::for_human(reader),
            scope.clone(),
            budget(),
        )
        .unwrap();
        let derived = ctx
            .auth()
            .for_agent_run(
                AgentRunId::from_bytes([92; 16]),
                scope.space_id.clone(),
                notarium_core::auth::ChatAudience::Shared,
                ctx.auth().spaces().clone(),
            )
            .unwrap();
        let derived = SpaceContext::new(derived, scope.clone(), budget()).unwrap();
        assert!(
            store
                .get_job(derived, rejected.id.clone())
                .await
                .unwrap()
                .import_diagnostic
                .is_none()
        );
        let observed = store.get_job(reader, rejected.id).await.unwrap();
        assert_eq!(observed.state, JobState::Failed);
        assert!(observed.import_diagnostic.is_none());
    }
    assert_eq!(note_count(root, &scope), 0);

    let baseline = if entries == 50_000 {
        Some(sample_foreground(store.clone(), ctx.clone(), 1000).await)
    } else {
        None
    };
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
    let baseline_notes = if baseline.is_some() {
        note_count(root, &scope)
    } else {
        0
    };
    let foreground = if baseline.is_some() {
        // Start the paired sample after the first durable batch so the active
        // run measures foreground work during import writes.
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                match store.get_job(ctx.clone(), accepted_job.id.clone()).await {
                    Ok(job) if job.state == JobState::Running && job.completed_units > 1 => break,
                    Ok(job) => assert!(matches!(job.state, JobState::Queued | JobState::Running)),
                    Err(PortError::DeadlineExceeded(_) | PortError::Unavailable(_)) => {}
                    Err(err) => panic!("cannot observe active import: {err:?}"),
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .unwrap();
        Some(tokio::spawn(sample_foreground(
            store.clone(),
            ctx.clone(),
            1000,
        )))
    } else {
        None
    };
    let accepted = terminal(&store, &ctx, &accepted_job).await;
    eprintln!("import of {entries} linked notes: {:?}", started.elapsed());
    assert_eq!(accepted.state, JobState::Succeeded);
    if let (Some(baseline), Some(foreground)) = (baseline, foreground) {
        let during = foreground.await.unwrap();
        let memory = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find(|line| line.starts_with("VmHWM:"))
                    .map(str::to_owned)
            });
        let wal = rusqlite::Connection::open(root.canonical())
            .unwrap()
            .query_row("PRAGMA wal_checkpoint(RESTART)", [], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap();
        eprintln!(
            "{}",
            serde_json::json!({
                "import_notes": entries, "baseline": baseline, "during_import": during,
                "memory": memory, "restart_checkpoint": wal, "seconds": started.elapsed().as_secs_f64(),
            })
        );
        assert_eq!(baseline["errors"], 0);
        assert_eq!(during["errors"], 0);
        assert_eq!(baseline["read"]["errors"], 0);
        assert_eq!(during["read"]["errors"], 0);
        assert_eq!(baseline["read"]["count"], 1000);
        assert_eq!(during["read"]["count"], 1000);
        assert_eq!(
            note_count(root, &scope),
            entries as i64 + baseline_notes + 1000
        );
        assert_eq!(wal.0, 0);
        stop.cancel();
        running.await.unwrap().unwrap();
        control.close().await;
        runtime.shutdown().await.unwrap();
        return;
    }
    assert_eq!(note_count(root, &scope), entries as i64);

    let archive_chat = if entries == 10_000 {
        Some(seed_archive_sections(&store, &ctx).await)
    } else {
        None
    };
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
    let download = open_export_during_stalled_fsck(&jobs, ctx.clone(), id, root).await;
    if entries == 201 {
        let expires = clock.now.load(Ordering::SeqCst) + 86_400_000;
        let pat = control_service
            .create_pat(
                AccountContext::new(ctx.auth().clone(), budget()),
                CreatePat {
                    name: "archive".into(),
                    scope: BearerScope::Write,
                    selected_spaces: None,
                    expires_at_ms: Some(expires),
                    expected: account.revision,
                },
            )
            .await
            .unwrap();
        let pat_auth = control_service
            .resolve(PreAuthContext {
                budget: budget(),
                evidence: AuthEvidence::new(AuthEvidenceKind::Pat, pat.value.token.expose().into()),
            })
            .await
            .unwrap();
        let pat_ctx = SpaceContext::new(pat_auth, scope.clone(), budget()).unwrap();
        let job = jobs
            .enqueue(
                pat_ctx.clone(),
                mutation(&pat_ctx, ContentJobKind::ExportSpace { encrypted: false }),
            )
            .await
            .unwrap()
            .value;
        let exported_by_pat = terminal(&store, &pat_ctx, &job).await;
        let as_caller = jobs.open_export(pat_ctx, id).await.unwrap();
        let as_origin = jobs
            .open_export(ctx.clone(), &exported_by_pat.artifacts[0])
            .await
            .unwrap();
        let before_expiry = clock.now.load(Ordering::SeqCst);
        for reader in [as_caller, as_origin] {
            *registry.advance_at_handoff.lock().unwrap() = Some(expires);
            let (out, mut recv) = tokio::sync::mpsc::channel(1);
            let chunk = reader
                .read_chunk_into(budget(), 0, 1, out.reserve_owned().await.unwrap())
                .await;
            assert!(matches!(
                chunk,
                Err(PortError::Domain(DomainError::AuthenticationFailed))
            ));
            assert!(recv.try_recv().is_err());
            clock.now.store(before_expiry, Ordering::SeqCst);
        }
    }
    let metadata = download.metadata();
    let (sender, mut chunks) = tokio::sync::mpsc::channel(1);
    download
        .read_chunk_into(
            budget(),
            metadata.bytes - 5,
            5,
            sender.reserve_owned().await.unwrap(),
        )
        .await
        .unwrap();
    let last = chunks.try_recv().unwrap();
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
    if let Some((thread, retained_body)) = archive_chat {
        let read_entry = |archive: &mut zip::ZipArchive<Cursor<Vec<u8>>>, name| {
            let mut result = String::new();
            archive
                .by_name(name)
                .unwrap()
                .read_to_string(&mut result)
                .unwrap();
            result
        };
        assert_eq!(
            read_entry(&mut archive, ".notarium/fields/schema.yaml"),
            "# Archived field schema\n",
        );
        assert_eq!(
            read_entry(
                &mut archive,
                ".notarium/abilities/archive-skill/scripts/helper.txt"
            ),
            "packaged resource\n",
        );
        let chat = read_entry(&mut archive, &format!("chats/{thread}.jsonl"));
        let rows = chat
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows[1]["body"], retained_body);
        assert_eq!(rows[2]["parent_seq"], rows[1]["entry_seq"]);
        assert_eq!(rows[2]["kind"], "redacted");
        assert_eq!(rows[2]["body"], serde_json::Value::Null);
        assert_eq!(rows[3]["parent_seq"], rows[1]["entry_seq"]);
        assert_eq!(rows[3]["body"], "alternate branch");
        assert_eq!(
            archive
                .file_names()
                .filter(|name| name.as_ref().unwrap().starts_with("documents/entry-"))
                .count(),
            entries
        );
    } else {
        assert_eq!(archive.len(), entries);
    }

    let db = rusqlite::Connection::open(root.canonical()).unwrap();
    let note = db
        .query_row(
            "SELECT note_id FROM note_heads WHERE space_id=?1 AND slug LIKE 'entry-%' LIMIT 1",
            [scope.space_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .unwrap();
    if entries == 201 {
        db.execute(
            "WITH RECURSIVE counts(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM counts WHERE i<10000)
             INSERT INTO folder_heads(space_id,folder_id,parent_folder_id,is_root,slug,slug_fold,display_name,
               is_project,lifecycle_state,rev_seq,head_rev_id,created_seq,updated_seq,updated_at_sec,updated_at_nsec)
             SELECT space_id,printf('fld_%032x',i),root_folder_id,0,'sibling-' || i,'sibling-' || i,'',0,
               'active',0,printf('rev_%032x',i),0,0,0,0 FROM spaces CROSS JOIN counts WHERE space_id=?1",
            [scope.space_id.as_str()],
        ).unwrap();
        let selected = jobs
            .enqueue(
                ctx.clone(),
                mutation(
                    &ctx,
                    ContentJobKind::Export {
                        notes: vec![NoteId::parse(&note).unwrap()],
                        encrypted: false,
                    },
                ),
            )
            .await
            .unwrap()
            .value;
        let completed =
            tokio::time::timeout(Duration::from_secs(10), terminal(&store, &ctx, &selected))
                .await
                .expect("one selected note must finish regardless of unrelated sibling folders");
        assert_eq!(
            (completed.state, completed.completed_units),
            (JobState::Succeeded, 1)
        );
        let selected_download = jobs
            .open_export(ctx.clone(), &completed.artifacts[0])
            .await
            .unwrap();
        let bytes = selected_download
            .read_chunk(budget(), 0, 16 * 1024)
            .await
            .unwrap();
        let mut selected_archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let slug: String = db
            .query_row(
                "SELECT slug FROM note_heads WHERE space_id=?1 AND note_id=?2",
                rusqlite::params![scope.space_id.as_str(), note],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(selected_archive.len(), 1);
        assert!(
            selected_archive
                .by_name(&format!("documents/{slug}.md"))
                .is_ok()
        );
    }
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
    if entries == 201 {
        check_import_admission(&jobs, &store, &ctx, root).await;
    }
    stop.cancel();
    running.await.unwrap().unwrap();
    if entries == 10_000 {
        probe_slow_cut(&jobs, &store, &ctx, root).await;
    }
    control.close().await;
    runtime.shutdown().await.unwrap();
}

async fn check_import_admission(
    jobs: &ArchiveJobs,
    store: &CanonicalStore,
    ctx: &SpaceContext,
    root: &DataRoot,
) {
    let initial = note_count(root, ctx.scope());
    let mut archive = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let stored =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    archive.start_file("budget/first.md", stored).unwrap();
    archive.write_all(b"# First").unwrap();
    archive.start_file("budget/last.md", stored).unwrap();
    archive.write_all(b"# ").unwrap();
    archive
        .write_all(&vec![b'a'; codec::MAX_MSGPACK_DECODE_BYTES])
        .unwrap();
    let bytes = archive.finish().unwrap().into_inner();
    let job = import(jobs, store, ctx, &bytes).await;
    assert_eq!((job.state, job.completed_units), (JobState::Failed, 0));
    assert_eq!(
        job.import_diagnostic.unwrap().reason,
        ValidationReason::BudgetExceeded
    );
    assert_eq!(note_count(root, ctx.scope()), initial);
    let db = rusqlite::Connection::open(root.canonical()).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM folder_heads WHERE slug='budget'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );

    // Each note fits the configured writer capacity on its own.
    let body = |name: &str, len| {
        let mut data = vec![0; len];
        blake3::Hasher::new()
            .update(name.as_bytes())
            .finalize_xof()
            .fill(&mut data);
        let text: String = data
            .into_iter()
            .map(|b| char::from(b'a' + b % 16))
            .collect();
        format!("# {name}\n\n{text}")
    };
    let mut notes = Vec::new();
    for slug in ["writer-a", "writer-b"] {
        let carrier = body(slug, 5000);
        assert!(
            (2049..=4096).contains(
                &store
                    .prepare_blob(carrier.as_bytes())
                    .unwrap()
                    .compressed_size()
            )
        );
        notes.push((format!("{slug}.md"), carrier));
    }
    let job = import(jobs, store, ctx, &zip(notes)).await;
    assert_eq!((job.state, job.completed_units), (JobState::Succeeded, 2));
    let oversized = body("writer-limit", 16_000);
    assert!(
        store
            .prepare_blob(oversized.as_bytes())
            .unwrap()
            .compressed_size()
            > 4096
    );
    let job = import(
        jobs,
        store,
        ctx,
        &zip([("writer-limit.md".into(), oversized)]),
    )
    .await;
    assert_eq!((job.state, job.completed_units), (JobState::Failed, 0));
    assert_eq!(
        job.import_diagnostic.unwrap().reason,
        ValidationReason::BudgetExceeded
    );

    let (id, bytes): (String, Vec<u8>) = db
        .query_row(
            "SELECT n.note_id,r.metadata_msgpack FROM note_heads n JOIN revisions r
         ON r.space_id=n.space_id AND r.rev_id=n.head_rev_id WHERE n.slug='writer-a'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let mut envelope = codec::RevisionMetadataEnvelope::decode(&bytes).unwrap();
    let codec::RevisionMetadataPayload::Note(note) = &mut envelope.payload else {
        panic!("expected a note")
    };
    note.title = "x".repeat(codec::MAX_MSGPACK_DECODE_BYTES);
    let excess = codec::encode_msgpack(&envelope).unwrap().len() - codec::MAX_MSGPACK_DECODE_BYTES;
    let codec::RevisionMetadataPayload::Note(note) = &mut envelope.payload else {
        unreachable!()
    };
    note.title
        .truncate(codec::MAX_MSGPACK_DECODE_BYTES - excess);
    let encoded = envelope.encode().unwrap();
    assert_eq!(encoded.len(), codec::MAX_MSGPACK_DECODE_BYTES);
    assert_eq!(
        codec::RevisionMetadataEnvelope::decode(&encoded).unwrap(),
        envelope
    );
    let codec::RevisionMetadataPayload::Note(note) = &mut envelope.payload else {
        unreachable!()
    };
    note.title.push('x');
    assert!(
        matches!(envelope.encode(), Err(PortError::Domain(DomainError::ValidationFailed { diagnostic })) if diagnostic.reason == ValidationReason::BudgetExceeded)
    );
    store
        .delete_note(
            ctx.clone(),
            mutation(
                ctx,
                DeleteNote {
                    note: NoteId::parse(&id).unwrap(),
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
}

async fn stage_import_shares_the_upload_deadline(
    jobs: &ArchiveJobs,
    ctx: &SpaceContext,
    clock: &Arc<TestClock>,
    root: &DataRoot,
) {
    use tokio::io::AsyncWriteExt;

    let mut ctx = ctx.clone();
    ctx.budget.remaining = Duration::from_millis(300);
    let (mut sender, input) = tokio::io::duplex(1);
    let stream = async {
        // The second byte cannot enter the pipe until the worker has polled
        // the first read, after its initial authority check.
        sender.write_all(b"ab").await.unwrap();
        tokio::time::sleep(Duration::from_millis(175)).await;
        clock.delay_once_ms.store(175, Ordering::SeqCst);
        sender.shutdown().await.unwrap();
    };
    let (result, ()) = tokio::join!(jobs.stage_import(ctx, input), stream);
    assert!(matches!(result, Err(PortError::DeadlineExceeded(_))));
    let db = rusqlite::Connection::open(root.canonical()).unwrap();
    let pinned: i64 = db
        .query_row(
            "SELECT count(*) FROM archive_uploads WHERE object_kind='input' AND state='pinned'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(pinned, 0);
}

async fn open_export_during_stalled_fsck(
    jobs: &Arc<ArchiveJobs>,
    mut ctx: SpaceContext,
    artifact: &ArtifactId,
    root: &DataRoot,
) -> ArchiveDownload {
    struct StalledSource {
        started: Option<tokio::sync::oneshot::Sender<()>>,
        release: std::sync::mpsc::Receiver<()>,
    }
    impl Read for StalledSource {
        fn read(&mut self, _out: &mut [u8]) -> std::io::Result<usize> {
            if let Some(started) = self.started.take() {
                let _ = started.send(());
                let _ = self.release.recv();
            }
            Ok(0)
        }
    }
    impl Seek for StalledSource {
        fn seek(&mut self, _from: SeekFrom) -> std::io::Result<u64> {
            Ok(0)
        }
    }
    let start = || {
        let (started, reading) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let keys = root.keyring();
        let budget = budget();
        let cancel = budget.cancellation.clone();
        let call = tokio::spawn(async move {
            run_fsck(
                MaintenanceContext {
                    authority: ServiceAuthority::admit(ServicePurpose::Fsck),
                    budget,
                },
                FsckInput::Archive(ArchiveInput::with_length(
                    StalledSource {
                        started: Some(started),
                        release: wait,
                    },
                    4096,
                )),
                &keys,
                BackupOptions::default(),
            )
            .await
        });
        (reading, cancel, release, call)
    };
    let (first_ready, first_cancel, first_release, first) = start();
    let (second_ready, second_cancel, second_release, second) = start();
    tokio::try_join!(first_ready, second_ready).unwrap();
    first_cancel.cancel();
    second_cancel.cancel();
    for result in [first.await.unwrap(), second.await.unwrap()] {
        assert!(matches!(result, Err(PortError::Cancelled(_))));
    }
    ctx.budget = budget();
    ctx.budget.remaining = Duration::from_secs(2);
    let opened = jobs.open_export(ctx, artifact).await;
    drop((first_release, second_release));
    opened.expect("opening an export has its own read admission")
}

async fn probe_slow_cut(
    jobs: &ArchiveJobs,
    store: &CanonicalStore,
    ctx: &SpaceContext,
    root: &DataRoot,
) {
    use notarium_canonical::ArchiveJobClass;
    use notarium_canonical::peers::archive_export::ExportData;

    let note = NoteId::from_bytes(codec::ordered_id_16().unwrap());
    let carrier = format!(
        "# Slow sink\n\n{}",
        "A bounded carrier line.\n".repeat(16_000)
    );
    let digest = notarium_syntax::content_digest(&carrier);
    store
        .create_note(
            ctx.clone(),
            mutation(
                ctx,
                CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "slow-sink".into(),
                    class: notarium_core::classes::DocClass::UserDoc,
                    carrier,
                },
            ),
        )
        .await
        .unwrap();
    let queued = jobs
        .enqueue(
            ctx.clone(),
            mutation(ctx, ContentJobKind::ExportSpace { encrypted: false }),
        )
        .await
        .unwrap()
        .value;
    let claimed = store
        .claim_next_archive_job(
            &budget(),
            ctx.scope(),
            "checkpoint-probe",
            Duration::from_secs(30),
            ArchiveJobClass::Export,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(claimed.job.id, queued.id);
    let began = std::time::Instant::now();
    let cut = store.capture_archive_export(ctx, &claimed).await.unwrap();
    let capture = began.elapsed();
    let snapshot = cut.snapshot_elapsed;
    assert!(snapshot < Duration::from_millis(50));
    assert_eq!(
        cut.entries
            .iter()
            .filter(|entry| entry.path.starts_with("documents/entry-"))
            .count(),
        9_999,
    );
    assert!(cut.entries.iter().any(|entry| {
        entry.path == "slow-sink.md"
            && matches!(entry.data, ExportData::Blob(hash) if hash == digest)
    }));
    let (sink, mut output) = tokio::sync::mpsc::channel(1);
    let call = budget();
    let cancel = call.cancellation.clone();
    let store_for_copy = store.clone();
    let hold = cut.hold_id.clone();
    let scope = ctx.scope().clone();
    let streaming = tokio::spawn(async move {
        store_for_copy
            .stream_held_blob(&call, &hold, &scope, digest, &sink)
            .await
    });
    assert!(output.recv().await.is_some());
    assert!(!streaming.is_finished());
    store
        .delete_note(
            ctx.clone(),
            mutation(
                ctx,
                DeleteNote {
                    note,
                    disposition: DeleteDisposition::Trash,
                },
            ),
        )
        .await
        .unwrap();
    assert!(
        store
            .check_export_generation(&budget(), ctx.scope(), cut.generation)
            .await
            .is_err()
    );

    let image = root.canonical();
    let (passive, restart) = tokio::task::spawn_blocking(move || {
        let db = rusqlite::Connection::open(image).unwrap();
        let check = |sql| {
            db.query_row(sql, [], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
        };
        (
            check("PRAGMA wal_checkpoint(PASSIVE)"),
            check("PRAGMA wal_checkpoint(RESTART)"),
        )
    })
    .await
    .unwrap();
    assert_eq!(passive.1, passive.2);
    assert_eq!(restart.0, 0);
    assert_eq!(restart.1, restart.2);
    cancel.cancel();
    drop(output);
    assert!(streaming.await.unwrap().is_err());
    cut.release().await.unwrap();
    eprintln!(
        "10k export capture complete {capture:?}, SQL {snapshot:?}, WAL passive {passive:?}, restart {restart:?}"
    );
}

async fn seed_archive_sections(
    store: &CanonicalStore,
    ctx: &SpaceContext,
) -> (ChatThreadId, String) {
    use notarium_canonical::{CreateFolderSpec, UpdateSpaceSchema};
    use notarium_core::classes::{AbilityKind, DocClass};

    let owner = ctx.auth().principal().clone();
    let space = &ctx.scope().space_id;
    let project = FolderId::from_bytes(codec::ordered_id_16().unwrap());
    let entrypoint = NoteId::from_bytes(codec::ordered_id_16().unwrap());
    store
        .update_space_schema(
            ctx.clone(),
            mutation(
                ctx,
                UpdateSpaceSchema {
                    schema_note: NoteId::from_bytes(codec::ordered_id_16().unwrap()),
                    parent: None,
                    slug: "export-schema".into(),
                    carrier: "# Archived field schema\n".into(),
                    schema: Default::default(),
                    expected_schema_revision: None,
                },
            ),
        )
        .await
        .unwrap();
    store
        .create_folder(CreateFolderSpec {
            scope: ctx.scope().clone(),
            active_epoch: store.read_space(space).await.unwrap().active_epoch,
            folder_id: project.clone(),
            parent: None,
            slug: "archive-project".into(),
            display_name: "Archive project".into(),
            is_project: true,
            project_slug: Some("archive-project".into()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .unwrap();
    store
        .create_note(
            ctx.clone(),
            mutation(
                ctx,
                CreateNote {
                    note: entrypoint.clone(),
                    parent: Some(project),
                    class: DocClass::Skill,
                    slug: "archive-skill".into(),
                    carrier: "---\nclass: skill\n---\n# Archive skill\n".into(),
                },
            ),
        )
        .await
        .unwrap();
    let resource = "packaged resource\n";
    store
        .publish_ability_package(
            ctx.clone(),
            mutation(
                ctx,
                PublishAbilityPackage {
                    ability: AbilityId::from_bytes(codec::ordered_id_16().unwrap()),
                    kind: AbilityKind::Skill,
                    entrypoint,
                    files: vec![AbilityFile {
                        path: "scripts/helper.txt".into(),
                        content: resource.into(),
                        digest: notarium_syntax::content_digest(resource),
                    }],
                    expected_package_revision: None,
                },
            ),
        )
        .await
        .unwrap();

    let thread = ChatThreadId::from_bytes(codec::ordered_id_16().unwrap());
    store
        .create_chat(
            ctx.clone(),
            mutation(
                ctx,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner,
                    project_folder: None,
                    title: "Exported conversation".into(),
                },
            ),
        )
        .await
        .unwrap();
    let retained = "A staged chat body with a quote \" and a newline.\n".repeat(20);
    let staged = store.stage_chat_blob(ctx.clone(), &retained).await.unwrap();
    let append = |parent, body| {
        mutation(
            ctx,
            AppendChat {
                thread: thread.clone(),
                parent,
                kind: ChatEntryKind::Human,
                body,
                referenced_notes: Vec::new(),
                tainted: false,
            },
        )
    };
    let parent = store
        .append_chat(
            ctx.clone(),
            append(ThreadEntrySeq::ZERO, ChatInputBody::Staged(staged)),
        )
        .await
        .unwrap()
        .value
        .seq;
    let removed = store
        .append_chat(
            ctx.clone(),
            append(parent, ChatInputBody::Text("removed body".into())),
        )
        .await
        .unwrap()
        .value
        .seq;
    store
        .fork_chat(
            ctx.clone(),
            mutation(
                ctx,
                ForkChat {
                    thread: thread.clone(),
                    parent,
                },
            ),
        )
        .await
        .unwrap();
    let alternate = store
        .append_chat(
            ctx.clone(),
            append(parent, ChatInputBody::Text("alternate branch".into())),
        )
        .await
        .unwrap()
        .value
        .seq;
    let head = store
        .read_chat(
            ctx.clone(),
            ChatRead {
                thread: thread.clone(),
                leaf: alternate,
                before: None,
                max_entries: PageLimit::new(1).unwrap(),
            },
        )
        .await
        .unwrap()
        .thread
        .revision;
    store
        .redact_chat_entry(
            ctx.clone(),
            mutation(
                ctx,
                RedactChatEntry {
                    thread: thread.clone(),
                    entry: removed,
                    expected_thread_revision: head,
                },
            ),
        )
        .await
        .unwrap();
    (thread, retained)
}

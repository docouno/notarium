use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use notarium_canonical::{
    ArchiveJobClass, CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec, codec,
    peers::archive_export::ExportCut,
};
use notarium_control::{
    backup::{BackupConfig, ControlBackup},
    keyring::{FreshLocalInitializer, Keyring, KeyringLocation},
    store::ControlStore,
};
use notarium_core::{
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::{DataRoot, EpochClassification, EpochReason, StorageEpochState},
    ids::*,
    model::HistoryScope,
    ports::*,
    receipt::{CausalBasis, ChangeCursor, CommandIdentity, ReceiptSet},
};
use notarium_jobs::{
    ArchiveInput, BackupArchive, BackupOptions, FsckInput, RestoreKeyring, RestoreTarget,
    run_backup, run_fsck, run_restore,
};

#[path = "maintenance/cloud_takeover.rs"]
mod cloud_takeover;
#[path = "maintenance/paired_load.rs"]
mod paired_load;
#[path = "maintenance/revision_integrity.rs"]
mod revision_integrity;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let parent = std::env::temp_dir();
        paired_load::check_rated_volume(&parent);
        let path = parent.join(codec::new_prefixed_hex_id("paired_archive_test_").unwrap());
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(codec::ordered_id_16().unwrap()),
        cancellation: Cancellation::default(),
        remaining: Duration::from_secs(60),
    }
}

fn authority(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: budget(),
    }
}

fn auth(scope: &HistoryScope, owner: &PrincipalId) -> SpaceContext {
    let human = VerifiedHuman::attest(
        owner.clone(),
        GrantId::from_bytes([1; 16]),
        BTreeMap::from([(
            scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
                project_root: None,
            },
        )]),
        false,
    );
    SpaceContext::new(EngineAuthContext::for_human(human), scope.clone(), budget()).unwrap()
}

fn open(path: &Path) -> ArchiveInput {
    ArchiveInput::new(File::open(path).unwrap()).unwrap()
}

async fn backup_completes_with_caller_blocking_pool_occupied(
    canonical: &CanonicalStore,
    control: &ControlBackup,
    root: &DataRoot,
    scratch: &Path,
) {
    let spools = scratch.join("occupied-pool-spools");
    canonical.set_backup_spool_dir(spools.clone());
    canonical.set_backup_step_delay_for_test(Duration::from_millis(20));
    let destination = scratch.join("occupied-pool.zip");
    let ctx = authority(ServicePurpose::Backup);
    let cancellation = ctx.budget.cancellation.clone();
    let (occupy, begin_blocking) = tokio::sync::oneshot::channel();
    let (started, ready) = tokio::sync::oneshot::channel();
    let (unblock, blocked) = std::sync::mpsc::channel::<()>();
    let (done, mut result) = tokio::sync::oneshot::channel();
    let caller = std::thread::spawn({
        let canonical = canonical.clone();
        let control = control.clone();
        let destination = destination.clone();
        move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(1)
                .build()
                .unwrap();
            drop(runtime.spawn(async move {
                if begin_blocking.await.is_ok() {
                    drop(tokio::task::spawn_blocking(move || {
                        let _ = started.send(());
                        let _ = blocked.recv();
                    }));
                }
            }));
            let outcome = runtime.block_on(run_backup(
                ctx,
                &canonical,
                &control,
                &destination,
                sqlite_backup_options(),
            ));
            let _ = done.send(outcome);
        }
    });
    let control_pending = root.staging().join("control");
    let prepared = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if paired_load::artifact_files(&control_pending)
                .iter()
                .any(|path| path.extension().is_some_and(|ext| ext == "pending"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await;
    let _ = occupy.send(());
    let occupied = tokio::time::timeout(Duration::from_secs(3), ready).await;
    let occupied_before_copy = canonical.last_backup_memory_stats().is_none();
    let finished = tokio::time::timeout(Duration::from_secs(5), &mut result).await;
    if finished.is_err() {
        cancellation.cancel();
    }
    let remaining = canonical
        .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM backup_holds")
        .await;
    drop(unblock);
    tokio::task::spawn_blocking(move || caller.join().unwrap())
        .await
        .unwrap();

    canonical.set_backup_step_delay_for_test(Duration::ZERO);
    prepared.expect("Control finished key inspection before occupying the caller pool");
    occupied
        .expect("caller blocking pool became occupied")
        .unwrap();
    assert!(
        occupied_before_copy,
        "the caller pool must be occupied before spooling ends"
    );
    let archive = finished
        .expect("backup must finish while the caller pool is occupied")
        .unwrap()
        .unwrap();
    assert!(archive.bytes > 0);
    assert_eq!(remaining.unwrap(), 0);
    assert!(destination.is_file());
    assert!(paired_load::artifact_files(&spools).is_empty());
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    canonical.set_backup_spool_dir(root.staging().join("backups"));
}

struct CaptureWrite {
    note: NoteId,
    before: SpaceSeq,
    after: SpaceSeq,
}

impl CaptureWrite {
    async fn check_restored(
        &self,
        restored: &CanonicalStore,
        owner: &PrincipalId,
        cutoff: &ChangeCursor,
    ) {
        assert!(cutoff.after == self.before || cutoff.after == self.after);
        let result = restored
            .get_note(
                auth(&cutoff.scope, owner),
                GetNote {
                    note: self.note.clone(),
                    revision: None,
                    causal: CausalBasis::Exact(ReceiptSet::default()),
                },
            )
            .await;
        if cutoff.after == self.after {
            result.expect("the restored note must be visible at its committed cutoff");
        } else {
            assert!(matches!(
                result,
                Err(notarium_core::error::PortError::Domain(
                    notarium_core::DomainError::ResourceNotFound
                ))
            ));
        }
    }
}

async fn capture_with_a_live_write(
    canonical: &CanonicalStore,
    control: &ControlBackup,
    scope: &HistoryScope,
    owner: &PrincipalId,
    path: &Path,
    carrier: &str,
    options: BackupOptions,
) -> (BackupArchive, CaptureWrite) {
    let spools = path.with_extension("capture-spools");
    canonical.set_backup_spool_dir(spools.clone());
    canonical.set_backup_step_delay_for_test(Duration::from_millis(15));
    let before = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;
    let note = NoteId::from_bytes(codec::ordered_id_16().unwrap());
    let write = async {
        // A fresh pending marker proves that this backup has entered prepare.
        loop {
            if fs::read_dir(&spools).is_ok_and(|mut entries| {
                entries.any(|entry| {
                    entry
                        .unwrap()
                        .path()
                        .extension()
                        .is_some_and(|ext| ext == "pending")
                })
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        canonical
            .create_note(
                auth(scope, owner),
                Mutation {
                    identity: CommandIdentity {
                        scope: scope.clone(),
                        actor: owner.clone(),
                        key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
                        hash: ContentDigest::from_bytes([0; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: note.clone(),
                        parent: None,
                        slug: "saved-during-backup".into(),
                        class: DocClass::UserDoc,
                        carrier: carrier.into(),
                    },
                },
            )
            .await
            .unwrap();
        canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq
    };
    let backup = run_backup(
        authority(ServicePurpose::Backup),
        canonical,
        control,
        path,
        options,
    );
    tokio::pin!(backup);
    let after = tokio::select! {
        biased;
        result = &mut backup => panic!("backup finished before the live write completed: {result:?}"),
        seq = tokio::time::timeout(Duration::from_secs(10), write) => seq.unwrap(),
    };
    assert!(after > before);
    let backup = backup.await.unwrap();
    canonical.set_backup_step_delay_for_test(Duration::ZERO);
    assert!(paired_load::artifact_files(&spools).is_empty());
    eprintln!("live write committed at {after:?} before paired backup completed");
    (
        backup,
        CaptureWrite {
            note,
            before,
            after,
        },
    )
}

fn sqlite_backup_options() -> BackupOptions {
    let mut options = BackupOptions::default();
    options.sqlite_verifier = options.sqlite_verifier.with_command(
        std::env::current_exe().unwrap(),
        ["--exact", "sqlite_verifier_protocol_child", "--nocapture"]
            .into_iter()
            .map(Into::into)
            .collect(),
    );
    options
}

#[test]
fn sqlite_verifier_protocol_child() {
    if std::env::var_os("NOTARIUM_SQLITE_VERIFIER_CHILD").is_some() {
        notarium_jobs::run_sqlite_verifier().unwrap();
    }
}

fn repackage_sqlite(
    path: &Path,
    scratch: &Path,
    database: &str,
    statement: &str,
) -> Cursor<Vec<u8>> {
    repackage_database(path, database, |payload| {
        let image = scratch.join(codec::new_prefixed_hex_id("forged_sqlite_").unwrap());
        fs::write(&image, &*payload).unwrap();
        let db = rusqlite::Connection::open(&image).unwrap();
        db.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
        db.execute_batch(statement).unwrap();
        assert_eq!(
            db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
        drop(db);
        *payload = fs::read(image).unwrap();
    })
}

fn repackage_database(
    path: &Path,
    database: &str,
    change: impl FnOnce(&mut Vec<u8>),
) -> Cursor<Vec<u8>> {
    let mut source = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
    let bytes = |source: &mut zip::ZipArchive<File>, name| {
        let mut bytes = Vec::new();
        source
            .by_name(name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        bytes
    };
    let mut control = bytes(&mut source, "db/control");
    let mut canonical = bytes(&mut source, "db/canonical");
    let payload = match database {
        "control" => &mut control,
        "canonical" => &mut canonical,
        _ => panic!("unknown database"),
    };
    change(payload);
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&bytes(&mut source, "manifest.json")).unwrap();
    manifest[database]["bytes"] = payload.len().into();
    manifest[database]["digest"] =
        serde_json::to_value(ContentDigest::from_bytes(*blake3::hash(payload).as_bytes())).unwrap();
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("db/control", control),
        ("db/canonical", canonical),
        ("cas/index", bytes(&mut source, "cas/index")),
        ("cas/data", bytes(&mut source, "cas/data")),
    ] {
        output.start_file(name, opts).unwrap();
        output.write_all(&data).unwrap();
    }
    output.finish().unwrap()
}

fn change_note_metadata(
    encoded: &[u8],
    change: impl FnOnce(&mut codec::NoteRevisionMetadata),
) -> Vec<u8> {
    let mut envelope = codec::RevisionMetadataEnvelope::decode(encoded).unwrap();
    let codec::RevisionMetadataPayload::Note(note) = &mut envelope.payload else {
        panic!("expected a note revision");
    };
    change(note);
    envelope.encode().unwrap()
}

fn stale_carrier(note: &mut codec::NoteRevisionMetadata) {
    let digest = note.content_digest.unwrap();
    let mut bytes = *digest.as_bytes();
    bytes.rotate_left(1);
    assert_ne!(bytes, *digest.as_bytes());
    note.content_digest = Some(ContentDigest::from_bytes(bytes));
}

fn v7_privacy_fixture() -> (String, String) {
    use notarium_canonical::schema::sqlite_v7_privacy_definitions;

    let triggers: BTreeMap<_, _> = sqlite_v7_privacy_definitions().collect();
    let sql: Vec<_> = triggers.values().map(String::as_str).collect();
    // Fingerprint the six sqlite_schema.sql values from the original supported v7.
    assert_eq!(
        blake3::hash(sql.join("\n").as_bytes()).to_hex().as_str(),
        "005c85d18644b31b10444c13b88185aa9def835401f26ab2894adc9f18aac09e"
    );
    let statements: Vec<_> = triggers
        .into_iter()
        .map(|(name, sql)| format!("DROP TRIGGER {name}; {sql};"))
        .collect();
    (statements.join("\n"), statements[0].clone())
}

async fn check_restored_note(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
    note: NoteId,
    expected: &str,
) {
    let ctx = auth(scope, owner);
    let snapshot = store
        .get_note(
            ctx.clone(),
            GetNote {
                note,
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        snapshot.document.explicit_read(ctx.auth()).unwrap(),
        expected
    );
    let ChangeReadResult::Seed(seed) = store
        .catch_up(
            authority(ServicePurpose::Projection),
            ChangeRead::Seed {
                scope: scope.clone(),
                cutoff: None,
                limit: PageLimit::new(10).unwrap(),
            },
        )
        .await
        .unwrap()
    else {
        panic!("expected a projection seed")
    };
    assert_eq!(&seed.cutoff.scope, scope);
    assert!(seed.next.is_none());
    assert!(seed.notes.iter().any(|item| {
        item.document.reference() == snapshot.document.reference()
            && item.document.revision() == snapshot.document.revision()
    }));
}

async fn held_export(
    store: &CanonicalStore,
    scope: &HistoryScope,
    owner: &PrincipalId,
) -> ExportCut {
    let ctx = auth(scope, owner);
    store
        .create_job(
            ctx.clone(),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes(codec::ordered_id_16().unwrap()),
                    hash: ContentDigest::from_bytes([0; 32]),
                },
                preconditions: Preconditions::default(),
                input: ContentJobKind::ExportSpace { encrypted: false },
            },
        )
        .await
        .unwrap();
    let claim = store
        .claim_next_archive_job(
            &budget(),
            scope,
            "backup-test-export",
            Duration::from_secs(60),
            ArchiveJobClass::Export,
        )
        .await
        .unwrap()
        .unwrap();
    store.capture_archive_export(&ctx, &claim).await.unwrap()
}

async fn local_backup_fixture(
    root: &DataRoot,
) -> (
    InstallationId,
    ControlStore,
    ControlBackup,
    CanonicalStore,
    CanonicalRuntime,
) {
    fs::create_dir_all(root.root().join("v1")).unwrap();
    let installation = InstallationId::from_bytes([2; 16]);
    let control = ControlStore::sqlite(root).await.unwrap();
    let empty = EmptyRootAuthorization::from_classification(
        installation.clone(),
        EpochClassification {
            state: StorageEpochState::EmptyRoot,
            reason: EpochReason::ConfirmedEmpty,
        },
    )
    .unwrap();
    let keyring = FreshLocalInitializer::initialize(control.clone(), root.clone(), empty, budget())
        .await
        .unwrap();
    rusqlite::Connection::open(root.control())
        .unwrap()
        .execute("UPDATE v1_storage_epoch SET state='ready'", [])
        .unwrap();
    let binding = ControlBackup::new(
        control.clone(),
        keyring,
        root.clone(),
        BackupConfig::default(),
    )
    .unwrap();
    let (canonical, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        installation.clone(),
        root.clone(),
    ))
    .await
    .unwrap();
    (installation, control, binding, canonical, runtime)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paired_archive_completes_with_a_single_caller_blocking_thread() {
    let scratch = Scratch::new();
    let root = DataRoot::new(scratch.0.join("source"));
    let (_, control, binding, canonical, runtime) = local_backup_fixture(&root).await;
    let owner = PrincipalId::from_bytes([0xf0; 16]);
    let scope = canonical
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([0xf1; 16]),
            incarnation: HistoryIncarnation::from_bytes([0xf2; 16]),
            root_folder_id: FolderId::from_bytes([0xf3; 16]),
            slug: "single-blocking-thread".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    for ordinal in 0..20 {
        let mut key = [0; 16];
        key[0] = 0xf4;
        key[15] = ordinal;
        canonical
            .create_note(
                auth(&scope, &owner),
                Mutation {
                    identity: CommandIdentity {
                        scope: scope.clone(),
                        actor: owner.clone(),
                        key: CommandKey::from_bytes(key),
                        hash: ContentDigest::from_bytes([0; 32]),
                    },
                    preconditions: Preconditions::default(),
                    input: CreateNote {
                        note: NoteId::from_bytes(key),
                        parent: None,
                        slug: format!("distinct-{ordinal}"),
                        class: DocClass::UserDoc,
                        carrier: format!("# Distinct body {ordinal}\n"),
                    },
                },
            )
            .await
            .unwrap();
    }
    let archive = scratch.0.join("single-blocking-thread.zip");
    let caller = std::thread::spawn({
        let store = canonical.clone();
        let adapter = binding.clone();
        let keyring = root.keyring();
        let archive = archive.clone();
        move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .max_blocking_threads(1)
                .build()
                .unwrap();
            runtime.block_on(async {
                let mut backup = authority(ServicePurpose::Backup);
                backup.budget.remaining = Duration::from_secs(5);
                tokio::time::timeout(
                    Duration::from_secs(8),
                    run_backup(backup, &store, &adapter, &archive, sqlite_backup_options()),
                )
                .await
                .expect("CAS packing must finish with one caller blocking thread")
                .unwrap();
                let mut fsck = authority(ServicePurpose::Fsck);
                fsck.budget.remaining = Duration::from_secs(5);
                tokio::time::timeout(
                    Duration::from_secs(8),
                    run_fsck(
                        fsck,
                        FsckInput::Live {
                            canonical: &store,
                            control: &adapter,
                        },
                        &keyring,
                        sqlite_backup_options(),
                    ),
                )
                .await
                .expect("live verification must finish with one caller blocking thread")
                .unwrap()
            })
        }
    });
    let report = tokio::task::spawn_blocking(move || caller.join().unwrap())
        .await
        .unwrap();
    assert_eq!(report.blobs, 20);
    assert!(archive.is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&archive).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    let limited_path = scratch.0.join("one-record.zip");
    let limited = BackupOptions {
        max_index_records: 1,
        ..sqlite_backup_options()
    };
    assert!(matches!(
        run_backup(authority(ServicePurpose::Backup), &canonical, &binding, &limited_path, limited).await,
        Err(notarium_core::error::PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::BudgetExceeded
    ));
    assert!(!limited_path.exists());
    assert_eq!(
        canonical
            .execute_diagnostic_read_sql_for_test(None, "SELECT count(*) FROM backup_holds")
            .await
            .unwrap(),
        0
    );
    assert!(paired_load::artifact_files(&root.staging().join("backups")).is_empty());
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    drop(binding);
    control.close().await;
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_archive_verification_restore_and_rejection() {
    let scratch = Scratch::new();
    let root = DataRoot::new(scratch.0.join("source"));
    let (installation, control, binding, canonical, runtime) = local_backup_fixture(&root).await;
    let owner = PrincipalId::from_bytes([3; 16]);
    let scope = canonical
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([4; 16]),
            incarnation: HistoryIncarnation::from_bytes([5; 16]),
            root_folder_id: FolderId::from_bytes([6; 16]),
            slug: "archive-round-trip".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let body = "# Restored\n\nA retained canonical carrier.\n";
    canonical
        .create_note(
            auth(&scope, &owner),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes([7; 16]),
                    hash: ContentDigest::from_bytes([8; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([9; 16]),
                    parent: None,
                    slug: "restored".into(),
                    class: DocClass::UserDoc,
                    carrier: body.into(),
                },
            },
        )
        .await
        .unwrap();
    canonical
        .create_note(
            auth(&scope, &owner),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes([10; 16]),
                    hash: ContentDigest::from_bytes([11; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([12; 16]),
                    parent: None,
                    slug: "shared-carrier".into(),
                    class: DocClass::UserDoc,
                    carrier: body.into(),
                },
            },
        )
        .await
        .unwrap();
    backup_completes_with_caller_blocking_pool_occupied(&canonical, &binding, &root, &scratch.0)
        .await;
    let export = held_export(&canonical, &scope, &owner).await;
    rusqlite::Connection::open(root.canonical())
        .unwrap()
        .execute(
            "INSERT INTO archive_export_cuts(backup_id,space_id,cutoff_seq) VALUES(?1,?2,?3)",
            rusqlite::params![
                export.hold_id.as_str(),
                scope.space_id.as_str(),
                export.seq.get() as i64
            ],
        )
        .unwrap();

    let live = run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Live {
            canonical: &canonical,
            control: &binding,
        },
        &root.keyring(),
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    assert_eq!((live.spaces, live.blobs, live.readable_keys), (1, 1, 1));
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    assert!(paired_load::artifact_files(&root.staging().join("backups")).is_empty());
    let destination = scratch.0.join("backup.zip");
    let (backup, concurrent_write) = capture_with_a_live_write(
        &canonical,
        &binding,
        &scope,
        &owner,
        &destination,
        body,
        sqlite_backup_options(),
    )
    .await;
    export.release().await.unwrap();
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    let report = run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Archive(open(&destination)),
        &root.keyring(),
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    assert_eq!(report.archive_digest, Some(backup.digest));
    assert_eq!(
        (report.spaces, report.blobs, report.readable_keys),
        (1, 1, 1)
    );
    assert_eq!(report.raw_blob_bytes, body.len() as u64);
    assert!(
        report
            .sqlite_native_peak_bytes
            .is_some_and(|peak| peak > 0 && peak < 80 * 1024 * 1024)
    );
    let mut constrained = sqlite_backup_options();
    constrained.sqlite_verifier.heap_bytes = 64 * 1024;
    assert!(matches!(
        run_fsck(authority(ServicePurpose::Fsck), FsckInput::Archive(open(&destination)), &root.keyring(), constrained).await,
        Err(notarium_core::error::PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::BudgetExceeded
    ));
    if std::env::var_os("NOTARIUM_SQLITE_FSCK_LARGE").is_some() {
        for page_size in [512, 65_536] {
            let image = repackage_sqlite(
                &destination,
                &scratch.0,
                "canonical",
                &format!(
                    "PRAGMA page_size={page_size}; VACUUM;
                     PRAGMA secure_delete=OFF;
                     CREATE TABLE verification_padding(data BLOB);
                     INSERT INTO verification_padding VALUES(zeroblob(167772160));
                     DROP TABLE verification_padding;"
                ),
            );
            let before = fs::read_dir(&scratch.0).unwrap().count();
            let result = run_fsck(
                authority(ServicePurpose::Fsck),
                FsckInput::Archive(ArchiveInput::new(image).unwrap()),
                &root.keyring(),
                sqlite_backup_options(),
            )
            .await
            .unwrap();
            assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), before);
            let peak = result.sqlite_native_peak_bytes.unwrap();
            assert!(peak < 80 * 1024 * 1024);
            eprintln!(
                "SQLite archive page size {page_size}, image exceeds 160 MiB, native verifier peak {peak} B"
            );
        }
    }

    let mut zip = zip::ZipArchive::new(File::open(&destination).unwrap()).unwrap();
    assert_eq!(
        zip.file_names()
            .map(|name| name.unwrap().into_owned())
            .collect::<Vec<_>>(),
        [
            "manifest.json",
            "db/control",
            "db/canonical",
            "cas/index",
            "cas/data"
        ],
    );
    let cas_offset = zip.by_name("cas/data").unwrap().data_start().unwrap() as usize;
    drop(zip);
    let mut broken = fs::read(&destination).unwrap();
    broken[cas_offset] ^= 0x10;
    let reject = DataRoot::new(scratch.0.join("reject"));
    let failed = run_restore(
        authority(ServicePurpose::Restore),
        ArchiveInput::new(std::io::Cursor::new(broken)).unwrap(),
        RestoreTarget::Local {
            root: reject.clone(),
            keyring: RestoreKeyring::External(root.keyring()),
        },
        sqlite_backup_options(),
    )
    .await;
    assert!(failed.is_err());
    assert!(!reject.root().exists());

    let reject_parent = scratch.0.join("reject-before-install");
    fs::create_dir(&reject_parent).unwrap();
    let (v7_privacy, mixed_privacy) = v7_privacy_fixture();
    let note_id = NoteId::from_bytes([9; 16]);
    let source_db = rusqlite::Connection::open(root.canonical()).unwrap();
    let metadata: Vec<u8> = source_db.query_row(
        "SELECT metadata_msgpack FROM revisions WHERE entity_type='note' AND entity_key=?1 ORDER BY space_seq LIMIT 1",
        [note_id.as_str()], |row| row.get(0),
    ).unwrap();
    let replace_note = |metadata: Vec<u8>| {
        let literal: String = source_db
            .query_row("SELECT quote(?1)", [metadata], |row| row.get(0))
            .unwrap();
        format!(
            "UPDATE revisions SET metadata_msgpack={literal} WHERE entity_type='note' AND entity_key='{note_id}'"
        )
    };
    let stale_digest = replace_note(change_note_metadata(&metadata, stale_carrier));
    let stale_owner = replace_note(change_note_metadata(&metadata, |note| {
        note.note_id = NoteId::from_bytes([12; 16])
    }));
    let stale_size = replace_note(change_note_metadata(&metadata, |note| note.byte_size += 1));
    let (folder_metadata, root_seq): (Vec<u8>, i64) = source_db
        .query_row(
            "SELECT metadata_msgpack,space_seq FROM revisions WHERE entity_type='folder'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(root_seq, 0);
    let wrong_owner: String = source_db
        .query_row(
            "SELECT quote(?1)",
            [revision_integrity::foreign_folder_owner(&folder_metadata)],
            |row| row.get(0),
        )
        .unwrap();
    let foreign_folder =
        format!("UPDATE revisions SET metadata_msgpack={wrong_owner} WHERE entity_type='folder'");
    drop(source_db);
    let missing_owner = format!(
        "DELETE FROM blob_references WHERE owner_kind='note_revision' AND owner_id='{}';
         UPDATE blob_catalog SET ref_count=1 WHERE ref_count=2;",
        NoteId::from_bytes([9; 16])
    );
    for (database, corruption) in [
        ("canonical", mixed_privacy.as_str()),
        (
            "canonical",
            "DROP TRIGGER archive_privacy_spaces;
             CREATE TRIGGER archive_privacy_spaces AFTER UPDATE ON spaces BEGIN SELECT 1; END;",
        ),
        ("canonical", "DELETE FROM folder_heads WHERE is_root=1"),
        (
            "canonical",
            "DELETE FROM revisions WHERE entity_type='folder'",
        ),
        (
            "canonical",
            "UPDATE revisions SET metadata_msgpack=x'c1' WHERE entity_type='folder'",
        ),
        (
            "canonical",
            "UPDATE revisions SET visibility_seq=(SELECT last_seq+1 FROM spaces) WHERE entity_type='folder'",
        ),
        ("canonical", foreign_folder.as_str()),
        ("canonical", missing_owner.as_str()),
        ("canonical", stale_digest.as_str()),
        ("canonical", stale_owner.as_str()),
        ("canonical", stale_size.as_str()),
        (
            "canonical",
            "DROP INDEX uq_spaces_slug_fold; CREATE INDEX uq_spaces_slug_fold ON spaces(slug_fold)",
        ),
        (
            "canonical",
            "UPDATE blob_catalog SET blob_state='corrupt' WHERE ref_count>0",
        ),
        (
            "canonical",
            "UPDATE blob_catalog SET admission_state='retiring' WHERE ref_count>0",
        ),
        ("control", "DELETE FROM _sqlx_migrations WHERE version=1"),
        (
            "control",
            "UPDATE _sqlx_migrations SET checksum=zeroblob(48) WHERE version=1",
        ),
        (
            "control",
            "UPDATE _sqlx_migrations SET success=0 WHERE version=1",
        ),
    ] {
        let forged = repackage_sqlite(&destination, &scratch.0, database, corruption);
        let checked = run_fsck(
            authority(ServicePurpose::Fsck),
            FsckInput::Archive(ArchiveInput::new(forged.clone()).unwrap()),
            &root.keyring(),
            sqlite_backup_options(),
        )
        .await;
        assert!(
            matches!(
                checked,
                Err(notarium_core::error::PortError::Domain(
                    notarium_core::DomainError::ValidationFailed { .. }
                ))
            ),
            "{corruption}: {checked:?}"
        );
        let rejected = run_restore(
            authority(ServicePurpose::Restore),
            ArchiveInput::new(forged).unwrap(),
            RestoreTarget::Local {
                root: DataRoot::new(reject_parent.join("target")),
                keyring: RestoreKeyring::External(root.keyring()),
            },
            sqlite_backup_options(),
        )
        .await;
        assert!(rejected.is_err(), "{corruption}");
        assert_eq!(
            fs::read_dir(&reject_parent).unwrap().count(),
            0,
            "{corruption}"
        );
    }

    const V7: &str = "DROP TABLE blob_gc_retries;
        UPDATE schema_meta SET schema_version=7,
            manifest_checksum=X'69d765f45ef72feff9238b179deb7a0afae85de76555b3720d2d3c5b9a954699'";
    const V8: &str = "UPDATE schema_meta SET schema_version=8,
        manifest_checksum=X'5d75c6594906f1a5d59f5a0e45ebbd1a1dc48f0138bafbad5c4b12cd2bb000e1'";
    const V9: &str = "UPDATE schema_meta SET schema_version=9,
        manifest_checksum=X'd36745482ffcf36929c0656e3315a27ac78a0e7b48ee15c5d5b385124514e520'";
    const BEFORE_V9: &str = "DROP INDEX idx_blob_catalog_legacy;
        DROP INDEX idx_note_heads_export_access; DROP INDEX idx_folder_heads_export_access;
        DROP INDEX idx_content_jobs_export_access;";
    const V8_KEYS: &str = "state, job_kind, space_id, lease_until_ms, job_id";
    for (target, predecessor, legacy_order, older_indexes) in [
        (
            "absent",
            Some(V7),
            "space_id, state, lease_until_ms, job_id",
            BEFORE_V9,
        ),
        (
            "space-before-kind",
            Some(V7),
            "state, space_id, job_kind, lease_until_ms, job_id",
            BEFORE_V9,
        ),
        ("v8", Some(V8), V8_KEYS, BEFORE_V9),
        ("v9", Some(V9), V8_KEYS, ""),
        ("v10-inherited", Some(""), "", ""),
        ("existing", None, "", ""),
    ] {
        let existing = predecessor.is_none();
        let restored = DataRoot::new(scratch.0.join(target));
        if existing {
            fs::create_dir(restored.root()).unwrap();
        }
        #[cfg(unix)]
        let initial = if existing {
            use std::os::unix::fs::MetadataExt;
            Some(fs::metadata(restored.root()).unwrap().ino())
        } else {
            None
        };
        let keyring = if existing {
            RestoreKeyring::ProvisionDefault {
                separately_saved: root.keyring(),
            }
        } else {
            RestoreKeyring::External(root.keyring())
        };
        let archive = if let Some(predecessor) = predecessor {
            let claims = if legacy_order.is_empty() {
                String::new()
            } else {
                format!(
                    "DROP INDEX idx_content_jobs_reclaim; DROP INDEX idx_content_jobs_claim;
                     CREATE INDEX idx_content_jobs_claim ON content_jobs ({legacy_order});"
                )
            };
            let privacy = if target == "space-before-kind" {
                ""
            } else {
                &v7_privacy
            };
            let legacy = repackage_sqlite(
                &destination,
                &scratch.0,
                "canonical",
                &format!("{older_indexes} {predecessor}; {claims} {privacy}"),
            );
            let report = run_fsck(
                authority(ServicePurpose::Fsck),
                FsckInput::Archive(ArchiveInput::new(legacy.clone()).unwrap()),
                &root.keyring(),
                sqlite_backup_options(),
            )
            .await
            .unwrap();
            assert_eq!(report.spaces, 1);
            ArchiveInput::new(legacy).unwrap()
        } else {
            open(&destination)
        };
        let result = run_restore(
            authority(ServicePurpose::Restore),
            archive,
            RestoreTarget::Local {
                root: restored.clone(),
                keyring,
            },
            sqlite_backup_options(),
        )
        .await
        .unwrap();
        assert_ne!(result.histories[0].scope.incarnation, scope.incarnation);
        assert_eq!(result.histories[0].scope.space_id, scope.space_id);
        assert!(!restored.restore_guard().exists());
        assert!(!fs::read_dir(&scratch.0).unwrap().any(|entry| {
            entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".notarium-restore-generation-")
        }));
        #[cfg(unix)]
        if let Some(initial) = initial {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(restored.root()).unwrap().ino(), initial);
        }
        let (restored_canonical, restored_runtime) = CanonicalRuntime::open(
            CanonicalConfig::local_default(installation.clone(), restored.clone()),
        )
        .await
        .unwrap();
        let db = rusqlite::Connection::open(restored.canonical()).unwrap();
        let keys: String = db
            .query_row(
                "SELECT group_concat(name, ',' ORDER BY seqno) FROM pragma_index_info('idx_content_jobs_claim')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(keys, "job_kind,space_id,created_seq,job_id");
        let clearing_triggers: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='trigger' AND name GLOB 'archive_privacy_*'
             AND instr(sql, 'DELETE FROM archive_export_cuts WHERE space_id=NEW.space_id') > 0",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(clearing_triggers, 6);
        drop(db);
        concurrent_write
            .check_restored(&restored_canonical, &owner, &result.histories[0])
            .await;
        check_restored_note(
            &restored_canonical,
            &result.histories[0].scope,
            &owner,
            NoteId::from_bytes([9; 16]),
            body,
        )
        .await;
        let bytes = restored_canonical
            .read_verified_blob(
                &result.histories[0].scope,
                notarium_syntax::content_digest(body),
            )
            .await
            .unwrap();
        assert_eq!(bytes, body.as_bytes());
        let restored_control = ControlStore::sqlite(&restored).await.unwrap();
        #[cfg(unix)]
        if existing {
            replay_published_local(&restored, &root, &destination, &result).await;
        }
        let location = if existing {
            KeyringLocation::LocalDefault(restored)
        } else {
            KeyringLocation::External(root.keyring())
        };
        let keys = Keyring::open(restored_control.clone(), location, budget())
            .await
            .unwrap();
        assert_eq!(keys.inspect(budget()).await.unwrap().len(), 1);
        drop(keys);
        restored_control.close().await;
        restored_runtime.shutdown().await.unwrap();
    }
    paired_load::capture_under_load(&canonical, &binding, &root, &scope, &owner, "sqlite").await;
    let note = NoteId::from_bytes([9; 16]);
    let current = canonical
        .get_note(
            auth(&scope, &owner),
            GetNote {
                note: note.clone(),
                revision: None,
                causal: CausalBasis::Exact(ReceiptSet::default()),
            },
        )
        .await
        .unwrap();
    canonical
        .open_collab_session(
            &budget(),
            notarium_canonical::OpenCollabSession {
                scope: scope.clone(),
                note,
                owner_id: "large-snapshot".into(),
                expected_carrier_rev: current.document.revision().clone(),
                expected_lease: None,
                expected_lineage: None,
                initial_yrs_snapshot: Some(vec![0; 33 * 1024 * 1024]),
                allow_fenced_recovery: false,
            },
        )
        .await
        .unwrap();
    let checkpoint_archive = scratch.0.join("large-checkpoint.zip");
    run_backup(
        authority(ServicePurpose::Backup),
        &canonical,
        &binding,
        &checkpoint_archive,
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    let verified = run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Archive(open(&checkpoint_archive)),
        &root.keyring(),
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    assert!(verified.sqlite_native_peak_bytes.unwrap() < 80 * 1024 * 1024);
    let restored = DataRoot::new(scratch.0.join("with-large-checkpoint"));
    run_restore(
        authority(ServicePurpose::Restore),
        open(&checkpoint_archive),
        RestoreTarget::Local {
            root: restored.clone(),
            keyring: RestoreKeyring::External(root.keyring()),
        },
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    let size: i64 = rusqlite::Connection::open(restored.canonical()).unwrap()
        .query_row("SELECT length(yrs_snapshot_blob) FROM collab_sessions WHERE space_id=?1 AND note_id=?2",
            [scope.space_id.as_str(), NoteId::from_bytes([9; 16]).as_str()], |row| row.get(0)).unwrap();
    assert_eq!(size, 33 * 1024 * 1024);
    drop(binding);
    control.close().await;
    runtime.shutdown().await.unwrap();
}

#[cfg(unix)]
async fn replay_published_local(
    restored: &DataRoot,
    saved_keys: &DataRoot,
    archive: &Path,
    report: &notarium_jobs::RestoreReport,
) {
    use std::os::unix::fs::MetadataExt;
    let identity = |path: &Path| {
        let metadata = fs::metadata(path).unwrap();
        serde_json::json!({"device": metadata.dev(), "inode": metadata.ino()})
    };
    let parent = restored.root().parent().unwrap();
    let name = codec::new_prefixed_hex_id(".notarium-restore-generation-").unwrap();
    let stage = DataRoot::new(parent.join(&name));
    let backups = stage.staging().join("backups");
    fs::create_dir_all(&backups).unwrap();
    fs::hard_link(restored.manifest(), stage.manifest()).unwrap();
    fs::write(stage.restore_guard(), report.archive_digest.to_hex()).unwrap();
    let components: Vec<_> = ["v1", "blobs", "secret-keyring"]
        .iter()
        .map(|name| (*name, identity(&restored.root().join(name))))
        .collect();
    let journal = serde_json::json!({
        "version": 1, "installation": report.installation, "digest": report.archive_digest,
        "existing": identity(restored.root()), "external_keyring": false,
        "histories": report.histories, "stage": name,
        "phase": {"name": "Install", "directory": identity(stage.root()), "components": components}
    });
    let key = blake3::hash(restored.root().file_name().unwrap().as_encoded_bytes());
    let pending = parent.join(format!(".notarium-restore-{key}.json"));
    fs::write(&pending, serde_json::to_vec(&journal).unwrap()).unwrap();
    assert!(restored.staging().join("backups").is_dir());
    let live_file = restored.root().join("operator.txt");
    fs::write(&live_file, b"keep").unwrap();
    let foreign = backups.join("operator.txt");
    fs::write(&foreign, b"keep too").unwrap();
    let target = RestoreTarget::Local {
        root: restored.clone(),
        keyring: RestoreKeyring::ProvisionDefault {
            separately_saved: saved_keys.keyring(),
        },
    };
    let retry = || {
        run_restore(
            authority(ServicePurpose::Restore),
            open(archive),
            target.clone(),
            sqlite_backup_options(),
        )
    };
    assert!(retry().await.is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"keep too");
    assert!(pending.exists());
    fs::remove_file(foreign).unwrap();
    let recovered = retry().await.unwrap();
    assert_eq!(recovered.histories, report.histories);
    assert_eq!(fs::read(live_file).unwrap(), b"keep");
    assert!(!stage.root().exists());
    assert!(!pending.exists());
}

#[derive(serde::Deserialize)]
struct StorageFixture {
    pg_socket_dir_container: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
    s3_socket_container: PathBuf,
    s3_endpoint: String,
    s3_region: String,
    s3_access_key: String,
    s3_secret_key: String,
}

impl StorageFixture {
    fn load() -> Self {
        let path = std::env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/workspace/.artifacts/storage-tests/current.json"));
        let bytes =
            fs::read(path).expect("run through make test app=api or the storage fixture wrapper");
        serde_json::from_slice(&bytes).unwrap()
    }

    fn database(&self) -> notarium_canonical::PgConnectConfig {
        notarium_canonical::PgConnectConfig {
            transport: notarium_canonical::PgTransport::UnixSocket {
                socket_dir: self.pg_socket_dir_container.clone(),
                port: self.pg_port,
            },
            username: self.pg_user.clone(),
            password: self.pg_password.clone(),
            database: self.pg_database.clone(),
        }
    }

    fn s3(&self, namespace: &str, bucket: String) -> notarium_canonical::S3Config {
        use notarium_canonical::{S3AddressingStyle, S3BucketModePolicy, S3Config, S3Credentials};
        S3Config {
            endpoint: self.s3_endpoint.clone(),
            region: self.s3_region.clone(),
            bucket,
            application_prefix: namespace.to_owned(),
            addressing: S3AddressingStyle::PathStyle,
            credentials: S3Credentials {
                access_key_id: self.s3_access_key.clone(),
                secret_access_key: self.s3_secret_key.clone(),
                session_token: None,
            },
            custom_ca_pem: None,
            unix_socket: Some(self.s3_socket_container.clone()),
            bucket_mode_policy: S3BucketModePolicy::RequireEnabled,
            request_timeout: Duration::from_secs(5),
        }
    }
}

fn cloud_config(
    installation: InstallationId,
    database: notarium_canonical::PgConnectConfig,
    s3: notarium_canonical::S3Config,
) -> CanonicalConfig {
    use notarium_canonical::{
        BlobBackendConfig, SqlBackendConfig, WriterConfig, config::default_postgres_backup_budget,
    };
    CanonicalConfig {
        installation_id: installation,
        sql: SqlBackendConfig::postgres_default(
            database,
            notarium_core::epoch::CLOUD_CANONICAL_SCHEMA,
        ),
        blobs: BlobBackendConfig::S3(Box::new(s3)),
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(300),
        default_backup_budget: default_postgres_backup_budget(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cloud_archive_verification_and_restore_to_an_independent_namespace() {
    use notarium_canonical::{blobs::s3::admin_ensure_bucket, build_pg_connect_options};
    use notarium_control::store::{PostgresConfig, TargetRecord};
    use notarium_jobs::CloudRestoreTarget;
    use sqlx::{Connection, PgConnection, Postgres, QueryBuilder};

    let fixture = StorageFixture::load();
    paired_load::check_rated_volume(
        &fixture
            .pg_socket_dir_container
            .parent()
            .unwrap()
            .join("pgdata"),
    );
    let scratch = Scratch::new();
    let root = DataRoot::new(scratch.0.join("separately-saved"));
    fs::create_dir_all(root.root().join("v1")).unwrap();
    let installation = InstallationId::from_bytes([19; 16]);
    let source_keys = ControlStore::sqlite(&root).await.unwrap();
    FreshLocalInitializer::initialize(
        source_keys.clone(),
        root.clone(),
        EmptyRootAuthorization::from_classification(
            installation.clone(),
            EpochClassification {
                state: StorageEpochState::EmptyRoot,
                reason: EpochReason::ConfirmedEmpty,
            },
        )
        .unwrap(),
        budget(),
    )
    .await
    .unwrap();
    const KEY_COLUMNS: &str =
        "SELECT key_id,key_hash,generation,state,canary,created_at,retired_at FROM secret_keyring";
    let key = rusqlite::Connection::open(root.control())
        .unwrap()
        .query_row(KEY_COLUMNS, [], |row| {
            Ok(TargetRecord::SecretKeyring {
                key_id: row.get(0)?,
                key_hash: row.get(1)?,
                generation: row.get(2)?,
                state: row.get(3)?,
                canary: row.get(4)?,
                created_at: row.get(5)?,
                retired_at: row.get(6)?,
            })
        })
        .unwrap();
    source_keys.close().await;

    let mut source = fixture.database();
    let mut target = source.clone();
    let mut competing = source.clone();
    let mut admin = PgConnection::connect_with(&build_pg_connect_options(&source))
        .await
        .unwrap();
    source.database = codec::new_prefixed_hex_id("jobs_src_").unwrap();
    target.database = codec::new_prefixed_hex_id("jobs_dst_").unwrap();
    competing.database = codec::new_prefixed_hex_id("jobs_compete_").unwrap();
    for database in [&source.database, &target.database, &competing.database] {
        QueryBuilder::<Postgres>::new("CREATE DATABASE ")
            .push(database)
            .build()
            .execute(&mut admin)
            .await
            .unwrap();
    }
    let bucket = codec::new_prefixed_hex_id("jobs-backup-").unwrap();
    let source_s3 = fixture.s3("source-content", bucket.clone());
    let target_s3 = fixture.s3("target-content", bucket.clone());
    admin_ensure_bucket(&source_s3, Some("Enabled"))
        .await
        .unwrap();
    let source_options = build_pg_connect_options(&source);
    let control =
        ControlStore::postgres(PostgresConfig::from_connect_options(source_options.clone()))
            .await
            .unwrap();
    control
        .import_target_batch(
            authority(ServicePurpose::Restore),
            &[
                TargetRecord::V1StorageEpoch {
                    singleton: 1,
                    epoch_version: 1,
                    state: "migrating".into(),
                    installation_id: installation.to_string(),
                    receipt_sha256: None,
                    receipt_json: None,
                },
                key,
            ],
        )
        .await
        .unwrap();
    let mut src_sql = PgConnection::connect_with(&source_options).await.unwrap();
    sqlx::query("UPDATE v1_control.v1_storage_epoch SET state='ready'")
        .execute(&mut src_sql)
        .await
        .unwrap();
    let keys = Keyring::open(
        control.clone(),
        KeyringLocation::External(root.keyring()),
        budget(),
    )
    .await
    .unwrap();
    let adapter =
        ControlBackup::new(control.clone(), keys, root.clone(), BackupConfig::default()).unwrap();
    let (store, runtime) = CanonicalRuntime::open(cloud_config(
        installation.clone(),
        source.clone(),
        source_s3.clone(),
    ))
    .await
    .unwrap();
    let owner = PrincipalId::from_bytes([20; 16]);
    let scope = store
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes([21; 16]),
            incarnation: HistoryIncarnation::from_bytes([22; 16]),
            root_folder_id: FolderId::from_bytes([23; 16]),
            slug: "cloud-backup-round-trip".into(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap()
        .scope;
    let carrier = format!(
        "# {}\n\nAn immutable version in the source bucket.\n",
        "x".repeat(2100),
    );
    let note = NoteId::from_bytes([26; 16]);
    let created = store
        .create_note(
            auth(&scope, &owner),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes([24; 16]),
                    hash: ContentDigest::from_bytes([25; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: note.clone(),
                    parent: None,
                    slug: "cloud".into(),
                    class: DocClass::UserDoc,
                    carrier: carrier.clone(),
                },
            },
        )
        .await
        .unwrap();
    let wrong_count = scratch.0.join("wrong-ref-count.zip");
    let original_metadata: Vec<u8> = sqlx::query_scalar(
        "SELECT metadata_msgpack FROM v1_canonical.revisions WHERE space_id=$1 AND rev_id=$2",
    )
    .bind(scope.space_id.as_str())
    .bind(created.value.revision.as_str())
    .fetch_one(&mut src_sql)
    .await
    .unwrap();
    let failed_spools = scratch.0.join("failed-capture-spools");
    store.set_backup_spool_dir(failed_spools.clone());
    sqlx::query("UPDATE v1_canonical.blob_catalog SET ref_count=2 WHERE space_id=$1")
        .bind(scope.space_id.as_str())
        .execute(&mut src_sql)
        .await
        .unwrap();
    assert!(
        run_fsck(
            authority(ServicePurpose::Fsck),
            FsckInput::Live {
                canonical: &store,
                control: &adapter
            },
            &root.keyring(),
            BackupOptions::default(),
        )
        .await
        .is_err()
    );
    assert!(
        run_backup(
            authority(ServicePurpose::Backup),
            &store,
            &adapter,
            &wrong_count,
            BackupOptions::default(),
        )
        .await
        .is_err()
    );
    assert!(!wrong_count.exists());
    assert!(paired_load::artifact_files(&failed_spools).is_empty());
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    for (admission, state) in [("retiring", "active"), ("open", "corrupt")] {
        sqlx::query("UPDATE v1_canonical.blob_catalog SET ref_count=1,admission_state=$2,blob_state=$3 WHERE space_id=$1")
            .bind(scope.space_id.as_str())
            .bind(admission)
            .bind(state)
            .execute(&mut src_sql)
            .await
            .unwrap();
        assert!(
            run_fsck(
                authority(ServicePurpose::Fsck),
                FsckInput::Live {
                    canonical: &store,
                    control: &adapter
                },
                &root.keyring(),
                BackupOptions::default(),
            )
            .await
            .is_err()
        );
    }
    sqlx::query("UPDATE v1_canonical.blob_catalog SET admission_state='open',blob_state='active' WHERE space_id=$1")
        .bind(scope.space_id.as_str())
        .execute(&mut src_sql)
        .await
        .unwrap();
    store
        .rename_note(
            auth(&scope, &owner),
            Mutation {
                identity: CommandIdentity {
                    scope: scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes([27; 16]),
                    hash: ContentDigest::from_bytes([28; 32]),
                },
                preconditions: Preconditions {
                    revision: Some(created.value.revision),
                    ..Preconditions::default()
                },
                input: RenameNote {
                    note: note.clone(),
                    slug: "long-title-with-alias".into(),
                    title: None,
                },
            },
        )
        .await
        .unwrap();
    let alias_bytes: i32 = sqlx::query_scalar(
        "SELECT max(octet_length(old_title_norm)) FROM v1_canonical.note_aliases",
    )
    .fetch_one(&mut src_sql)
    .await
    .unwrap();
    assert_eq!(alias_bytes, 2100);
    let export = held_export(&store, &scope, &owner).await;
    sqlx::query("INSERT INTO v1_canonical.archive_export_cuts(backup_id,space_id,cutoff_seq) VALUES($1,$2,$3)")
        .bind(export.hold_id.as_str()).bind(scope.space_id.as_str()).bind(export.seq.get() as i64)
        .execute(&mut src_sql).await.unwrap();
    let path = scratch.0.join("cloud.zip");
    let (backup, concurrent_write) = capture_with_a_live_write(
        &store,
        &adapter,
        &scope,
        &owner,
        &path,
        &carrier,
        BackupOptions::default(),
    )
    .await;
    export.release().await.unwrap();
    assert!(paired_load::artifact_files(&root.staging().join("control")).is_empty());
    let validated = run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Archive(open(&path)),
        &root.keyring(),
        BackupOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(validated.archive_digest, Some(backup.digest));
    assert_eq!(
        (validated.spaces, validated.blobs, validated.readable_keys),
        (1, 1, 1)
    );
    let live = run_fsck(
        authority(ServicePurpose::Fsck),
        FsckInput::Live {
            canonical: &store,
            control: &adapter,
        },
        &root.keyring(),
        BackupOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        (
            live.spaces,
            live.blobs,
            live.raw_blob_bytes,
            live.readable_keys
        ),
        (
            validated.spaces,
            validated.blobs,
            validated.raw_blob_bytes,
            validated.readable_keys
        )
    );
    let cloud_target = CloudRestoreTarget {
        database: target.clone(),
        object_store: target_s3.clone(),
        scratch: root.clone(),
        external_keyring: root.keyring(),
    };
    use revision_integrity::RevisionFault;
    for fault in [
        RevisionFault::NoteCarrier,
        RevisionFault::MissingRoot,
        RevisionFault::MalformedFolder,
        RevisionFault::ForeignFolderOwner,
        RevisionFault::FutureVisibility,
    ] {
        let forged = fault.postgres_archive(&path, &original_metadata);
        let fsck = run_fsck(
            authority(ServicePurpose::Fsck),
            FsckInput::Archive(ArchiveInput::new(forged.clone()).unwrap()),
            &root.keyring(),
            BackupOptions::default(),
        )
        .await;
        let restore = run_restore(
            authority(ServicePurpose::Restore),
            ArchiveInput::new(forged).unwrap(),
            RestoreTarget::Cloud(Box::new(cloud_target.clone())),
            BackupOptions::default(),
        )
        .await;
        for error in [fsck.unwrap_err(), restore.unwrap_err()] {
            assert!(
                matches!(&error, notarium_core::error::PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }) if diagnostic.reason == fault.reason()),
                "{fault:?}: {error:?}",
            );
        }
    }
    let mut fresh = PgConnection::connect_with(&build_pg_connect_options(&target))
        .await
        .unwrap();
    let untouched: bool = sqlx::query_scalar(
        "SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('notarium_restore','v1_canonical','v1_control'))",
    ).fetch_one(&mut fresh).await.unwrap();
    assert!(untouched);
    fresh.close().await.unwrap();
    competing_cloud_restore(&path, &cloud_target, &competing).await;
    let target_spec = RestoreTarget::Cloud(Box::new(cloud_target));
    let restored = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target_spec.clone(),
        BackupOptions::default(),
    )
    .await
    .unwrap();
    assert_ne!(restored.histories[0].scope, scope);
    assert!(
        CanonicalRuntime::open(cloud_config(
            installation.clone(),
            target.clone(),
            source_s3
        ))
        .await
        .is_err()
    );
    let (restored_store, restored_runtime) = CanonicalRuntime::open(cloud_config(
        installation.clone(),
        target.clone(),
        target_s3.clone(),
    ))
    .await
    .unwrap();
    concurrent_write
        .check_restored(&restored_store, &owner, &restored.histories[0])
        .await;
    check_restored_note(
        &restored_store,
        &restored.histories[0].scope,
        &owner,
        note,
        &carrier,
    )
    .await;
    let content = notarium_syntax::content_digest(&carrier);
    assert_eq!(
        restored_store
            .read_verified_blob(&restored.histories[0].scope, content)
            .await
            .unwrap(),
        carrier.as_bytes()
    );
    assert_eq!(
        store.read_verified_blob(&scope, content).await.unwrap(),
        carrier.as_bytes()
    );
    let live_scope = &restored.histories[0].scope;
    let restored_epoch = restored_store
        .read_space(&live_scope.space_id)
        .await
        .unwrap()
        .active_epoch;
    restored_store
        .advance_space_lease(
            &authority(ServicePurpose::Revocation),
            live_scope,
            LeaseEpoch::new(restored_epoch.get() + 1).unwrap(),
        )
        .await
        .unwrap();
    restored_store
        .create_note(
            auth(live_scope, &owner),
            Mutation {
                identity: CommandIdentity {
                    scope: live_scope.clone(),
                    actor: owner.clone(),
                    key: CommandKey::from_bytes([29; 16]),
                    hash: ContentDigest::from_bytes([30; 32]),
                },
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note: NoteId::from_bytes([31; 16]),
                    parent: None,
                    slug: "written-after-ready".into(),
                    class: DocClass::UserDoc,
                    carrier: "# Written after ready\n".into(),
                },
            },
        )
        .await
        .unwrap();
    let replay = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target_spec.clone(),
        BackupOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(restored.histories, replay.histories);
    assert!(
        restored_store
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq
            > restored.histories[0].after
    );
    let restored_control = ControlStore::postgres(PostgresConfig::from_connect_options(
        build_pg_connect_options(&target),
    ))
    .await
    .unwrap();
    let new_keys = Keyring::open(
        restored_control.clone(),
        KeyringLocation::External(root.keyring()),
        budget(),
    )
    .await
    .unwrap();
    assert_eq!(new_keys.inspect(budget()).await.unwrap().len(), 1);
    drop(new_keys);
    restored_control.close().await;
    restored_runtime.shutdown().await.unwrap();
    let mut legacy = PgConnection::connect_with(&build_pg_connect_options(&target))
        .await
        .unwrap();
    sqlx::query("ALTER TABLE notarium_restore.readiness DROP COLUMN namespace_owner")
        .execute(&mut legacy)
        .await
        .unwrap();
    legacy.close().await.unwrap();
    let legacy_retry = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target_spec,
        BackupOptions::default(),
    )
    .await;
    assert!(matches!(legacy_retry,
        Err(notarium_core::error::PortError::Domain(notarium_core::DomainError::ValidationFailed { diagnostic }))
            if diagnostic.reason == notarium_core::error::ValidationReason::InvalidState));
    let (legacy_store, legacy_runtime) = CanonicalRuntime::open(cloud_config(
        installation.clone(),
        target.clone(),
        target_s3,
    ))
    .await
    .unwrap();
    assert_eq!(
        legacy_store
            .read_verified_blob(live_scope, content)
            .await
            .unwrap(),
        carrier.as_bytes()
    );
    legacy_runtime.shutdown().await.unwrap();
    paired_load::capture_under_load(&store, &adapter, &root, &scope, &owner, "postgres").await;
    cloud_takeover::exercise(
        &store,
        control.clone(),
        &source,
        &installation,
        &bucket,
        &scratch.0,
    )
    .await;
    drop(adapter);
    control.close().await;
    runtime.shutdown().await.unwrap();
    src_sql.close().await.unwrap();
    for database in [&source.database, &target.database, &competing.database] {
        QueryBuilder::<Postgres>::new("DROP DATABASE ")
            .push(database)
            .build()
            .execute(&mut admin)
            .await
            .unwrap();
    }
}

async fn competing_cloud_restore(
    archive: &Path,
    target: &notarium_jobs::CloudRestoreTarget,
    competing: &notarium_canonical::PgConnectConfig,
) {
    use notarium_canonical::build_pg_connect_options;
    use sqlx::{Connection, PgConnection};

    let mut first = PgConnection::connect_with(&build_pg_connect_options(&target.database))
        .await
        .unwrap();
    let mut second = PgConnection::connect_with(&build_pg_connect_options(competing))
        .await
        .unwrap();
    // Delay the second journal after it observed empty S3 and before it commits.
    sqlx::raw_sql(
        "CREATE FUNCTION public.wait_for_restore() RETURNS event_trigger LANGUAGE plpgsql AS $$
           BEGIN PERFORM pg_advisory_xact_lock(19482159); END; $$;
         CREATE EVENT TRIGGER wait_for_restore ON ddl_command_end WHEN TAG IN ('CREATE SCHEMA')
           EXECUTE FUNCTION public.wait_for_restore();
         SELECT pg_advisory_lock(19482159);",
    )
    .execute(&mut second)
    .await
    .unwrap();
    // Fail the first PostgreSQL acknowledgement of the durable S3 claim.
    sqlx::raw_sql(
        "CREATE FUNCTION public.reject_claim_ack() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'interrupt namespace claim'; END; $$;
         CREATE FUNCTION public.interrupt_restore() RETURNS event_trigger LANGUAGE plpgsql AS $$
           BEGIN
             CREATE TRIGGER reject_claim_ack BEFORE UPDATE ON notarium_restore.readiness
                 FOR EACH ROW EXECUTE FUNCTION public.reject_claim_ack();
           END; $$;
         CREATE EVENT TRIGGER interrupt_restore ON ddl_command_end WHEN TAG IN ('CREATE TABLE')
           EXECUTE FUNCTION public.interrupt_restore();",
    )
    .execute(&mut first)
    .await
    .unwrap();
    let mut rival = target.clone();
    rival.database = competing.clone();
    let waiting = tokio::spawn(run_restore(
        authority(ServicePurpose::Restore),
        open(archive),
        RestoreTarget::Cloud(Box::new(rival)),
        BackupOptions::default(),
    ));
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let blocked: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted
                   AND objid=19482159 AND database=(SELECT oid FROM pg_database WHERE datname=current_database()))"
            ).fetch_one(&mut second).await.unwrap();
            if blocked { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("competing restore observed an empty prefix");
    let stopped = run_restore(
        authority(ServicePurpose::Restore),
        open(archive),
        RestoreTarget::Cloud(Box::new(target.clone())),
        BackupOptions::default(),
    )
    .await;
    assert!(stopped.is_err());
    let pending: bool = sqlx::query_scalar(
        "SELECT phase='reserving' AND NOT canonical_loaded FROM notarium_restore.readiness WHERE singleton=1"
    ).fetch_one(&mut first).await.unwrap();
    assert!(pending);
    sqlx::query("SELECT pg_advisory_unlock(19482159)")
        .execute(&mut second)
        .await
        .unwrap();
    assert!(waiting.await.unwrap().is_err());
    let lost: bool = sqlx::query_scalar(
        "SELECT phase='reserving' AND NOT canonical_loaded FROM notarium_restore.readiness WHERE singleton=1"
    ).fetch_one(&mut second).await.unwrap();
    assert!(lost);
    sqlx::raw_sql(
        "DROP EVENT TRIGGER interrupt_restore;
                   DROP TRIGGER reject_claim_ack ON notarium_restore.readiness",
    )
    .execute(&mut first)
    .await
    .unwrap();
    first.close().await.unwrap();
    second.close().await.unwrap();
}

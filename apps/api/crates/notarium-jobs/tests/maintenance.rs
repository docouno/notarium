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
    receipt::CommandIdentity,
};
use notarium_jobs::{
    ArchiveInput, BackupOptions, FsckInput, RestoreKeyring, RestoreTarget, run_backup, run_fsck,
    run_restore,
};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(codec::new_prefixed_hex_id("paired_archive_test_").unwrap());
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

fn repackage_sqlite(path: &Path, scratch: &Path, statement: &str) -> ArchiveInput {
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
    let image = scratch.join(codec::new_prefixed_hex_id("forged_sqlite_").unwrap());
    fs::write(&image, bytes(&mut source, "db/canonical")).unwrap();
    let db = rusqlite::Connection::open(&image).unwrap();
    db.execute_batch("PRAGMA foreign_keys=OFF;").unwrap();
    db.execute_batch(statement).unwrap();
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    drop(db);
    let canonical = fs::read(image).unwrap();
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&bytes(&mut source, "manifest.json")).unwrap();
    manifest["canonical"]["bytes"] = canonical.len().into();
    manifest["canonical"]["digest"] = serde_json::to_value(ContentDigest::from_bytes(
        *blake3::hash(&canonical).as_bytes(),
    ))
    .unwrap();
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, data) in [
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("db/control", bytes(&mut source, "db/control")),
        ("db/canonical", canonical),
        ("cas/index", bytes(&mut source, "cas/index")),
        ("cas/data", bytes(&mut source, "cas/data")),
    ] {
        output.start_file(name, opts).unwrap();
        output.write_all(&data).unwrap();
    }
    ArchiveInput::new(output.finish().unwrap()).unwrap()
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sqlite_archive_verification_restore_and_rejection() {
    let scratch = Scratch::new();
    let root = DataRoot::new(scratch.0.join("source"));
    fs::create_dir_all(root.root().join("v1")).unwrap();
    let installation = InstallationId::from_bytes([2; 16]);
    let control = ControlStore::sqlite(&root).await.unwrap();
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
    let destination = scratch.0.join("backup.zip");
    let backup = run_backup(
        authority(ServicePurpose::Backup),
        &canonical,
        &binding,
        &destination,
        sqlite_backup_options(),
    )
    .await
    .unwrap();
    export.release().await.unwrap();
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

    for corruption in [
        "DELETE FROM folder_heads WHERE is_root=1;".to_owned(),
        format!(
            "DELETE FROM blob_references WHERE owner_kind='note_revision' AND owner_id='{}';
                  UPDATE blob_catalog SET ref_count=1 WHERE ref_count=2;",
            NoteId::from_bytes([9; 16])
        ),
        "DROP INDEX uq_spaces_slug_fold; CREATE INDEX uq_spaces_slug_fold ON spaces(slug_fold);"
            .to_owned(),
    ] {
        let forged = repackage_sqlite(&destination, &scratch.0, &corruption);
        let rejected = run_restore(
            authority(ServicePurpose::Restore),
            forged,
            RestoreTarget::Local {
                root: reject.clone(),
                keyring: RestoreKeyring::External(root.keyring()),
            },
            sqlite_backup_options(),
        )
        .await;
        assert!(rejected.is_err(), "{corruption}");
        assert!(!reject.root().exists());
    }

    for (target, existing) in [("absent", false), ("existing", true)] {
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
        let result = run_restore(
            authority(ServicePurpose::Restore),
            open(&destination),
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
        #[cfg(unix)]
        if let Some(initial) = initial {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(fs::metadata(restored.root()).unwrap().ino(), initial);
        }
        let (restored_canonical, owner) = CanonicalRuntime::open(CanonicalConfig::local_default(
            installation.clone(),
            restored.clone(),
        ))
        .await
        .unwrap();
        let bytes = restored_canonical
            .read_verified_blob(
                &result.histories[0].scope,
                notarium_syntax::content_digest(body),
            )
            .await
            .unwrap();
        assert_eq!(bytes, body.as_bytes());
        let restored_control = ControlStore::sqlite(&restored).await.unwrap();
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
        owner.shutdown().await.unwrap();
    }
    drop(binding);
    control.close().await;
    runtime.shutdown().await.unwrap();
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
    let mut admin = PgConnection::connect_with(&build_pg_connect_options(&source))
        .await
        .unwrap();
    source.database = codec::new_prefixed_hex_id("jobs_src_").unwrap();
    target.database = codec::new_prefixed_hex_id("jobs_dst_").unwrap();
    for database in [&source.database, &target.database] {
        QueryBuilder::<Postgres>::new("CREATE DATABASE ")
            .push(database)
            .build()
            .execute(&mut admin)
            .await
            .unwrap();
    }
    let bucket = codec::new_prefixed_hex_id("jobs-backup-").unwrap();
    let source_s3 = fixture.s3("source-content", bucket.clone());
    let target_s3 = fixture.s3("target-content", bucket);
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
    let carrier = "# Cloud round trip\n\nAn immutable version in the source bucket.\n";
    store
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
                    note: NoteId::from_bytes([26; 16]),
                    parent: None,
                    slug: "cloud".into(),
                    class: DocClass::UserDoc,
                    carrier: carrier.into(),
                },
            },
        )
        .await
        .unwrap();
    let export = held_export(&store, &scope, &owner).await;
    sqlx::query("INSERT INTO v1_canonical.archive_export_cuts(backup_id,space_id,cutoff_seq) VALUES($1,$2,$3)")
        .bind(export.hold_id.as_str()).bind(scope.space_id.as_str()).bind(export.seq.get() as i64)
        .execute(&mut src_sql).await.unwrap();
    let path = scratch.0.join("cloud.zip");
    let backup = run_backup(
        authority(ServicePurpose::Backup),
        &store,
        &adapter,
        &path,
        BackupOptions::default(),
    )
    .await
    .unwrap();
    export.release().await.unwrap();
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
    let target_spec = RestoreTarget::Cloud(Box::new(CloudRestoreTarget {
        database: target.clone(),
        object_store: target_s3.clone(),
        scratch: root.clone(),
        external_keyring: root.keyring(),
    }));
    let restored = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target_spec.clone(),
        BackupOptions::default(),
    )
    .await
    .unwrap();
    let replay = run_restore(
        authority(ServicePurpose::Restore),
        open(&path),
        target_spec,
        BackupOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(restored.histories, replay.histories);
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
    let (restored_store, restored_runtime) =
        CanonicalRuntime::open(cloud_config(installation, target.clone(), target_s3))
            .await
            .unwrap();
    let content = notarium_syntax::content_digest(carrier);
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
    drop(adapter);
    control.close().await;
    runtime.shutdown().await.unwrap();
    src_sql.close().await.unwrap();
    for database in [&source.database, &target.database] {
        QueryBuilder::<Postgres>::new("DROP DATABASE ")
            .push(database)
            .build()
            .execute(&mut admin)
            .await
            .unwrap();
    }
}

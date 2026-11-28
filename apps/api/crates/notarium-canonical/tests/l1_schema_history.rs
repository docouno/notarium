#![forbid(unsafe_code)]

mod support;

use notarium_canonical::{
    CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateFolderSpec, CreateSpaceSpec,
    PgConnectConfig, PgTransport, SqlBackendConfig, build_pg_connect_options,
    observe_sqlite_canonical_witness,
};
use notarium_core::{
    DomainError,
    auth::SpaceKind,
    epoch::{DatabaseState, MarkerObservation, SUPPORTED_V1_EPOCH},
    error::{PortError, ValidationReason},
    ids::{LeaseEpoch, SpaceSeq},
    model::{HistoryScope, Lifecycle},
    ports::ServicePurpose,
    value::Timestamp,
};
use sqlx::Connection;

use crate::support::{
    StorageTestFixtures, TempDataRoot, assert_validation_err, maintenance_ctx, sample_folder_id,
    sample_incarnation, sample_installation_id, sample_note_id, sample_principal_id,
    sample_space_id,
};

#[cfg(target_os = "linux")]
#[tokio::test]
async fn sqlite_access_time_policy_applies_to_new_database_files() {
    use rustix::fs::{IFlags, ioctl_getflags, ioctl_setflags};
    use std::fs::{self, File};

    let root = TempDataRoot::new("sqlite-inode-policy");
    let data = root.data_root();
    let probe = data.root().join("probe");
    fs::create_dir_all(&probe).unwrap();
    let dir = File::open(&probe).unwrap();
    let Ok(flags) = ioctl_getflags(&dir) else {
        return;
    };
    if ioctl_setflags(&dir, flags | IFlags::NOATIME).is_err() {
        return;
    }
    let expected = ioctl_getflags(File::create(probe.join("child")).unwrap()).unwrap();
    let db = data.canonical();
    let parent = db.parent().unwrap();
    fs::create_dir_all(parent).unwrap();
    let prior = parent.join("existing-file");
    let original = ioctl_getflags(File::create(&prior).unwrap()).unwrap();
    let config = CanonicalConfig::local_default(sample_installation_id(51), data.clone());
    let (_, runtime) = CanonicalRuntime::open(config).await.unwrap();
    runtime.shutdown().await.unwrap();

    assert!(
        ioctl_getflags(File::open(parent).unwrap())
            .unwrap()
            .contains(IFlags::NOATIME)
    );
    assert_eq!(
        ioctl_getflags(File::open(prior).unwrap()).unwrap(),
        original
    );
    let actual = ioctl_getflags(File::open(db).unwrap()).unwrap();
    assert_eq!(
        actual.contains(IFlags::NOATIME),
        expected.contains(IFlags::NOATIME)
    );
}

#[tokio::test]
async fn postgres_tcp_requires_a_verified_server_and_redacts_credentials() {
    use sqlx::postgres::PgSslMode;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let config = PgConnectConfig {
        transport: PgTransport::Tcp {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            root_cert: None,
        },
        username: "fixture-user-marker".into(),
        password: "fixture-password-marker".into(),
        database: "canonical".into(),
    };
    let sql = SqlBackendConfig::postgres_default(config.clone(), "v1_canonical");
    let diagnostic = format!("{sql:?}");
    assert!(!diagnostic.contains(&config.password));
    assert!(!diagnostic.contains(&config.username));
    let options = build_pg_connect_options(&config);
    assert!(matches!(options.get_ssl_mode(), PgSslMode::VerifyFull));
    assert_eq!(options.get_host(), "127.0.0.1");

    // A PostgreSQL server can decline the initial SSL request before authentication.
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut ssl_request = [0u8; 8];
        stream.read_exact(&mut ssl_request).await.unwrap();
        assert_eq!(ssl_request, [0, 0, 0, 8, 4, 210, 22, 47]);
        stream.write_all(b"N").await.unwrap();
        let mut byte = [0];
        assert_eq!(stream.read(&mut byte).await.unwrap(), 0);
    });
    let connection = sqlx::PgConnection::connect_with(&options).await;
    assert!(matches!(connection, Err(sqlx::Error::Tls(_))));
    server.await.unwrap();
}

#[tokio::test]
async fn postgres_open_rejects_fsync_off_before_creating_the_schema() {
    let mut fixtures = StorageTestFixtures::load_required();
    fixtures.pg_port = fixtures
        .pg_fsync_off_port
        .expect("isolated fsync-off test server");
    fixtures.pg_database = "postgres".into();
    let mut observer = fixtures.open_raw_pg().await;
    let (sync, fsync): (String, String) =
        sqlx::query_as("SELECT current_setting('synchronous_commit'), current_setting('fsync')")
            .fetch_one(&mut observer)
            .await
            .unwrap();
    assert_eq!((sync.as_str(), fsync.as_str()), ("on", "off"));

    let schema = fixtures.fresh_pg_schema();
    let cfg = fixtures
        .open_pg_s3_config(sample_installation_id(53), &schema)
        .await;
    let Err(failure) = CanonicalRuntime::open(cfg).await else {
        panic!("fsync-off startup must fail");
    };
    assert_eq!(
        failure,
        notarium_canonical::codec::internal_not_committed(
            "pg_fsync_disabled",
            "PostgreSQL fsync=off, expected on",
        )
    );
    let created: bool = sqlx::query_scalar("SELECT to_regnamespace($1) IS NOT NULL")
        .bind(&schema)
        .fetch_one(&mut observer)
        .await
        .unwrap();
    assert!(
        !created,
        "durability verification precedes schema migration"
    );
}

#[tokio::test]
async fn l1_sqlite_bootstrap_witness_owner_lock_and_fail_closed_guards() {
    let temp = TempDataRoot::new("l1-sqlite-boot");
    let install = sample_installation_id(1);

    // Before bootstrap, canonical witness is Missing.
    assert_eq!(
        observe_sqlite_canonical_witness(&temp.data_root()).await,
        MarkerObservation::Missing
    );

    let cfg = CanonicalConfig::local_default(install.clone(), temp.data_root());
    let mut invalid_timer = cfg.clone();
    if let SqlBackendConfig::Sqlite {
        wal_reset_cycle_deadline,
        ..
    } = &mut invalid_timer.sql
    {
        *wal_reset_cycle_deadline = std::time::Duration::MAX;
    }
    assert_validation_err(
        &CanonicalRuntime::open(invalid_timer).await.map(|_| ()),
        ValidationReason::InvalidRange,
    );
    assert_eq!(
        observe_sqlite_canonical_witness(&temp.data_root()).await,
        MarkerObservation::Missing
    );
    let (store, runtime) = CanonicalRuntime::open(cfg.clone())
        .await
        .expect("initial SQLite canonical open");

    assert_eq!(runtime.witness().epoch_version, SUPPORTED_V1_EPOCH);
    assert_eq!(runtime.witness().installation_id, install);
    assert_eq!(runtime.witness().state, DatabaseState::Ready);

    // Non-mutating witness classifier agrees while runtime is open.
    let observed = observe_sqlite_canonical_witness(&temp.data_root()).await;
    assert_eq!(
        observed,
        MarkerObservation::Present(runtime.witness().clone())
    );

    // Second instance on the same DataRoot must fail closed due to DataRootOwnerLock.
    let second_open = CanonicalRuntime::open(cfg.clone()).await;
    assert!(
        second_open.is_err(),
        "second runtime on active DataRoot must fail closed"
    );
    drop(store);

    runtime.shutdown().await.expect("clean SQLite shutdown");

    {
        let mut raw = temp.open_raw_sqlite().await;
        sqlx::raw_sql(concat!(
            include_str!("fixtures/schema-v6-remove-projection.sql"),
            include_str!("fixtures/schema-v8-remove-agents.sql")
        ))
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::raw_sql("DROP TABLE collab_checkpoints;
            ALTER TABLE backup_holds DROP COLUMN owner_generation;
            UPDATE schema_meta SET schema_version=2,
                manifest_checksum=X'4375964FA9CF7DE29749E52C6387A9F72D1A4538FB9F97240A9FE356061BDBDF'")
            .execute(&mut raw).await.unwrap();
        raw.close().await.unwrap();
    }
    assert_eq!(
        observe_sqlite_canonical_witness(&temp.data_root()).await,
        observed
    );

    // Opening the older DataRoot through the normal runtime upgrades it in place.
    let (_store2, runtime2) = CanonicalRuntime::open(cfg.clone())
        .await
        .expect("upgrade SQLite predecessor");
    runtime2.shutdown().await.expect("shutdown after upgrade");
    let (_, reopened) = CanonicalRuntime::open(cfg.clone())
        .await
        .expect("reopen current SQLite schema");
    reopened.shutdown().await.unwrap();

    // Installation mismatch must fail closed.
    let wrong_install_cfg =
        CanonicalConfig::local_default(sample_installation_id(2), temp.data_root());
    assert!(CanonicalRuntime::open(wrong_install_cfg).await.is_err());

    // Newer schema_version must fail closed and classify witness as Invalid.
    {
        let mut raw = temp.open_raw_sqlite().await;
        sqlx::query("UPDATE schema_meta SET schema_version = 999 WHERE singleton_id = 1")
            .execute(&mut raw)
            .await
            .expect("bump schema_version");
        let _ = raw.close().await;
    }
    assert_eq!(
        observe_sqlite_canonical_witness(&temp.data_root()).await,
        MarkerObservation::Invalid
    );
    assert!(CanonicalRuntime::open(cfg.clone()).await.is_err());

    // Restore schema_version, then test incomplete migration_state = 'migrating'.
    {
        let mut raw = temp.open_raw_sqlite().await;
        sqlx::query(
            "UPDATE schema_meta SET schema_version = $1, migration_state = 'migrating' WHERE singleton_id = 1",
        )
        .bind(i64::from(notarium_canonical::CANONICAL_SCHEMA_VERSION))
        .execute(&mut raw)
        .await
        .expect("set migrating");
        let _ = raw.close().await;
    }
    assert!(CanonicalRuntime::open(cfg.clone()).await.is_err());

    // Restore migration_state = 'ready', then tamper manifest_checksum.
    let orig_checksum: Vec<u8> = {
        let mut raw = temp.open_raw_sqlite().await;
        let cs: Vec<u8> =
            sqlx::query_scalar("SELECT manifest_checksum FROM schema_meta WHERE singleton_id = 1")
                .fetch_one(&mut raw)
                .await
                .expect("read checksum");
        let mut tampered = cs.clone();
        tampered[0] ^= 0xff;
        sqlx::query(
            "UPDATE schema_meta SET migration_state = 'ready', manifest_checksum = ? WHERE singleton_id = 1",
        )
        .bind(&tampered)
        .execute(&mut raw)
        .await
        .expect("tamper checksum");
        let _ = raw.close().await;
        cs
    };
    assert_eq!(
        observe_sqlite_canonical_witness(&temp.data_root()).await,
        MarkerObservation::Invalid
    );
    assert!(CanonicalRuntime::open(cfg.clone()).await.is_err());

    // Restore valid checksum, then inject a forbidden table / virtual table and verify catalog rejection.
    {
        let mut raw = temp.open_raw_sqlite().await;
        sqlx::query("UPDATE schema_meta SET manifest_checksum = ? WHERE singleton_id = 1")
            .bind(&orig_checksum)
            .execute(&mut raw)
            .await
            .expect("restore checksum");
        sqlx::query("CREATE TABLE rogue_shadow (x INTEGER)")
            .execute(&mut raw)
            .await
            .expect("inject rogue table");
        let _ = raw.close().await;
    }
    assert!(
        CanonicalRuntime::open(cfg).await.is_err(),
        "rogue / shadow table in canonical SQLite must fail closed"
    );
}

#[tokio::test]
async fn l1_postgres_bootstrap_idempotence_and_fail_closed_guards() {
    let fixtures = StorageTestFixtures::load_required();
    let schema = fixtures.fresh_pg_schema();
    let install = sample_installation_id(3);

    let cfg = fixtures.open_pg_s3_config(install.clone(), &schema).await;
    let (_store, runtime) = CanonicalRuntime::open(cfg.clone())
        .await
        .expect("initial PostgreSQL 16 canonical open");

    assert_eq!(runtime.witness().epoch_version, SUPPORTED_V1_EPOCH);
    assert_eq!(runtime.witness().installation_id, install);
    assert_eq!(runtime.witness().state, DatabaseState::Ready);
    runtime.shutdown().await.expect("clean PG shutdown");

    const CONSTRAINTS: &str = "SELECT t.relname::text, c.conname::text, pg_get_constraintdef(c.oid)
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        WHERE t.relnamespace=current_schema()::regnamespace ORDER BY t.relname, c.conname";
    // Reopen the recognized previous manifest through the startup migration.
    let fresh_constraints: Vec<(String, String, String)>;
    {
        let mut raw = fixtures.open_raw_pg().await;
        let path = format!("SET search_path TO \"{schema}\"");
        sqlx::query(sqlx::AssertSqlSafe(path))
            .execute(&mut raw)
            .await
            .unwrap();
        fresh_constraints = sqlx::query_as(CONSTRAINTS)
            .fetch_all(&mut raw)
            .await
            .unwrap();
        sqlx::raw_sql(concat!(
            include_str!("fixtures/schema-v6-remove-projection.sql"),
            include_str!("fixtures/schema-v8-remove-agents.sql")
        ))
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::raw_sql(
            "DROP TABLE collab_checkpoints; ALTER TABLE backup_holds DROP COLUMN owner_generation",
        )
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::query("DROP TABLE account_catalog_receipts")
            .execute(&mut raw)
            .await
            .unwrap();
        sqlx::query("ALTER TABLE chat_pending_inputs DROP COLUMN ext_space_tainted")
            .execute(&mut raw)
            .await
            .unwrap();
        sqlx::query("UPDATE schema_meta SET schema_version=1, manifest_checksum=decode('3992ad6e8c888cc7ed98c9dd45e9463bf3334c5617b9c7c416334bc312398c69','hex') WHERE singleton_id=1").execute(&mut raw).await.unwrap();
        raw.close().await.unwrap();
    }

    // Reopen same schema idempotently.
    let cfg2 = fixtures.open_pg_s3_config(install.clone(), &schema).await;
    let (_store2, runtime2) = CanonicalRuntime::open(cfg2.clone())
        .await
        .expect("idempotent PG reopen");
    runtime2.shutdown().await.expect("second PG shutdown");

    // Exercise the v2 predecessor with its early misplaced size constraint.
    let mut raw = fixtures.open_raw_pg().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET search_path TO \"{schema}\""
    )))
    .execute(&mut raw)
    .await
    .unwrap();
    sqlx::raw_sql(concat!(
        include_str!("fixtures/schema-v6-remove-projection.sql"),
        include_str!("fixtures/schema-v8-remove-agents.sql")
    ))
    .execute(&mut raw)
    .await
    .unwrap();
    sqlx::raw_sql("DROP TABLE collab_checkpoints;
        ALTER TABLE backup_holds DROP COLUMN owner_generation;
        ALTER TABLE account_catalog_receipts DROP CONSTRAINT account_catalog_receipts_result_msgpack_check;
        ALTER TABLE content_jobs ADD CHECK (length(result_msgpack) BETWEEN 1 AND 4096);
        UPDATE schema_meta SET schema_version=2,
            manifest_checksum=decode('4375964fa9cf7de29749e52c6387a9f72d1a4538fb9f97240a9fe356061bdbdf','hex')")
        .execute(&mut raw).await.unwrap();
    sqlx::raw_sql(include_str!("fixtures/legacy-collab.sql"))
        .execute(&mut raw)
        .await
        .unwrap();
    // Bootstrap directly so ordinary runtime recovery does not reconcile the old hold.
    notarium_canonical::schema::bootstrap_postgres_schema(&mut raw, &schema, &install)
        .await
        .unwrap();
    let reference_indexes: Vec<String> = sqlx::query_scalar(
        "SELECT indexdef FROM pg_indexes WHERE schemaname=current_schema()
         AND tablename='blob_references' ORDER BY indexname",
    )
    .fetch_all(&mut raw)
    .await
    .unwrap();
    for key in [
        "(space_id, owner_kind, owner_id)",
        "(space_id, content_blake3)",
    ] {
        assert!(
            reference_indexes.iter().any(|def| def.ends_with(key)),
            "missing full index on {key}"
        );
    }
    let upgraded_constraints: Vec<(String, String, String)> = sqlx::query_as(CONSTRAINTS)
        .fetch_all(&mut raw)
        .await
        .unwrap();
    assert_eq!(upgraded_constraints, fresh_constraints);
    let checkpoints: Vec<(String,i64,i64,i64)> = sqlx::query_as(
        "SELECT note_id,snapshot_lease_epoch,snapshot_update_seq,carrier_dirty FROM collab_checkpoints ORDER BY note_id"
    ).fetch_all(&mut raw).await.unwrap();
    assert_eq!(
        checkpoints,
        vec![
            ("checkpoint".into(), 7, i64::MAX, 1),
            ("delta-only".into(), 0, 0, 1)
        ]
    );
    let delta_count: i64 = sqlx::query_scalar("SELECT count(*) FROM collab_update_log")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    assert_eq!(delta_count, 2);
    let generation: String = sqlx::query_scalar("SELECT owner_generation FROM backup_holds")
        .fetch_one(&mut raw)
        .await
        .unwrap();
    assert!(generation.is_empty());
    sqlx::raw_sql("INSERT INTO content_jobs(space_id,job_id,job_kind,state,lease_epoch,artifacts_json,result_msgpack,created_seq,updated_seq)
        VALUES ('legacy-collab','j','backup','queued',0,'[]',decode(repeat('aa',8192),'hex'),1,1);
        INSERT INTO account_catalog_receipts VALUES ('owner','actor','key',decode(repeat('00',32),'hex'),decode(repeat('aa',4096),'hex'))")
        .execute(&mut raw).await.unwrap();
    let oversized = sqlx::query(
        "UPDATE account_catalog_receipts SET result_msgpack=decode(repeat('aa',4097),'hex')",
    )
    .execute(&mut raw)
    .await
    .unwrap_err();
    assert_eq!(
        oversized.as_database_error().unwrap().code().as_deref(),
        Some("23514")
    );
    raw.close().await.unwrap();

    // Wrong installation fails closed.
    let wrong_cfg = fixtures
        .open_pg_s3_config(sample_installation_id(4), &schema)
        .await;
    assert!(CanonicalRuntime::open(wrong_cfg).await.is_err());

    // Newer schema_version fails closed on PG.
    {
        let mut raw = fixtures.open_raw_pg().await;
        let sql = format!(
            "UPDATE \"{schema}\".schema_meta SET schema_version = 999 WHERE singleton_id = 1"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .execute(&mut raw)
            .await
            .expect("bump PG schema_version");
        let _ = raw.close().await;
    }
    assert!(
        CanonicalRuntime::open(fixtures.open_pg_s3_config(install.clone(), &schema).await)
            .await
            .is_err()
    );

    // Restore schema_version, test migration_state = 'migrating' fails closed on PG.
    {
        let mut raw = fixtures.open_raw_pg().await;
        let sql = format!(
            "UPDATE \"{schema}\".schema_meta SET schema_version = $1, migration_state = 'migrating' WHERE singleton_id = 1"
        );
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(notarium_canonical::CANONICAL_SCHEMA_VERSION as i32)
            .execute(&mut raw)
            .await
            .expect("set PG migrating");
        let _ = raw.close().await;
    }
    assert!(
        CanonicalRuntime::open(fixtures.open_pg_s3_config(install, &schema).await)
            .await
            .is_err()
    );

    fixtures.drop_pg_schema(&schema).await;
}

#[tokio::test]
async fn l1_semantic_parity_sqlite_and_postgres() {
    // 1. Run full L1 semantic suite on SQLite.
    {
        let temp = TempDataRoot::new("l1-sem-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(10), temp.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg)
            .await
            .expect("open SQLite for semantic L1");
        run_semantic_l1_suite(&store).await;
        verify_sqlite_mid_command_and_purge_fence(&store, &temp).await;
        runtime.shutdown().await.expect("shutdown SQLite");
    }

    // 2. Run identical L1 semantic suite on PostgreSQL 16.
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let cfg = fixtures
            .open_pg_s3_config(sample_installation_id(11), &schema)
            .await;
        let (store, runtime) = CanonicalRuntime::open(cfg)
            .await
            .expect("open PostgreSQL 16 for semantic L1");
        run_semantic_l1_suite(&store).await;
        verify_postgres_mid_command_and_purge_fence(&store, &fixtures, &schema).await;
        runtime.shutdown().await.expect("shutdown PG");
        fixtures.drop_pg_schema(&schema).await;
    }
}

async fn run_semantic_l1_suite(store: &CanonicalStore) {
    let owner = sample_principal_id(1);
    let space_a = sample_space_id(1);
    let inc_a = sample_incarnation(1);
    let root_a = sample_folder_id(1);
    let epoch_1 = LeaseEpoch::new(1).unwrap();

    // Nanosecond pre-1970 Timestamp roundtrip!
    let pre_epoch_ts = Timestamp::from_unix_parts(-1, 987_654_321).unwrap();
    let rec_a = store
        .create_space(CreateSpaceSpec {
            space_id: space_a.clone(),
            incarnation: inc_a,
            root_folder_id: root_a.clone(),
            slug: "Caf\u{00e9}-Workspace".to_owned(), // NFC
            kind: SpaceKind::Shared,
            owner: owner.clone(),
            active_epoch: epoch_1,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: Some(pre_epoch_ts),
        })
        .await
        .expect("create space A");

    assert_eq!(rec_a.created_at, pre_epoch_ts);
    let fetched_a = store.get_space(&space_a).await.expect("get space A");
    assert_eq!(fetched_a.created_at, pre_epoch_ts);
    assert_eq!(fetched_a.root_folder_id, root_a);

    // Duplicate Space slug using NFD + uppercase must fail with PathConflict.
    let dup_space = store
        .create_space(CreateSpaceSpec {
            space_id: sample_space_id(99),
            incarnation: sample_incarnation(99),
            root_folder_id: sample_folder_id(99),
            slug: "CAF\u{0045}\u{0301}-WORKSPACE".to_owned(), // NFD + uppercase
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: epoch_1,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await;
    assert!(
        matches!(
            dup_space,
            Err(PortError::Domain(DomainError::PathConflict { .. }))
        ),
        "NFD/case-variant Space slug must collide: {dup_space:?}"
    );

    // Create Space B with year-9999 nanosecond timestamp & test cross-Space parent rejection.
    let space_b = sample_space_id(2);
    let inc_b = sample_incarnation(2);
    let root_b = sample_folder_id(2);
    let far_future_ts = Timestamp::parse("9999-12-31T23:59:59.123456789Z").unwrap();
    let rec_b = store
        .create_space(CreateSpaceSpec {
            space_id: space_b.clone(),
            incarnation: inc_b,
            root_folder_id: root_b.clone(),
            slug: "space-b".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: epoch_1,
            initial_last_seq: SpaceSeq::ZERO,
            created_at: Some(far_future_ts),
        })
        .await
        .expect("create space B");
    assert_eq!(
        store.get_space(&space_b).await.unwrap().created_at,
        far_future_ts
    );

    let scope_a = HistoryScope {
        space_id: space_a.clone(),
        incarnation: inc_a,
    };
    let _ = rec_b;

    // Cross-Space parent FolderId (passing root_b into Space A) must fail with ResourceNotFound!
    let cross_parent_res = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1,
            folder_id: sample_folder_id(10),
            parent: Some(root_b.clone()),
            slug: "cross-leak".to_owned(),
            display_name: "Cross Leak".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert!(
        matches!(
            cross_parent_res,
            Err(PortError::Domain(DomainError::ResourceNotFound))
        ),
        "cross-Space parent folder must return ResourceNotFound, got {cross_parent_res:?}"
    );

    // Root folder protection: cannot trash root folder.
    let root_rev_rec = store
        .read_entity_revision_at_cutoff(&scope_a, "folder", root_a.as_str(), Some(SpaceSeq::ZERO))
        .await
        .expect("read root folder rev")
        .expect("root folder rev present");

    let trash_root_res = store
        .set_folder_lifecycle(
            &scope_a,
            epoch_1,
            &root_a,
            &root_rev_rec.revision_id,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await;
    assert_validation_err(&trash_root_res, ValidationReason::InvalidState);

    // Create child folder 1 under root (`parent = None` normalizes to `root_a`), as a project.
    let fld_1 = sample_folder_id(11);
    let (_fld_ref_1, rev_1_create, seq_1) = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1,
            folder_id: fld_1.clone(),
            parent: None,
            slug: "Caf\u{00e9}".to_owned(), // NFC
            display_name: "Café Notes".to_owned(),
            is_project: true,
            project_slug: Some("Proj-Alpha".to_owned()),
            actor: owner.clone(),
            timestamp: Some(far_future_ts),
        })
        .await
        .expect("create folder 1");
    assert_eq!(seq_1.get(), 1);

    // Sibling collision under Unicode NFD + casefold ("CAFE\u{0301}" vs "Café").
    let sibling_dup = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1,
            folder_id: sample_folder_id(12),
            parent: Some(root_a.clone()),
            slug: "caf\u{0065}\u{0301}".to_owned(), // NFD
            display_name: "Duplicate Café".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert!(matches!(
        sibling_dup,
        Err(PortError::Domain(DomainError::PathConflict { .. }))
    ));

    // Active project_slug collision in another folder ("proj-alpha").
    let proj_dup = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1,
            folder_id: sample_folder_id(13),
            parent: Some(root_a.clone()),
            slug: "other-folder".to_owned(),
            display_name: "Other Folder".to_owned(),
            is_project: true,
            project_slug: Some("PROJ-ALPHA".to_owned()),
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert!(matches!(
        proj_dup,
        Err(PortError::Domain(DomainError::PathConflict { .. }))
    ));

    // Trash fld_1 -> frees both its sibling slug and its project_slug!
    let (rev_1_trash, seq_2) = store
        .set_folder_lifecycle(
            &scope_a,
            epoch_1,
            &fld_1,
            &rev_1_create,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .expect("trash fld_1");
    assert_eq!(seq_2.get(), 2);

    // Now creating fld_2 with NFD "cafe\u{0301}" succeeds because fld_1 is Trashed!
    let fld_2 = sample_folder_id(14);
    let (_fld_ref_2, rev_2_create, seq_3) = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1,
            folder_id: fld_2.clone(),
            parent: None,
            slug: "cafe\u{0301}".to_owned(),
            display_name: "Replacement Café".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await
        .expect("create replacement sibling while fld_1 trashed");
    assert_eq!(seq_3.get(), 3);

    // Restoring fld_1 while fld_2 occupies the active sibling slug must return PathConflict without data loss!
    let restore_conflict = store
        .set_folder_lifecycle(
            &scope_a,
            epoch_1,
            &fld_1,
            &rev_1_trash,
            Lifecycle::Active,
            &owner,
            None,
        )
        .await;
    assert!(
        matches!(
            restore_conflict,
            Err(PortError::Domain(DomainError::PathConflict { .. }))
        ),
        "restore collision must return PathConflict: {restore_conflict:?}"
    );

    // Trash fld_2, then restore fld_1 -> succeeds cleanly!
    let (_rev_2_trash, seq_4) = store
        .set_folder_lifecycle(
            &scope_a,
            epoch_1,
            &fld_2,
            &rev_2_create,
            Lifecycle::Trashed,
            &owner,
            None,
        )
        .await
        .expect("trash fld_2");
    assert_eq!(seq_4.get(), 4);

    let (rev_1_restore, seq_5) = store
        .set_folder_lifecycle(
            &scope_a,
            epoch_1,
            &fld_1,
            &rev_1_trash,
            Lifecycle::Active,
            &owner,
            None,
        )
        .await
        .expect("restore fld_1 after freeing slug");
    assert_eq!(seq_5.get(), 5);

    // Immutable cutoff reads across fld_1's history:
    // cutoff=0 -> None; cutoff=1 -> rev_1_create; cutoff=2 -> rev_1_trash; cutoff=5 / None -> rev_1_restore.
    assert!(
        store
            .read_entity_revision_at_cutoff(
                &scope_a,
                "folder",
                fld_1.as_str(),
                Some(SpaceSeq::ZERO)
            )
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .read_entity_revision_at_cutoff(&scope_a, "folder", fld_1.as_str(), Some(seq_1))
            .await
            .unwrap()
            .unwrap()
            .revision_id,
        rev_1_create
    );
    assert_eq!(
        store
            .read_entity_revision_at_cutoff(&scope_a, "folder", fld_1.as_str(), Some(seq_2))
            .await
            .unwrap()
            .unwrap()
            .revision_id,
        rev_1_trash
    );
    assert_eq!(
        store
            .read_entity_revision_at_cutoff(&scope_a, "folder", fld_1.as_str(), None)
            .await
            .unwrap()
            .unwrap()
            .revision_id,
        rev_1_restore
    );

    // Cutoff beyond last_seq returns InvalidCutoff.
    let future_cutoff = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "folder",
            fld_1.as_str(),
            Some(SpaceSeq::new(999).unwrap()),
        )
        .await;
    assert_validation_err(&future_cutoff, ValidationReason::InvalidCutoff);

    // Query plan certification: must select `idx_revisions_entity_vis_seq` on both SQLite and PostgreSQL 16!
    let plan = store
        .explain_immutable_revision_query_plan(&space_a, "folder", fld_1.as_str(), seq_5)
        .await
        .expect("explain query plan");
    assert!(
        plan.contains("idx_revisions_entity_vis_seq"),
        "expected immutable revision query plan to use idx_revisions_entity_vis_seq, got:\n{plan}"
    );

    // Lease turnover (`advance_space_lease`) & stale lease rejection.
    let wrong_purpose_ctx = maintenance_ctx(ServicePurpose::Projection);
    assert!(
        store
            .advance_space_lease(&wrong_purpose_ctx, &scope_a, LeaseEpoch::new(2).unwrap())
            .await
            .is_err()
    );

    let revoc_ctx = maintenance_ctx(ServicePurpose::Revocation);
    let epoch_2 = store
        .advance_space_lease(&revoc_ctx, &scope_a, LeaseEpoch::new(2).unwrap())
        .await
        .expect("advance space lease to epoch 2");
    assert_eq!(epoch_2.get(), 2);

    let stale_epoch_write = store
        .create_folder(CreateFolderSpec {
            scope: scope_a.clone(),
            active_epoch: epoch_1, // stale!
            folder_id: sample_folder_id(20),
            parent: None,
            slug: "stale-epoch".to_owned(),
            display_name: "Stale Epoch".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner.clone(),
            timestamp: None,
        })
        .await;
    assert_validation_err(&stale_epoch_write, ValidationReason::InvalidAuthority);

    // SpaceSeq::MAX overflow guard: Space initialized at SpaceSeq::MAX rejects mutation BEFORE any side effect!
    let max_space = sample_space_id(50);
    let max_inc = sample_incarnation(50);
    let max_root = sample_folder_id(50);
    store
        .create_space(CreateSpaceSpec {
            space_id: max_space.clone(),
            incarnation: max_inc,
            root_folder_id: max_root,
            slug: "max-seq-space".to_owned(),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: epoch_1,
            initial_last_seq: SpaceSeq::MAX,
            created_at: None,
        })
        .await
        .expect("create max-seq space");

    let overflow_res = store
        .create_folder(CreateFolderSpec {
            scope: HistoryScope {
                space_id: max_space.clone(),
                incarnation: max_inc,
            },
            active_epoch: epoch_1,
            folder_id: sample_folder_id(51),
            parent: None,
            slug: "overflow-folder".to_owned(),
            display_name: "Overflow Folder".to_owned(),
            is_project: false,
            project_slug: None,
            actor: owner,
            timestamp: None,
        })
        .await;
    assert_validation_err(&overflow_res, ValidationReason::SequenceOverflow);
    assert_eq!(
        store.get_space(&max_space).await.unwrap().last_seq,
        SpaceSeq::MAX
    );
}

async fn verify_sqlite_mid_command_and_purge_fence(store: &CanonicalStore, temp: &TempDataRoot) {
    let space_a = sample_space_id(1);
    let inc_a = sample_incarnation(1);
    let scope_a = HistoryScope {
        space_id: space_a.clone(),
        incarnation: inc_a,
    };
    let fenced_note = sample_note_id(77);

    // Insert a 2-event command (seqs 6..=7) and a revision_purge_fences row via raw SQLite connection,
    // then verify mid-command cutoff (seq 6) returns InvalidCutoff while command-end (seq 7) succeeds,
    // and fenced note read returns ResourceNotFound.
    {
        let mut raw = temp.open_raw_sqlite().await;
        sqlx::query("UPDATE spaces SET last_seq = 7 WHERE space_id = ?")
            .bind(space_a.as_str())
            .execute(&mut raw)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO change_commands (space_id, history_incarnation, command_id, first_seq, last_seq, command_kind, payload_id, committed_at_ms)
             VALUES (?, ?, 'cmd_multi', 6, 7, 'batch', NULL, 1000)",
        )
        .bind(space_a.as_str())
        .bind(inc_a.as_bytes().as_slice())
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO revision_purge_fences (space_id, history_incarnation, note_id, purge_seq, old_identity_state, successor_note_id, created_at_sec, created_at_nsec)
             VALUES (?, ?, ?, 7, 'purged', NULL, 1000, 0)",
        )
        .bind(space_a.as_str())
        .bind(inc_a.as_bytes().as_slice())
        .bind(fenced_note.as_str())
        .execute(&mut raw)
        .await
        .unwrap();
        let _ = raw.close().await;
    }

    let mid_cut = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "folder",
            sample_folder_id(11).as_str(),
            Some(SpaceSeq::new(6).unwrap()),
        )
        .await;
    assert_validation_err(&mid_cut, ValidationReason::InvalidCutoff);

    let end_cut = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "folder",
            sample_folder_id(11).as_str(),
            Some(SpaceSeq::new(7).unwrap()),
        )
        .await;
    assert!(end_cut.expect("command-end cutoff 7 valid").is_some());

    let fenced_read = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "note",
            fenced_note.as_str(),
            Some(SpaceSeq::new(5).unwrap()),
        )
        .await;
    assert!(matches!(
        fenced_read,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
}

async fn verify_postgres_mid_command_and_purge_fence(
    store: &CanonicalStore,
    fixtures: &StorageTestFixtures,
    schema: &str,
) {
    let space_a = sample_space_id(1);
    let inc_a = sample_incarnation(1);
    let scope_a = HistoryScope {
        space_id: space_a.clone(),
        incarnation: inc_a,
    };
    let fenced_note = sample_note_id(77);

    {
        let mut raw = fixtures.open_raw_pg().await;
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "SET search_path TO \"{schema}\""
        )))
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::query("UPDATE spaces SET last_seq = 7 WHERE space_id = $1")
            .bind(space_a.as_str())
            .execute(&mut raw)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO change_commands (space_id, history_incarnation, command_id, first_seq, last_seq, command_kind, payload_id, committed_at_ms)
             VALUES ($1, $2, 'cmd_multi', 6, 7, 'batch', NULL, 1000)",
        )
        .bind(space_a.as_str())
        .bind(inc_a.as_bytes().as_slice())
        .execute(&mut raw)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO revision_purge_fences (space_id, history_incarnation, note_id, purge_seq, old_identity_state, successor_note_id, created_at_sec, created_at_nsec)
             VALUES ($1, $2, $3, 7, 'purged', NULL, 1000, 0)",
        )
        .bind(space_a.as_str())
        .bind(inc_a.as_bytes().as_slice())
        .bind(fenced_note.as_str())
        .execute(&mut raw)
        .await
        .unwrap();
        let _ = raw.close().await;
    }

    let mid_cut = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "folder",
            sample_folder_id(11).as_str(),
            Some(SpaceSeq::new(6).unwrap()),
        )
        .await;
    assert_validation_err(&mid_cut, ValidationReason::InvalidCutoff);

    let end_cut = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "folder",
            sample_folder_id(11).as_str(),
            Some(SpaceSeq::new(7).unwrap()),
        )
        .await;
    assert!(end_cut.expect("PG command-end cutoff 7 valid").is_some());

    let fenced_read = store
        .read_entity_revision_at_cutoff(
            &scope_a,
            "note",
            fenced_note.as_str(),
            Some(SpaceSeq::new(5).unwrap()),
        )
        .await;
    assert!(matches!(
        fenced_read,
        Err(PortError::Domain(DomainError::ResourceNotFound))
    ));
}

#[tokio::test]
async fn l1_long_incompressible_title_fold_succeeds_in_sqlite_and_postgres_v9_index() {
    use notarium_core::ids::{CommandKey, ContentDigest, GrantId, RequestId};
    use notarium_core::ports::{CreateNote, Mutation, NoteWritePort, Preconditions, SpaceContext};
    use notarium_core::receipt::CommandIdentity;

    // 8192 incompressible hex characters (128 distinct blake3 chunks): exceeds PG16's 8 KiB
    // B-tree item limit if indexed verbatim, but fits cleanly in the bounded 256-char prefix index.
    let mut long_title = String::with_capacity(8192);
    for i in 0u16..128 {
        let digest = blake3::hash(&i.to_be_bytes());
        long_title.push_str(&digest.to_hex());
    }
    assert_eq!(long_title.len(), 8192);
    let body = format!("# {long_title}\n\nbody\n");

    let run_case = |store: CanonicalStore| {
        let body = body.clone();
        async move {
            let owner = sample_principal_id(41);
            let space_id = sample_space_id(41);
            let inc = sample_incarnation(41);
            let root = sample_folder_id(41);
            let scope = HistoryScope {
                space_id: space_id.clone(),
                incarnation: inc,
            };
            store
                .create_space(CreateSpaceSpec {
                    space_id: space_id.clone(),
                    incarnation: inc,
                    root_folder_id: root.clone(),
                    slug: "long-title-space".to_owned(),
                    kind: SpaceKind::Personal,
                    owner: owner.clone(),
                    active_epoch: LeaseEpoch::new(1).unwrap(),
                    initial_last_seq: SpaceSeq::ZERO,
                    created_at: None,
                })
                .await
                .expect("create space");
            let auth = notarium_core::auth::EngineAuthContext::for_human(
                notarium_core::auth::VerifiedHuman::attest(
                    owner.clone(),
                    GrantId::from_bytes([41; 16]),
                    std::collections::BTreeMap::from([(
                        space_id.clone(),
                        notarium_core::auth::SpaceGrant {
                            role: notarium_core::auth::SpaceRole::Owner,
                            read_classes: std::collections::BTreeSet::from([
                                notarium_core::classes::DocClass::UserDoc,
                            ]),
                            write_classes: std::collections::BTreeSet::from([
                                notarium_core::classes::DocClass::UserDoc,
                            ]),
                            project_root: None,
                        },
                    )]),
                    false,
                ),
            );
            let ctx = SpaceContext::new(
                auth,
                scope.clone(),
                notarium_core::ports::CallBudget {
                    request: RequestId::from_bytes([41; 16]),
                    cancellation: notarium_core::ports::Cancellation::default(),
                    remaining: std::time::Duration::from_secs(10),
                },
            )
            .unwrap();
            store
                .create_note(
                    ctx,
                    Mutation {
                        identity: CommandIdentity {
                            scope,
                            actor: owner,
                            key: CommandKey::from_bytes([41; 16]),
                            hash: ContentDigest::from_bytes(
                                *blake3::hash(body.as_bytes()).as_bytes(),
                            ),
                        },
                        preconditions: Preconditions::default(),
                        input: CreateNote {
                            note: sample_note_id(41),
                            parent: None,
                            slug: "long-h1".to_owned(),
                            class: notarium_core::classes::DocClass::UserDoc,
                            carrier: body,
                            folder_page: false,
                        },
                    },
                )
                .await
                .expect("active note with 8 KiB incompressible H1 must fit v9 title_fold index");
        }
    };

    {
        let temp = TempDataRoot::new("l1-long-title-sqlite");
        let cfg = CanonicalConfig::local_default(sample_installation_id(41), temp.data_root());
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open SQLite");
        run_case(store).await;
        runtime.shutdown().await.expect("shutdown SQLite");
    }
    {
        let fixtures = StorageTestFixtures::load_required();
        let schema = fixtures.fresh_pg_schema();
        let cfg = fixtures
            .open_pg_s3_config(sample_installation_id(42), &schema)
            .await;
        let (store, runtime) = CanonicalRuntime::open(cfg).await.expect("open PG16");
        run_case(store).await;
        runtime.shutdown().await.expect("shutdown PG16");
        fixtures.drop_pg_schema(&schema).await;
    }
}

#[tokio::test]
async fn canonical_open_rejects_hybrid_storage_profiles() {
    use notarium_canonical::{
        BlobBackendConfig, S3BucketModePolicy, SqlBackendConfig, WriterConfig,
        config::{default_backup_budget, default_postgres_backup_budget},
    };
    use notarium_core::error::ValidationReason;
    use std::time::Duration;

    let fixtures = StorageTestFixtures::load_required();
    let temp = TempDataRoot::new("hybrid-profiles");
    let schema = fixtures.fresh_pg_schema();

    // Hybrid 1: PostgreSQL + Local CAS must be rejected before opening sockets or locks.
    let pg_local = CanonicalConfig {
        installation_id: sample_installation_id(91),
        sql: SqlBackendConfig::postgres_default(fixtures.pg_connect_config(), &schema),
        blobs: BlobBackendConfig::Local {
            data_root: temp.data_root(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    assert_validation_err(
        &CanonicalRuntime::open(pg_local).await,
        ValidationReason::InvalidState,
    );

    // Hybrid 2: SQLite + S3 CAS must be rejected before opening sockets or locks.
    let s3_cfg = fixtures.s3_config(
        "notarium-hybrid-unused",
        S3BucketModePolicy::DetectFromBucket,
    );
    let sqlite_s3 = CanonicalConfig {
        installation_id: sample_installation_id(92),
        sql: SqlBackendConfig::sqlite_default(temp.data_root()),
        blobs: BlobBackendConfig::S3(Box::new(s3_cfg)),
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_backup_budget(),
    };
    assert_validation_err(
        &CanonicalRuntime::open(sqlite_s3).await,
        ValidationReason::InvalidState,
    );
}

#[tokio::test]
async fn pg_v8_and_v9_512b_upgrade_lifts_inline_limit_and_retires_staged_chat() {
    use sqlx::Connection;

    let fixtures = StorageTestFixtures::load_required();
    let v8_hash = "085e724d4cf969a85265d36b616fe04bc78a51c3beadf86dee7f1664bee2dcd7";
    let v9_hash = "a906f0cf2dc6d4948cd01b180491c1cbe796160ef88e18a706a96e7f36c8fd84";

    for (version, hash) in [(8i32, v8_hash), (9i32, v9_hash)] {
        let schema = fixtures.fresh_pg_schema();
        let install = sample_installation_id(80 + version as u8);
        let mut raw = fixtures.open_raw_pg().await;
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "CREATE SCHEMA \"{schema}\"; SET search_path TO \"{schema}\""
        )))
        .execute(&mut raw)
        .await
        .unwrap();

        let downgraded_ddl = include_str!("../src/schema/postgres_ddl.sql")
            .replace("CONSTRAINT chat_entries_body_check CHECK", "CHECK")
            .replace("CONSTRAINT chat_pending_inputs_body_check CHECK", "CHECK")
            .replace("<= 32768", "<= 512");
        sqlx::raw_sql(sqlx::AssertSqlSafe(downgraded_ddl))
            .execute(&mut raw)
            .await
            .unwrap();
        if version == 8 {
            sqlx::raw_sql(include_str!("fixtures/schema-v8-remove-agents.sql"))
                .execute(&mut raw)
                .await
                .unwrap();
        }
        sqlx::query("INSERT INTO schema_meta VALUES(1,$1,1,$2,'ready',$3,0,0,0,0)")
            .bind(version)
            .bind(install.as_str())
            .bind(hex::decode(hash).unwrap())
            .execute(&mut raw)
            .await
            .unwrap();
        let space_id = sample_space_id(80 + version as u8);
        let sid = space_id.as_str();
        sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
            "INSERT INTO spaces VALUES('{sid}',decode('00000000000000000000000000000000','hex'),'root','home','home','personal','owner','active',1,10,'{{}}',0,0);
             INSERT INTO chat_threads(
                 space_id, history_incarnation, thread_id, kind, owner_id, project_folder_id,
                 title, head_leaf_seq, head_rev_id, next_entry_seq, active_run_id,
                 ext_space_tainted_mask, created_seq, updated_seq, created_at_sec,
                 created_at_nsec, updated_at_sec, updated_at_nsec
             ) VALUES ('{sid}',decode('00000000000000000000000000000000','hex'),'thread','personal','owner',NULL,'Chat',1,'r1',2,NULL,0,1,2,0,0,0,0);
             INSERT INTO chat_entries(
                 space_id, thread_id, entry_seq, parent_seq, revision_id, kind, author_id,
                 inline_text, referenced_notes_json, ext_space_tainted, is_chain_node,
                 branch_depth, created_space_seq, redacted_at_seq
             ) VALUES ('{sid}','thread',1,NULL,'r1','human','owner','hello','[]',0,1,0,1,NULL);
             INSERT INTO chat_entry_note_refs(
                 space_id, thread_id, entry_seq, ref_ordinal, target_space_id,
                 target_note_id, created_space_seq
             ) VALUES ('{sid}','thread',1,0,'{sid}','note1',1);
             INSERT INTO chat_pending_inputs(
                 space_id, thread_id, input_id, ordinal, author_id, inline_text,
                 queued_base_leaf_seq, in_flight_run_id, mentions_agent, status,
                 enqueued_seq, ext_space_tainted
             ) VALUES ('{sid}','thread','in1',1,'owner','pending',1,'run1',0,'pending',2,0);
             INSERT INTO blob_catalog VALUES('{sid}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),600,120,1,'pub_staged','open','active',1);
             INSERT INTO blob_publications VALUES('{sid}','pub_staged',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,'s3_chunked_v1','active',1,1,600,120,1,1);
             INSERT INTO blob_references VALUES('{sid}','staged_chat','lease1','r0','body',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'pub_staged',1);"
        )))
        .execute(&mut raw)
        .await
        .unwrap();

        // Pre-upgrade 513B insert must fail against the old anonymous <= 512 CHECK.
        let body_513 = "a".repeat(513);
        assert!(
            sqlx::query(
                "INSERT INTO chat_entries(
                    space_id, thread_id, entry_seq, parent_seq, revision_id, kind, author_id,
                    inline_text, referenced_notes_json, ext_space_tainted, is_chain_node,
                    branch_depth, created_space_seq
                 ) VALUES ($1,'thread',2,1,'r2','model','owner',$2,'[]',0,1,1,3)",
            )
            .bind(sid)
            .bind(&body_513)
            .execute(&mut raw)
            .await
            .is_err(),
            "PG v{version} must reject 513B inline before upgrade"
        );

        notarium_canonical::schema::bootstrap_postgres_schema(&mut raw, &schema, &install)
            .await
            .expect("upgrade PG v8/v9 to v10");
        sqlx::query(sqlx::AssertSqlSafe(format!(
            "SET search_path TO \"{schema}\""
        )))
        .execute(&mut raw)
        .await
        .unwrap();

        let body_32k = "b".repeat(32 * 1024);
        let body_32k_plus_1 = "c".repeat(32 * 1024 + 1);
        sqlx::query(
            "INSERT INTO chat_entries(
                space_id, thread_id, entry_seq, parent_seq, revision_id, kind, author_id,
                inline_text, referenced_notes_json, ext_space_tainted, is_chain_node,
                branch_depth, created_space_seq, human_origin, body_format
             ) VALUES ($1,'thread',2,1,'r2','model','owner',$2,'[]',0,1,1,3,0,0)",
        )
        .bind(sid)
        .bind(&body_32k)
        .execute(&mut raw)
        .await
        .expect("upgraded PG chat_entries must accept 32 KiB inline");
        assert!(
            sqlx::query(
                "INSERT INTO chat_entries(
                    space_id, thread_id, entry_seq, parent_seq, revision_id, kind, author_id,
                    inline_text, referenced_notes_json, ext_space_tainted, is_chain_node,
                    branch_depth, created_space_seq, human_origin, body_format
                 ) VALUES ($1,'thread',3,2,'r3','model','owner',$2,'[]',0,1,2,4,0,0)",
            )
            .bind(sid)
            .bind(&body_32k_plus_1)
            .execute(&mut raw)
            .await
            .is_err()
        );
        sqlx::query(
            "INSERT INTO chat_pending_inputs(
                space_id, thread_id, input_id, ordinal, author_id, inline_text,
                queued_base_leaf_seq, in_flight_run_id, mentions_agent, status,
                enqueued_seq, ext_space_tainted
             ) VALUES ($1,'thread','in2',2,'owner',$2,2,'run1',0,'pending',4,0)",
        )
        .bind(sid)
        .bind(&body_32k)
        .execute(&mut raw)
        .await
        .expect("upgraded PG chat_pending_inputs must accept 32 KiB inline");
        assert!(
            sqlx::query(
                "INSERT INTO chat_pending_inputs(
                    space_id, thread_id, input_id, ordinal, author_id, inline_text,
                    queued_base_leaf_seq, in_flight_run_id, mentions_agent, status,
                    enqueued_seq, ext_space_tainted
                 ) VALUES ($1,'thread','in3',3,'owner',$2,2,'run1',0,'pending',5,0)",
            )
            .bind(sid)
            .bind(&body_32k_plus_1)
            .execute(&mut raw)
            .await
            .is_err()
        );

        let remaining_staged: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blob_references WHERE owner_kind='staged_chat'",
        )
        .fetch_one(&mut raw)
        .await
        .unwrap();
        let catalog_refs: i64 =
            sqlx::query_scalar("SELECT ref_count FROM blob_catalog WHERE space_id=$1")
                .bind(sid)
                .fetch_one(&mut raw)
                .await
                .unwrap();
        let pending_rets: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM blob_retirements WHERE space_id=$1 AND reason='gc' AND status='pending'",
        )
        .bind(sid)
        .fetch_one(&mut raw)
        .await
        .unwrap();
        assert_eq!((remaining_staged, catalog_refs, pending_rets), (0, 0, 1));

        let _ = raw.close().await;
        fixtures.drop_pg_schema(&schema).await;
    }

    // PostgreSQL parity: reachable >64 MiB note_revision blob must fail closed and roll back
    // v9->v10 cleanly; converting it to obsolete staged_chat retires it and allows upgrade.
    let schema = fixtures.fresh_pg_schema();
    let install = sample_installation_id(99);
    let space_id = sample_space_id(99);
    let sid = space_id.as_str();
    let mut raw = fixtures.open_raw_pg().await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE SCHEMA \"{schema}\"; SET search_path TO \"{schema}\""
    )))
    .execute(&mut raw)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../src/schema/postgres_ddl.sql"))
        .execute(&mut raw)
        .await
        .unwrap();
    sqlx::query("INSERT INTO schema_meta VALUES(1,9,1,$1,'ready',$2,0,0,0,0)")
        .bind(install.as_str())
        .bind(hex::decode(v9_hash).unwrap())
        .execute(&mut raw)
        .await
        .unwrap();
    let over_64m = notarium_canonical::blobs::MAX_BLOB_DECODE_BYTES as i64 + 1;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "INSERT INTO spaces VALUES('{sid}',decode('00000000000000000000000000000000','hex'),'root','home','home','personal','owner','active',1,10,'{{}}',0,0);
         INSERT INTO blob_catalog VALUES('{sid}',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),{over_64m},120,1,'pub_big','open','active',1);
         INSERT INTO blob_publications VALUES('{sid}','pub_big',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),1,'s3_chunked_v1','active',1,1,{over_64m},120,1,1);
         INSERT INTO blob_references VALUES('{sid}','note_revision','note1','r1','body',decode('0000000000000000000000000000000000000000000000000000000000000000','hex'),'pub_big',1);"
    )))
    .execute(&mut raw)
    .await
    .unwrap();
    assert!(
        notarium_canonical::schema::bootstrap_postgres_schema(&mut raw, &schema, &install)
            .await
            .is_err(),
        "PG v10 upgrade must fail closed when a reachable blob exceeds 64 MiB"
    );
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET search_path TO \"{schema}\""
    )))
    .execute(&mut raw)
    .await
    .unwrap();
    let ver_after_abort: i32 =
        sqlx::query_scalar("SELECT schema_version FROM schema_meta WHERE singleton_id=1")
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(ver_after_abort, 9);

    sqlx::query("UPDATE blob_references SET owner_kind='staged_chat'")
        .execute(&mut raw)
        .await
        .unwrap();
    notarium_canonical::schema::bootstrap_postgres_schema(&mut raw, &schema, &install)
        .await
        .expect("PG staged_chat-only >64 MiB blob must retire before reachability check");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "SET search_path TO \"{schema}\""
    )))
    .execute(&mut raw)
    .await
    .unwrap();
    let ver_after_ok: i32 =
        sqlx::query_scalar("SELECT schema_version FROM schema_meta WHERE singleton_id=1")
            .fetch_one(&mut raw)
            .await
            .unwrap();
    assert_eq!(
        ver_after_ok,
        notarium_canonical::CANONICAL_SCHEMA_VERSION as i32
    );

    let _ = raw.close().await;
    fixtures.drop_pg_schema(&schema).await;
}

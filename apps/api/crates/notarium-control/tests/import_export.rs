use notarium_control::store::{ControlStore, PostgresConfig, target::*};
use notarium_core::{epoch::DataRoot, ids::*, ports::*};
use sqlx::Connection;
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn ctx(purpose: ServicePurpose) -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(purpose),
        budget: CallBudget {
            request: RequestId::from_bytes([1; 16]),
            cancellation: Cancellation::default(),
            remaining: Duration::from_secs(20),
        },
    }
}
fn epoch() -> TargetRecord {
    TargetRecord::V1StorageEpoch(V1StorageEpochRow {
        singleton: 1,
        epoch_version: 1,
        state: "migrating".into(),
        installation_id: InstallationId::from_bytes([1; 16]).to_string(),
        receipt_sha256: None,
        receipt_json: None,
    })
}
fn user(n: u8) -> TargetRecord {
    TargetRecord::Users(UsersRow {
        user_id: PrincipalId::from_bytes([n; 16]).to_string(),
        username: format!("user{n}"),
        email: None,
        display_name: "user".into(),
        password_hash: None,
        is_admin: 0,
        disabled_at: None,
        personal_space_id: None,
        revision: 0,
        metadata_revision: 0,
        auth_version: 0,
        created_at: 0,
    })
}
fn client(name: String, metadata: Option<String>) -> TargetRecord {
    TargetRecord::OauthClients(OauthClientsRow {
        client_id: "client".into(),
        kind: "dcr".into(),
        redirect_uris: "[]".into(),
        client_name: name,
        metadata_uri: metadata,
        metadata_digest: None,
        cache_expires_at: None,
        activated_at: None,
        created_at: 0,
        last_seen_at: None,
    })
}
fn episode(n: u8, parent: Option<u8>) -> TargetRecord {
    TargetRecord::AgentEpisodes(AgentEpisodesRow {
        episode_id: EpisodeId::from_bytes([n; 16]).to_string(),
        owner_id: PrincipalId::from_bytes([1; 16]).to_string(),
        name: None,
        parent_id: parent.map(|p| EpisodeId::from_bytes([p; 16]).to_string()),
        active_role: None,
        project_space: None,
        project_folder: None,
        lifecycle: "active".into(),
        revision: 0,
        created_at: 0,
        last_seen_at: 0,
        closed_at: None,
        calls: 0,
    })
}
fn refresh(n: u8, next: Option<u8>) -> TargetRecord {
    TargetRecord::OauthRefreshTokens(OauthRefreshTokensRow {
        token_id: format!("{n:012x}"),
        token_hash: vec![n; 32],
        family_id: OAuthFamilyId::from_bytes([1; 16]).to_string(),
        client_id: "client".into(),
        issued_at: 0,
        expires_at: 100,
        used_at: None,
        revoked_at: None,
        rotated_to: next.map(|n| format!("{n:012x}")),
    })
}
enum Observer {
    Sqlite(sqlx::SqliteConnection),
    Postgres(sqlx::PgConnection),
}
fn retrieval(number: usize, score: Option<f64>) -> TargetRecord {
    TargetRecord::AgentRetrievals(AgentRetrievalsRow {
        retrieval_id: RequestId::from_bytes((number as u128).to_be_bytes()).to_string(),
        owner_id: PrincipalId::from_bytes([1; 16]).to_string(),
        principal: PrincipalId::from_bytes([1; 16]).to_string(),
        agent: None,
        call_id: None,
        tool: "search".into(),
        query_summary: "\"hybrid\"".into(),
        filters: serde_json::to_string(&ContentDigest::from_bytes([0; 32])).unwrap(),
        hit_refs: "[]".into(),
        result_count: 1,
        top_score: score,
        created_at: 0,
    })
}
impl Observer {
    async fn raw_score(&mut self, score: f64) -> Result<(), sqlx::Error> {
        let sql = "INSERT INTO agent_retrievals(retrieval_id,owner_id,principal,tool,query_summary,filters,hit_refs,result_count,top_score,created_at) VALUES('raw',$1,'principal','search','{}','{}','[]',1,$2,0)";
        let owner = PrincipalId::from_bytes([1; 16]).to_string();
        match self {
            Self::Sqlite(conn) => sqlx::query(sql)
                .bind(owner)
                .bind(score)
                .execute(conn)
                .await
                .map(|_| ()),
            Self::Postgres(conn) => sqlx::query(sql)
                .bind(owner)
                .bind(score)
                .execute(conn)
                .await
                .map(|_| ()),
        }
    }
    async fn raw_user(&mut self, username: &str, display_name: &str) -> bool {
        let sql =
            "INSERT INTO users(user_id,username,display_name,created_at) VALUES ('raw',$1,$2,0)";
        match self {
            Self::Sqlite(conn) => sqlx::query(sql)
                .bind(username)
                .bind(display_name)
                .execute(conn)
                .await
                .is_ok(),
            Self::Postgres(conn) => sqlx::query(sql)
                .bind(username)
                .bind(display_name)
                .execute(conn)
                .await
                .is_ok(),
        }
    }
    async fn execute(&mut self, sql: &'static str) {
        match self {
            Self::Sqlite(conn) => {
                sqlx::query(sql).execute(conn).await.unwrap();
            }
            Self::Postgres(conn) => {
                sqlx::query(sql).execute(conn).await.unwrap();
            }
        }
    }
    async fn count(&mut self, sql: &'static str) -> i64 {
        match self {
            Self::Sqlite(conn) => sqlx::query_scalar(sql).fetch_one(conn).await.unwrap(),
            Self::Postgres(conn) => sqlx::query_scalar(sql).fetch_one(conn).await.unwrap(),
        }
    }
    fn retention(&self) -> BackupRetentionBudget {
        match self {
            Self::Sqlite(_) => BackupRetentionBudget::SqliteWal {
                max_pinned_bytes: 64 * 1024 * 1024,
            },
            Self::Postgres(_) => BackupRetentionBudget::PostgresSnapshot {
                max_age: Duration::from_secs(10),
            },
        }
    }
    async fn snapshot_released(&mut self) {
        match self {
            Self::Sqlite(conn) => {
                let checkpoint: (i64, i64, i64) = sqlx::query_as("PRAGMA wal_checkpoint(TRUNCATE)")
                    .fetch_one(conn)
                    .await
                    .unwrap();
                assert_eq!(
                    checkpoint,
                    (0, 0, 0),
                    "idle export must release the WAL reader"
                );
            }
            Self::Postgres(conn) => {
                let count:i64=sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'").fetch_one(conn).await.unwrap();
                assert_eq!(count, 0, "idle export must release its snapshot");
            }
        }
    }
}
async fn export(
    store: &ControlStore,
    observer: &Observer,
    context: MaintenanceContext,
    deadline: Duration,
) -> notarium_control::store::TargetExport {
    store
        .export_target(
            context,
            BackupBudget {
                deadline,
                retention: observer.retention(),
                max_spool_bytes: 64 * 1024 * 1024,
            },
        )
        .await
        .unwrap()
}
async fn verify(store: ControlStore, mut observer: Observer) {
    let mut expired = ctx(ServicePurpose::Restore);
    expired.budget.remaining = Duration::ZERO;
    let error = store
        .import_target_batch(expired, &[epoch()])
        .await
        .unwrap_err();
    assert_eq!(error.code(), "deadline_exceeded");
    assert_eq!(
        observer
            .count("SELECT count(*) FROM v1_storage_epoch")
            .await,
        0
    );
    store
        .import_target_batch(ctx(ServicePurpose::Restore), &[epoch(), user(1)])
        .await
        .unwrap();

    // A persisted marker must satisfy the same version boundary as an incoming
    // marker, even when restore resumes without supplying the marker again.
    observer
        .execute("UPDATE v1_storage_epoch SET epoch_version=2")
        .await;
    let error = store
        .import_target_batch(ctx(ServicePurpose::Restore), &[user(2)])
        .await
        .unwrap_err();
    assert_eq!(error.code(), "validation_failed");
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
    assert_eq!(
        observer
            .count("SELECT epoch_version FROM v1_storage_epoch WHERE singleton=1")
            .await,
        2
    );
    observer
        .execute("UPDATE v1_storage_epoch SET epoch_version=1")
        .await;
    store
        .import_target_batch(ctx(ServicePurpose::Restore), &[user(2)])
        .await
        .unwrap();
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 2);
    observer
        .execute("DELETE FROM users WHERE username='user2'")
        .await;

    observer.raw_score(0.125).await.unwrap();
    observer
        .execute("DELETE FROM agent_retrievals WHERE retrieval_id='raw'")
        .await;
    for score in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert!(
            store
                .import_target_batch(
                    ctx(ServicePurpose::Restore),
                    &[user(2), retrieval(99, Some(score))]
                )
                .await
                .is_err()
        );
        assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
        assert_eq!(
            observer
                .count("SELECT count(*) FROM agent_retrievals")
                .await,
            0
        );
        // SQLite's driver maps NaN to SQL NULL before constraints see it. The
        // typed admission above rejects it before that lossy conversion.
        if !score.is_nan() || matches!(observer, Observer::Postgres(_)) {
            let expected = if matches!(observer, Observer::Postgres(_)) {
                "23514"
            } else {
                "275"
            };
            let error = observer.raw_score(score).await.unwrap_err();
            assert_eq!(
                error.as_database_error().unwrap().code().as_deref(),
                Some(expected)
            );
        }
    }
    let finite_scores = [
        None,
        Some(f64::MIN),
        Some(-0.0),
        Some(0.0),
        Some(f64::EPSILON),
        Some(f64::MAX),
    ];
    let scores: Vec<_> = finite_scores
        .iter()
        .enumerate()
        .map(|(i, score)| retrieval(i, *score))
        .collect();
    store
        .import_target_batch(ctx(ServicePurpose::Restore), &scores)
        .await
        .unwrap();

    // The target domain is portable, including unindexed text and composite
    // index keys. PostgreSQL cannot store NUL or arbitrarily large B-tree keys.
    for value in ["valid\0tail".into(), "x".repeat(8192), "Ж".repeat(1025)] {
        let TargetRecord::Users(mut row) = user(2) else {
            unreachable!()
        };
        row.username = value.clone();
        assert!(
            store
                .import_target_batch(ctx(ServicePurpose::Restore), &[TargetRecord::Users(row)])
                .await
                .is_err()
        );
        assert!(!observer.raw_user(&value, "display").await);
    }
    assert!(!observer.raw_user("normal", "unindexed\0text").await);
    let oversized_key = TargetRecord::UserOidcIdentities(UserOidcIdentitiesRow {
        issuer: "i".repeat(1100),
        subject: "s".repeat(1100),
        user_id: PrincipalId::from_bytes([1; 16]).to_string(),
        created_at: 0,
    });
    assert!(
        store
            .import_target_batch(ctx(ServicePurpose::Restore), &[oversized_key])
            .await
            .is_err()
    );
    let TargetRecord::Users(mut boundary_user) = user(2) else {
        unreachable!()
    };
    boundary_user.username = "Ж".repeat(1024); // Exactly 2048 UTF-8 bytes.
    store
        .import_target_batch(
            ctx(ServicePurpose::Restore),
            &[TargetRecord::Users(boundary_user)],
        )
        .await
        .unwrap();
    observer
        .execute("DELETE FROM users WHERE length(username)>32")
        .await;

    // JSON escaping must be included in admission, before any writes commit.
    let huge = client(
        "\u{1}".repeat(1024 * 1024),
        Some("\u{1}".repeat(1024 * 1024)),
    );
    assert!(serde_json::to_vec(&huge).unwrap().len() > 8 * 1024 * 1024);
    assert!(
        store
            .import_target_batch(ctx(ServicePurpose::Restore), &[user(2), huge])
            .await
            .is_err()
    );
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
    assert_eq!(
        observer.count("SELECT count(*) FROM oauth_clients").await,
        0
    );
    // Exactly the cap, including the tagged envelope: no conservative export
    // overhead may make an accepted boundary row permanently unreadable.
    let mut boundary = client("\u{1}".repeat(1024 * 1024), Some("\u{1}".repeat(300_000)));
    let size = serde_json::to_vec(&boundary).unwrap().len();
    let TargetRecord::OauthClients(row) = &mut boundary else {
        unreachable!()
    };
    row.metadata_uri
        .as_mut()
        .unwrap()
        .push_str(&"a".repeat(8 * 1024 * 1024 - size));
    assert_eq!(
        serde_json::to_vec(&boundary).unwrap().len(),
        8 * 1024 * 1024
    );
    store
        .import_target_batch(ctx(ServicePurpose::Restore), &[boundary])
        .await
        .unwrap();
    observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    let mut cut = export(
        &store,
        &observer,
        ctx(ServicePurpose::Backup),
        Duration::from_secs(10),
    )
    .await;
    let scores = cut
        .page(TargetTable::AgentRetrievals, None, 200)
        .await
        .unwrap();
    assert_eq!(scores.records.len(), finite_scores.len());
    for (record, expected) in scores.records.iter().zip(finite_scores) {
        let decoded: TargetRecord =
            serde_json::from_slice(&serde_json::to_vec(record).unwrap()).unwrap();
        let TargetRecord::AgentRetrievals(row) = decoded else {
            unreachable!()
        };
        assert_eq!(
            row.top_score, expected,
            "finite score must survive both database and JSON"
        );
    }
    let page = cut.page(TargetTable::OauthClients, None, 1).await.unwrap();
    assert_eq!(
        serde_json::to_vec(&page.records[0]).unwrap().len(),
        8 * 1024 * 1024
    );
    cut.close().await.unwrap();
    observer
        .execute("UPDATE v1_storage_epoch SET state='migrating'")
        .await;

    let grant = TargetRecord::OauthGrants(OauthGrantsRow {
        grant_id: OAuthGrantId::from_bytes([1; 16]).to_string(),
        user_id: PrincipalId::from_bytes([1; 16]).to_string(),
        client_id: "client".into(),
        resource_uri: "https://example.test".into(),
        scope: "read".into(),
        selected_spaces: None,
        revoked_at: None,
        revision: 0,
        created_at: 0,
    });
    let family = TargetRecord::OauthRefreshFamilies(OauthRefreshFamiliesRow {
        family_id: OAuthFamilyId::from_bytes([1; 16]).to_string(),
        grant_id: OAuthGrantId::from_bytes([1; 16]).to_string(),
        revoked_at: None,
        reason_code: None,
        created_at: 0,
    });
    store
        .import_target_batch(
            ctx(ServicePurpose::Restore),
            &[
                grant,
                family,
                episode(2, None),
                episode(1, Some(2)),
                refresh(2, None),
                refresh(1, Some(2)),
            ],
        )
        .await
        .unwrap();
    observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    let mut cut = export(
        &store,
        &observer,
        ctx(ServicePurpose::Backup),
        Duration::from_secs(10),
    )
    .await;
    let mut pages = Vec::new();
    for table in [TargetTable::AgentEpisodes, TargetTable::OauthRefreshTokens] {
        let first = cut.page(table, None, 1).await.unwrap();
        assert!(first.continuation.is_some());
        let second = cut.page(table, first.continuation, 1).await.unwrap();
        assert!(second.continuation.is_none());
        pages.push(first.records);
        pages.push(second.records);
    }
    cut.close().await.unwrap();
    observer.execute("DELETE FROM agent_episodes").await;
    observer.execute("DELETE FROM oauth_refresh_tokens").await;
    observer
        .execute("UPDATE v1_storage_epoch SET state='migrating'")
        .await;
    let mut import = store
        .begin_target_import(ctx(ServicePurpose::Restore))
        .await
        .unwrap();
    // PK ordering emits both children before their parents, across page boundaries.
    for page in &pages {
        import.append(page).await.unwrap();
    }
    import.finish().await.unwrap();
    assert_eq!(
        observer.count("SELECT count(*) FROM agent_episodes").await,
        2
    );
    assert_eq!(
        observer
            .count("SELECT count(*) FROM oauth_refresh_tokens")
            .await,
        2
    );
    let mut import = store
        .begin_target_import(ctx(ServicePurpose::Restore))
        .await
        .unwrap();
    import
        .append(&[user(3), episode(3, Some(4))])
        .await
        .unwrap();
    assert!(
        import.finish().await.is_err(),
        "unresolved deferred references must abort"
    );
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
    assert_eq!(
        observer.count("SELECT count(*) FROM agent_episodes").await,
        2
    );

    // Cancellation while acquiring database authority must not publish a row.
    match &mut observer {
        Observer::Sqlite(_) => observer.execute("BEGIN IMMEDIATE").await,
        Observer::Postgres(_) => {
            observer.execute("BEGIN").await;
            observer
                .execute("UPDATE v1_storage_epoch SET state='migrating'")
                .await;
        }
    }
    let context = ctx(ServicePurpose::Restore);
    let cancellation = context.budget.cancellation.clone();
    let worker_store = store.clone();
    let worker =
        tokio::spawn(async move { worker_store.import_target_batch(context, &[user(4)]).await });
    tokio::time::sleep(Duration::from_millis(30)).await;
    cancellation.cancel();
    tokio::time::sleep(Duration::from_millis(10)).await;
    observer.execute("COMMIT").await;
    assert_eq!(worker.await.unwrap().unwrap_err().code(), "cancelled");
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);

    // An abandoned import also releases its transaction without finish/append.
    let context = ctx(ServicePurpose::Restore);
    let cancellation = context.budget.cancellation.clone();
    let mut import = store.begin_target_import(context).await.unwrap();
    import.append(&[user(5)]).await.unwrap();
    cancellation.cancel();
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
    observer.snapshot_released().await;
    drop(import);

    // Drop only an in-flight page future, keeping the import handle alive. A
    // later finish must never commit the prefix of the requested page.
    let mut import = store
        .begin_target_import(ctx(ServicePurpose::Restore))
        .await
        .unwrap();
    let records: Vec<_> = (10..210).map(user).collect();
    {
        let mut append = Box::pin(import.append(&records));
        std::future::poll_fn(|cx| {
            assert!(append.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
    }
    assert!(import.finish().await.is_err());
    assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);

    if matches!(observer, Observer::Postgres(_)) {
        // The first row finishes, the second blocks on an uncommitted unique
        // key, and the third is never dispatched. Cancelling append must roll
        // back both executed rows even after the blocker releases its lock.
        observer.execute("BEGIN").await;
        observer.execute("INSERT INTO users(user_id,username,display_name,created_at) VALUES('blocker','user11','blocker',0)").await;
        let mut import = store
            .begin_target_import(ctx(ServicePurpose::Restore))
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(50),
                import.append(&[user(10), user(11), user(12)])
            )
            .await
            .is_err()
        );
        observer.execute("ROLLBACK").await;
        assert!(import.finish().await.is_err());
        assert_eq!(observer.count("SELECT count(*) FROM users").await, 1);
    }

    observer
        .execute("UPDATE v1_storage_epoch SET state='ready'")
        .await;
    let mut cut = export(
        &store,
        &observer,
        ctx(ServicePurpose::Backup),
        Duration::from_secs(5),
    )
    .await;
    observer
        .execute("UPDATE users SET revision=revision+1")
        .await;
    {
        let mut page = Box::pin(cut.page(TargetTable::Users, None, 200));
        std::future::poll_fn(|cx| {
            assert!(page.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    observer.snapshot_released().await;
    assert!(cut.page(TargetTable::Users, None, 1).await.is_err());
    cut.close().await.unwrap();
    for cancel in [true, false] {
        let context = ctx(ServicePurpose::Backup);
        let cancellation = context.budget.cancellation.clone();
        let cut = export(
            &store,
            &observer,
            context,
            if cancel {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(30)
            },
        )
        .await;
        observer
            .execute("UPDATE users SET revision=revision+1")
            .await;
        if cancel {
            cancellation.cancel();
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        // Deliberately retain the handle and never call page or close first.
        observer.snapshot_released().await;
        let replacement = export(
            &store,
            &observer,
            ctx(ServicePurpose::Backup),
            Duration::from_secs(1),
        )
        .await;
        replacement.close().await.unwrap();
        cut.close().await.unwrap();
    }
    drop(observer);
    store.close().await;
}
#[tokio::test]
async fn sqlite_import_export_bounds_and_lifetimes() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = PathBuf::from(std::env::var_os("CARGO_TARGET_DIR").expect("use pinned runner"))
        .join(format!("control-tests/roundtrip-{unique}"));
    std::fs::create_dir_all(root.join("v1")).unwrap();
    let store = ControlStore::sqlite(&DataRoot::new(&root)).await.unwrap();
    let mut observer = sqlx::SqliteConnection::connect(&format!(
        "sqlite:{}",
        root.join("v1/control.sqlite").display()
    ))
    .await
    .unwrap();
    sqlx::query("PRAGMA busy_timeout=250")
        .execute(&mut observer)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut observer)
        .await
        .unwrap();
    verify(store, Observer::Sqlite(observer)).await;
    std::fs::remove_dir_all(root).unwrap();
}
#[tokio::test]
async fn postgres_import_export_bounds_and_lifetimes() {
    let descriptor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../.artifacts/control-db-fixture/active.json");
    let descriptor: serde_json::Value = serde_json::from_slice(
        &std::fs::read(descriptor).expect("PostgreSQL fixture required; run make test"),
    )
    .unwrap();
    let socket = PathBuf::from(descriptor["socket"].as_str().unwrap());
    let options = sqlx::postgres::PgConnectOptions::new()
        .socket(&socket)
        .username("postgres")
        .database("postgres");
    let mut admin = sqlx::PgConnection::connect_with(&options).await.unwrap();
    sqlx::query("CREATE DATABASE import_export_test")
        .execute(&mut admin)
        .await
        .unwrap();
    let store = ControlStore::postgres(PostgresConfig::unix_socket(
        socket,
        "import_export_test",
        "postgres",
    ))
    .await
    .unwrap();
    let mut observer = sqlx::PgConnection::connect_with(&options.database("import_export_test"))
        .await
        .unwrap();
    sqlx::query("SET search_path TO v1_control,pg_catalog")
        .execute(&mut observer)
        .await
        .unwrap();
    verify(store, Observer::Postgres(observer)).await;
    sqlx::query("DROP DATABASE import_export_test")
        .execute(&mut admin)
        .await
        .unwrap();
}

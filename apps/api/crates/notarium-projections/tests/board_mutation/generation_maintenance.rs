use std::time::Duration;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::ProjectionGeneration,
    ports::{DeleteDisposition, DeleteNote, PageLimit, StructuralReadPort},
    receipt::{AwaitWatermarks, CausalBasis},
};
use notarium_projections::{
    PostgresProjectionCache,
    derived::{GenerationControl, GenerationDescriptor},
};

use super::*;

fn incompatible(error: &PortError, expected: ValidationReason) -> bool {
    matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
        if diagnostic.reason == expected)
}

async fn prepare_abandoned_candidate(
    store: &DerivedStore,
    control: &GenerationControl,
    active: &GenerationDescriptor,
) -> SpaceId {
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes(random_bytes()),
        incarnation: HistoryIncarnation::from_bytes(random_bytes()),
    };
    store.register_scope(&scope).await.unwrap();
    let candidate = GenerationDescriptor {
        generation: store.generation(),
        publication_epoch: active.publication_epoch + 1,
        cut_fingerprint: active.cut_fingerprint,
    };
    assert!(
        control
            .reserve_candidate(Some(active), &candidate)
            .await
            .unwrap()
    );
    assert!(control.cancel_candidate(&candidate).await.unwrap());
    scope.space_id
}

async fn purge_offline(store: &CanonicalStore, owner: &SpaceContext, victim: &NoteId) {
    store
        .delete_note(
            owner.clone(),
            mutation(
                owner,
                DeleteNote {
                    note: victim.clone(),
                    disposition: DeleteDisposition::Purge,
                },
            ),
        )
        .await
        .unwrap();
    let inventory = store
        .read_projection_purge_fences_page(
            &projection_context(),
            owner.scope(),
            None,
            PageLimit::new(1).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        inventory.rows.first().map(|fence| &fence.note_id),
        Some(victim)
    );
}

#[tokio::test]
async fn sqlite_recovers_an_older_generation_and_keeps_held_files() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let config =
        CanonicalConfig::local_default(InstallationId::from_bytes(random_bytes()), root.clone());
    let (canonical, canonical_runtime) = CanonicalRuntime::open(config).await.unwrap();
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();
    let (scope, owner) = open_space(&canonical).await;
    let created = note(
        &canonical,
        &owner,
        "recovery-note",
        DocClass::UserDoc,
        "Recover from canonical".into(),
    )
    .await;
    let victim = note(
        &canonical,
        &owner,
        "purged-during-recovery",
        DocClass::UserDoc,
        "# Purged from the obsolete SQLite generation\n".into(),
    )
    .await;
    let start = || {
        ProjectorRuntime::start_sqlite(
            canonical.clone(),
            projection_context(),
            root.clone(),
            initial,
            ProjectionConfig::default(),
        )
    };
    let runtime = start().await.unwrap();
    sync(&canonical, &runtime, &scope).await;
    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let old = runtime
        .engine()
        .acquire_snapshot(owner.clone(), causal.clone())
        .await
        .unwrap();
    assert!(old.lookup(&victim.note).unwrap().is_some());
    runtime.shutdown().await.unwrap();
    purge_offline(&canonical, &owner, &victim.note).await;
    let head = canonical
        .read_space(&scope.space_id)
        .await
        .unwrap()
        .last_seq;

    let old_db = root.derived(initial);
    let contains_victim = |db: &rusqlite::Connection| -> bool {
        db.query_row(
            "SELECT EXISTS (SELECT 1 FROM projected_notes WHERE space_id = ? AND note_id = ?)",
            [scope.space_id.as_str(), victim.note.as_str()],
            |row| row.get(0),
        )
        .unwrap()
    };
    let control = GenerationControl::open_sqlite(&root).await.unwrap();
    let old_descriptor = control.active().await.unwrap().unwrap();
    {
        let db = rusqlite::Connection::open(&old_db).unwrap();
        assert!(
            !contains_victim(&db),
            "offline SQLite purge removes purged rows even after ProjectorRuntime stops"
        );
        db.execute("UPDATE derived_schema_meta SET schema_version = 999", [])
            .unwrap();
    }
    let error = start()
        .await
        .err()
        .expect("newer formats are left untouched");
    assert!(incompatible(&error, ValidationReason::GenerationMismatch));
    assert_eq!(
        control.active().await.unwrap(),
        Some(old_descriptor.clone())
    );
    assert!(!root.derived(next).exists());
    {
        let db = rusqlite::Connection::open(&old_db).unwrap();
        db.execute("UPDATE derived_schema_meta SET schema_version = 0", [])
            .unwrap();
    }
    let prepared = DerivedStore::open_sqlite(&root, next).await.unwrap();
    let abandoned = prepare_abandoned_candidate(&prepared, &control, &old_descriptor).await;
    let candidate_db = root.derived(next);
    let contains_abandoned = |db: &rusqlite::Connection| -> bool {
        db.query_row(
            "SELECT EXISTS (SELECT 1 FROM projection_space_guard WHERE space_id = ?)",
            [abandoned.as_str()],
            |row| row.get(0),
        )
        .unwrap()
    };
    {
        let db = rusqlite::Connection::open(&candidate_db).unwrap();
        db.execute("UPDATE derived_schema_meta SET schema_version = 999", [])
            .unwrap();
    }
    let error = start()
        .await
        .err()
        .expect("a newer unpublished candidate stays untouched");
    assert!(incompatible(&error, ValidationReason::GenerationMismatch));
    assert_eq!(
        control.active().await.unwrap(),
        Some(old_descriptor.clone())
    );
    {
        let db = rusqlite::Connection::open(&candidate_db).unwrap();
        let version: i64 = db
            .query_row(
                "SELECT schema_version FROM derived_schema_meta",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 999);
        db.execute("UPDATE derived_schema_meta SET schema_version = 0", [])
            .unwrap();
    }
    let error = start()
        .await
        .err()
        .expect("an opened store pins the obsolete candidate files");
    assert!(incompatible(&error, ValidationReason::NotReady));
    assert!(contains_abandoned(
        &rusqlite::Connection::open(&candidate_db).unwrap()
    ));
    drop(prepared);
    let runtime = start().await.unwrap();
    assert_eq!(control.active().await.unwrap().unwrap().generation, next);
    let current = runtime
        .engine()
        .acquire_snapshot(owner, causal)
        .await
        .unwrap();
    assert_eq!(current.cut().generation, next);
    assert_eq!(current.cut().projected_seq, head);
    assert!(current.lookup(&created.note).unwrap().is_some());
    assert!(current.lookup(&victim.note).unwrap().is_none());
    {
        let db = rusqlite::Connection::open(candidate_db).unwrap();
        assert!(!contains_victim(&db));
        assert!(!contains_abandoned(&db));
    }
    assert_eq!(old.cut().generation, initial);
    assert!(old.lookup(&created.note).unwrap().is_some());
    assert!(old.lookup(&victim.note).unwrap().is_none());
    assert!(old_db.exists(), "the held snapshot pins its old files");
    drop(old);
    tokio::time::timeout(Duration::from_secs(4), async {
        while old_db.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("obsolete files reclaimed after the held snapshot drops");
    drop(current);
    runtime.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_recovers_only_after_the_old_worker_releases_its_admission() {
    let fixture = PgFixture::required();
    let cache = Scratch::new();
    let other_cache = Scratch::new();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_recovery_{id}");
    let derived_schema = format!("test_recovery_{id}_d");
    let config = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: fixture.s3_blobs(&canonical_schema).await,
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    let (canonical, canonical_runtime) = CanonicalRuntime::open(config).await.unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();
    let (scope, owner) = open_space(&canonical).await;
    let created = note(
        &canonical,
        &owner,
        "recovery-note",
        DocClass::UserDoc,
        "Recover from canonical".into(),
    )
    .await;
    let local = PostgresProjectionCache::provision(cache.root())
        .await
        .unwrap();
    let other = PostgresProjectionCache::provision(other_cache.root())
        .await
        .unwrap();
    let runtime = ProjectorRuntime::start_postgres(
        canonical.clone(),
        projection_context(),
        pool.clone(),
        &derived_schema,
        local.clone(),
        initial,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&canonical, &runtime, &scope).await;
    let control = GenerationControl::open_postgres(pool.clone(), &derived_schema)
        .await
        .unwrap();
    let old = control.active().await.unwrap().unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "UPDATE {derived_schema}_g1.derived_schema_meta SET mmap_format_ver = 0"
    )))
    .execute(&pool)
    .await
    .unwrap();
    let error = ProjectorRuntime::start_postgres(
        canonical.clone(),
        projection_context(),
        pool.clone(),
        &derived_schema,
        other,
        initial,
        ProjectionConfig::default(),
    )
    .await
    .err()
    .expect("a second runtime on the same canonical owner is rejected");
    assert!(
        incompatible(&error, ValidationReason::DuplicateKey),
        "{error:?}"
    );
    assert_eq!(control.active().await.unwrap(), Some(old));
    assert!(control.candidate().await.unwrap().is_none());
    runtime.shutdown().await.unwrap();
    let runtime = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            match ProjectorRuntime::start_postgres(
                canonical.clone(),
                projection_context(),
                pool.clone(),
                &derived_schema,
                local.clone(),
                initial,
                ProjectionConfig::default(),
            )
            .await
            {
                Ok(runtime) => break runtime,
                Err(error) if incompatible(&error, ValidationReason::NotReady) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("recovery failed: {error:?}"),
            }
        }
    })
    .await
    .expect("PG recovery after old worker release");
    let snapshot = runtime
        .engine()
        .acquire_snapshot(owner, CausalBasis::Await(AwaitWatermarks::default()))
        .await
        .unwrap();
    assert_eq!(snapshot.cut().generation, next);
    assert!(snapshot.lookup(&created.note).unwrap().is_some());
    let old_schema = format!("{derived_schema}_g1");
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let exists: bool = sqlx::query_scalar("SELECT to_regnamespace($1) IS NOT NULL")
                .bind(&old_schema)
                .fetch_one(&pool)
                .await
                .unwrap();
            if !exists {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("obsolete PostgreSQL schema reclaimed");
    drop(snapshot);
    runtime.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{derived_schema}_g2"),
        format!("{derived_schema}_ctrl"),
    ] {
        let ddl = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[tokio::test]
async fn postgres_recovers_obsolete_format_and_resets_obsolete_candidate() {
    let fixture = PgFixture::required();
    let cache = Scratch::new();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_pg_recovery_{id}");
    let derived_schema = format!("test_pg_recovery_{id}_d");
    let config = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: fixture.s3_blobs(&canonical_schema).await,
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    let (store, canonical) = CanonicalRuntime::open(config).await.unwrap();
    let (scope_a, owner_a) = open_space(&store).await;
    let (scope_b, owner_b) = open_space(&store).await;
    let note_a = note(&store, &owner_a, "owner-a", DocClass::UserDoc, "A".into()).await;
    let note_b = note(&store, &owner_b, "owner-b", DocClass::UserDoc, "B".into()).await;
    let victim_b = note(
        &store,
        &owner_b,
        "purged-during-recovery",
        DocClass::UserDoc,
        "# Purged from the obsolete PostgreSQL generation\n".into(),
    )
    .await;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();

    let local = PostgresProjectionCache::provision(cache.root())
        .await
        .unwrap();
    let start = |canonical, pool, schema: String, cache| async move {
        ProjectorRuntime::start_postgres(
            canonical,
            projection_context(),
            pool,
            &schema,
            cache,
            initial,
            ProjectionConfig::default(),
        )
        .await
    };
    let runtime = start(
        store.clone(),
        pool.clone(),
        derived_schema.clone(),
        local.clone(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope_a).await;
    sync(&store, &runtime, &scope_b).await;

    let control = GenerationControl::open_postgres(pool.clone(), &derived_schema)
        .await
        .unwrap();
    let previous = control.active().await.unwrap().unwrap();
    let old_schema = format!("{derived_schema}_g1");
    let new_schema = format!("{derived_schema}_g2");
    let old_files_a = cache
        .root()
        .space_fast_index_dir(initial, &scope_a.space_id);
    let old_files_b = cache
        .root()
        .space_fast_index_dir(initial, &scope_b.space_id);
    assert!(old_files_a.is_dir());
    assert!(old_files_b.is_dir());
    runtime.shutdown().await.unwrap();

    purge_offline(&store, &owner_b, &victim_b.note).await;
    let obsolete = format!("UPDATE {old_schema}.derived_schema_meta SET mmap_format_ver = 0");
    let stamped = sqlx::query(sqlx::AssertSqlSafe(obsolete))
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(stamped.rows_affected(), 1);

    // An existing future-version candidate schema must be left untouched.
    let prepared = DerivedStore::open_postgres(pool.clone(), &derived_schema, next)
        .await
        .unwrap();
    let abandoned = prepare_abandoned_candidate(&prepared, &control, &previous).await;
    drop(prepared);
    let contains_abandoned = || async {
        let query = format!(
            "SELECT EXISTS (SELECT 1 FROM {new_schema}.projection_space_guard WHERE space_id = $1)"
        );
        sqlx::query_scalar::<_, bool>(sqlx::AssertSqlSafe(query))
            .bind(abandoned.as_str())
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let stamp_candidate =
        format!("UPDATE {new_schema}.derived_schema_meta SET schema_version = $1");
    sqlx::query(sqlx::AssertSqlSafe(stamp_candidate.as_str()))
        .bind(999_i64)
        .execute(&pool)
        .await
        .unwrap();
    let error = start(
        store.clone(),
        pool.clone(),
        derived_schema.clone(),
        local.clone(),
    )
    .await
    .err()
    .expect("a newer unpublished candidate stays untouched");
    assert!(incompatible(&error, ValidationReason::GenerationMismatch));
    assert_eq!(control.active().await.unwrap(), Some(previous.clone()));
    let version_query = format!("SELECT schema_version FROM {new_schema}.derived_schema_meta");
    let version: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(version_query))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(version, 999);
    assert!(control.candidate().await.unwrap().is_none());

    // An obsolete candidate schema is safely reset and rebuilt from canonical.
    sqlx::query(sqlx::AssertSqlSafe(stamp_candidate))
        .bind(0_i64)
        .execute(&pool)
        .await
        .unwrap();
    let mut barrier = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 251850))")
        .bind(&new_schema)
        .execute(&mut *barrier)
        .await
        .unwrap();
    let recovery = tokio::spawn(start(
        store.clone(),
        pool.clone(),
        derived_schema.clone(),
        local.clone(),
    ));
    let reservation = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Some(reservation) = control.candidate().await.unwrap() {
                break reservation;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the founder reserved the candidate before opening its schema");
    let other_cache = Scratch::new();
    let competing = tokio::time::timeout(
        Duration::from_secs(3),
        start(
            store.clone(),
            pool.clone(),
            derived_schema.clone(),
            PostgresProjectionCache::provision(other_cache.root())
                .await
                .unwrap(),
        ),
    )
    .await
    .expect("the second starter reports the active coordinator");
    let error = competing.err().expect("another founder owns recovery");
    assert!(incompatible(&error, ValidationReason::NotReady));
    assert_eq!(control.candidate().await.unwrap(), Some(reservation));
    assert_eq!(control.active().await.unwrap(), Some(previous.clone()));
    barrier.rollback().await.unwrap();
    let runtime = recovery
        .await
        .unwrap()
        .expect("the first founder completes recovery");
    let active = control.active().await.unwrap().unwrap();
    assert_eq!(active.generation, next);
    assert_eq!(active.publication_epoch, previous.publication_epoch + 1);
    assert!(control.candidate().await.unwrap().is_none());

    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let snapshot_a = runtime
        .engine()
        .acquire_snapshot(owner_a, causal.clone())
        .await
        .unwrap();
    let snapshot_b = runtime
        .engine()
        .acquire_snapshot(owner_b, causal)
        .await
        .unwrap();
    let head_a = store.read_space(&scope_a.space_id).await.unwrap().last_seq;
    let head_b = store.read_space(&scope_b.space_id).await.unwrap().last_seq;
    assert_eq!(snapshot_a.cut().generation, next);
    assert_eq!(snapshot_a.cut().projected_seq, head_a);
    assert_eq!(snapshot_b.cut().generation, next);
    assert_eq!(snapshot_b.cut().projected_seq, head_b);
    assert!(snapshot_a.lookup(&note_a.note).unwrap().is_some());
    assert!(snapshot_b.lookup(&note_b.note).unwrap().is_some());
    assert!(snapshot_b.lookup(&victim_b.note).unwrap().is_none());
    let victim_query = format!(
        "SELECT EXISTS (SELECT 1 FROM {new_schema}.projected_notes WHERE space_id = $1 AND note_id = $2)"
    );
    let victim_exists: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(victim_query))
        .bind(scope_b.space_id.as_str())
        .bind(victim_b.note.as_str())
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(!victim_exists);
    assert!(!contains_abandoned().await);
    assert!(
        find_checkpoint_file(&cache.root(), next, &scope_a.space_id, head_a)
            .is_some_and(|path| path.is_file())
    );
    assert!(
        find_checkpoint_file(&cache.root(), next, &scope_b.space_id, head_b)
            .is_some_and(|path| path.is_file())
    );
    drop((snapshot_a, snapshot_b));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let old_schema_exists: bool =
                sqlx::query_scalar("SELECT to_regnamespace($1) IS NOT NULL")
                    .bind(&old_schema)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            if !old_schema_exists && !old_files_a.exists() && !old_files_b.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("maintenance reclaims the obsolete schema and local files");
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        old_schema,
        new_schema,
        format!("{derived_schema}_ctrl"),
    ] {
        let ddl = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

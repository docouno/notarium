use std::time::Duration;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ids::ProjectionGeneration,
    ports::{DeleteDisposition, DeleteNote, PageLimit, StructuralReadPort},
    receipt::{AwaitWatermarks, CausalBasis},
};
use notarium_projections::derived::{GenerationControl, GenerationDescriptor};

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
    assert!(old.lookup(&victim.note).is_some());
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
            contains_victim(&db),
            "offline purge left the old cache untouched"
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
    assert!(current.lookup(&created.note).is_some());
    assert!(current.lookup(&victim.note).is_none());
    {
        let db = rusqlite::Connection::open(candidate_db).unwrap();
        assert!(!contains_victim(&db));
        assert!(!contains_abandoned(&db));
    }
    assert_eq!(old.cut().generation, initial);
    assert!(old.lookup(&created.note).is_some());
    assert!(old.lookup(&victim.note).is_none());
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
    let blobs = Scratch::new();
    let cache = Scratch::new();
    let other_cache = Scratch::new();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_recovery_{id}");
    let derived_schema = format!("test_recovery_{id}_d");
    let config = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: blobs.root(),
        },
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
    let runtime = ProjectorRuntime::start_postgres(
        canonical.clone(),
        projection_context(),
        pool.clone(),
        &derived_schema,
        cache.root(),
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
        other_cache.root(),
        initial,
        ProjectionConfig::default(),
    )
    .await
    .err()
    .expect("an idle old worker still has admission");
    assert!(
        incompatible(&error, ValidationReason::NotReady),
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
                cache.root(),
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
    assert!(snapshot.lookup(&created.note).is_some());
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
async fn postgres_recovers_obsolete_format_across_split_owners() {
    let fixture = PgFixture::required();
    let blobs_a = Scratch::new();
    let blobs_b = Scratch::new();
    let cache_a = Scratch::new();
    let cache_b = Scratch::new();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_split_recovery_{id}");
    let derived_schema = format!("test_split_recovery_{id}_d");
    let config = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: blobs_a.root(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    let (a, canonical_a) = CanonicalRuntime::open(config.clone()).await.unwrap();
    let (b, canonical_b) = CanonicalRuntime::open(CanonicalConfig {
        blobs: BlobBackendConfig::Local {
            data_root: blobs_b.root(),
        },
        ..config
    })
    .await
    .unwrap();
    let (scope_a, owner_a) = open_space(&a).await;
    let (scope_b, owner_b) = open_space(&b).await;
    let note_a = note(&a, &owner_a, "owner-a", DocClass::UserDoc, "A".into()).await;
    let note_b = note(&b, &owner_b, "owner-b", DocClass::UserDoc, "B".into()).await;
    let victim_b = note(
        &b,
        &owner_b,
        "purged-during-recovery",
        DocClass::UserDoc,
        "# Purged from the obsolete PostgreSQL generation\n".into(),
    )
    .await;
    let pool_a = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let pool_b = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();

    let start = |canonical, pool, schema: String, cache_root| async move {
        ProjectorRuntime::start_postgres(
            canonical,
            projection_context(),
            pool,
            &schema,
            cache_root,
            initial,
            ProjectionConfig::default(),
        )
        .await
    };
    let runtime_a = start(
        a.clone(),
        pool_a.clone(),
        derived_schema.clone(),
        cache_a.root(),
    )
    .await
    .unwrap();
    let runtime_b = start(
        b.clone(),
        pool_b.clone(),
        derived_schema.clone(),
        cache_b.root(),
    )
    .await
    .unwrap();
    sync(&a, &runtime_a, &scope_a).await;
    sync(&b, &runtime_b, &scope_b).await;
    assert!(a.live_visibility_fence().space(&scope_b).is_err());
    assert!(b.live_visibility_fence().space(&scope_a).is_err());

    let control = GenerationControl::open_postgres(pool_a.clone(), &derived_schema)
        .await
        .unwrap();
    let previous = control.active().await.unwrap().unwrap();
    let old_schema = format!("{derived_schema}_g1");
    let new_schema = format!("{derived_schema}_g2");
    let old_files_a = cache_a
        .root()
        .space_fast_index_dir(initial, &scope_a.space_id);
    let old_files_b = cache_b
        .root()
        .space_fast_index_dir(initial, &scope_b.space_id);
    assert!(old_files_a.is_dir());
    assert!(old_files_b.is_dir());
    tokio::try_join!(runtime_a.shutdown(), runtime_b.shutdown()).unwrap();
    let drained = format!(
        "SELECT NOT EXISTS (
        SELECT 1 FROM {derived_schema}_ctrl.projection_generation_read_leases WHERE generation = 1
    )"
    );
    tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let idle: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(drained.as_str()))
                .fetch_one(&pool_a)
                .await
                .unwrap();
            if idle {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both obsolete worker admissions drain");
    purge_offline(&b, &owner_b, &victim_b.note).await;
    let obsolete = format!("UPDATE {old_schema}.derived_schema_meta SET mmap_format_ver = 0");
    let stamped = sqlx::query(sqlx::AssertSqlSafe(obsolete))
        .execute(&pool_a)
        .await
        .unwrap();
    assert_eq!(stamped.rows_affected(), 1);

    let prepared = DerivedStore::open_postgres(pool_a.clone(), &derived_schema, next)
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
            .fetch_one(&pool_b)
            .await
            .unwrap()
    };
    let stamp_candidate =
        format!("UPDATE {new_schema}.derived_schema_meta SET schema_version = $1");
    sqlx::query(sqlx::AssertSqlSafe(stamp_candidate.as_str()))
        .bind(999_i64)
        .execute(&pool_a)
        .await
        .unwrap();
    let error = start(
        a.clone(),
        pool_a.clone(),
        derived_schema.clone(),
        cache_a.root(),
    )
    .await
    .err()
    .expect("a newer unpublished candidate stays untouched");
    assert!(incompatible(&error, ValidationReason::GenerationMismatch));
    assert_eq!(control.active().await.unwrap(), Some(previous.clone()));
    let version_query = format!("SELECT schema_version FROM {new_schema}.derived_schema_meta");
    let version: i64 = sqlx::query_scalar(sqlx::AssertSqlSafe(version_query))
        .fetch_one(&pool_a)
        .await
        .unwrap();
    assert_eq!(version, 999);
    sqlx::query(sqlx::AssertSqlSafe(stamp_candidate))
        .bind(0_i64)
        .execute(&pool_a)
        .await
        .unwrap();
    let lease_table = format!("{derived_schema}_ctrl.projection_generation_read_leases");
    let lease_id = random_bytes();
    let admit = format!(
        "INSERT INTO {lease_table} (generation, lease_id, participant) VALUES (2, $1, 'old-candidate')"
    );
    sqlx::query(sqlx::AssertSqlSafe(admit))
        .bind(lease_id.as_slice())
        .execute(&pool_a)
        .await
        .unwrap();
    let error = start(
        a.clone(),
        pool_a.clone(),
        derived_schema.clone(),
        cache_a.root(),
    )
    .await
    .err()
    .expect("a durable worker admission pins the obsolete candidate");
    assert!(incompatible(&error, ValidationReason::NotReady));
    assert!(contains_abandoned().await);
    let release = format!("DELETE FROM {lease_table} WHERE generation = 2 AND lease_id = $1");
    sqlx::query(sqlx::AssertSqlSafe(release))
        .bind(lease_id.as_slice())
        .execute(&pool_a)
        .await
        .unwrap();

    let founder_a = tokio::spawn(start(
        a.clone(),
        pool_a.clone(),
        derived_schema.clone(),
        cache_a.root(),
    ));
    let initial_head_a = a.read_space(&scope_a.space_id).await.unwrap().last_seq;
    let attempt = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            assert!(!founder_a.is_finished(), "A must wait for B");
            if let Some(attempt) = control.peer_candidate().await.unwrap() {
                let ready = control.peer_readiness(&attempt).await.unwrap();
                if let Some(witness) = ready.get(&scope_a.space_id) {
                    assert_eq!(witness.scope, scope_a);
                    assert_eq!(witness.through, initial_head_a);
                    assert_eq!(ready.len(), 1);
                    break attempt;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("A publishes only its own recovery witness");
    assert_eq!(control.active().await.unwrap(), Some(previous.clone()));
    assert_eq!(attempt.descriptor.generation, next);
    let old_admission = control
        .admit_generation_read(initial, "late-old-reader")
        .await
        .err()
        .expect("the recovery reservation closes old admission");
    assert!(incompatible(&old_admission, ValidationReason::NotReady));
    assert!(
        cache_a
            .root()
            .space_fast_index(next, &scope_a.space_id, initial_head_a)
            .is_file()
    );
    assert!(
        !cache_a
            .root()
            .space_fast_index_dir(next, &scope_b.space_id)
            .exists()
    );
    assert!(!founder_a.is_finished());
    let advanced = note(
        &a,
        &owner_a,
        "after-readiness",
        DocClass::UserDoc,
        "Current A".into(),
    )
    .await;

    let founder_b = start(
        b.clone(),
        pool_b.clone(),
        derived_schema.clone(),
        cache_b.root(),
    );
    let (runtime_a, runtime_b) = tokio::time::timeout(Duration::from_secs(8), async {
        tokio::join!(founder_a, founder_b)
    })
    .await
    .expect("both founders observe distributed recovery");
    let runtime_a = runtime_a.unwrap().unwrap();
    let runtime_b = runtime_b.unwrap();
    let active = control.active().await.unwrap().unwrap();
    assert_eq!(active.generation, next);
    assert_eq!(active.publication_epoch, previous.publication_epoch + 1);
    assert!(control.candidate().await.unwrap().is_none());
    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let snapshot_a = runtime_a
        .engine()
        .acquire_snapshot(owner_a, causal.clone())
        .await
        .unwrap();
    let snapshot_b = runtime_b
        .engine()
        .acquire_snapshot(owner_b, causal)
        .await
        .unwrap();
    let head_a = a.read_space(&scope_a.space_id).await.unwrap().last_seq;
    let head_b = b.read_space(&scope_b.space_id).await.unwrap().last_seq;
    assert_eq!(snapshot_a.cut().generation, next);
    assert_eq!(snapshot_a.cut().projected_seq, head_a);
    assert_eq!(snapshot_b.cut().generation, next);
    assert_eq!(snapshot_b.cut().projected_seq, head_b);
    assert!(snapshot_a.lookup(&note_a.note).is_some());
    assert!(snapshot_a.lookup(&advanced.note).is_some());
    assert!(snapshot_b.lookup(&note_b.note).is_some());
    assert!(snapshot_b.lookup(&victim_b.note).is_none());
    let victim_query = format!(
        "SELECT EXISTS (SELECT 1 FROM {new_schema}.projected_notes WHERE space_id = $1 AND note_id = $2)"
    );
    let victim_exists: bool = sqlx::query_scalar(sqlx::AssertSqlSafe(victim_query))
        .bind(scope_b.space_id.as_str())
        .bind(victim_b.note.as_str())
        .fetch_one(&pool_b)
        .await
        .unwrap();
    assert!(!victim_exists);
    assert!(!contains_abandoned().await);
    assert!(
        cache_a
            .root()
            .space_fast_index(next, &scope_a.space_id, head_a)
            .is_file()
    );
    assert!(
        cache_b
            .root()
            .space_fast_index(next, &scope_b.space_id, head_b)
            .is_file()
    );
    drop((snapshot_a, snapshot_b));
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let old_schema_exists: bool =
                sqlx::query_scalar("SELECT to_regnamespace($1) IS NOT NULL")
                    .bind(&old_schema)
                    .fetch_one(&pool_a)
                    .await
                    .unwrap();
            if !old_schema_exists && !old_files_a.exists() && !old_files_b.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both founders reclaim the obsolete schema and their local files");
    tokio::try_join!(runtime_a.shutdown(), runtime_b.shutdown()).unwrap();
    canonical_b.shutdown().await.unwrap();
    canonical_a.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        old_schema,
        new_schema,
        format!("{derived_schema}_ctrl"),
    ] {
        let ddl = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&pool_a)
            .await
            .unwrap();
    }
    pool_b.close().await;
    pool_a.close().await;
}

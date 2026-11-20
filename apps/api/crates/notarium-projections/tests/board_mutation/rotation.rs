use notarium_core::{
    classes::DocClass,
    ids::{NoteId, ProjectionGeneration, SpaceSeq, ViewKey},
    ports::{
        ChatPort, DeleteDisposition, DeleteNote, EntityId, EventBusPort, MaintenanceContext,
        NoteWritePort, PageLimit, PortStream, RedactChatEntry, RenameNote, ServiceAuthority,
        ServicePurpose, SpaceContext, SpaceEvent, SpaceEventKind, StructuralReadPort,
        ViewGraphPort, ViewQuery, ViewRef,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::{AwaitWatermarks, CausalBasis, ChangeCursor},
};
use notarium_projections::PostgresProjectionCache;

use super::{
    CanonicalStore, DerivedStore, ProjectorRuntime, budget, mutation, note, open_space, sync,
};

#[tokio::test]
async fn quiet_space_releases_a_superseded_checkpoint_at_cursor_expiry() {
    use std::time::Duration;

    use notarium_core::{
        model::LifecycleMask,
        ports::{NoteQuery, NoteReadPort},
        query::{Direction, SortColumn, SortKey, SortSpec},
    };
    use notarium_projections::ProjectedNoteReadPort;

    use super::{
        CanonicalConfig, CanonicalRuntime, InstallationId, ProjectionConfig, Scratch,
        projection_context, random_bytes,
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(random_bytes()),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store).await;
    for slug in ["first", "second"] {
        note(&store, &owner, slug, DocClass::UserDoc, slug.into()).await;
    }
    let generation = ProjectionGeneration::new(1).unwrap();
    let runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_context(),
        root.clone(),
        generation,
        ProjectionConfig {
            retained_read_lifetime: Duration::from_secs(2),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    let engine = runtime.engine();
    let head = store.read_space(&scope.space_id).await.unwrap().last_seq;
    let path = engine
        .checkpoint_for_test(&scope, head)
        .await
        .unwrap()
        .path()
        .to_owned();
    let page = ProjectedNoteReadPort::new(engine.clone())
        .list_notes(
            owner.clone(),
            ReadRequest::Open {
                query: NoteQuery {
                    folder: None,
                    recursive: false,
                    classes: DocClass::all(),
                    lifecycle: LifecycleMask::Active,
                    filter: FieldFilterAstV1 {
                        version: 1,
                        predicate: Predicate::All(Vec::new()),
                    },
                    sort: SortSpec::new(vec![SortKey {
                        column: SortColumn::UpdatedAt,
                        direction: Direction::Desc,
                    }])
                    .unwrap(),
                    limit: PageLimit::new(1).unwrap(),
                },
                causal: CausalBasis::Await(AwaitWatermarks::default()),
            },
        )
        .await
        .unwrap();
    assert!(page.children.next.is_some());
    note(&store, &owner, "third", DocClass::UserDoc, "third".into()).await;
    let next = store.read_space(&scope.space_id).await.unwrap().last_seq;
    sync(&store, &runtime, &scope).await;
    engine.checkpoint_for_test(&scope, next).await.unwrap();
    assert!(path.is_file(), "the retained cursor pins its checkpoint");
    tokio::time::timeout(Duration::from_secs(6), async {
        while path.exists() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("expiry releases the old file without any new projection reads");
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn sqlite_promotes_lookup_before_reclaiming_the_old_checkpoint() {
    use std::time::Duration;

    use super::{
        CanonicalConfig, CanonicalRuntime, InstallationId, ProjectionConfig, Scratch,
        projection_context, random_bytes,
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (store, canonical) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(random_bytes()),
        root.clone(),
    ))
    .await
    .unwrap();
    let (scope, owner) = open_space(&store).await;
    let (delayed_scope, delayed_owner) = open_space(&store).await;
    let created = note(
        &store,
        &owner,
        "rotation-lookup",
        DocClass::UserDoc,
        "# Survives rotation".into(),
    )
    .await;
    let delayed = note(
        &store,
        &delayed_owner,
        "delayed-lookup",
        DocClass::UserDoc,
        "# Waits for its own gate".into(),
    )
    .await;
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();
    let mut runtime = ProjectorRuntime::start_sqlite(
        store.clone(),
        projection_context(),
        root.clone(),
        initial,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&store, &runtime, &scope).await;
    sync(&store, &runtime, &delayed_scope).await;
    let engine = runtime.engine();
    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let old = engine
        .acquire_snapshot(owner.clone(), causal.clone())
        .await
        .unwrap();
    assert!(old.lookup(&created.note).is_some());

    // A held reader permits the catalog seal but blocks lookup replacement
    // for this Space. Other Spaces can still finish serving the new cut.
    let delayed_permit = store
        .live_visibility_fence()
        .space(&delayed_scope)
        .unwrap()
        .try_read()
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), runtime.rotate(next, &budget()))
        .await
        .unwrap()
        .unwrap();
    let current = tokio::time::timeout(
        Duration::from_secs(2),
        engine.acquire_snapshot(owner.clone(), causal.clone()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(current.cut().generation, next);
    assert!(current.lookup(&created.note).is_some());
    assert!(old.lookup(&created.note).is_some());
    assert!(
        tokio::time::timeout(
            Duration::from_millis(50),
            engine.acquire_snapshot(delayed_owner.clone(), causal.clone()),
        )
        .await
        .is_err()
    );
    drop(current);

    let old_db = root.derived(initial);
    assert!(old_db.is_file());
    drop(old);
    assert!(old_db.is_file(), "the old lookup still pins its cache");
    drop(delayed_permit);
    let reopened = engine
        .acquire_snapshot(delayed_owner, causal.clone())
        .await
        .unwrap();
    assert_eq!(reopened.cut().generation, next);
    assert!(reopened.lookup(&delayed.note).is_some());
    drop(reopened);
    tokio::time::timeout(Duration::from_secs(5), async {
        while old_db.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();

    let current = engine
        .acquire_snapshot(owner.clone(), causal)
        .await
        .unwrap();
    assert_eq!(current.cut().generation, next);
    assert!(current.lookup(&created.note).is_some());
    assert!(engine.is_live_visible(&owner, &created.note).unwrap());
    drop(current);
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
}

#[tokio::test]
async fn postgres_single_owner_rotation() {
    use std::time::Duration;

    use super::{
        BlobBackendConfig, CanonicalConfig, CanonicalRuntime, InstallationId, PgFixture,
        PgPoolOptions, ProjectionConfig, Scratch, SqlBackendConfig, WriterConfig,
        default_postgres_backup_budget, projection_context, random_bytes,
    };

    let fixture = PgFixture::required();
    let blobs = Scratch::new();
    let cache = Scratch::new();
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_pg_rot_{id}");
    let derived_schema = format!("test_pg_rot_{id}_d");
    let cfg = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: blobs.root(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    let (store, canonical) = CanonicalRuntime::open(cfg).await.unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(fixture.pool_options())
        .await
        .unwrap();
    let initial = ProjectionGeneration::new(1).unwrap();
    let next = initial.checked_next().unwrap();
    let mut runtime = ProjectorRuntime::start_postgres(
        store.clone(),
        projection_context(),
        pool.clone(),
        &derived_schema,
        PostgresProjectionCache::provision(cache.root())
            .await
            .unwrap(),
        initial,
        ProjectionConfig {
            retained_read_lifetime: Duration::from_secs(3),
            ..ProjectionConfig::default()
        },
    )
    .await
    .unwrap();
    exercise(&store, &mut runtime, next).await;
    let old_schema = format!("{derived_schema}_g1");
    let old_files = cache.root().derived(initial).with_file_name("spaces");
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let old_exists: bool = sqlx::query_scalar("SELECT to_regnamespace($1) IS NOT NULL")
                .bind(&old_schema)
                .fetch_one(&pool)
                .await
                .unwrap();
            if !old_exists && !old_files.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("single-owner PostgreSQL rotation reclaims the retired schema and cache files");
    runtime.shutdown().await.unwrap();
    canonical.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{derived_schema}_g1"),
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
async fn postgres_split_owners_backlinks_and_detached_erasure() {
    use std::time::Duration;

    use super::{
        BlobBackendConfig, CanonicalConfig, CanonicalRuntime, InstallationId, PgFixture,
        PgPoolOptions, ProjectionConfig, Scratch, SqlBackendConfig, WriterConfig,
        default_postgres_backup_budget, projection_context, random_bytes,
    };

    let fixture = PgFixture::required();
    let blobs_a = Scratch::new();
    let blobs_b = Scratch::new();
    let cache_a = Scratch::new();
    let cache_b = Scratch::new();
    let open_cache_lock = |cache: &Scratch| {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(cache.root().root().join("v1/projection_checkpoint.lock"))
            .unwrap()
    };
    let id = hex::encode(&random_bytes()[..6]);
    let canonical_schema = format!("test_split_{id}");
    let derived_schema = format!("test_split_{id}_d");
    let cfg = CanonicalConfig {
        installation_id: InstallationId::from_bytes(random_bytes()),
        sql: SqlBackendConfig::postgres_default(fixture.canonical(), &canonical_schema),
        blobs: BlobBackendConfig::Local {
            data_root: blobs_a.root(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    };
    let (a, canonical_a) = CanonicalRuntime::open(cfg.clone()).await.unwrap();
    let (b, canonical_b) = CanonicalRuntime::open(CanonicalConfig {
        blobs: BlobBackendConfig::Local {
            data_root: blobs_b.root(),
        },
        ..cfg
    })
    .await
    .unwrap();
    let (scope_a, owner_a) = open_space(&a).await;
    let (scope_b, owner_b) = open_space(&b).await;
    let ca = note(
        &a,
        &owner_a,
        "first-owner",
        DocClass::UserDoc,
        "First".into(),
    )
    .await;
    let cb = note(
        &b,
        &owner_b,
        "second-owner",
        DocClass::UserDoc,
        "Second".into(),
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
    let local_a = PostgresProjectionCache::provision(cache_a.root())
        .await
        .unwrap();
    let runtime_a = ProjectorRuntime::start_postgres(
        a.clone(),
        projection_context(),
        pool_a.clone(),
        &derived_schema,
        local_a.clone(),
        initial,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let local_b = PostgresProjectionCache::provision(cache_b.root())
        .await
        .unwrap();
    assert_ne!(local_a.expected_id, local_b.expected_id);
    let runtime_b = ProjectorRuntime::start_postgres(
        b.clone(),
        projection_context(),
        pool_b.clone(),
        &derived_schema,
        local_b,
        initial,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    sync(&a, &runtime_a, &scope_a).await;
    sync(&b, &runtime_b, &scope_b).await;

    let live_a = a.live_visibility_fence().space(&scope_a).unwrap();
    let live_b = b.live_visibility_fence().space(&scope_b).unwrap();
    assert_ne!(
        live_a.try_read().unwrap().owner_witness().process(),
        live_b.try_read().unwrap().owner_witness().process(),
    );
    assert!(a.live_visibility_fence().space(&scope_b).is_err());
    assert!(b.live_visibility_fence().space(&scope_a).is_err());

    let (chat_writer, detached_redaction) =
        exercise_split_backlinks(&a, &runtime_a, &runtime_b, &owner_a, &owner_b, &cb.note).await;

    let engine_a = runtime_a.engine();
    let engine_b = runtime_b.engine();
    let causal = CausalBasis::Await(AwaitWatermarks::default());

    let serving = DerivedStore::open_postgres(pool_b.clone(), &derived_schema, initial)
        .await
        .unwrap();
    let limit = PageLimit::new(2).unwrap();
    let refs = serving
        .chat_ref_page(&scope_b, &cb.note, None, limit)
        .await
        .unwrap();
    assert_eq!(refs.len(), 1);
    assert_eq!(refs[0].entry_seq, detached_redaction.entry);
    let earlier = serving
        .watermarks(&scope_a.space_id)
        .await
        .unwrap()
        .unwrap()
        .snapshot_seq;
    let orphan_file = cache_a
        .root()
        .space_fast_index(initial, &scope_a.space_id, earlier);
    let orphan_bytes = std::fs::read(&orphan_file).unwrap();
    let _detached_victim = note(
        &a,
        &owner_a,
        "detached-cache-only",
        DocClass::UserDoc,
        format!("# Remains in local cache\n\n[[{}]]\n", ca.note),
    )
    .await;
    sync(&a, &runtime_a, &scope_a).await;
    let source_checkpoint = tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let current = serving
                .watermarks(&scope_a.space_id)
                .await
                .unwrap()
                .unwrap();
            if current.snapshot_seq > earlier && !orphan_file.exists() {
                break current;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the new checkpoint retires the earlier file");
    let held = engine_a
        .acquire_snapshot(owner_a.clone(), causal.clone())
        .await
        .unwrap();
    assert_eq!(held.cut().generation, initial);
    assert!(held.lookup(&ca.note).is_some());
    assert_eq!(held.cut().projected_seq, source_checkpoint.snapshot_seq);
    let source_file =
        cache_a
            .root()
            .space_fast_index(initial, &scope_a.space_id, source_checkpoint.snapshot_seq);
    assert!(source_file.is_file());

    let stopped = std::sync::Arc::downgrade(&engine_a);
    drop(engine_a);
    runtime_a.shutdown().await.unwrap();
    assert!(stopped.upgrade().is_none());
    // Recreate the old immutable bytes left by a process that stopped
    // before retiring its previous checkpoint. No local lease owns it.
    std::fs::write(&orphan_file, &orphan_bytes).unwrap();
    assert!(orphan_file.is_file());
    let peer = engine_b
        .acquire_snapshot(owner_b.clone(), causal.clone())
        .await
        .unwrap();
    assert_eq!(peer.cut().generation, initial);
    a.redact_chat_entry(
        chat_writer.clone(),
        mutation(&chat_writer, detached_redaction),
    )
    .await
    .unwrap();
    assert!(
        serving
            .chat_ref_page(&scope_b, &cb.note, None, limit)
            .await
            .unwrap()
            .is_empty()
    );
    let abandoned_in_serving_generation =
        source_file.with_file_name(".fast-index-abcdef0123456789abcdef0123456789.tmp");
    std::fs::copy(&source_file, &abandoned_in_serving_generation).unwrap();
    assert!(abandoned_in_serving_generation.is_file());
    a.delete_note(
        owner_a.clone(),
        mutation(
            &owner_a,
            DeleteNote {
                note: ca.note.clone(),
                disposition: DeleteDisposition::Purge,
            },
        ),
    )
    .await
    .unwrap();
    assert!(held.lookup(&ca.note).is_none());
    assert!(
        !abandoned_in_serving_generation.exists(),
        "detached purge scrubs a temporary checkpoint in the serving generation"
    );
    assert!(
        !orphan_file.exists(),
        "detached purge scrubs the orphan from an earlier cut in the serving generation"
    );
    assert!(
        serving
            .watermarks(&scope_a.space_id)
            .await
            .unwrap()
            .is_some()
    );
    #[cfg(unix)]
    assert!(
        !source_file.exists(),
        "on Unix, purge unlinks registered checkpoint files immediately even while a snapshot is held"
    );
    drop(held);
    tokio::time::timeout(Duration::from_secs(2), async {
        while source_file.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the detached purge removes the checkpoint file");
    assert!(
        matches!(
            open_cache_lock(&cache_a).try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ),
        "the detached canonical eraser holds the cache without a snapshot"
    );
    assert!(peer.lookup(&cb.note).is_some());

    let independent = open_cache_lock(&cache_b);
    drop(engine_b);
    runtime_b.shutdown().await.unwrap();
    canonical_b.shutdown().await.unwrap();
    drop(b);
    assert!(
        matches!(
            independent.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ),
        "the retained mmap holds the cache after both runtimes stop"
    );
    drop(peer);
    independent
        .try_lock()
        .expect("the last mmap releases the cache");
    drop(independent);
    canonical_a.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{derived_schema}_g1"),
        format!("{derived_schema}_ctrl"),
    ] {
        let ddl = format!("DROP SCHEMA IF EXISTS {schema} CASCADE");
        sqlx::query(sqlx::AssertSqlSafe(ddl))
            .execute(&pool_a)
            .await
            .unwrap();
    }
    pool_a.close().await;
    pool_b.close().await;
}

async fn wait_for_note_change(
    stream: &mut dyn PortStream<SpaceEvent>,
    seq: SpaceSeq,
    note: &NoteId,
) {
    loop {
        let event = stream.next().await.unwrap().unwrap();
        if event.seq == seq
            && matches!(&event.kind, SpaceEventKind::Changed(change)
                if matches!(&change.entity, EntityId::Note(id) if id == note))
        {
            return;
        }
    }
}

pub(super) async fn exercise(
    store: &CanonicalStore,
    runtime: &mut ProjectorRuntime,
    generation: ProjectionGeneration,
) {
    let (scope, owner) = open_space(store).await;
    let view_key = ViewKey::from_bytes([31; 16]);
    let view = note(
        store,
        &owner,
        "rotating-view",
        DocClass::UserDoc,
        format!(
            "```nota\nid: {view_key}\ntype: table\nfilter: {{exists: position}}\n\
             sort: [{{field: position, type: number, direction: asc}}]\n```\n"
        ),
    )
    .await;
    let first = note(
        store,
        &owner,
        "first",
        DocClass::UserDoc,
        "---\ntitle: First\nposition: 1\n---\n".into(),
    )
    .await;
    let second = note(
        store,
        &owner,
        "second",
        DocClass::UserDoc,
        "---\ntitle: Second before rotation\nposition: 2\n---\n".into(),
    )
    .await;
    note(
        store,
        &owner,
        "third",
        DocClass::UserDoc,
        "---\ntitle: Third\nposition: 3\n---\n".into(),
    )
    .await;
    sync(store, runtime, &scope).await;

    let engine = runtime.engine();
    let causal = CausalBasis::Await(AwaitWatermarks::default());
    let request = ViewQuery {
        view: ViewRef {
            note: view.note,
            key: view_key,
        },
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(Vec::new()),
        },
        sort: None,
        group_by: None,
        limit: PageLimit::new(1).unwrap(),
    };
    let old = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: request.clone(),
                causal: causal.clone(),
            },
        )
        .await
        .expect("open the retained view before rotation");
    assert_eq!(
        old.rows.items[0]
            .card
            .document
            .provenance()
            .reference()
            .note_id,
        first.note
    );
    let stale_token = old.rows.next.expect("retain an old generation cursor");
    let old_generation = ProjectionGeneration::new(1).unwrap();
    assert_eq!(stale_token.generation, old_generation);

    let mut rename = mutation(
        &owner,
        RenameNote {
            note: second.note.clone(),
            slug: "second-renamed".into(),
            title: Some("Second after rotation".into()),
        },
    );
    rename.preconditions.revision = Some(second.revision.clone());
    let renamed = store
        .rename_note(owner.clone(), rename)
        .await
        .expect("advance the live cut");
    sync(store, runtime, &scope).await;

    // A cursor opened before a write in the same generation cleanly reports
    // CursorStale once derived advances past its cut.
    assert!(matches!(
        engine
            .query_view(
                owner.clone(),
                ReadRequest::Continue {
                    cursor: stale_token
                },
            )
            .await,
        Err(notarium_core::error::PortError::Domain(
            notarium_core::DomainError::ValidationFailed { diagnostic }
        )) if diagnostic.reason == notarium_core::error::ValidationReason::CursorStale
    ));

    // A cursor opened at the final cut of generation 1 stays readable across
    // Blue-Green rotation while generation 1 remains pinned by ReadState.
    let at_handoff = engine
        .query_view(
            owner.clone(),
            ReadRequest::Open {
                query: request,
                causal: causal.clone(),
            },
        )
        .await
        .expect("open a view at the final cut before rotation");
    let token = at_handoff
        .rows
        .next
        .expect("retain a cursor at the rotation boundary");
    assert_eq!(token.generation, old_generation);

    let bus = engine.event_bus();
    let mut stream = bus
        .subscribe(
            owner.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: renamed.receipt.seq(),
            },
        )
        .await
        .expect("subscribe in the old generation");
    runtime
        .rotate(generation, &budget())
        .await
        .expect("activate a caught-up generation");
    let (tail_pause, tail_note, tail_seq) = {
        let mut pause = engine.pause_before_projection_for_test(&scope, 1).unwrap();
        let note = note(
            store,
            &owner,
            "first-change-after-rotation",
            DocClass::UserDoc,
            "A committed change above the activated projection cut".into(),
        )
        .await;
        let pending = tokio::time::timeout(std::time::Duration::from_secs(3), pause.reached())
            .await
            .expect("hold the first post-flip change before projection")
            .unwrap();
        assert!(pending.last_seq > renamed.receipt.seq());
        (pause, note.note, pending.last_seq)
    };
    let switched = tokio::time::timeout(std::time::Duration::from_secs(3), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(switched.kind, SpaceEventKind::ResyncRequired));
    assert_eq!(switched.seq, renamed.receipt.seq());
    {
        bus.publish(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::EventPublication),
                budget: budget(),
            },
            SpaceEvent {
                scope: scope.clone(),
                seq: tail_seq,
                kind: SpaceEventKind::ResyncRequired,
            },
        )
        .await
        .unwrap();
        let refresh = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let event = stream.next().await.unwrap().unwrap();
                assert!(
                    event.seq <= switched.seq,
                    "refresh crossed the admitted cut"
                );
                if matches!(event.kind, SpaceEventKind::ResyncRequired) {
                    break event;
                }
            }
        })
        .await
        .expect("an ahead notification refreshes only the admitted cut");
        assert_eq!(refresh.seq, switched.seq);
    }
    bus.publish(
        MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::EventPublication),
            budget: budget(),
        },
        SpaceEvent {
            scope: scope.clone(),
            seq: switched.seq,
            kind: SpaceEventKind::GraphSettled { generation },
        },
    )
    .await
    .unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let event = stream.next().await.unwrap().unwrap();
            if let SpaceEventKind::GraphSettled {
                generation: received,
            } = event.kind
            {
                assert_eq!(received, generation);
                break;
            }
        }
    })
    .await
    .expect("subscriber continues on the newly admitted generation");
    let new = engine
        .acquire_snapshot(owner.clone(), causal)
        .await
        .expect("open a current structural snapshot");
    assert_eq!(new.cut().generation, generation);
    assert_eq!(new.cut().projected_seq, renamed.receipt.seq());
    assert!(new.lookup(&second.note).is_some());

    let continued = engine
        .query_view(owner, ReadRequest::Continue { cursor: token })
        .await
        .expect("continue against the frozen final cut of the previous generation");
    assert_eq!(continued.effective_read, at_handoff.effective_read);
    assert_eq!(continued.rows.projected_seq, at_handoff.rows.projected_seq);
    let visible = &continued.rows.items[0].card;
    assert_eq!(
        visible.document.provenance().reference().note_id,
        second.note
    );
    assert_eq!(
        visible.document.provenance().revision(),
        &renamed.value.revision
    );
    assert_eq!(visible.title, "Second after rotation");
    assert_eq!(
        continued.rows.next.expect("one more old row").generation,
        old_generation
    );
    {
        drop(tail_pause);
        tokio::time::timeout(
            std::time::Duration::from_secs(3),
            wait_for_note_change(&mut *stream, tail_seq, &tail_note),
        )
        .await
        .expect("the first post-flip change is not skipped by a refresh");
    }
}

async fn exercise_split_backlinks(
    source: &CanonicalStore,
    source_runtime: &ProjectorRuntime,
    target_runtime: &ProjectorRuntime,
    source_owner: &SpaceContext,
    target_owner: &SpaceContext,
    target: &notarium_core::ids::NoteId,
) -> (SpaceContext, RedactChatEntry) {
    use std::sync::{Arc, RwLock};

    use notarium_canonical::ProjectionOwnerIdentity;
    use notarium_core::{
        DomainError,
        auth::{EngineAuthContext, SpaceGrant, SpaceRole, VerifiedHuman},
        error::{PortError, ValidationReason},
        ids::{ChatThreadId, GrantId, ThreadEntrySeq},
        model::{HistoryScope, NoteRef},
        ports::{AppendChat, ChatEntryKind, ChatInputBody, ChatThreadKind, CreateChat},
        receipt::ReceiptSet,
    };
    use notarium_projections::{BacklinkOwnerEndpoint, BacklinkOwnerResolver};

    use super::{projection_context, random_bytes};

    struct TestRoute {
        source: HistoryScope,
        endpoint: RwLock<Option<BacklinkOwnerEndpoint>>,
    }

    impl BacklinkOwnerResolver for TestRoute {
        fn resolve(&self, owner: &ProjectionOwnerIdentity) -> Option<BacklinkOwnerEndpoint> {
            if owner.scope() != &self.source {
                return None;
            }
            self.endpoint.read().unwrap().clone()
        }
    }

    let a = source_runtime.engine();
    let b = target_runtime.engine();
    let mut grants = source_owner.auth().spaces().clone();
    grants.insert(
        target_owner.scope().space_id.clone(),
        SpaceGrant {
            role: SpaceRole::Viewer,
            read_classes: DocClass::all(),
            write_classes: Default::default(),
            project_root: None,
        },
    );
    let auth = EngineAuthContext::for_human(
        VerifiedHuman::attest(
            source_owner.auth().principal().clone(),
            GrantId::from_bytes(random_bytes()),
            grants,
            false,
        )
        .with_human_management(true),
    );
    let writer = SpaceContext::new(auth.clone(), source_owner.scope().clone(), budget()).unwrap();
    let viewer = SpaceContext::new(auth, target_owner.scope().clone(), budget()).unwrap();
    let thread = ChatThreadId::from_bytes(random_bytes());
    source
        .create_chat(
            writer.clone(),
            mutation(
                &writer,
                CreateChat {
                    thread: thread.clone(),
                    kind: ChatThreadKind::Personal,
                    owner: source_owner.auth().principal().clone(),
                    project_folder: None,
                    title: "Cross-owner source".into(),
                },
            ),
        )
        .await
        .unwrap();
    let appended = source
        .append_chat(
            writer.clone(),
            mutation(
                &writer,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Referenced note".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: target_owner.scope().space_id.clone(),
                        note_id: target.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(source, source_runtime, source_owner.scope()).await;

    let latest = || CausalBasis::Await(AwaitWatermarks::default());
    let unavailable: PortError = DomainError::validation(ValidationReason::NotReady).into();
    assert_eq!(
        b.chat_backlinks(viewer.clone(), target, latest())
            .await
            .unwrap_err(),
        unavailable,
    );
    let without_source = b
        .chat_backlinks(target_owner.clone(), target, latest())
        .await
        .unwrap();
    assert!(without_source.links.is_empty() && without_source.next.is_none());

    let route = Arc::new(TestRoute {
        source: source_owner.scope().clone(),
        endpoint: RwLock::new(Some(b.backlink_owner_endpoint())),
    });
    b.set_backlink_owner_resolver(route.clone()).unwrap();
    assert_eq!(
        b.chat_backlinks(viewer.clone(), target, latest())
            .await
            .unwrap_err(),
        unavailable,
    );
    *route.endpoint.write().unwrap() = Some(a.backlink_owner_endpoint());

    let causal = CausalBasis::Exact(ReceiptSet::new([appended.receipt]).unwrap());
    let page = b
        .chat_backlinks(viewer.clone(), target, causal)
        .await
        .unwrap();
    assert_eq!(page.links.len(), 1);
    assert_eq!(page.links[0].thread.space, source_owner.scope().space_id);
    assert_eq!(page.links[0].thread.id, thread);
    assert_eq!(page.links[0].entry, appended.value.seq);
    assert_eq!(page.links[0].title, "Cross-owner source");
    assert!(page.next.is_none());

    {
        let mut pause = a
            .pause_before_projection_for_test(source_owner.scope(), 1)
            .unwrap();
        let next = source
            .append_chat(
                writer.clone(),
                mutation(
                    &writer,
                    AppendChat {
                        thread: thread.clone(),
                        parent: appended.value.seq,
                        kind: ChatEntryKind::Human,
                        body: ChatInputBody::Text("Follow-up without a reference".into()),
                        referenced_notes: Vec::new(),
                        tainted: false,
                    },
                ),
            )
            .await
            .unwrap();
        let held = tokio::time::timeout(std::time::Duration::from_secs(5), pause.reached())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(held.last_seq, next.receipt.seq());
        let causal = CausalBasis::Exact(ReceiptSet::new([next.receipt]).unwrap());
        let mut read = Box::pin(b.chat_backlinks(viewer.clone(), target, causal));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut read)
                .await
                .is_err()
        );
        drop(pause);
        let advanced = tokio::time::timeout(std::time::Duration::from_secs(5), read)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(advanced.links.len(), 1);
        assert_eq!(advanced.links[0].thread.id, thread);
        assert_eq!(advanced.links[0].thread.head, next.value.seq);
        assert_eq!(advanced.links[0].entry, appended.value.seq);
    }

    *route.endpoint.write().unwrap() = None;
    assert_eq!(
        b.chat_backlinks(viewer.clone(), target, latest())
            .await
            .unwrap_err(),
        unavailable,
    );
    *route.endpoint.write().unwrap() = Some(a.backlink_owner_endpoint());
    let head = source
        .read_projection_chat_head(&projection_context(), source_owner.scope(), None, &thread)
        .await
        .unwrap()
        .unwrap();
    source
        .redact_chat_entry(
            writer.clone(),
            mutation(
                &writer,
                RedactChatEntry {
                    thread: thread.clone(),
                    entry: appended.value.seq,
                    expected_thread_revision: head.thread.revision,
                },
            ),
        )
        .await
        .unwrap();
    let redacted = b.chat_backlinks(viewer, target, latest()).await.unwrap();
    assert!(redacted.links.is_empty() && redacted.next.is_none());

    let pending = source
        .append_chat(
            writer.clone(),
            mutation(
                &writer,
                AppendChat {
                    thread: thread.clone(),
                    parent: ThreadEntrySeq::ZERO,
                    kind: ChatEntryKind::Human,
                    body: ChatInputBody::Text("Referenced note from the stopped projector".into()),
                    referenced_notes: vec![NoteRef {
                        space_id: target_owner.scope().space_id.clone(),
                        note_id: target.clone(),
                    }],
                    tainted: false,
                },
            ),
        )
        .await
        .unwrap();
    sync(source, source_runtime, source_owner.scope()).await;
    let head = source
        .read_projection_chat_head(&projection_context(), source_owner.scope(), None, &thread)
        .await
        .unwrap()
        .unwrap();
    (
        writer,
        RedactChatEntry {
            thread,
            entry: pending.value.seq,
            expected_thread_revision: head.thread.revision,
        },
    )
}

mod link_invalidation;

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use notarium_canonical::{
    BlobBackendConfig, CanonicalConfig, CanonicalRuntime, CanonicalStore, CreateSpaceSpec,
    PgConnectConfig, PgTransport, SqlBackendConfig, WriterConfig,
    config::default_postgres_backup_budget,
};
use notarium_core::{
    DomainError,
    auth::{EngineAuthContext, SpaceGrant, SpaceKind, SpaceRole, VerifiedHuman},
    classes::DocClass,
    epoch::DataRoot,
    error::{PortError, ValidationReason},
    ids::*,
    model::HistoryScope,
    ports::{
        CallBudget, Cancellation, CommandSeqRange, Committed, CreateNote, DeleteDisposition,
        DeleteNote, MaintenanceContext, Mutation, NoteRevision, NoteWritePort, Preconditions,
        ServiceAuthority, ServicePurpose, SpaceContext, StructuralReadPort,
    },
    receipt::{CausalBasis, CommandIdentity},
};
use serde::Deserialize;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

use super::{ProjectionConfig, ProjectorRuntime, apply};
use crate::{
    derived::{DerivedStore, TrustedCheckpoint},
    index::FastIndexBuilder,
    mmap::{BaseIndexHandle, FORMAT_VERSION, IndexIdentity, platform_abi},
};

const GENERATION: u64 = 1;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let dir = tmp.join(format!(
            "notarium-checkpoint-orphan-{}",
            hex::encode(entropy())
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn root(&self) -> DataRoot {
        DataRoot::new(&self.0)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn entropy() -> [u8; 16] {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).unwrap();
    bytes
}

fn budget() -> CallBudget {
    CallBudget {
        request: RequestId::from_bytes(entropy()),
        remaining: Duration::from_secs(15),
        cancellation: Cancellation::default(),
    }
}

fn projection_context() -> MaintenanceContext {
    MaintenanceContext {
        authority: ServiceAuthority::admit(ServicePurpose::Projection),
        budget: budget(),
    }
}

async fn start(
    canonical: &CanonicalStore,
    derived: &DerivedStore,
    root: &DataRoot,
) -> ProjectorRuntime {
    ProjectorRuntime::start_for_test(
        canonical.clone(),
        projection_context(),
        derived.clone(),
        root.clone(),
        ProjectionConfig::default(),
    )
    .await
    .unwrap()
}

async fn owner(canonical: &CanonicalStore) -> SpaceContext {
    let owner = PrincipalId::from_bytes(entropy());
    let created = canonical
        .create_space(CreateSpaceSpec {
            space_id: SpaceId::from_bytes(entropy()),
            incarnation: HistoryIncarnation::from_bytes(entropy()),
            root_folder_id: FolderId::from_bytes(entropy()),
            slug: format!("checkpoint-{}", hex::encode(entropy())),
            kind: SpaceKind::Personal,
            owner: owner.clone(),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            initial_last_seq: SpaceSeq::ZERO,
            created_at: None,
        })
        .await
        .unwrap();
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        owner,
        GrantId::from_bytes(entropy()),
        [(
            created.scope.space_id.clone(),
            SpaceGrant {
                role: SpaceRole::Owner,
                project_root: None,
                read_classes: DocClass::all(),
                write_classes: DocClass::all(),
            },
        )]
        .into(),
        false,
    ));
    SpaceContext::new(auth, created.scope, budget()).unwrap()
}

async fn create(
    canonical: &CanonicalStore,
    ctx: &SpaceContext,
    slug: &str,
    carrier: String,
) -> Committed<NoteRevision> {
    create_with_id(canonical, ctx, NoteId::from_bytes(entropy()), slug, carrier).await
}

async fn create_with_id(
    canonical: &CanonicalStore,
    ctx: &SpaceContext,
    note: NoteId,
    slug: &str,
    carrier: String,
) -> Committed<NoteRevision> {
    canonical
        .create_note(
            ctx.clone(),
            Mutation {
                identity: command_identity(ctx),
                preconditions: Preconditions::default(),
                input: CreateNote {
                    note,
                    parent: None,
                    slug: slug.to_owned(),
                    class: DocClass::UserDoc,
                    carrier,
                },
            },
        )
        .await
        .unwrap()
}

fn command_identity(ctx: &SpaceContext) -> CommandIdentity {
    CommandIdentity {
        scope: ctx.scope().clone(),
        actor: ctx.auth().principal().clone(),
        key: CommandKey::from_bytes(entropy()),
        hash: ContentDigest::from_bytes(*blake3::hash(&entropy()).as_bytes()),
    }
}

#[tokio::test]
async fn cluster_lens_survives_forced_compaction_and_generation_rotation() {
    use std::{collections::BTreeSet, sync::Arc};

    use notarium_core::{
        ports::{GraphNodeId, GraphQuery, GraphTier, ViewGraphPort},
        query::{FieldFilterAstV1, Predicate},
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, canonical_runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let ctx = owner(&canonical).await;
    let scope = ctx.scope();
    let generation = ProjectionGeneration::new(GENERATION).unwrap();
    let derived = DerivedStore::open_sqlite(&root, generation).await.unwrap();
    let [a, b, c, d] = [1, 2, 3, 4].map(|value| NoteId::from_bytes([value; 16]));
    create_with_id(&canonical, &ctx, b.clone(), "b", format!("[[{c}]]")).await;
    create_with_id(&canonical, &ctx, c.clone(), "c", "C".into()).await;
    let isolated = create_with_id(&canonical, &ctx, d.clone(), "d", "D".into()).await;
    let stop = Cancellation::default();
    let (stable, isolated_id, latest) = {
        let runtime = start(&canonical, &derived, &root).await;
        let engine = runtime.engine();
        engine
            .wait_for_projected(scope, isolated.receipt.seq(), &budget())
            .await
            .unwrap();
        let previous = engine.published_cut(scope).unwrap();
        let index = engine.open_index(&previous).unwrap();
        let cluster = |id: &NoteId| index.cluster(index.dense_id(id).unwrap()).unwrap();
        let stable = cluster(&b);
        assert_eq!(cluster(&c), stable);
        let isolated_id = cluster(&d);
        assert_ne!(isolated_id, stable);
        runtime.shutdown().await.unwrap();

        // Install the adjacency first, then settle at the same sequence. Only
        // the durable memberships and settlement overlay know A joined B and C.
        let added =
            create_with_id(&canonical, &ctx, a.clone(), "a", format!("[[{b}]] [[{c}]]")).await;
        let q = added.receipt.seq();
        let command = apply::command(
            &engine,
            &previous,
            CommandSeqRange::new(q, q).unwrap(),
            &stop,
        )
        .await
        .unwrap();
        let compacted = apply::checkpoint(&engine, &command.cut, false, &stop)
            .await
            .unwrap();
        let index = engine.open_index(&compacted).unwrap();
        let a_dense = index.dense_id(&a).unwrap();
        assert_eq!(index.cluster(a_dense), None);
        let mut settled = apply::checkpoint(&engine, &compacted, true, &stop)
            .await
            .unwrap();
        assert_eq!(
            engine.open_index(&settled).unwrap().cluster(a_dense),
            Some(stable.clone())
        );

        // Count an empty CSR row's reserved capacity against L0. The next
        // ordinary command must discard that delta and checkpoint immediately.
        let delta = &mut Arc::get_mut(&mut settled).unwrap().delta;
        Arc::make_mut(delta).replace_adjacency(
            index.dense_id(&d).unwrap(),
            Some(Vec::with_capacity(
                crate::index::L0_BYTE_LIMIT / size_of::<u32>(),
            )),
            None,
        );
        let added = create(&canonical, &ctx, "e", "E".into()).await;
        let r = added.receipt.seq();
        let forced = apply::command(
            &engine,
            &settled,
            CommandSeqRange::new(r, r).unwrap(),
            &stop,
        )
        .await
        .unwrap();
        assert_eq!(forced.cut.watermark.snapshot_seq, r);
        assert_eq!(forced.cut.watermark.graph_settled_seq, q);
        assert_eq!(
            engine.open_index(&forced.cut).unwrap().cluster(a_dense),
            Some(stable.clone())
        );
        (stable, isolated_id, r)
    };

    // The candidate seeds in NoteId order, so A is now the first dense slot.
    let mut runtime = start(&canonical, &derived, &root).await;
    let engine = runtime.engine();
    engine
        .wait_for_projected(scope, latest, &budget())
        .await
        .unwrap();
    runtime
        .rotate(generation.checked_next().unwrap(), &budget())
        .await
        .unwrap();
    engine
        .wait_for_projected(scope, latest, &budget())
        .await
        .unwrap();
    let lenses = [(stable, vec![a, b, c]), (isolated_id, vec![d])];
    let check_lenses = async |engine: &super::ProjectionEngine| {
        for (id, expected) in &lenses {
            let result = engine
                .query_graph(
                    ctx.clone(),
                    GraphQuery {
                        tier: GraphTier::Lens {
                            cluster: Some(id.clone()),
                            project: None,
                            tags: Vec::new(),
                        },
                        filter: FieldFilterAstV1 {
                            version: 1,
                            predicate: Predicate::All(Vec::new()),
                        },
                    },
                )
                .await
                .unwrap();
            assert_eq!(
                result
                    .nodes
                    .into_iter()
                    .map(|node| node.id)
                    .collect::<BTreeSet<_>>(),
                expected.iter().cloned().map(GraphNodeId::Note).collect(),
            );
        }
    };
    check_lenses(&engine).await;
    runtime.shutdown().await.unwrap();
    drop(engine);
    let reopened = ProjectorRuntime::start_sqlite(
        canonical.clone(),
        projection_context(),
        root.clone(),
        generation,
        ProjectionConfig::default(),
    )
    .await
    .unwrap();
    let engine = reopened.engine();
    engine
        .wait_for_projected(scope, latest, &budget())
        .await
        .unwrap();
    check_lenses(&engine).await;
    reopened.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
}

#[derive(Clone, Copy)]
enum Orphan {
    Unregistered,
    Registered,
    PreviousHistory,
    DamagedHeader,
}

const ORPHANS: [Orphan; 4] = [
    Orphan::Unregistered,
    Orphan::Registered,
    Orphan::PreviousHistory,
    Orphan::DamagedHeader,
];

async fn exercise(
    canonical: &CanonicalStore,
    derived: &DerivedStore,
    root: &DataRoot,
    orphan: Orphan,
) {
    let ctx = owner(canonical).await;
    let scope = ctx.scope();
    let first = create(canonical, &ctx, "first", "# First\n".into()).await;
    let p = first.receipt.seq();
    let generation = derived.generation();
    let path_p = root.space_fast_index(generation, &scope.space_id, p);

    let original = start(canonical, derived, root).await;
    let engine = original.engine();
    engine
        .wait_for_projected(scope, p, &budget())
        .await
        .unwrap();
    let retained = engine
        .acquire_snapshot(ctx.clone(), CausalBasis::Await(Default::default()))
        .await
        .unwrap();
    assert!(retained.lookup(&first.value.note).is_some());
    let published = engine.published_cut(scope).unwrap();
    assert_eq!(published.watermark.snapshot_seq, p);
    original.shutdown().await.unwrap();

    // Commit the usual command and drive the production apply path after the
    // old worker stops, so the following on-disk crash state is deterministic.
    let second = create(
        canonical,
        &ctx,
        "second",
        format!("# Second\n\n[[{}]]\n", first.value.note),
    )
    .await;
    let q = second.receipt.seq();
    let applied = apply::command(
        &engine,
        &published,
        CommandSeqRange::new(q, q).unwrap(),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    assert_eq!(applied.cut.watermark.snapshot_seq, p);
    assert_eq!(applied.cut.watermark.projected_seq, q);
    let tail = derived
        .replay_page(&applied.cut.watermark, p)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(tail.len(), 1);
    assert_eq!((tail[0].after, tail[0].through), (p, q));

    // The writer has placed Q at its immutable name but never committed the
    // snapshot watermark. The wrong contents distinguish rebuilding from
    // installing an uncommitted file simply because its digest is known.
    let path_q = root.space_fast_index(generation, &scope.space_id, q);
    let mut file_scope = scope.clone();
    if matches!(orphan, Orphan::PreviousHistory) {
        file_scope.incarnation = HistoryIncarnation::from_bytes(entropy());
    }
    let (handle, trust) = FastIndexBuilder::default()
        .publish(
            &path_q,
            IndexIdentity {
                generation,
                scope: file_scope,
                seq: q,
            },
        )
        .unwrap();
    let cache = engine.cache_identity.clone();
    if matches!(orphan, Orphan::Registered) {
        derived
            .register_checkpoint(&TrustedCheckpoint {
                space_id: scope.space_id.clone(),
                history_incarnation: scope.incarnation,
                seq: q,
                format_version: u32::from(FORMAT_VERSION),
                platform_abi: trust.abi,
                publication_id: cache.clone(),
                size_bytes: trust.size,
                digest: ContentDigest::from_bytes(trust.digest),
                graph_seq: q,
            })
            .await
            .unwrap();
    }
    let wrong_digest = trust.digest;
    if matches!(orphan, Orphan::PreviousHistory) {
        handle.register_for_erasure(&engine.pool);
        assert!(
            !BaseIndexHandle::discard_unpublished_name(&path_q, q).unwrap(),
            "a live vnode from another history must retain its name"
        );
    }
    drop(handle);
    if matches!(orphan, Orphan::DamagedHeader) {
        BaseIndexHandle::discard_unleased(&path_q).unwrap();
        std::fs::write(&path_q, b"interrupted checkpoint header").unwrap();
    }
    drop(applied);
    drop(published);
    drop(engine);

    let restarted = start(canonical, derived, root).await;
    let engine = restarted.engine();
    tokio::time::timeout(Duration::from_secs(12), async {
        loop {
            let row = derived.watermarks(&scope.space_id).await.unwrap().unwrap();
            if row.snapshot_seq == q
                && row.graph_settled_seq == q
                && engine
                    .published_cut(scope)
                    .is_ok_and(|cut| cut.base.identity().seq == q)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("quiet checkpoint Q must be installed without another write");
    let registered = derived
        .trusted_checkpoint(scope, q, u32::from(FORMAT_VERSION), &platform_abi(), &cache)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(registered.digest.as_bytes(), &wrong_digest);
    assert_eq!(registered.graph_seq, q);
    assert_eq!(
        canonical
            .read_space(&scope.space_id)
            .await
            .unwrap()
            .last_seq,
        q
    );

    let snapshot = engine
        .acquire_snapshot(ctx.clone(), CausalBasis::Await(Default::default()))
        .await
        .unwrap();
    let source = snapshot.lookup(&second.value.note).unwrap();
    let target = snapshot.lookup(&first.value.note).unwrap();
    assert_eq!(
        snapshot.outgoing(source).unwrap().collect::<Vec<_>>(),
        [target]
    );
    assert_eq!(
        snapshot.incoming(target).unwrap().collect::<Vec<_>>(),
        [source]
    );
    assert!(path_p.is_file());
    let crash_image =
        matches!(orphan, Orphan::Unregistered).then(|| std::fs::read(&path_p).unwrap());
    drop(retained);
    assert!(
        !path_p.exists(),
        "the last old runtime lease must reclaim P"
    );
    assert!(path_q.is_file());
    drop(snapshot);
    restarted.shutdown().await.unwrap();
    drop(engine);

    if let Some(bytes) = crash_image {
        // Model a process exiting after durable Q while a reader still held P.
        // Restore that exact writer image without any surviving file leases.
        std::fs::write(&path_p, &bytes).unwrap();
        std::fs::set_permissions(&path_p, std::fs::metadata(&path_q).unwrap().permissions())
            .unwrap();
        let neighbor = owner(canonical).await;
        let survivor = create(canonical, &neighbor, "neighbor", "# Neighbor".into()).await;
        let runtime = start(canonical, derived, root).await;
        let engine = runtime.engine();
        engine
            .wait_for_projected(scope, q, &budget())
            .await
            .unwrap();
        assert!(!path_p.exists(), "restart must reclaim the unleased P");
        assert!(path_q.is_file());
        engine
            .wait_for_projected(neighbor.scope(), survivor.receipt.seq(), &budget())
            .await
            .unwrap();
        let held = engine
            .acquire_snapshot(neighbor, CausalBasis::Await(Default::default()))
            .await
            .unwrap();
        runtime.shutdown().await.unwrap();
        drop(engine);

        // Both names still contain the purged note. The truncated named
        // checkpoint retains its complete ownership header.
        assert!(
            bytes
                .windows(first.value.note.as_str().len())
                .any(|chunk| chunk == first.value.note.as_str().as_bytes())
        );
        let abandoned =
            path_p.with_file_name(format!(".fast-index-{}.tmp", hex::encode(entropy())));
        std::fs::write(&path_p, &bytes[..bytes.len() - 1]).unwrap();
        std::fs::write(&abandoned, &bytes).unwrap();
        canonical
            .delete_note(
                ctx.clone(),
                Mutation {
                    identity: command_identity(&ctx),
                    preconditions: Preconditions {
                        revision: Some(first.value.revision),
                        ..Preconditions::default()
                    },
                    input: DeleteNote {
                        note: first.value.note,
                        disposition: DeleteDisposition::Purge,
                    },
                },
            )
            .await
            .unwrap();
        assert!(
            !path_p.exists(),
            "offline purge must reclaim a truncated named checkpoint"
        );
        assert!(
            !abandoned.exists(),
            "offline purge must finish its filesystem sweep"
        );
        assert!(held.lookup(&survivor.value.note).is_some());
    }
}

async fn exercise_purge_publication(
    canonical: &CanonicalStore,
    derived: &DerivedStore,
    root: &DataRoot,
) {
    let ctx = owner(canonical).await;
    let scope = ctx.scope();
    let first = create(canonical, &ctx, "first", "# First\n".into()).await;
    let p = first.receipt.seq();
    let runtime = start(canonical, derived, root).await;
    let engine = runtime.engine();
    engine
        .wait_for_projected(scope, p, &budget())
        .await
        .unwrap();
    let published = engine.published_cut(scope).unwrap();
    runtime.shutdown().await.unwrap();

    // Drive the ordinary command to durable Q while the runtime is quiet.
    let second = create(canonical, &ctx, "second", "# Second\n".into()).await;
    let q = second.receipt.seq();
    let applied = apply::command(
        &engine,
        &published,
        CommandSeqRange::new(q, q).unwrap(),
        &Cancellation::default(),
    )
    .await
    .unwrap();
    let store = &applied.cut.store;
    assert_eq!(applied.cut.watermark.snapshot_seq, p);
    let generation = store.generation();
    let identity = IndexIdentity {
        generation,
        scope: scope.clone(),
        seq: q,
    };
    let path = root.space_fast_index(generation, &scope.space_id, q);

    // A completed native publication has no SQL writer row yet. Keep the
    // producing lease alive across a real canonical Purge.
    let prepared = FastIndexBuilder::default()
        .prepare(identity.clone())
        .unwrap();
    let (pending, _) = apply::publish_checkpoint_file(&engine, store, prepared)
        .await
        .unwrap();
    assert!(path.is_file());
    assert!(pending.open(&engine.pool).is_err());
    assert!(
        store
            .trusted_checkpoint(
                scope,
                q,
                u32::from(FORMAT_VERSION),
                &platform_abi(),
                &engine.cache_identity,
            )
            .await
            .unwrap()
            .is_none()
    );

    // A crash from an older runtime could also have left an unregistered
    // immutable file in the resident generation.
    let orphan = root.space_fast_index(generation, &scope.space_id, SpaceSeq::ZERO);
    drop(
        FastIndexBuilder::default()
            .publish(
                &orphan,
                IndexIdentity {
                    seq: SpaceSeq::ZERO,
                    ..identity.clone()
                },
            )
            .unwrap(),
    );

    let temp = |nonce: u8| path.with_file_name(format!(".fast-index-{nonce:032x}.tmp"));
    let complete = temp(1);
    let partial = temp(2);
    let linked = temp(3);
    let later = temp(4);
    let foreign = temp(5);
    let contents = std::fs::read(published.base.path()).unwrap();
    std::fs::write(&complete, &contents).unwrap();
    std::fs::write(&partial, &contents[..contents.len() - 1]).unwrap();
    std::fs::hard_link(&orphan, &linked).unwrap();
    for (file, identity) in [
        (
            &later,
            IndexIdentity {
                seq: SpaceSeq::MAX,
                ..identity.clone()
            },
        ),
        (
            &foreign,
            IndexIdentity {
                scope: HistoryScope {
                    incarnation: HistoryIncarnation::from_bytes(entropy()),
                    ..scope.clone()
                },
                ..identity.clone()
            },
        ),
    ] {
        drop(FastIndexBuilder::default().publish(file, identity).unwrap());
    }
    #[cfg(unix)]
    let symlink = {
        let link = temp(6);
        std::os::unix::fs::symlink(published.base.path(), &link).unwrap();
        link
    };

    let purged = canonical
        .delete_note(
            ctx.clone(),
            Mutation {
                identity: command_identity(&ctx),
                preconditions: Preconditions {
                    revision: Some(first.value.revision),
                    ..Preconditions::default()
                },
                input: DeleteNote {
                    note: first.value.note,
                    disposition: DeleteDisposition::Purge,
                },
            },
        )
        .await
        .unwrap();
    assert!(purged.receipt.seq() > q);
    assert!(
        !path.exists(),
        "purge must unlink even a held pending vnode"
    );
    assert!(
        !orphan.exists(),
        "resident purge must sweep matching orphans"
    );
    assert!(!complete.exists(), "purge must sweep a fully written temp");
    assert!(!partial.exists(), "purge must sweep a truncated temp");
    assert!(!linked.exists(), "purge must sweep the orphan's temp link");
    assert!(later.is_file());
    assert!(foreign.is_file());
    #[cfg(unix)]
    assert!(std::fs::symlink_metadata(symlink).unwrap().is_symlink());
    assert!(pending.finish_publication().is_err());

    // The same pre-purge checkpoint cannot materialize at the physical name
    // after the erasure callback and its durable floor have completed.
    let late = FastIndexBuilder::default().prepare(identity).unwrap();
    let error = apply::publish_checkpoint_file(&engine, store, late)
        .await
        .unwrap_err();
    assert!(
        matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if diagnostic.reason == ValidationReason::CursorStale)
    );
    assert!(!path.exists());
}

#[tokio::test]
async fn unpublished_checkpoint_replays_and_compacts_on_sqlite() {
    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let derived = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(GENERATION).unwrap())
        .await
        .unwrap();
    for orphan in ORPHANS {
        exercise(&canonical, &derived, &root, orphan).await;
    }
    exercise_purge_publication(&canonical, &derived, &root).await;
    runtime.shutdown().await.unwrap();
}

#[derive(Deserialize)]
struct PgFixture {
    pg_socket_dir_container: PathBuf,
    pg_socket_dir_host: PathBuf,
    pg_port: u16,
    pg_user: String,
    pg_password: String,
    pg_database: String,
}

#[tokio::test]
async fn unpublished_checkpoint_replays_and_compacts_on_postgres() {
    let manifest = std::env::var_os("NOTARIUM_STORAGE_FIXTURES_MANIFEST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .ancestors()
                .nth(4)
                .unwrap()
                .join(".artifacts/storage-tests/current.json")
        });
    let fixture: PgFixture = serde_json::from_slice(
        &std::fs::read(manifest).expect("run through the required PostgreSQL storage fixture"),
    )
    .unwrap();
    let socket = format!(".s.PGSQL.{}", fixture.pg_port);
    let directory = [
        &fixture.pg_socket_dir_container,
        &fixture.pg_socket_dir_host,
    ]
    .into_iter()
    .find(|directory| directory.join(&socket).exists())
    .unwrap();
    let pool = PgPoolOptions::new()
        .max_connections(6)
        .connect_with(
            PgConnectOptions::new()
                .socket(directory)
                .port(fixture.pg_port)
                .username(&fixture.pg_user)
                .password(&fixture.pg_password)
                .database(&fixture.pg_database),
        )
        .await
        .unwrap();
    let scratch = Scratch::new();
    let root = scratch.root();
    let canonical_schema = format!("test_checkpoint_{}", hex::encode(&entropy()[..6]));
    let prefix = format!("{canonical_schema}_d");
    let (canonical, runtime) = CanonicalRuntime::open(CanonicalConfig {
        installation_id: InstallationId::from_bytes(entropy()),
        sql: SqlBackendConfig::postgres_default(
            PgConnectConfig {
                transport: PgTransport::UnixSocket {
                    socket_dir: directory.to_path_buf(),
                    port: fixture.pg_port,
                },
                username: fixture.pg_user.clone(),
                password: fixture.pg_password.clone(),
                database: fixture.pg_database.clone(),
            },
            &canonical_schema,
        ),
        blobs: BlobBackendConfig::Local {
            data_root: root.clone(),
        },
        writer: WriterConfig::default(),
        snapshot_retention: Duration::from_secs(60),
        default_backup_budget: default_postgres_backup_budget(),
    })
    .await
    .unwrap();
    let derived = DerivedStore::open_postgres(
        pool.clone(),
        &prefix,
        ProjectionGeneration::new(GENERATION).unwrap(),
    )
    .await
    .unwrap();
    for orphan in ORPHANS {
        exercise(&canonical, &derived, &root, orphan).await;
    }
    exercise_purge_publication(&canonical, &derived, &root).await;
    runtime.shutdown().await.unwrap();
    for schema in [
        canonical_schema,
        format!("{prefix}_g1"),
        format!("{prefix}_ctrl"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(format!("DROP SCHEMA {schema} CASCADE")))
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn a_late_old_history_worker_cannot_withdraw_the_restored_cut() {
    use std::sync::Arc;

    use notarium_core::{
        ports::{BackupParticipantPort, EventBusPort, SpaceEventKind},
        receipt::ChangeCursor,
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, canonical_runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let old_context = owner(&canonical).await;
    let old_scope = old_context.scope().clone();
    let retained = create(&canonical, &old_context, "retained", "# Retained".into()).await;
    let cutoff = retained.receipt.seq();
    let derived = DerivedStore::open_sqlite(&root, ProjectionGeneration::new(GENERATION).unwrap())
        .await
        .unwrap();
    let runtime = start(&canonical, &derived, &root).await;
    let engine = runtime.engine();
    engine
        .wait_for_projected(&old_scope, cutoff, &budget())
        .await
        .unwrap();
    let old_slot = Arc::downgrade(&engine.generation.load().slot(&old_scope.space_id).unwrap());
    let mut stream = engine
        .event_bus()
        .subscribe(
            old_context.clone(),
            ChangeCursor {
                scope: old_scope.clone(),
                // Leave the non-empty initial cut pending across restore.
                after: SpaceSeq::ZERO,
            },
        )
        .await
        .unwrap();

    // Hold the old task after it has entered catch-up. The database read
    // takes place after restore even if cancellation has reached the task.
    let mut held = engine.pause_before_catch_up_for_test(&old_scope).unwrap();
    let pending = create(&canonical, &old_context, "pending", "# Pending".into()).await;
    let restored_head = pending.receipt.seq();
    assert!(restored_head > cutoff);
    tokio::time::timeout(
        Duration::from_secs(5),
        held.reached_feed_boundary_for_test(),
    )
    .await
    .unwrap()
    .unwrap();
    let restored = HistoryScope {
        space_id: old_scope.space_id.clone(),
        incarnation: HistoryIncarnation::from_bytes(entropy()),
    };
    canonical
        .restore_cursors(
            MaintenanceContext {
                authority: ServiceAuthority::admit(ServicePurpose::Restore),
                budget: budget(),
            },
            vec![ChangeCursor {
                scope: restored.clone(),
                after: restored_head,
            }],
        )
        .await
        .unwrap();

    let terminal = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let event = stream.next().await.unwrap().unwrap();
            if matches!(event.kind, SpaceEventKind::ResyncRequired) {
                break event;
            }
        }
    })
    .await
    .expect("restore ends the old subscription while its worker is held");
    assert_eq!(terminal.seq, SpaceSeq::ZERO);
    assert_eq!(terminal.scope, old_scope);
    assert!(stream.next().await.unwrap().is_none());
    // The canonical change can end the stream before the supervisor has
    // detached the old cut. Check the replacement after that handoff.
    {
        let withdrawn = old_slot.upgrade().unwrap();
        tokio::time::timeout(Duration::from_secs(5), withdrawn.history_ended.cancelled())
            .await
            .expect("catalog discovery detaches the previous history");
    }
    engine
        .wait_for_projected(&restored, restored_head, &budget())
        .await
        .unwrap();
    assert!(old_slot.upgrade().unwrap().is_detached());

    held.resume_for_test().await.unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while old_slot.upgrade().is_some() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the stale worker completes against its detached slot");
    let restored_context =
        SpaceContext::new(old_context.auth().clone(), restored.clone(), budget()).unwrap();
    let snapshot = engine
        .acquire_snapshot(restored_context, CausalBasis::Await(Default::default()))
        .await
        .expect("the quiet replacement remains publicly readable after the old worker exits");
    assert_eq!(snapshot.cut().scope, restored);
    assert_eq!(snapshot.cut().projected_seq, restored_head);
    assert!(snapshot.lookup(&retained.value.note).is_some());
    assert!(snapshot.lookup(&pending.value.note).is_some());
    runtime.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
}

#[tokio::test]
async fn rebind_waits_for_a_cut_withdrawn_during_admission() {
    use notarium_core::{
        ports::{EventBusPort, SpaceEventKind},
        receipt::ChangeCursor,
    };

    let scratch = Scratch::new();
    let root = scratch.root();
    let (canonical, canonical_runtime) = CanonicalRuntime::open(CanonicalConfig::local_default(
        InstallationId::from_bytes(entropy()),
        root.clone(),
    ))
    .await
    .unwrap();
    let context = owner(&canonical).await;
    let scope = context.scope();
    let note = create(&canonical, &context, "rebind", "# Rebind".into()).await;
    let seq = note.receipt.seq();
    let generation = ProjectionGeneration::new(GENERATION).unwrap();
    let derived = DerivedStore::open_sqlite(&root, generation).await.unwrap();
    let mut runtime = start(&canonical, &derived, &root).await;
    let engine = runtime.engine();
    engine
        .wait_for_projected(scope, seq, &budget())
        .await
        .unwrap();
    let mut stream = engine
        .event_bus()
        .subscribe(
            context.clone(),
            ChangeCursor {
                scope: scope.clone(),
                after: seq,
            },
        )
        .await
        .unwrap();

    let next_generation = generation.checked_next().unwrap();
    runtime.rotate(next_generation, &budget()).await.unwrap();
    engine
        .wait_for_projected(scope, seq, &budget())
        .await
        .unwrap();
    let mut admission = engine
        .pause_before_rebind_admission_for_test(scope)
        .unwrap();
    let mut rebind = tokio::spawn(async move { stream.next().await });
    tokio::time::timeout(
        Duration::from_secs(5),
        admission.reached_feed_boundary_for_test(),
    )
    .await
    .expect("rebind holds a verified generation lease before final delivery")
    .unwrap();

    let mut recovery = engine.pause_before_recovery_for_test(scope).unwrap();
    let cut = engine.published_cut(scope).unwrap();
    assert_eq!(cut.cut.generation, next_generation);
    let slot = engine.generation.load().slot(&scope.space_id).unwrap();
    assert!(slot.request_repair(&cut.base));
    tokio::time::timeout(
        Duration::from_secs(5),
        recovery.reached_feed_boundary_for_test(),
    )
    .await
    .expect("the worker withdraws the cut and pauses before rebuilding")
    .unwrap();
    assert!(slot.admitted_cut().is_none());
    admission.resume_for_test().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(30), &mut rebind)
            .await
            .is_err(),
        "rebind must wait even while the live owner remains available"
    );

    recovery.resume_for_test().await.unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), rebind)
        .await
        .expect("the repaired cut completes the rebind")
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(event.kind, SpaceEventKind::ResyncRequired));
    assert_eq!(event.seq, seq);
    let snapshot = engine
        .acquire_snapshot(context, CausalBasis::Await(Default::default()))
        .await
        .expect("the first read after rebind sees the repaired generation");
    assert_eq!(snapshot.cut().generation, next_generation);
    assert_eq!(snapshot.cut().projected_seq, seq);
    assert!(snapshot.lookup(&note.value.note).is_some());
    runtime.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
}

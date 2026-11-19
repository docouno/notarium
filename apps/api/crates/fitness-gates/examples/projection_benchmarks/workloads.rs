use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    path::Path,
    time::{Duration, Instant},
};

use notarium_canonical::{CanonicalRuntime, CanonicalStore};
use notarium_core::{
    epoch::DataRoot,
    error::PortError,
    ids::{NoteId, ProjectionGeneration, SpaceSeq},
    ports::{
        GraphNodeId, GraphQuery, GraphTier, GroupKey, MaintenanceContext, MoveBoardCard,
        MoveFolder, NoteWritePort, RankExpectation, RankNeighbor, ServiceAuthority, ServicePurpose,
        ViewGraphPort, ViewResult, ViewRow,
    },
    query::{FieldFilterAstV1, Predicate, ReadRequest},
    receipt::{AwaitWatermarks, CausalBasis, MutationReceiptToken, ReceiptSet},
    value::{ScalarValue, YamlValue},
};
use notarium_projections::{
    ProjectionConfig, ProjectionEngine, ProjectorRuntime, derived::DerivedStore, index::PostingKey,
};
use sqlx::PgPool;

use super::{
    fixture::{
        Corpus, PG_DERIVED_PREFIX, PgFixture, REPLAY_TAG, budget, card_id, matches_board,
        open_canonical, projection_context,
    },
    observations::Observer,
    report::{
        Backend, BackendMeasurements, CORPUS_NOTES, FIELDS_PER_NOTE, LAGGED_BATCH_NOTES,
        LINKS_PER_NOTE, MINIMUM_SAMPLES, TAIL_NOTES, Timing,
    },
};

const SAMPLE_COUNT: usize = MINIMUM_SAMPLES;
const PHASE_WAIT: Duration = Duration::from_secs(600);

fn generation() -> ProjectionGeneration {
    ProjectionGeneration::new(1).unwrap()
}

fn time_ns(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).expect("duration fits in u64 nanoseconds")
}

fn report_timing(backend: Backend, operation: &str, timing: &Timing) {
    eprintln!(
        "projection benchmark {backend:?} {operation}: {} samples, p50={} ns, p95={} ns, p99={} ns",
        timing.samples, timing.p50_ns, timing.p95_ns, timing.p99_ns
    );
}

async fn open_derived(backend: Backend, root: &DataRoot, pg: &PgPool) -> DerivedStore {
    let store = match backend {
        Backend::Sqlite => DerivedStore::open_sqlite(root, generation()).await,
        Backend::Postgres => {
            DerivedStore::open_postgres(pg.clone(), PG_DERIVED_PREFIX, generation()).await
        }
    };
    store.expect("open derived generation")
}

async fn observer(backend: Backend, root: &DataRoot, pg: &PgPool) -> Observer {
    match backend {
        Backend::Sqlite => Observer::sqlite(&root.derived(generation())).await,
        Backend::Postgres => Observer::Postgres(pg.clone()),
    }
}

async fn start(
    canonical: &CanonicalStore,
    derived: DerivedStore,
    root: &DataRoot,
) -> ProjectorRuntime {
    let config = ProjectionConfig {
        max_open_spaces: std::num::NonZeroUsize::MIN,
        max_retained_reads: std::num::NonZeroUsize::MIN,
        ..ProjectionConfig::default()
    };
    ProjectorRuntime::start(
        canonical.clone(),
        projection_context(),
        derived,
        root.clone(),
        config,
    )
    .await
    .expect("start projection reactor")
}

async fn wait(engine: &ProjectionEngine, fixture: &Corpus, seq: SpaceSeq) {
    let mut budget = budget();
    budget.remaining = PHASE_WAIT;
    let cut = engine
        .wait_for_projected(&fixture.space.scope, seq, &budget)
        .await
        .unwrap_or_else(|error| panic!("wait for projected command-end {seq:?}: {error:?}"));
    assert!(cut.projected_seq >= seq);
}

async fn reopen(
    backend: Backend,
    path: &Path,
    pg: &PgFixture,
    fixture: &mut Corpus,
) -> (CanonicalStore, CanonicalRuntime) {
    let (store, runtime) = open_canonical(backend, path, pg).await;
    if backend == Backend::Postgres {
        let epoch = fixture.space.active_epoch.checked_next().unwrap();
        let context = MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Revocation),
            budget: budget(),
        };
        store
            .advance_space_lease(&context, &fixture.space.scope, epoch)
            .await
            .expect("confirm new PostgreSQL Space owner after shutting down the old owner");
        fixture.space.active_epoch = epoch;
    }
    (store, runtime)
}

pub(crate) async fn backend_profile(
    backend: Backend,
    path: &Path,
    pg: &PgFixture,
    pool: &PgPool,
) -> BackendMeasurements {
    let canonical = path.join("canonical");
    let cache = DataRoot::new(path.join("cache"));
    let (store, canonical_runtime) = open_canonical(backend, &canonical, pg).await;
    let mut fixture = Corpus::create(&store).await;
    eprintln!("projection benchmark {backend:?}: populating the canonical corpus");
    fixture.seed(&store, CORPUS_NOTES).await;
    let derived = open_derived(backend, &cache, pool).await;
    let projector = start(&store, derived.clone(), &cache).await;
    let engine = projector.engine();
    eprintln!(
        "projection benchmark {backend:?}: waiting for the initial cut at {}",
        fixture.head.get()
    );
    wait(&engine, &fixture, fixture.head).await;
    let checkpoint = engine
        .checkpoint_for_test(&fixture.space.scope, fixture.head)
        .await
        .expect("durable base checkpoint at the benchmark cut");
    let watched = observer(backend, &cache, pool).await;
    let (corpus_notes, corpus_links, resolved_links) = watched.counts().await;
    assert_eq!(
        (corpus_notes, corpus_links),
        (CORPUS_NOTES, CORPUS_NOTES * LINKS_PER_NOTE)
    );
    assert_eq!(
        resolved_links, corpus_links,
        "every benchmark edge resolves"
    );

    eprintln!("projection benchmark {backend:?}: measuring the public read paths");
    let reference = ReferenceBoard::new(CORPUS_NOTES, watched.board_top().await);
    let mut cold_checkpoint_samples = Vec::with_capacity(SAMPLE_COUNT);
    for _ in 0..SAMPLE_COUNT {
        evict_checkpoint(&engine, &fixture, checkpoint.path());
        let started = Instant::now();
        let mapped = checkpoint
            .open_uncached()
            .expect("cold open trusted checkpoint");
        cold_checkpoint_samples.push(time_ns(started));
        drop(mapped);
    }
    let cold_checkpoint_open = Timing::from_samples(cold_checkpoint_samples);
    report_timing(backend, "cold checkpoint open", &cold_checkpoint_open);

    let warm_board = warm_board(&engine, &fixture, &reference).await;
    report_timing(backend, "warm board", &warm_board);
    let neighborhood = timed_neighborhood(&engine, &fixture).await;
    report_timing(backend, "two-hop neighborhood", &neighborhood);

    let mut cold_board_samples = Vec::with_capacity(SAMPLE_COUNT);
    for _ in 0..SAMPLE_COUNT {
        evict_cold_board(&engine, &fixture, checkpoint.path(), backend, &cache);
        let (frame, elapsed) = open_board(&engine, &fixture, None, no_receipts()).await;
        reference.verify(&frame);
        cold_board_samples.push(elapsed);
    }
    let cold_board = Timing::from_samples(cold_board_samples);
    report_timing(backend, "cold board", &cold_board);

    watched.watch_folder_move().await;
    let mut folder_move = fixture.command(MoveFolder {
        folder: fixture.moved_folder.clone(),
        new_parent: Some(fixture.destination_folder.clone()),
    });
    folder_move.preconditions.revision = Some(fixture.moved_folder_revision.clone());
    let moved = store
        .move_folder(fixture.ctx(), folder_move)
        .await
        .expect("move the 100k-note source subtree");
    wait(&engine, &fixture, moved.receipt.seq()).await;
    let (unqualified_move_rewrites, candidate_move_rewrites) = watched.folder_move_touches().await;
    drop(watched);

    eprintln!("projection benchmark {backend:?}: checking exact reads during the import");
    let (ryow_frames, stale_frames, imported) = race(&store, &engine, &fixture, &reference).await;
    eprintln!(
        "projection benchmark {backend:?} receipt updates: {stale_frames} stale frames of {ryow_frames}"
    );
    drop(checkpoint);

    eprintln!("projection benchmark {backend:?}: recovering the durable projection tail");
    let base = engine
        .checkpoint_for_test(&fixture.space.scope, imported)
        .await
        .expect("checkpoint the completed import before producing a replay tail");
    // The import may have checkpointed structural rows ahead of the graph.
    // Let its scheduled settlement finish before making a graph-neutral tail.
    tokio::time::timeout(PHASE_WAIT, async {
        loop {
            let watermark = derived
                .watermarks(&fixture.space.scope.space_id)
                .await
                .expect("read replay fixture watermark")
                .expect("projected Space watermark");
            if watermark.graph_settled_seq == imported {
                assert_eq!(watermark.snapshot_seq, imported);
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("settle the import graph before measuring replay");
    let final_notes = CORPUS_NOTES + LAGGED_BATCH_NOTES;
    let first_tail_note = final_notes - TAIL_NOTES;
    // One new tag tests recovered metadata without changing the benchmark
    // board's membership, link lookup keys or graph.
    let tail = fixture
        .edit_tail(&store, first_tail_note..final_notes, CORPUS_NOTES)
        .await;
    assert_eq!(tail.get() - imported.get(), TAIL_NOTES as u64);
    wait(&engine, &fixture, tail).await;
    engine
        .evict_projection_for_test(&fixture.space.scope)
        .expect("reopen the checkpoint with no resident mapping");
    let recovery_started = Instant::now();
    let (recovered_snapshot, recovered_head, recovered) = engine
        .recover_tail_for_test(&fixture.space.scope)
        .await
        .expect("recover from the trusted checkpoint and durable L0 journal");
    let tail_replay_ns = time_ns(recovery_started);
    assert_eq!(
        (recovered_snapshot, recovered_head),
        (imported, tail),
        "recovery must reuse the older checkpoint and replay the complete durable tail"
    );
    let tagged = recovered
        .posting(&PostingKey::Tag(REPLAY_TAG.into()))
        .unwrap()
        .iter()
        .map(|dense| recovered.note_id(recovered.dense(dense)).unwrap())
        .collect::<BTreeSet<_>>();
    let expected: BTreeSet<_> = (first_tail_note..final_notes).map(card_id).collect();
    assert_eq!(tagged, expected, "read the entire replayed posting");
    let source = recovered.dense_id(&card_id(first_tail_note)).unwrap();
    let outgoing = recovered
        .outgoing(source)
        .map(|dense| recovered.note_id(recovered.dense(dense)).unwrap())
        .collect::<BTreeSet<_>>();
    let expected_neighbors: BTreeSet<_> = (1..=LINKS_PER_NOTE)
        .map(|offset| card_id((first_tail_note + offset * 37) % CORPUS_NOTES))
        .collect();
    assert_eq!(
        outgoing, expected_neighbors,
        "read the recovered forward adjacency"
    );
    for neighbor in expected_neighbors {
        let target = recovered.dense_id(&neighbor).unwrap();
        assert!(recovered.incoming(target).any(|dense| dense == source));
    }
    let replayed_tail_notes = tagged.len();
    drop(recovered);
    drop(base);
    eprintln!(
        "projection benchmark {backend:?} durable tail: {replayed_tail_notes} witnessed edits in {tail_replay_ns} ns"
    );
    let watched = observer(backend, &cache, pool).await;
    let final_edges = final_notes * LINKS_PER_NOTE;
    assert_eq!(
        watched.counts().await,
        (final_notes, final_edges, final_edges)
    );
    let digest = watched
        .semantic_digest(&fixture.space.scope.space_id, final_notes)
        .await;
    let (frame_before, _) = open_board(&engine, &fixture, None, no_receipts()).await;
    let board_before = board_witness(&frame_before);

    drop(engine);
    projector
        .shutdown()
        .await
        .expect("stop projection workers before removing derived state");
    drop(derived);
    if backend == Backend::Postgres {
        let context = MaintenanceContext {
            authority: ServiceAuthority::admit(ServicePurpose::Revocation),
            budget: budget(),
        };
        store
            .drain_projection_owner(&context, &fixture.space.scope)
            .await
            .expect("durably drain the PostgreSQL Space owner before rebuild");
    }
    canonical_runtime
        .shutdown()
        .await
        .expect("release canonical owner before rebuild");
    drop(store);
    watched
        .drop_for_rebuild(cache.derived(generation()).parent().unwrap())
        .await;

    eprintln!("projection benchmark {backend:?}: rebuilding from watermark zero");
    let (store, canonical_runtime) = reopen(backend, &canonical, pg, &mut fixture).await;
    let derived = open_derived(backend, &cache, pool).await;
    store.reset_projection_read_metrics_for_test();
    let busy_before = store
        .wal_telemetry()
        .map_or(0, |stats| stats.leaked_sqlite_busy_errors);
    let rebuild_started = Instant::now();
    let projector = start(&store, derived, &cache).await;
    let engine = projector.engine();
    wait(&engine, &fixture, tail).await;
    let rebuild_ns = time_ns(rebuild_started);
    let metadata = store.projection_read_metrics_for_test();
    assert!(
        metadata.transactions > 0,
        "no canonical rebuild read transactions measured"
    );
    assert_eq!(
        metadata.non_successful_reads, 0,
        "canonical reads failed during rebuild"
    );
    let rebuild_sqlite_busy = store.wal_telemetry().map_or(0, |stats| {
        stats
            .leaked_sqlite_busy_errors
            .checked_sub(busy_before)
            .unwrap()
    });
    let watched = observer(backend, &cache, pool).await;
    let (frame_after, _) = open_board(&engine, &fixture, None, no_receipts()).await;
    let identical_rebuild = watched.counts().await == (final_notes, final_edges, final_edges)
        && digest
            == watched
                .semantic_digest(&fixture.space.scope.space_id, final_notes)
                .await
        && board_before == board_witness(&frame_after);
    eprintln!(
        "projection benchmark {backend:?} rebuild: {rebuild_ns} ns, maximum read {} ns, {rebuild_sqlite_busy} busy errors, equivalent={identical_rebuild}",
        metadata.max_elapsed_ns
    );
    drop(engine);
    drop(watched);
    projector.shutdown().await.unwrap();
    canonical_runtime.shutdown().await.unwrap();
    drop(store);
    fs::remove_dir_all(path).expect("remove the completed benchmark corpus");

    BackendMeasurements {
        backend,
        corpus_notes,
        corpus_links,
        fields_per_note: FIELDS_PER_NOTE,
        cold_checkpoint_open,
        warm_board,
        cold_board,
        neighborhood,
        replayed_tail_notes,
        tail_replay_ns,
        lagged_batch_notes: LAGGED_BATCH_NOTES,
        ryow_frames,
        stale_frames,
        rebuild_ns,
        max_rebuild_read_ns: metadata.max_elapsed_ns,
        rebuild_sqlite_busy,
        identical_rebuild,
        unqualified_move_rewrites,
        candidate_move_rewrites,
    }
}

async fn open_board(
    engine: &ProjectionEngine,
    fixture: &Corpus,
    group: Option<&str>,
    causal: CausalBasis,
) -> (ViewResult, u64) {
    let request = ReadRequest::Open {
        query: fixture.board_query(group),
        causal,
    };
    let context = fixture.ctx();
    let started = Instant::now();
    let response = engine
        .query_view(context, request)
        .await
        .unwrap_or_else(|error| {
            panic!(
                "query authored Kanban board (group {group:?}) after {:?}: {error:?}",
                started.elapsed()
            )
        });
    (response, time_ns(started))
}

fn no_receipts() -> CausalBasis {
    CausalBasis::Await(AwaitWatermarks::default())
}

fn exact(receipt: &MutationReceiptToken) -> CausalBasis {
    CausalBasis::Exact(ReceiptSet::new([receipt.clone()]).unwrap())
}

fn group(name: &str) -> GroupKey {
    GroupKey::Value(ScalarValue::String(name.into()))
}

fn group_count(result: &ViewResult, name: &str) -> u64 {
    let key = group(name);
    result
        .groups
        .iter()
        .find(|item| item.group == key)
        .map_or(0, |item| item.count)
}

fn note_id(row: &ViewRow) -> &NoteId {
    &row.card.document.provenance().reference().note_id
}

struct ReferenceBoard {
    todo: u64,
    done: u64,
    top: Vec<NoteId>,
}

impl ReferenceBoard {
    fn new(notes: usize, top: Vec<NoteId>) -> Self {
        let eligible: Vec<_> = (0..notes).filter(|&index| matches_board(index)).collect();
        let todo = eligible
            .iter()
            .filter(|&&index| index.is_multiple_of(2))
            .count() as u64;
        let done = eligible.len() as u64 - todo;
        Self { todo, done, top }
    }

    fn verify(&self, result: &ViewResult) {
        assert!(!result.rows.incomplete);
        assert_eq!(group_count(result, "todo"), self.todo);
        assert_eq!(group_count(result, "done"), self.done);
        assert_eq!(
            result.groups.iter().map(|item| item.count).sum::<u64>(),
            self.todo + self.done
        );
        assert!(
            result.rows.items.iter().map(note_id).eq(self.top.iter()),
            "board order differs from the independent reference"
        );
        assert!(
            result
                .rows
                .items
                .iter()
                .all(|row| !row.card.preview.is_empty() && !row.card.path.is_empty())
        );
    }
}

fn board_witness(result: &ViewResult) -> Vec<(String, String, String, Option<String>)> {
    result
        .rows
        .items
        .iter()
        .map(|row| {
            (
                note_id(row).as_str().to_owned(),
                row.card.title.clone(),
                row.card.path.clone(),
                row.rank.clone(),
            )
        })
        .collect()
}

async fn warm_board(
    engine: &ProjectionEngine,
    fixture: &Corpus,
    reference: &ReferenceBoard,
) -> Timing {
    // Trigger lazy parser, pool, schema and index caches outside measured samples.
    for _ in 0..5 {
        let (frame, _) = open_board(engine, fixture, None, no_receipts()).await;
        reference.verify(&frame);
    }
    let mut samples = Vec::with_capacity(SAMPLE_COUNT);
    for _ in 0..SAMPLE_COUNT {
        let (frame, elapsed) = open_board(engine, fixture, None, no_receipts()).await;
        reference.verify(&frame);
        samples.push(elapsed);
    }
    Timing::from_samples(samples)
}

async fn timed_neighborhood(engine: &ProjectionEngine, fixture: &Corpus) -> Timing {
    let mut samples = Vec::with_capacity(SAMPLE_COUNT);
    for sample in 0..SAMPLE_COUNT {
        let focal = 10_000 + 41 * sample;
        let query = GraphQuery {
            tier: GraphTier::Neighborhood {
                note: card_id(focal),
                hops: 2,
            },
            filter: FieldFilterAstV1 {
                version: 1,
                predicate: Predicate::All(Vec::new()),
            },
        };
        let ctx = fixture.ctx();
        let started = Instant::now();
        let result = engine
            .query_graph(ctx, query)
            .await
            .expect("query a two-hop ego graph");
        samples.push(time_ns(started));
        let actual: BTreeSet<_> = result
            .nodes
            .into_iter()
            .map(|node| match node.id {
                GraphNodeId::Note(note) => note,
                GraphNodeId::Cluster(_) => panic!("neighborhood returned a cluster"),
            })
            .collect();
        let mut expected = BTreeSet::from([card_id(focal)]);
        for shift in -10_i32..=10 {
            expected.insert(card_id(usize::try_from(focal as i32 + 37 * shift).unwrap()));
        }
        assert_eq!(
            actual, expected,
            "expected both edge directions for the whole two-hop neighborhood"
        );
        assert_eq!(result.hidden_count, 0);
        assert!(!result.truncated);
    }
    Timing::from_samples(samples)
}

fn evict_file_cache(path: &Path) {
    let file = File::open(path).expect("open benchmark file for cold cache advice");
    file.sync_all()
        .expect("flush benchmark file before advising cold cache");
    #[cfg(target_os = "linux")]
    rustix::fs::fadvise(&file, 0, None, rustix::fs::Advice::DontNeed)
        .expect("POSIX_FADV_DONTNEED for benchmark file");
    #[cfg(not(target_os = "linux"))]
    panic!("projection cold-cache benchmark requires Linux");
}

fn evict_checkpoint(engine: &ProjectionEngine, fixture: &Corpus, path: &Path) {
    engine
        .evict_projection_for_test(&fixture.space.scope)
        .expect("release all resident benchmark mmap readers");
    evict_file_cache(path);
}

fn evict_cold_board(
    engine: &ProjectionEngine,
    fixture: &Corpus,
    checkpoint: &Path,
    backend: Backend,
    cache: &DataRoot,
) {
    evict_checkpoint(engine, fixture, checkpoint);
    if backend == Backend::Sqlite {
        let db = cache.derived(generation());
        evict_file_cache(&db);
        let wal = Path::new(&format!("{}-wal", db.display())).to_path_buf();
        if wal.is_file() {
            evict_file_cache(&wal);
        }
    }
}

async fn race(
    store: &CanonicalStore,
    engine: &ProjectionEngine,
    fixture: &Corpus,
    reference: &ReferenceBoard,
) -> (usize, usize, SpaceSeq) {
    let (todo, _) = open_board(engine, fixture, Some("todo"), no_receipts()).await;
    let (done, _) = open_board(engine, fixture, Some("done"), no_receipts()).await;
    let target = todo.rows.items.first().expect("source card");
    let first_done = done.rows.items.first().expect("destination card");
    let next_done = &done.rows.items[1];

    // Materialize ranks through the real planner before sampling a single-card
    // move. The initial placement legitimately has a wait-only receipt.
    let initial_rank = engine
        .move_board_card(
            fixture.ctx(),
            fixture.command(MoveBoardCard {
                view: fixture.view.clone(),
                note: note_id(first_done).clone(),
                group: group("done"),
                before: Some(RankNeighbor {
                    note: note_id(next_done).clone(),
                    expected_rank: RankExpectation::Absent,
                }),
                after: None,
                fields: BTreeMap::new(),
                expected_note: first_done.card.document.provenance().revision().clone(),
                expected_view: fixture.view_revision.clone(),
                expected_rank: RankExpectation::Absent,
            }),
        )
        .await
        .expect("materialize destination ranks through the board planner");
    wait(engine, fixture, initial_rank.receipt.seq()).await;

    let mut pause_move = engine
        .pause_before_projection_for_test(&fixture.space.scope, 1)
        .unwrap();
    let moved = engine
        .move_board_card(
            fixture.ctx(),
            fixture.command(MoveBoardCard {
                view: fixture.view.clone(),
                note: note_id(target).clone(),
                group: group("done"),
                before: Some(RankNeighbor {
                    note: note_id(first_done).clone(),
                    expected_rank: RankExpectation::Existing(initial_rank.value.rank_revision),
                }),
                after: None,
                fields: BTreeMap::from([("status".into(), Some(YamlValue::String("done".into())))]),
                expected_note: target.card.document.provenance().revision().clone(),
                expected_view: fixture.view_revision.clone(),
                expected_rank: RankExpectation::Absent,
            }),
        )
        .await
        .expect("commit cross-column drag with its real receipt");
    let paused_at = tokio::time::timeout(PHASE_WAIT, pause_move.reached())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        paused_at.last_seq,
        moved.receipt.seq(),
        "the move itself must be ahead of projection"
    );

    let mut pause_import = engine
        .pause_before_projection_for_test(&fixture.space.scope, LAGGED_BATCH_NOTES as u64)
        .unwrap();
    let imported = fixture
        .insert_batch(
            store,
            CORPUS_NOTES,
            CORPUS_NOTES + LAGGED_BATCH_NOTES,
            CORPUS_NOTES,
        )
        .await;
    assert_eq!(
        imported.get() - moved.receipt.seq().get(),
        LAGGED_BATCH_NOTES as u64
    );

    let mut frames = 0;
    let mut stale = 0;
    let phase = |whole: &ViewResult, destination: &ViewResult| {
        group_count(whole, "todo") == reference.todo - 1
            && group_count(whole, "done") == reference.done + 1
            && destination.rows.items.first().is_some_and(|row| {
                note_id(row) == note_id(target)
                    && row.rank.as_deref() == Some(moved.value.rank.as_str())
            })
    };
    let (whole, _) = open_board(engine, fixture, None, exact(&moved.receipt)).await;
    let (destination, _) = open_board(engine, fixture, Some("done"), exact(&moved.receipt)).await;
    assert!(
        whole.rows.projected_seq < moved.receipt.seq(),
        "at least one sample must exercise the receipt overlay ahead of projection"
    );
    frames += 1;
    stale += usize::from(!phase(&whole, &destination));
    drop(pause_move);

    let pending = tokio::time::timeout(PHASE_WAIT, pause_import.reached())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.last_seq, imported);
    assert_eq!(
        pending.last_seq.get() - pending.first_seq.get() + 1,
        LAGGED_BATCH_NOTES as u64
    );

    // A bulk receipt must wait. It must also observe the user's finite deadline
    // and explicit cancellation while the complete command is still staged.
    let bulk_receipt = MutationReceiptToken::new(fixture.space.scope.clone(), imported).unwrap();
    let request = ReadRequest::Open {
        query: fixture.board_query(None),
        causal: exact(&bulk_receipt),
    };
    let mut short = fixture.ctx();
    short.budget.remaining = Duration::from_millis(60);
    let result = engine.query_view(short, request.clone()).await;
    assert!(
        matches!(result, Err(PortError::DeadlineExceeded(_))),
        "bulk receipt returned {result:?}"
    );
    let cancelled = fixture.ctx();
    cancelled.budget.cancellation.cancel();
    let result = engine.query_view(cancelled, request).await;
    assert!(
        matches!(result, Err(PortError::Cancelled(_))),
        "cancelled receipt returned {result:?}"
    );

    drop(pause_import);
    for _ in 0..SAMPLE_COUNT {
        let (whole, _) = open_board(engine, fixture, None, exact(&moved.receipt)).await;
        let (destination, _) =
            open_board(engine, fixture, Some("done"), exact(&moved.receipt)).await;
        frames += 1;
        stale += usize::from(!phase(&whole, &destination));
    }
    wait(engine, fixture, imported).await;
    let (whole, _) = open_board(engine, fixture, None, exact(&moved.receipt)).await;
    let (destination, _) = open_board(engine, fixture, Some("done"), exact(&moved.receipt)).await;
    frames += 1;
    stale += usize::from(!phase(&whole, &destination));
    (frames, stale, imported)
}

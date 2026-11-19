//! Scale exercise for immutable checkpoint, board planner, card hydration and
//! visibility capacity. Prepare synthetic index records without a million CAS
//! objects. The regular profiles separately exercise the full canonical flow.

use std::{collections::BTreeMap, num::NonZeroUsize, path::Path, sync::Arc, time::Instant};

use notarium_canonical::{FenceCensusFixture, LiveDenseLookup, SpaceRecord, codec::encode_msgpack};
use notarium_core::{
    auth::{
        EngineAuthContext, Space, SpaceGrant, SpaceKind, SpaceLifecycle, SpaceRole, VerifiedHuman,
    },
    classes::DocClass,
    epoch::DataRoot,
    error::Diagnostic,
    ids::{
        AbilityId, ClusterId, ContentDigest, FolderId, GrantId, HistoryIncarnation, LeaseEpoch,
        NoteId, PrincipalId, ProjectionGeneration, RevisionId, SpaceId, SpaceSeq, ViewKey,
    },
    model::{HistoryScope, Lifecycle},
    ports::{GroupKey, PageLimit, ViewQuery, ViewRef},
    query::{FieldFilterAstV1, FieldObservation, FieldValue, Predicate},
    value::{Date, ExactNumber, ScalarValue, Timestamp, YamlValue},
};
use notarium_projections::{
    benchmark_planner::{
        WindowInput, plan_view, select_window, structural_universe, view_source_candidates,
    },
    derived::{DerivedMutation, DerivedStore, ProjectedNote, ProjectionWatermark, SpaceApply},
    index::{
        BaseIndexHandle, FastIndexBuilder, GraphSections, IndexIdentity, IndexNote, IndexView,
        L0Delta, MmapPool, NoteSortHeader,
    },
    nota::compile_views,
};
use notarium_syntax::extract::{ExtractedDocDelta, extract};

use super::{
    fixture::{board_carrier, card_id, matches_board},
    report::{FencePhase, FenceSample, MICROPROFILE_NOTES, MINIMUM_SAMPLES, Microprofile, Timing},
};

fn initial_seq() -> SpaceSeq {
    SpaceSeq::new(1).unwrap()
}
const ADDED: usize = 128;

struct Mapping {
    base: BaseIndexHandle,
    pool: Arc<MmapPool>,
}

impl LiveDenseLookup for Mapping {
    fn slots(&self) -> u32 {
        self.base.open(&self.pool).unwrap().node_count()
    }

    fn dense_id(&self, note: &NoteId) -> Option<u32> {
        self.base.open(&self.pool).unwrap().lookup(note)
    }

    fn generation(&self) -> Option<ProjectionGeneration> {
        Some(self.base.identity().generation)
    }
}

struct Fixture {
    folders: [FolderId; 4],
    due_dates: [Date; 28],
    space: Space,
    scope: HistoryScope,
    generation: ProjectionGeneration,
    pool: Arc<MmapPool>,
}

impl Fixture {
    fn new() -> Self {
        let id = SpaceId::from_bytes([0x71; 16]);
        Self {
            folders: std::array::from_fn(|i| FolderId::from_bytes([0x10 + i as u8; 16])),
            due_dates: std::array::from_fn(|i| {
                Date::parse(&format!("2026-10-{:02}", i + 1)).unwrap()
            }),
            space: Space {
                id: id.clone(),
                kind: SpaceKind::Personal,
                lifecycle: SpaceLifecycle::Active,
            },
            scope: HistoryScope {
                space_id: id,
                incarnation: HistoryIncarnation::from_bytes([0x81; 16]),
            },
            generation: ProjectionGeneration::new(1).unwrap(),
            pool: Arc::new(MmapPool::new(NonZeroUsize::MIN)),
        }
    }

    fn record(&self) -> SpaceRecord {
        SpaceRecord {
            space: self.space.clone(),
            scope: self.scope.clone(),
            root_folder_id: self.folders[0].clone(),
            slug: "projection-scale".into(),
            owner: PrincipalId::from_bytes([0x55; 16]),
            active_epoch: LeaseEpoch::new(1).unwrap(),
            last_seq: initial_seq(),
            created_at: stamp(0),
        }
    }

    fn projected_note(&self, index: usize, revision: &RevisionId) -> ProjectedNote {
        let doc = self.note(index);
        let sec = doc.updated.unix_seconds();
        let nanos = doc.updated.nanosecond();
        let digest =
            ContentDigest::from_bytes(*blake3::hash(doc.note_id.as_str().as_bytes()).as_bytes());
        ProjectedNote {
            space_id: self.scope.space_id.clone(),
            dense_id: index as u32,
            note_id: doc.note_id,
            rev_id: revision.clone(),
            parent_folder_id: self.folders[doc.folder as usize].clone(),
            dense_folder_id: doc.folder,
            ability_id: doc.ability,
            slug: format!("task-{index:06}"),
            slug_fold: format!("task-{index:06}"),
            title: format!("Task {index:06}"),
            title_fold: format!("task {index:06}"),
            preview: format!("Hydrated benchmark card {index:06}"),
            doc_class: doc.class,
            lifecycle: Lifecycle::Active,
            byte_size: 32,
            content_digest: Some(digest),
            tags_msgpack: encode_msgpack(&doc.tags).unwrap(),
            view_blocks_msgpack: encode_msgpack(&Vec::<String>::new()).unwrap(),
            created_at_sec: sec,
            created_at_nsec: nanos,
            updated_at_sec: sec,
            updated_at_nsec: nanos,
            raw_fields_msgpack: encode_msgpack(&Option::<BTreeMap<String, YamlValue>>::None)
                .unwrap(),
            header_diagnostic_msgpack: encode_msgpack(&Option::<Diagnostic>::None).unwrap(),
            evaluated_fields_msgpack: encode_msgpack(&doc.fields).unwrap(),
            diagnostics_msgpack: encode_msgpack(&Vec::<Diagnostic>::new()).unwrap(),
            rank_version: digest,
            has_pending_nota: false,
            has_invalid_nota: false,
        }
    }

    fn note(&self, index: usize) -> SyntheticNote {
        let folder = if index % 7 >= 5 {
            3
        } else if index.is_multiple_of(4) {
            2
        } else {
            1
        };
        let package = index < 64 && index.is_multiple_of(7) && !matches_board(index);
        let (class, ability) = if package {
            (
                DocClass::Skill,
                Some(AbilityId::from_bytes((index as u128).to_be_bytes())),
            )
        } else {
            (DocClass::UserDoc, None)
        };
        SyntheticNote {
            dense: index as u32,
            note_id: card_id(index),
            updated: stamp(index),
            folder,
            ancestors: match folder {
                1 => &[1, 0],
                2 => &[2, 1, 0],
                _ => &[3, 0],
            },
            class,
            ability,
            fields: BTreeMap::from([
                (
                    "status".into(),
                    string(if index.is_multiple_of(2) {
                        "todo"
                    } else {
                        "done"
                    }),
                ),
                (
                    "priority".into(),
                    string(if index % 5 < 3 { "high" } else { "normal" }),
                ),
                (
                    "due".into(),
                    scalar(ScalarValue::Date(self.due_dates[index % 28])),
                ),
                (
                    "owner".into(),
                    scalar(ScalarValue::String(format!("team-{}", index % 19))),
                ),
                (
                    "estimate".into(),
                    scalar(ScalarValue::Number(ExactNumber::new(
                        (1 + index % 25).into(),
                    ))),
                ),
            ]),
            tags: vec![
                if index.is_multiple_of(3) {
                    "focus"
                } else {
                    "general"
                }
                .into(),
            ],
        }
    }

    fn checkpoint(&self, root: &DataRoot, seq: SpaceSeq, count: usize) -> BaseIndexHandle {
        let mut builder = FastIndexBuilder::default();
        for (dense, folder) in self.folders.iter().enumerate() {
            builder
                .add_folder(dense as u32, folder, Lifecycle::Active)
                .unwrap();
        }
        for dense in 0..count {
            let note = self.note(dense);
            builder.add_note(note.index_row()).unwrap();
        }
        builder.set_graph(graph(count));
        let path = root.space_fast_index(self.generation, &self.scope.space_id, seq);
        let identity = IndexIdentity {
            generation: self.generation,
            scope: self.scope.clone(),
            seq,
        };
        let (handle, witness) = builder.publish(&path, identity).unwrap();
        assert_eq!(std::fs::metadata(path).unwrap().len(), witness.size);
        handle
    }

    fn census(&self, base: BaseIndexHandle) -> FenceCensusFixture {
        let lookup = Arc::new(Mapping {
            base,
            pool: self.pool.clone(),
        });
        let mut fence = FenceCensusFixture::new(self.record(), lookup).unwrap();
        for (dense, folder) in self.folders.iter().enumerate() {
            let parent = match dense {
                0 => None,
                2 => Some(self.folders[1].clone()),
                _ => Some(self.folders[0].clone()),
            };
            fence.apply_folder(folder.clone(), parent).unwrap();
        }
        for index in 0..MICROPROFILE_NOTES {
            let note = self.note(index);
            fence
                .apply_note(
                    note.note_id,
                    self.folders[note.folder as usize].clone(),
                    note.class,
                    note.ability,
                )
                .unwrap();
        }
        fence
    }
}

struct SyntheticNote {
    dense: u32,
    note_id: NoteId,
    updated: Timestamp,
    folder: u32,
    ancestors: &'static [u32],
    class: DocClass,
    ability: Option<AbilityId>,
    fields: BTreeMap<String, FieldObservation<FieldValue>>,
    tags: Vec<String>,
}

impl SyntheticNote {
    fn index_row(&self) -> IndexNote<'_> {
        IndexNote {
            dense: self.dense,
            id: &self.note_id,
            header: NoteSortHeader::new(
                self.updated,
                self.updated,
                self.folder,
                self.class,
                Lifecycle::Active,
            ),
            ancestors: self.ancestors,
            trashed_ancestor: false,
            fields: &self.fields,
            tags: &self.tags,
            ability: self.ability.as_ref(),
        }
    }
}

fn stamp(index: usize) -> Timestamp {
    let nanos = ((index as u64 * 17_019 + 1) % 1_000_000_000) as u32;
    Timestamp::from_unix_parts(1_700_000_000 + index as i64, nanos).unwrap()
}

fn graph(nodes: usize) -> GraphSections {
    let mut graph = GraphSections {
        outgoing: Vec::with_capacity(nodes),
        incoming: Vec::with_capacity(nodes),
        clusters: Vec::with_capacity(nodes),
    };
    for index in 0..nodes {
        let direction = |reverse: bool| -> Vec<u32> {
            (1..=5)
                .map(|hop| {
                    ((index + if reverse { nodes - 37 * hop } else { 37 * hop }) % nodes) as u32
                })
                .collect()
        };
        graph.outgoing.push(direction(false));
        graph.incoming.push(direction(true));
        graph.clusters.push(Some(ClusterId::from_bytes(
            ((index / 20_000) as u128).to_be_bytes(),
        )));
    }
    graph
}

fn scalar(value: ScalarValue) -> FieldObservation<FieldValue> {
    FieldObservation::Ok(FieldValue::Scalar(value))
}

fn string(value: &str) -> FieldObservation<FieldValue> {
    scalar(ScalarValue::String(value.into()))
}

pub(crate) async fn run(path: &Path) -> Microprofile {
    eprintln!("projection benchmark: building the synthetic million-note checkpoint");
    let fixture = Fixture::new();
    let root = DataRoot::new(path);
    let base = fixture.checkpoint(&root, initial_seq(), MICROPROFILE_NOTES);
    let checkpoint_bytes = std::fs::metadata(base.path()).unwrap().len();
    let cold_checkpoint_open = measure_cold_open(&base);
    eprintln!(
        "projection benchmark million-note cold checkpoint open: {} samples, p50={} ns, p95={} ns, p99={} ns",
        cold_checkpoint_open.samples,
        cold_checkpoint_open.p50_ns,
        cold_checkpoint_open.p95_ns,
        cold_checkpoint_open.p99_ns
    );
    let index = IndexView::new(
        base.open(&fixture.pool).unwrap(),
        Arc::new(L0Delta::default()),
    );
    let indexed_notes = index.node_count() as usize;
    assert_eq!(indexed_notes, MICROPROFILE_NOTES);
    let (warm_board, hydration_table_rows) = measure_board(&fixture, &root, &index).await;
    drop(index);

    let mut fence = fixture.census(base.clone());
    let hydrated = census_sample(&fence, FencePhase::Hydrated, checkpoint_bytes, 0);
    let mut delta = L0Delta::default();
    for number in MICROPROFILE_NOTES..MICROPROFILE_NOTES + ADDED {
        let note = fixture.note(number);
        delta.replace_note(note.index_row()).unwrap();
        fence
            .apply_note(
                note.note_id,
                fixture.folders[note.folder as usize].clone(),
                note.class,
                note.ability,
            )
            .unwrap();
    }
    assert_eq!(fence.memory_usage().delta_notes, ADDED);
    let lagged = census_sample(
        &fence,
        FencePhase::Lagged,
        checkpoint_bytes,
        delta.approx_bytes(),
    );

    drop(delta);
    let compacted_base = fixture.checkpoint(
        &root,
        initial_seq().checked_next().unwrap(),
        MICROPROFILE_NOTES + ADDED,
    );
    let compacted_bytes = std::fs::metadata(compacted_base.path()).unwrap().len();
    fence
        .update_lookup(Arc::new(Mapping {
            base: compacted_base.clone(),
            pool: fixture.pool.clone(),
        }))
        .unwrap();
    assert_eq!(fence.memory_usage().delta_notes, 0);
    let compacted = census_sample(&fence, FencePhase::Compacted, compacted_bytes, 0);

    fixture.pool.evict(&compacted_base);
    assert_eq!(fixture.pool.live_mmap_count(), 0);
    let evicted = census_sample(&fence, FencePhase::Evicted, 0, 0);

    Microprofile {
        scope: super::report::MICROPROFILE_SCOPE.to_owned(),
        indexed_notes,
        hydration_table_rows,
        checkpoint_bytes,
        cold_checkpoint_open,
        warm_board,
        fence: [hydrated, lagged, compacted, evicted],
    }
}

fn measure_cold_open(base: &BaseIndexHandle) -> Timing {
    let mut samples = Vec::with_capacity(MINIMUM_SAMPLES);
    for _ in 0..MINIMUM_SAMPLES {
        let file = std::fs::File::open(base.path()).expect("open 1M checkpoint for cold advice");
        file.sync_all().expect("flush 1M checkpoint");
        #[cfg(target_os = "linux")]
        rustix::fs::fadvise(&file, 0, None, rustix::fs::Advice::DontNeed)
            .expect("POSIX_FADV_DONTNEED for 1M checkpoint");
        #[cfg(not(target_os = "linux"))]
        panic!("projection cold-cache benchmark requires Linux");
        drop(file);
        let pool = MmapPool::new(NonZeroUsize::MIN);
        let started = Instant::now();
        let mapped = base.open(&pool).expect("cold open 1M trusted checkpoint");
        samples.push(u64::try_from(started.elapsed().as_nanos()).unwrap());
        drop(mapped);
    }
    Timing::from_samples(samples)
}

fn census_sample(
    fence: &FenceCensusFixture,
    phase: FencePhase,
    shared_file_bytes: u64,
    shared_overlay_bytes: usize,
) -> FenceSample {
    let usage = fence.memory_usage();
    assert!(usage.dense_slots >= MICROPROFILE_NOTES);
    FenceSample {
        phase,
        private_steady_bytes: usage.private_bytes as u64,
        private_peak_bytes: usage.peak_private_bytes as u64,
        shared_file_bytes,
        shared_overlay_bytes: shared_overlay_bytes as u64,
    }
}

async fn measure_board(fixture: &Fixture, root: &DataRoot, index: &IndexView) -> (Timing, usize) {
    let store = DerivedStore::open_sqlite(root, fixture.generation)
        .await
        .unwrap();
    let view_key = ViewKey::from_bytes([0x72; 16]);
    let view_note = NoteId::from_bytes([0x73; 16]);
    let carrier = board_carrier(&view_key, &fixture.folders[1]);
    let ExtractedDocDelta::Plain(parsed) =
        extract(&carrier, DocClass::UserDoc, &view_note, "Board", None).unwrap()
    else {
        panic!("scale board needs a Markdown carrier");
    };
    let schema = BTreeMap::new();
    let compiled = compile_views(&parsed.views, &schema);
    let descriptor = compiled.get(&view_key).unwrap();
    let revision = RevisionId::from_bytes([0x74; 16]);
    let request = ViewQuery {
        view: ViewRef {
            note: view_note,
            key: view_key,
        },
        filter: FieldFilterAstV1 {
            version: 1,
            predicate: Predicate::All(Vec::new()),
        },
        sort: None,
        group_by: None,
        limit: PageLimit::new(50).unwrap(),
    };
    let grant = SpaceGrant {
        role: SpaceRole::Owner,
        read_classes: DocClass::all(),
        write_classes: DocClass::all(),
        project_root: None,
    };
    let auth = EngineAuthContext::for_human(VerifiedHuman::attest(
        fixture.record().owner,
        GrantId::from_bytes([0x76; 16]),
        BTreeMap::from([(fixture.scope.space_id.clone(), grant)]),
        false,
    ));
    let eligible: Vec<_> = (0..MICROPROFILE_NOTES)
        .filter(|&idx| matches_board(idx))
        .collect();
    let expected_todo = eligible
        .iter()
        .filter(|&&idx| idx.is_multiple_of(2))
        .count();
    let top: Vec<_> = eligible
        .iter()
        .copied()
        .filter(|idx| idx.is_multiple_of(2))
        .take(50)
        .collect();
    let expected = top.iter().map(|&idx| card_id(idx)).collect::<Vec<_>>();
    let watermark = ProjectionWatermark {
        scope: fixture.scope.clone(),
        root_folder_id: fixture.folders[0].clone(),
        next_dense_id: MICROPROFILE_NOTES as u64,
        next_dense_folder_id: fixture.folders.len() as u64,
        projected_seq: initial_seq(),
        snapshot_seq: initial_seq(),
        graph_settled_seq: initial_seq(),
        schema: None,
        seed_in_progress: false,
        updated_at_ms: 0,
    };
    let mutations = top
        .iter()
        .map(|&idx| DerivedMutation::UpsertNote(Box::new(fixture.projected_note(idx, &revision))))
        .collect();
    store
        .apply(&SpaceApply {
            expected: None,
            watermark,
            mutations,
        })
        .await
        .unwrap();

    let mut samples = Vec::with_capacity(MINIMUM_SAMPLES);
    for run in 0..MINIMUM_SAMPLES + 5 {
        let started = Instant::now();
        let plan = plan_view(descriptor, &request, &revision, None, &schema).unwrap();
        let universe = structural_universe(index, &fixture.space, &auth).unwrap();
        let candidates = view_source_candidates(
            index,
            &descriptor.source,
            Some(&fixture.folders[1]),
            universe,
        )
        .unwrap();
        let selection = select_window(WindowInput {
            index,
            store: &store,
            scope: &fixture.scope,
            cut: initial_seq(),
            candidates: &candidates,
            filter: &plan.filter,
            sort: &plan.sort,
            group_by: plan.group_by.as_deref(),
            columns: &descriptor.columns,
            board: true,
            ranks: &BTreeMap::new(),
            overlay: &BTreeMap::new(),
            after: None,
            limit: request.limit,
        })
        .await
        .unwrap();
        let ids: Vec<_> = selection.rows.iter().map(|row| row.dense_id).collect();
        let cards = store
            .hydrate(&fixture.scope, initial_seq(), &ids)
            .await
            .unwrap();
        let elapsed = started.elapsed().as_nanos() as u64;
        if run >= 5 {
            samples.push(elapsed);
        }
        let group_count = |label: &str| {
            selection
                .groups
                .iter()
                .find(|group| group.group == GroupKey::Value(ScalarValue::String(label.into())))
                .map_or(0, |group| group.count as usize)
        };
        assert_eq!(group_count("todo"), expected_todo);
        assert_eq!(group_count("done"), eligible.len() - expected_todo);
        assert!(
            cards
                .into_iter()
                .map(|card| card.unwrap().note_id)
                .eq(expected.iter().cloned())
        );
    }
    (Timing::from_samples(samples), top.len())
}

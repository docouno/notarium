use super::*;
use crate::layout::{SearchLayout, VectorModel};
use croaring::Bitmap;
use notarium_core::{
    auth::{ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::{ClassifiedDocument, ContentPart},
    ids::{RevisionId, SpaceId, SpaceSeq},
    model::{Lifecycle, NoteRef},
};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy).unwrap();
        let path = std::env::temp_dir().join(format!("search-vector-{}", hex::encode(entropy)));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn model() -> ModelProfileId {
    ModelProfileId::from_bytes([3; 16])
}

fn fixture(index: u32, dimension: usize) -> VectorChunk {
    let mut bytes = [0; 16];
    bytes[12..].copy_from_slice(&index.to_be_bytes());
    let metadata = ChunkMetadata {
        note: NoteId::from_bytes(bytes),
        key: ContentDigest::from_bytes(*blake3::hash(index.to_le_bytes().as_slice()).as_bytes()),
        source: ContentDigest::from_bytes([4; 32]),
        folder: 1 + index % 3,
        class: DocClass::UserDoc,
        tokens: 5,
        context: vec![ByteSpan::new(0, 8).unwrap()],
        spans: vec![ByteSpan::new(9, 20).unwrap()],
    };
    let mut values = vec![0.0; dimension];
    values[index as usize % dimension] = 1.0;
    VectorChunk {
        metadata,
        vector: QuantizedVector::quantize(&values).unwrap(),
    }
}

fn write_fixture(path: &Path, count: u32) -> MmapSegment {
    let mut builder = SegmentBuilder::new(&model(), 100).unwrap();
    for index in 0..count {
        builder.push(fixture(index, 100)).unwrap();
    }
    builder.finish(path).unwrap().unwrap()
}

#[test]
fn odd_segment_preserves_alignment_ordering_and_chunk_context() {
    let scratch = Scratch::new();
    let path = scratch.0.join("seg_0000000000000001.seg");
    let empty = SegmentBuilder::new(&model(), 100).unwrap();
    assert!(empty.finish(&path).unwrap().is_none());
    assert!(!path.exists());
    let segment = write_fixture(&path, 13);
    assert_eq!(segment.len(), 13);
    assert!(matches!(
        MmapSegment::open(&path, &[7; 32]),
        Err(VectorError::CorruptIndex)
    ));
    let bytes = fs::read(&path).unwrap();
    for index in 0..format::SECTION_COUNT {
        assert_eq!(format::read_u64(&bytes, 80 + 16 * index) % 64, 0);
    }
    let metadata = segment.metadata(9).unwrap();
    assert_eq!(metadata, fixture(9, 100).metadata);
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let selected = Bitmap::of(&[1, 6, 9, 11]);
    let expected = fixture(9, 100);
    let result = segment
        .search(&expected.vector, &selected, 3, budget)
        .unwrap();
    assert_eq!(result.hnsw_hops, 0);
    assert_eq!(
        result
            .neighbors
            .iter()
            .map(|hit| hit.slot)
            .collect::<Vec<_>>(),
        [9, 1, 6]
    );
    assert!(result.neighbors[0].score > 0.99);
    let query = simd::Dot::new(expected.vector.values()).unwrap();
    let stats = allocation_counter::measure(|| {
        let sum: u32 = segment.layer0_neighbors(9).sum();
        std::hint::black_box(sum);
        std::hint::black_box(query.dot(expected.vector.values()).unwrap());
    });
    assert_eq!(stats.count_total, 0);
    cancellation.cancel();
    assert!(matches!(
        segment.search(&expected.vector, &selected, 3, budget),
        Err(VectorError::Cancelled)
    ));
}

#[test]
fn mapped_spans_render_the_same_carrier_content_part() {
    let scratch = Scratch::new();
    let source = "# Header\nUseful text";
    let mut chunk = fixture(1, 64);
    chunk.metadata.source = ContentDigest::from_bytes(*blake3::hash(source.as_bytes()).as_bytes());
    chunk.metadata.context = vec![ByteSpan::new(0, 8).unwrap()];
    chunk.metadata.spans = vec![ByteSpan::new(9, source.len()).unwrap()];
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(chunk.clone()).unwrap();
    let segment = builder.finish(&scratch.0.join("segment")).unwrap().unwrap();
    let reloaded = segment.metadata(0).unwrap();
    let space = SpaceId::from_bytes([1; 16]);
    let document = Arc::new(
        ClassifiedDocument::from_canonical(
            NoteRef {
                space_id: space.clone(),
                note_id: reloaded.note.clone(),
            },
            RevisionId::from_bytes([1; 16]),
            ResourceFacts {
                space: Space {
                    id: space,
                    lifecycle: SpaceLifecycle::Active,
                    kind: SpaceKind::Personal,
                },
                class: DocClass::UserDoc,
                ancestor_folders: vec![],
                folder_write_locked: false,
                ability_package: None,
            },
            Lifecycle::Active,
            source.to_owned(),
            reloaded.source,
        )
        .unwrap(),
    );
    let descriptor = reloaded.descriptor(source, model()).unwrap();
    let part = ContentPart::from_chunk(document, descriptor).unwrap();
    assert_eq!(part.context(), chunk.metadata.context);
    assert_eq!(part.spans(), chunk.metadata.spans);
}

fn write_corrupt(path: &Path, mut bytes: Vec<u8>, rehash: bool) {
    if rehash && bytes.len() >= format::HEADER + format::FOOTER {
        let end = bytes.len() - format::FOOTER;
        let hash = blake3::hash(&bytes[..end]);
        bytes[end..end + 32].copy_from_slice(hash.as_bytes());
    }
    fs::write(path, bytes).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).unwrap();
}

#[test]
fn segment_parser_rejects_truncation_and_corrupt_graph_addresses() {
    let scratch = Scratch::new();
    let path = scratch.0.join("valid");
    drop(write_fixture(&path, 13));
    let valid = fs::read(&path).unwrap();
    let base = format::read_u64(&valid, 80 + 16 * format::BASE) as usize;
    for (index, offset) in [
        0,
        8,
        68,
        80,
        80 + format::UPPER_OFFSETS * 16,
        base,
        base + 4,
    ]
    .into_iter()
    .enumerate()
    {
        let bad = scratch.0.join(format!("corrupt-{index}"));
        let mut bytes = valid.clone();
        bytes[offset] ^= 0xFF;
        write_corrupt(&bad, bytes, true);
        assert!(matches!(
            MmapSegment::open(&bad, &model_hash(&model())),
            Err(VectorError::CorruptIndex)
        ));
    }
    let short = scratch.0.join("short");
    write_corrupt(&short, valid[..130].to_vec(), false);
    assert!(matches!(
        MmapSegment::open(&short, &model_hash(&model())),
        Err(VectorError::CorruptIndex)
    ));
}

#[test]
fn mutable_wal_replays_replacements_and_scrubs_every_purged_frame() {
    let scratch = Scratch::new();
    let note = fixture(1, 64).metadata.note;
    let other = fixture(2, 64).metadata.note;
    let mut buffer = MutableBuffer::open(&scratch.0, 64).unwrap();
    let seq = |value| SpaceSeq::new(value).unwrap();
    buffer
        .apply(
            seq(1),
            MutableOperation::Upsert {
                note: note.clone(),
                chunks: vec![fixture(1, 64)],
            },
        )
        .unwrap();
    buffer
        .apply(
            seq(2),
            MutableOperation::Upsert {
                note: other.clone(),
                chunks: vec![fixture(2, 64)],
            },
        )
        .unwrap();
    buffer
        .apply(seq(3), MutableOperation::Delete(note.clone()))
        .unwrap();
    drop(buffer);
    let mut buffer = MutableBuffer::open(&scratch.0, 64).unwrap();
    assert!(buffer.supersedes(&note));
    assert_eq!(buffer.len(), 1);
    assert_eq!(buffer.last_seq(), seq(3));
    buffer.scrub_note(&note).unwrap();
    let path = scratch.0.join("l0.wal");
    let bytes = fs::read(&path).unwrap();
    assert!(
        !bytes
            .windows(note.as_str().len())
            .any(|window| window == note.as_str().as_bytes())
    );
    assert!(
        bytes
            .windows(other.as_str().len())
            .any(|window| window == other.as_str().as_bytes())
    );
    fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
    assert!(matches!(
        MutableBuffer::open(&scratch.0, 64),
        Err(VectorError::CorruptIndex)
    ));
    buffer.reset_after_flush().unwrap();
    assert!(MutableBuffer::open(&scratch.0, 64).unwrap().is_empty());
}

#[test]
fn tombstones_are_durable_and_validate_slot_bounds() {
    let scratch = Scratch::new();
    let path = scratch.0.join("segment.tomb");
    let mut tombstones = Tombstones::default();
    tombstones.mark(12);
    tombstones.persist(&path).unwrap();
    assert!(Tombstones::open(&path, 13).unwrap().bitmap().contains(12));
    assert!(matches!(
        Tombstones::open(&path, 12),
        Err(VectorError::CorruptIndex)
    ));
    let mut bytes = fs::read(&path).unwrap();
    bytes[0] ^= 1;
    fs::write(&path, bytes).unwrap();
    assert!(matches!(
        Tombstones::open(&path, 13),
        Err(VectorError::CorruptIndex)
    ));
}

#[test]
fn wal_rewrites_obsolete_overwrites_and_replays_the_latest_frame() {
    let scratch = Scratch::new();
    let mut buffer = MutableBuffer::open(&scratch.0, 4096).unwrap();
    let mut chunk = fixture(1, 4096);
    for number in 1u64..=512 {
        let mut digest = [0; 32];
        digest[..8].copy_from_slice(&number.to_le_bytes());
        chunk.metadata.source = ContentDigest::from_bytes(digest);
        buffer
            .apply(
                SpaceSeq::new(number).unwrap(),
                MutableOperation::Upsert {
                    note: chunk.metadata.note.clone(),
                    chunks: vec![chunk.clone()],
                },
            )
            .unwrap();
    }
    assert_eq!(buffer.len(), 1);
    assert!(fs::metadata(scratch.0.join("l0.wal")).unwrap().len() < 1_100_000);
    let reopened = MutableBuffer::open(&scratch.0, 4096).unwrap();
    assert_eq!(reopened.last_seq(), SpaceSeq::new(512).unwrap());
    assert_eq!(reopened.chunks().next().unwrap().metadata, chunk.metadata);
}

#[test]
fn equal_vectors_stay_reachable_in_a_sealed_graph() {
    let scratch = Scratch::new();
    let vector = fixture(0, 64).vector;
    let count = 128;
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    for slot in 0..count {
        let mut chunk = fixture(slot, 64);
        chunk.vector = vector.clone();
        let mut key = [0; 32];
        key[..4].copy_from_slice(&slot.to_le_bytes());
        for salt in 0u32.. {
            key[4..8].copy_from_slice(&salt.to_le_bytes());
            if hnsw::node_level(&key, slot) == u8::from(slot == 0) {
                break;
            }
        }
        chunk.metadata.key = ContentDigest::from_bytes(key);
        builder.push(chunk).unwrap();
    }
    let segment = builder
        .finish(&scratch.0.join("equal.seg"))
        .unwrap()
        .unwrap();
    let mut stack = vec![0];
    let mut seen = Bitmap::new();
    while let Some(slot) = stack.pop() {
        if !seen.contains(slot) {
            seen.add(slot);
            stack.extend(segment.layer0_neighbors(slot));
        }
    }
    assert_eq!(seen.cardinality(), u64::from(count));
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    let mut tail = Bitmap::new();
    tail.add_range(33..count);
    let approximate = segment
        .search_mode(&vector, &tail, 10, budget, false, |_| true)
        .unwrap();
    assert_eq!(approximate.neighbors.len(), 10);
    assert!(approximate.hnsw_hops > 0);
    assert!(
        approximate
            .neighbors
            .iter()
            .all(|row| tail.contains(row.slot))
    );
}

#[test]
fn selective_exact_uses_each_sealed_segment_cardinality() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let mut epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    let vector = fixture(0, 64).vector;
    let count = EXACT_SCAN_LIMIT as u32;
    let rows = (0..count)
        .map(|slot| {
            let mut row = fixture(slot, 64);
            row.metadata.folder = 1;
            row
        })
        .collect();
    epoch
        .seed(
            SegmentBuilder::with_test_rows(&model(), 64, rows),
            SpaceSeq::new(1).unwrap(),
        )
        .unwrap();
    let mut mutable = fixture(count + 1, 64);
    mutable.metadata.folder = 1;
    epoch
        .apply(
            SpaceSeq::new(2).unwrap(),
            MutableOperation::Upsert {
                note: mutable.metadata.note.clone(),
                chunks: vec![mutable],
            },
        )
        .unwrap();
    let folders = Bitmap::of(&[1]);
    let classes = BTreeSet::from([DocClass::UserDoc]);
    let filter = VectorFilter {
        classes: &classes,
        folders: Some(&folders),
        notes: None,
        excluded: None,
    };
    let snapshot = epoch.snapshot();
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    let exact = snapshot.search(&vector, &filter, 10, budget).unwrap();
    assert_eq!(exact.hnsw_hops, 0);
    assert_eq!(exact.hits[0].metadata.note, fixture(0, 64).metadata.note);
}

#[test]
fn exact_ties_survive_compaction_and_the_epoch_rejects_mixed_dimensions() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let directory = layout
        .model_epoch(&VectorModel::local(model(), 64))
        .unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    let first = fixture(1, 64);
    let mut second = fixture(2, 64);
    second.vector = first.vector.clone();
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(second).unwrap();
    epoch.seed(builder, SpaceSeq::new(1).unwrap()).unwrap();
    epoch
        .apply(
            SpaceSeq::new(2).unwrap(),
            MutableOperation::Upsert {
                note: first.metadata.note.clone(),
                chunks: vec![first.clone()],
            },
        )
        .unwrap();
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    let classes = BTreeSet::from([DocClass::UserDoc]);
    let filter = VectorFilter {
        classes: &classes,
        folders: None,
        notes: None,
        excluded: None,
    };
    let best = |epoch: &VectorEpoch| {
        epoch
            .snapshot()
            .search(&first.vector, &filter, 1, budget)
            .unwrap()
            .hits
            .remove(0)
            .metadata
            .note
    };
    assert_eq!(best(&epoch), first.metadata.note);
    epoch.compact().unwrap();
    assert_eq!(best(&epoch), first.metadata.note);
    let id = epoch.snapshot().manifest().active_segments[0];
    let path = directory.join(format!("seg_{id:016x}.seg"));
    drop(epoch);
    fs::remove_file(&path).unwrap();
    let mut wrong = SegmentBuilder::new(&model(), 128).unwrap();
    wrong.push(fixture(1, 128)).unwrap();
    wrong.finish(&path).unwrap().unwrap();
    assert!(matches!(
        VectorEpoch::open(layout, model(), 64),
        Err(VectorError::InvalidDimension)
    ));
}

#[test]
fn direct_segment_upsert_preserves_unrelated_pending_chunks_on_reopen() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let seq = |seq| SpaceSeq::new(seq).unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    let old = fixture(1, 64);
    let other = fixture(2, 64);
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(old.clone()).unwrap();
    epoch.seed(builder, seq(1)).unwrap();
    epoch
        .apply(
            seq(2),
            MutableOperation::Upsert {
                note: other.metadata.note.clone(),
                chunks: vec![other.clone()],
            },
        )
        .unwrap();
    let mut first = fixture(3, 64);
    let mut second = fixture(4, 64);
    first.metadata.note = old.metadata.note.clone();
    second.metadata.note = old.metadata.note.clone();
    let replacement = [first, second];
    epoch
        .apply_large_upsert(seq(3), old.metadata.note.clone(), replacement.to_vec())
        .unwrap();
    drop(epoch);

    let epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    assert!(epoch.is_checkpointed(seq(3)));
    assert!(epoch.matches_note_chunks(&old.metadata.note, &replacement));
    assert!(epoch.matches_note_chunks(&other.metadata.note, std::slice::from_ref(&other)));
}

#[test]
fn large_upsert_is_crash_safe_before_and_after_publish() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let epoch_dir = layout
        .model_epoch(&VectorModel::local(model(), 64))
        .unwrap();
    let seq = |seq| SpaceSeq::new(seq).unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    let old = fixture(1, 64);
    let note = old.metadata.note.clone();
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(old.clone()).unwrap();
    epoch.seed(builder, seq(1)).unwrap();
    let seg1_tomb = epoch_dir.join("seg_0000000000000001.tomb");
    assert!(!seg1_tomb.exists());

    let mut first = fixture(2, 64);
    let mut second = fixture(3, 64);
    first.metadata.note = note.clone();
    second.metadata.note = note.clone();
    let replacement = [first, second];

    // Window 1: publishing fails before epoch_manifest.json rotates.
    // Prior segment tombstones must remain untouched on disk.
    let blocker = epoch_dir.join("block_publish");
    fs::create_dir(&blocker).unwrap();
    assert!(
        epoch
            .apply_large_upsert(seq(2), note.clone(), replacement.to_vec())
            .is_err()
    );
    assert!(
        !seg1_tomb.exists(),
        "failed pre-publish large upsert must not tombstone old segments"
    );
    drop(epoch);
    fs::remove_dir(&blocker).unwrap();

    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    assert!(epoch.is_checkpointed(seq(1)));
    assert!(epoch.matches_note_chunks(&note, std::slice::from_ref(&old)));
    epoch.collect_obsolete().unwrap();
    assert!(!epoch_dir.join("seg_0000000000000002.seg").exists());

    // Window 2: crash after epoch_manifest.json publishes, before old .tomb persists.
    // Reopening must reconcile superseded segments and persist the missing tombstone.
    epoch
        .apply_large_upsert(seq(2), note.clone(), replacement.to_vec())
        .unwrap();
    assert!(seg1_tomb.exists());
    drop(epoch);
    fs::remove_file(&seg1_tomb).unwrap();

    let epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    assert!(
        seg1_tomb.exists(),
        "reopen must persist tombstones for superseded segments"
    );
    assert!(epoch.is_checkpointed(seq(2)));
    assert!(epoch.matches_note_chunks(&note, &replacement));
    let cancellation = Cancellation::default();
    let classes = BTreeSet::from([DocClass::UserDoc]);
    let filter = VectorFilter {
        classes: &classes,
        folders: None,
        notes: None,
        excluded: None,
    };
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let hits = epoch
        .snapshot()
        .search(&old.vector, &filter, 10, budget)
        .unwrap()
        .hits;
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|hit| hit.metadata != old.metadata));
}

#[test]
fn epoch_restarts_compacts_and_scrubs_obsolete_carriers() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let epoch_path = layout
        .model_epoch(&VectorModel::local(model(), 100))
        .unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 100).unwrap();
    let seq = |seq| SpaceSeq::new(seq).unwrap();
    let mut builder = SegmentBuilder::new(&model(), 100).unwrap();
    let first = fixture(1, 100);
    builder.push(first.clone()).unwrap();
    assert_eq!(builder.find_vector(first.metadata.key), Some(&first.vector));
    builder.push(fixture(2, 100)).unwrap();
    epoch.seed(builder, seq(1)).unwrap();

    let mut update = first.clone();
    let note = first.metadata.note.clone();
    update.metadata.spans = vec![ByteSpan::new(10, 21).unwrap()];
    update.vector = epoch.find_vector(first.metadata.key).unwrap();
    epoch
        .apply(
            seq(2),
            MutableOperation::Upsert {
                note: note.clone(),
                chunks: vec![update.clone()],
            },
        )
        .unwrap();
    epoch.checkpoint(seq(2)).unwrap();

    let cancellation = Cancellation::default();
    let classes = BTreeSet::from([DocClass::UserDoc]);
    let filter = VectorFilter {
        excluded: None,
        classes: &classes,
        folders: None,
        notes: None,
    };
    let check = |epoch: &VectorEpoch| {
        let budget = SearchBudget {
            cancellation: &cancellation,
            deadline: Instant::now() + Duration::from_secs(1),
        };
        let result = epoch
            .snapshot()
            .search(&first.vector, &filter, 20, budget)
            .unwrap();
        assert_eq!(result.hits.len(), 2);
        assert_eq!(result.hits[0].metadata, update.metadata);
    };
    check(&epoch);
    drop(epoch);
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 100).unwrap();
    check(&epoch);
    epoch.flush().unwrap();
    check(&epoch);
    assert!(epoch.should_compact());
    epoch.compact().unwrap();
    epoch.collect_obsolete().unwrap();
    check(&epoch);
    assert_eq!(epoch.snapshot().manifest().active_segments.len(), 1);

    epoch.scrub_note(&note, seq(3)).unwrap();
    epoch.collect_obsolete().unwrap();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let result = epoch
        .snapshot()
        .search(&first.vector, &filter, 20, budget)
        .unwrap();
    assert_eq!(result.hits.len(), 1);
    assert_ne!(result.hits[0].metadata.note, note);
    assert!(epoch.find_vector(first.metadata.key).is_none());
    for file in fs::read_dir(epoch_path).unwrap() {
        let bytes = fs::read(file.unwrap().path()).unwrap();
        assert!(
            !bytes
                .windows(note.as_str().len())
                .any(|window| window == note.as_str().as_bytes())
        );
    }
}

#[test]
fn hnsw_traverses_but_never_returns_ineligible_slots() {
    let scratch = Scratch::new();
    let path = scratch.0.join("graph");
    let segment = write_fixture(&path, 100);
    let query = fixture(19, 100).vector;
    let scorer = hnsw::Similarity::new(query.values(), query.scale()).unwrap();
    let cancellation = Cancellation::default();
    let result = hnsw::query_graph(
        &segment,
        scorer,
        0,
        0,
        10,
        SearchBudget {
            cancellation: &cancellation,
            deadline: Instant::now() + Duration::from_secs(1),
        },
        |slot| slot % 2 == 1,
    )
    .unwrap();
    assert!(result.evaluations > 1);
    assert_eq!(result.neighbors.len(), 10);
    assert_eq!(result.neighbors[0].slot, 19);
    assert!(
        result
            .neighbors
            .iter()
            .all(|neighbor| neighbor.slot % 2 == 1)
    );
}

#[test]
fn invisible_chunks_cannot_displace_visible_sealed_or_mutable_hits() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let mut epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    let visible_sealed = fixture(1, 64);
    let visible_mutable = fixture(2, 64);
    let hidden = fixture(0, 64);
    let query = hidden.vector.clone();
    let sealed = std::iter::repeat_n(hidden.clone(), 100)
        .chain([visible_sealed.clone()])
        .collect();
    epoch
        .seed(
            SegmentBuilder::with_test_rows(&model(), 64, sealed),
            SpaceSeq::new(1).unwrap(),
        )
        .unwrap();
    let mut hidden_mutable = fixture(3, 64);
    hidden_mutable.vector = query.clone();
    for (chunk, count) in [(hidden_mutable, 100), (visible_mutable.clone(), 1)] {
        epoch
            .apply(
                SpaceSeq::new(2).unwrap(),
                MutableOperation::Upsert {
                    note: chunk.metadata.note.clone(),
                    chunks: vec![chunk; count],
                },
            )
            .unwrap();
    }
    let classes = BTreeSet::from([DocClass::UserDoc]);
    let filter = VectorFilter {
        classes: &classes,
        folders: None,
        notes: None,
        excluded: None,
    };
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    let expected = BTreeSet::from([visible_sealed.metadata.note, visible_mutable.metadata.note]);
    let hits = epoch
        .snapshot()
        .search_visible(&query, &filter, 100, budget, |note| expected.contains(note))
        .unwrap();
    assert_eq!(hits.hnsw_hops, 0);
    assert_eq!(
        hits.hits
            .into_iter()
            .map(|hit| hit.metadata.note)
            .collect::<BTreeSet<_>>(),
        expected
    );
}

#[test]
fn ann_returns_oversampled_candidates_above_the_exploration_width() {
    let scratch = Scratch::new();
    let query = fixture(0, 64).vector;
    let chunks = (0..2048).map(|slot| fixture(slot, 64)).collect();
    let segment = SegmentBuilder::with_test_rows(&model(), 64, chunks)
        .finish(&scratch.0.join("wide.seg"))
        .unwrap()
        .unwrap();
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    let scorer = hnsw::Similarity::new(query.values(), query.scale()).unwrap();
    for top_k in [260, 800] {
        let result =
            hnsw::query_graph(&segment, scorer, 0, 0, top_k, budget, |slot| slot >= 256).unwrap();
        assert_eq!(result.neighbors.len(), top_k);
        assert!(result.neighbors.iter().all(|hit| hit.slot >= 256));
    }
}

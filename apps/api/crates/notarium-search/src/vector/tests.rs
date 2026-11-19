use super::*;
use crate::layout::SearchLayout;
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
fn epoch_restarts_compacts_and_scrubs_obsolete_carriers() {
    use notarium_core::{epoch::DataRoot, ids::HistoryIncarnation, model::HistoryScope};
    use std::collections::BTreeSet;

    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let epoch_path = layout.model_epoch(&model()).unwrap();
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

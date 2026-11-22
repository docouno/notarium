use super::*;
use crate::layout::{SearchLayout, VectorModel};
use croaring::Bitmap;
use notarium_core::{
    DomainError,
    auth::{ResourceFacts, Space, SpaceKind, SpaceLifecycle},
    classes::{ClassifiedDocument, ContentPart},
    epoch::DataRoot,
    error::ValidationReason,
    ids::{HistoryIncarnation, RevisionId, SpaceId, SpaceSeq},
    model::{HistoryScope, Lifecycle, NoteRef},
};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Self {
        let mut entropy = [0; 16];
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
    #[cfg(unix)]
    {
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(path, permissions).unwrap();
    }
}

#[test]
fn segment_parser_rejects_truncation_and_corrupt_graph_addresses() {
    let scratch = Scratch::new();
    let path = scratch.0.join("valid");
    drop(write_fixture(&path, 13));
    let valid = fs::read(&path).unwrap();
    let base = format::read_u64(&valid, 80 + 16 * format::BASE) as usize;
    let entry = format::read_u32(&valid, 68) as usize;
    let entry_base = base + entry * format::BASE_ROW_BYTES;

    // Header and section corruption fails on open even with a rehashed footer.
    for (index, offset) in [0, 8, 68, 80, 80 + format::UPPER_OFFSETS * 16]
        .into_iter()
        .enumerate()
    {
        let bad = scratch.0.join(format!("corrupt-header-{index}"));
        let mut bytes = valid.clone();
        bytes[offset] ^= 0xFF;
        write_corrupt(&bad, bytes, true);
        assert!(matches!(
            MmapSegment::open(&bad, &model_hash(&model())),
            Err(VectorError::CorruptIndex)
        ));
    }

    // Unrehashed body corruption is caught by the single-pass BLAKE3 check on open.
    for (index, offset) in [entry_base, entry_base + 4].into_iter().enumerate() {
        let bad = scratch.0.join(format!("corrupt-body-bitrot-{index}"));
        let mut bytes = valid.clone();
        bytes[offset] ^= 0xFF;
        write_corrupt(&bad, bytes, false);
        assert!(matches!(
            MmapSegment::open(&bad, &model_hash(&model())),
            Err(VectorError::CorruptIndex)
        ));
    }

    // Forged rehashed graph corruption is caught without panic by checked accessors.
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let query = fixture(0, 100).vector;
    for (index, offset) in [entry_base, entry_base + 4].into_iter().enumerate() {
        let bad = scratch.0.join(format!("corrupt-body-forged-{index}"));
        let mut bytes = valid.clone();
        bytes[offset] ^= 0xFF;
        write_corrupt(&bad, bytes, true);
        let opened = MmapSegment::open(&bad, &model_hash(&model())).unwrap();
        let search = opened.search_mode(
            &query,
            &mmap_segment::SlotMask::All(opened.len()),
            5,
            1,
            budget,
            false,
            |_| Ok(true),
        );
        assert!(matches!(search, Err(VectorError::CorruptIndex)));
    }

    let short = scratch.0.join("short");
    write_corrupt(&short, valid[..130].to_vec(), false);
    assert!(matches!(
        MmapSegment::open(&short, &model_hash(&model())),
        Err(VectorError::CorruptIndex)
    ));
}

#[test]
fn mutable_wal_replays_replacements_and_resets_after_flush() {
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
    let path = scratch.0.join("l0.wal");
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, &bytes[..bytes.len() - 1]).unwrap();
    assert!(matches!(
        MutableBuffer::open(&scratch.0, 64),
        Err(VectorError::CorruptIndex)
    ));
    buffer.reset_after_flush().unwrap();
    assert!(MutableBuffer::open(&scratch.0, 64).unwrap().is_empty());
}

#[test]
fn truncated_17_byte_wal_header_with_max_len_fails_without_oom() {
    let scratch = Scratch::new();
    let mut header = Vec::with_capacity(17);
    header.extend_from_slice(b"L0W1");
    header.push(1);
    header.extend_from_slice(&1u64.to_le_bytes());
    header.extend_from_slice(&(32u32 * 1024 * 1024).to_le_bytes());
    assert_eq!(header.len(), 17);
    fs::write(scratch.0.join("l0.wal"), &header).unwrap();

    let mut result = None;
    let stats = allocation_counter::measure(|| {
        result = Some(MutableBuffer::open(&scratch.0, 64));
    });
    assert!(matches!(result, Some(Err(VectorError::CorruptIndex))));
    assert!(
        stats.bytes_total < 1024 * 1024,
        "truncated WAL header must not pre-allocate 32 MiB; allocated {} bytes",
        stats.bytes_total
    );
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
        .search_mode(
            &vector,
            &mmap_segment::SlotMask::Ref(&tail),
            10,
            1,
            budget,
            false,
            |_| Ok(true),
        )
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
    crate::layout::remove_path_if_exists(&path).unwrap();
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
fn epoch_restarts_and_compacts_obsolete_carriers() {
    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([1; 16]),
        incarnation: HistoryIncarnation::from_bytes([1; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 100).unwrap();
    let seq = |seq| SpaceSeq::new(seq).unwrap();
    let mut builder = SegmentBuilder::new(&model(), 100).unwrap();
    let first = fixture(1, 100);
    builder.push(first.clone()).unwrap();
    assert_eq!(
        builder.find_vector(first.metadata.key),
        Some(first.vector.clone())
    );
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
                note,
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
    let mut epoch = VectorEpoch::open(layout, model(), 100).unwrap();
    check(&epoch);
    epoch.flush().unwrap();
    check(&epoch);
    assert!(epoch.should_compact());
    epoch.compact().unwrap();
    epoch.collect_obsolete().unwrap();
    check(&epoch);
    assert_eq!(epoch.snapshot().manifest().active_segments.len(), 1);
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
        1,
        SearchBudget {
            cancellation: &cancellation,
            deadline: Instant::now() + Duration::from_secs(1),
        },
        |slot| Ok(slot % 2 == 1),
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
        .search_visible(&query, &filter, 100, budget, |note| {
            Ok(expected.contains(note))
        })
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
        let result = hnsw::query_graph(&segment, scorer, 0, 0, top_k, 1, budget, |slot| {
            Ok(slot >= 256)
        })
        .unwrap();
        assert_eq!(result.neighbors.len(), top_k);
        assert!(result.neighbors.iter().all(|hit| hit.slot >= 256));
    }
}

#[test]
fn key_index_handles_eight_byte_prefix_collisions_with_full_digest_check() {
    let scratch = Scratch::new();
    let path = scratch.0.join("collide.seg");
    let make_key = |suffix: u8| {
        let mut bytes = [0xABu8; 32];
        bytes[8..].fill(suffix);
        ContentDigest::from_bytes(bytes)
    };
    let mut c1 = fixture(1, 64);
    let mut c2 = fixture(2, 64);
    let mut c3 = fixture(3, 64);
    let mut dup_c2 = fixture(4, 64);
    c1.metadata.key = make_key(1);
    c2.metadata.key = make_key(2);
    c3.metadata.key = make_key(3);
    dup_c2.metadata.key = make_key(2);
    dup_c2.vector = c2.vector.clone();

    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    for chunk in [&c1, &c2, &c3, &dup_c2] {
        builder.push(chunk.clone()).unwrap();
    }
    let sealed = builder.finish(&path).unwrap().unwrap();
    let reopened = MmapSegment::open(&path, &model_hash(&model())).unwrap();
    for seg in [&sealed, &reopened] {
        assert_eq!(seg.find_vector(c1.metadata.key), Some(c1.vector.clone()));
        assert_eq!(seg.find_vector(c2.metadata.key), Some(c2.vector.clone()));
        assert_eq!(seg.find_vector(c3.metadata.key), Some(c3.vector.clone()));
        assert_eq!(seg.find_vector(make_key(99)), None);
    }
}

#[test]
fn slot_mask_fast_paths_selective_visibility_and_fallible_errors() {
    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([2; 16]),
        incarnation: HistoryIncarnation::from_bytes([2; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let mut epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    let rows: Vec<_> = (0..64)
        .map(|slot| {
            let mut row = fixture(slot, 64);
            row.metadata.class = if slot % 4 == 0 {
                DocClass::AgentMemory
            } else {
                DocClass::UserDoc
            };
            row
        })
        .collect();
    epoch
        .seed(
            SegmentBuilder::with_test_rows(&model(), 64, rows),
            SpaceSeq::new(1).unwrap(),
        )
        .unwrap();

    let snapshot = epoch.snapshot();
    let cancellation = Cancellation::default();
    let budget = SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(1),
    };
    let query = fixture(0, 64).vector;

    // Fast path SlotMask::All (all 4 non-encrypted classes, no filters).
    let all_classes = BTreeSet::from([
        DocClass::UserDoc,
        DocClass::AgentMemory,
        DocClass::Skill,
        DocClass::Profile,
    ]);
    let all_filter = VectorFilter {
        classes: &all_classes,
        folders: None,
        notes: None,
        excluded: None,
    };
    assert_eq!(
        snapshot
            .search(&query, &all_filter, 64, budget)
            .unwrap()
            .hits
            .len(),
        64
    );

    // Fast path SlotMask::Ref (single UserDoc class, no filters).
    let user_only = BTreeSet::from([DocClass::UserDoc]);
    let user_filter = VectorFilter {
        classes: &user_only,
        folders: None,
        notes: None,
        excluded: None,
    };
    assert_eq!(
        snapshot
            .search(&query, &user_filter, 64, budget)
            .unwrap()
            .hits
            .len(),
        48
    );

    // Fallible visibility propagates DomainError instead of silently dropping hits.
    let err = snapshot.search_visible(&query, &user_filter, 10, budget, |_| {
        Err(VectorError::Domain(DomainError::validation(
            ValidationReason::NotReady,
        )))
    });
    assert!(matches!(err, Err(VectorError::Domain(_))));

    // HNSW mode with selective visibility returns bounded graph hits directly
    // without falling back to exact linear scan.
    let seg_path = scratch.0.join("hnsw_only.seg");
    let seg = SegmentBuilder::with_test_rows(
        &model(),
        64,
        (0..64).map(|slot| fixture(slot, 64)).collect(),
    )
    .finish(&seg_path)
    .unwrap()
    .unwrap();
    let mut checks = 0usize;
    let res = seg
        .search_mode(
            &query,
            &mmap_segment::SlotMask::All(seg.len()),
            20,
            1,
            budget,
            false,
            |slot| {
                checks += 1;
                Ok(slot == 0)
            },
        )
        .unwrap();
    assert!(res.hnsw_hops > 0);
    assert_eq!(res.neighbors.len(), 1);
    assert_eq!(res.neighbors[0].slot, 0);
    assert!(checks <= seg.len() as usize);
}

#[test]
fn non_blocking_compaction_and_flush_support_cancellation_and_concurrent_writes() {
    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([3; 16]),
        incarnation: HistoryIncarnation::from_bytes([3; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let seq = |n| SpaceSeq::new(n).unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    let c1 = fixture(1, 64);
    let c2 = fixture(2, 64);
    let c3 = fixture(3, 64);
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(c1.clone()).unwrap();
    builder.push(c2.clone()).unwrap();
    epoch.seed(builder, seq(1)).unwrap();

    // Update c1 and flush so segment 1 becomes dead-heavy (1/2 > 20%).
    let mut c1_v2 = c1.clone();
    c1_v2.metadata.spans = vec![ByteSpan::new(10, 22).unwrap()];
    epoch
        .apply(
            seq(2),
            MutableOperation::Upsert {
                note: c1.metadata.note.clone(),
                chunks: vec![c1_v2.clone()],
            },
        )
        .unwrap();
    epoch.flush().unwrap();
    assert!(epoch.should_compact());

    // 1. Cancelled plan leaves epoch segments intact.
    let before_segments = epoch.snapshot().manifest().active_segments.clone();
    let plan = epoch.plan_compact().expect("compaction plan");
    let cancelled = Cancellation::default();
    cancelled.cancel();
    assert!(matches!(
        plan.execute(&cancelled),
        Err(VectorError::Cancelled)
    ));
    assert_eq!(epoch.snapshot().manifest().active_segments, before_segments);

    // 2. Live concurrent update during compaction is preserved when committing.
    let plan = epoch.plan_compact().expect("compaction plan");
    let live_cancel = Cancellation::default();
    let replacement = plan.execute(&live_cancel).unwrap();
    let mut c2_v2 = c2.clone();
    c2_v2.metadata.spans = vec![ByteSpan::new(11, 25).unwrap()];
    epoch
        .apply(
            seq(3),
            MutableOperation::Upsert {
                note: c2.metadata.note.clone(),
                chunks: vec![c2_v2.clone()],
            },
        )
        .unwrap();
    let dirty = HashSet::from([c2.metadata.note.clone()]);
    epoch.commit_compaction(plan, replacement, &dirty).unwrap();
    assert!(epoch.matches_note_chunks(&c2.metadata.note, std::slice::from_ref(&c2_v2)));
    assert!(epoch.matches_note_chunks(&c1.metadata.note, std::slice::from_ref(&c1_v2)));

    // 3. Non-blocking FlushL0 preserves a concurrent same-SpaceSeq overwrite.
    let flush_plan = epoch.plan_flush_l0().unwrap().expect("flush plan");
    let flush_seg = flush_plan.execute(&live_cancel).unwrap();
    let mut c2_v3 = c2.clone();
    c2_v3.metadata.spans = vec![ByteSpan::new(12, 26).unwrap()];
    epoch
        .apply_batch(
            seq(3),
            vec![
                MutableOperation::Upsert {
                    note: c2.metadata.note.clone(),
                    chunks: vec![c2_v3.clone()],
                },
                MutableOperation::Upsert {
                    note: c3.metadata.note.clone(),
                    chunks: vec![c3.clone()],
                },
            ],
        )
        .unwrap();
    let flush_dirty = HashSet::from([c2.metadata.note.clone(), c3.metadata.note.clone()]);
    epoch
        .commit_flush_l0(flush_plan, flush_seg, &flush_dirty)
        .unwrap();
    assert!(epoch.matches_note_chunks(&c2.metadata.note, std::slice::from_ref(&c2_v3)));
    assert!(epoch.matches_note_chunks(&c3.metadata.note, std::slice::from_ref(&c3)));
    drop(epoch);

    let reopened = VectorEpoch::open(layout, model(), 64).unwrap();
    assert!(reopened.matches_note_chunks(&c2.metadata.note, std::slice::from_ref(&c2_v3)));
    assert!(reopened.matches_note_chunks(&c3.metadata.note, std::slice::from_ref(&c3)));
}

#[test]
fn quantize_preserves_small_nonzero_vectors_without_1e12_clipping() {
    for magnitude in [1e-20_f32, f32::MIN_POSITIVE, f32::from_bits(1)] {
        let mut values = [0.0f32; 64];
        values[0] = magnitude;
        let q = QuantizedVector::quantize(&values).unwrap();
        assert!(q.scale() > 0.0 && q.scale() <= 1.0);
        let dot = simd::dot_i8_scalar(q.values(), q.values()).unwrap();
        let cosine = dot as f32 * q.scale() * q.scale();
        assert!(
            cosine > 0.99,
            "expected unit self-cosine for {magnitude:e}, got {cosine}"
        );
    }
    assert!(matches!(
        QuantizedVector::quantize(&[0.0f32; 64]),
        Err(VectorError::InvalidVector)
    ));
    assert!(matches!(
        QuantizedVector::quantize(&[f32::NAN; 64]),
        Err(VectorError::InvalidVector)
    ));
}

#[test]
fn collect_obsolete_cleans_orphan_temps_and_ignores_ds_store() {
    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([4; 16]),
        incarnation: HistoryIncarnation::from_bytes([4; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let epoch_dir = layout
        .model_epoch(&VectorModel::local(model(), 64))
        .unwrap();
    let mut epoch = VectorEpoch::open(layout.clone(), model(), 64).unwrap();
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(fixture(1, 64)).unwrap();
    epoch.seed(builder, SpaceSeq::new(1).unwrap()).unwrap();

    let temps = [
        ".segment-99-0.tmp",
        "l0.wal.99.0.tmp",
        "seg_0000000000000001.tomb.99.0.tmp",
        "epoch_manifest.json.99.0.tmp",
    ];
    for name in temps {
        fs::write(epoch_dir.join(name), b"orphan").unwrap();
    }
    fs::write(epoch_dir.join(".DS_Store"), b"finder").unwrap();

    epoch.collect_obsolete().unwrap();
    for name in temps {
        assert!(!epoch_dir.join(name).exists(), "{name} should be removed");
    }
    assert!(epoch_dir.join(".DS_Store").exists());
    drop(epoch);
    assert!(VectorEpoch::open(layout, model(), 64).is_ok());
}

#[test]
fn metadata_caps_context_spans_and_oversized_notes_bypass_wal_limit() {
    let mut bad = fixture(1, 64);
    bad.metadata.context = (0..=MAX_CONTEXT_SPANS)
        .map(|i| ByteSpan::new(i, i + 1).unwrap())
        .collect();
    assert!(matches!(
        bad.metadata.validate(),
        Err(VectorError::InvalidChunk)
    ));

    let scratch = Scratch::new();
    let buffer = MutableBuffer::open(&scratch.0, 4096).unwrap();
    let sample = fixture(1, 4096);
    let oversized = MutableOperation::Upsert {
        note: sample.metadata.note.clone(),
        chunks: vec![sample; 4_200],
    };
    assert!(buffer.exceeds_single_limit(&oversized));
    assert_eq!(L0_MAX_BYTES, 16 * 1024 * 1024);
}

#[test]
fn l0_soft_flush_headroom_and_bounded_delete_overflow() {
    assert_eq!(L0_FLUSH_CHUNKS, 20_000);
    assert_eq!(L0_FLUSH_BYTES, 12 * 1024 * 1024);
    assert_eq!(L0_MAX_CHUNKS, 25_000);
    assert_eq!(L0_MAX_BYTES, 16 * 1024 * 1024);

    let seq = |n| SpaceSeq::new(n).unwrap();
    let note_id = |index: u32| {
        let mut bytes = [0u8; 16];
        bytes[12..].copy_from_slice(&index.to_be_bytes());
        NoteId::from_bytes(bytes)
    };

    // 1. MutableBuffer triggers should_flush at L0_FLUSH_BYTES (12 MiB) while
    // retaining 4 MiB headroom for Upserts before L0_MAX_BYTES (16 MiB).
    // Without active-plan headroom, both Upserts and Deletes hit BufferFull at
    // L0_MAX_BYTES; with active-plan headroom, Delete overflow succeeds up to
    // 2 * L0_MAX_BYTES and replays cleanly on reopen.
    let scratch = Scratch::new();
    let mut buffer = MutableBuffer::open(&scratch.0, 4096).unwrap();
    let base_chunk = fixture(1, 4096);
    let make_upsert = |index: u32, count: usize| {
        let mut chunk = base_chunk.clone();
        let note = note_id(index);
        chunk.metadata.note = note.clone();
        MutableOperation::Upsert {
            note,
            chunks: vec![chunk; count],
        }
    };
    let initial: Vec<_> = (1..=30).map(|i| make_upsert(i, 100)).collect();
    buffer.apply_batch(seq(1), initial).unwrap();
    assert!(buffer.mem_bytes() >= L0_FLUSH_BYTES);
    assert!(buffer.mem_bytes() < L0_MAX_BYTES);
    assert!(buffer.should_flush(Instant::now()));

    // Upsert within the 4 MiB headroom succeeds.
    buffer.apply(seq(2), make_upsert(31, 100)).unwrap();
    assert!(buffer.mem_bytes() < L0_MAX_BYTES);

    // Fill close to L0_MAX_BYTES (39 notes ~= 15.95 MiB): both Upsert and
    // unguarded Delete overflow return BufferFull.
    let fill: Vec<_> = (32..=39).map(|i| make_upsert(i, 100)).collect();
    buffer.apply_batch(seq(3), fill).unwrap();
    assert!(matches!(
        buffer.apply(seq(4), make_upsert(40, 100)),
        Err(VectorError::BufferFull)
    ));
    let deletes = || -> Vec<MutableOperation> {
        (10_000..15_000)
            .map(|i| MutableOperation::Delete(note_id(i)))
            .collect()
    };
    assert!(matches!(
        buffer.apply_batch(seq(4), deletes()),
        Err(VectorError::BufferFull)
    ));

    // Active-plan Delete headroom accepts the batch above L0_MAX_BYTES and replays.
    buffer
        .apply_batch_with_delete_headroom(seq(4), deletes(), true)
        .unwrap();
    assert!(buffer.mem_bytes() > L0_MAX_BYTES);
    drop(buffer);
    let reopened = MutableBuffer::open(&scratch.0, 4096).unwrap();
    assert!(reopened.mem_bytes() > L0_MAX_BYTES);
    assert!(reopened.supersedes(&note_id(14_999)));

    // 2. Without an active plan, a Delete-only stream exceeding L0_MAX_CHUNKS
    // triggers a delete-only flush (tombstones + WAL reset, no new segment),
    // keeping MutableBuffer strictly bounded.
    let no_plan_scratch = Scratch::new();
    let no_plan_scope = HistoryScope {
        space_id: SpaceId::from_bytes([4; 16]),
        incarnation: HistoryIncarnation::from_bytes([4; 16]),
    };
    let no_plan_layout =
        Arc::new(SearchLayout::open(&DataRoot::new(&no_plan_scratch.0), no_plan_scope).unwrap());
    let mut no_plan_epoch = VectorEpoch::open(no_plan_layout, model(), 64).unwrap();
    let mut seed_builder = SegmentBuilder::new(&model(), 64).unwrap();
    let kept_chunk = fixture(5, 64);
    for idx in 1..=5 {
        seed_builder.push(fixture(idx, 64)).unwrap();
    }
    no_plan_epoch.seed(seed_builder, seq(1)).unwrap();
    for page in 0u32..26 {
        let start = page * 1_000 + 1;
        let ops: Vec<_> = (start..start + 1_000)
            .filter(|&id| id != 5)
            .map(|id| MutableOperation::Delete(note_id(id)))
            .collect();
        no_plan_epoch
            .apply_batch(seq(u64::from(page) + 2), ops)
            .unwrap();
    }
    assert_eq!(
        no_plan_epoch.snapshot().manifest().active_segments.len(),
        1,
        "delete-only L0 flush must not build a new segment"
    );
    assert!(
        no_plan_epoch.mutable_entry_count() < L0_MAX_CHUNKS,
        "mass Delete stream without active plan must flush and bound MutableBuffer"
    );
    assert!(no_plan_epoch.matches_note_chunks(&note_id(1), &[]));
    assert!(
        no_plan_epoch
            .matches_note_chunks(&kept_chunk.metadata.note, std::slice::from_ref(&kept_chunk),)
    );

    // 3. With an active FlushL0 plan, Delete-only batches may overflow up to
    // 2 * L0_MAX_CHUNKS without forcing a duplicate sync flush, and reject
    // above the 2 * L0_MAX_CHUNKS hard cap with BufferFull.
    let epoch_scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([5; 16]),
        incarnation: HistoryIncarnation::from_bytes([5; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&epoch_scratch.0), scope).unwrap());
    let epoch_dir = layout
        .model_epoch(&VectorModel::local(model(), 64))
        .unwrap();
    let mut epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    let live_chunk = fixture(1, 64);
    let mut ops = Vec::with_capacity(L0_FLUSH_CHUNKS);
    ops.push(MutableOperation::Upsert {
        note: live_chunk.metadata.note.clone(),
        chunks: vec![live_chunk.clone()],
    });
    for i in 2..=(L0_FLUSH_CHUNKS as u32) {
        ops.push(MutableOperation::Delete(note_id(i)));
    }
    epoch.apply_batch(seq(1), ops).unwrap();
    assert!(epoch.should_flush(Instant::now()));

    let plan = epoch.plan_flush_l0().unwrap().expect("flush plan");
    let concurrent_deletes: Vec<_> = (100_000..110_000)
        .map(|i| MutableOperation::Delete(note_id(i)))
        .collect();
    epoch.apply_batch(seq(2), concurrent_deletes).unwrap();
    assert!(
        epoch.snapshot().manifest().active_segments.is_empty(),
        "Delete-only batch during FlushL0 must not force a duplicate sync flush"
    );
    assert_eq!(epoch.mutable_entry_count(), 30_000);

    // Crash-recovery replay of the >L0_MAX_CHUNKS WAL written during FlushL0 succeeds.
    let replayed = MutableBuffer::open(&epoch_dir, 64).unwrap();
    assert_eq!(replayed.notes().count(), 30_000);

    // Exceeding the 2 * L0_MAX_CHUNKS hard cap during an active plan fails closed.
    let excessive_deletes: Vec<_> = (200_000..221_000)
        .map(|i| MutableOperation::Delete(note_id(i)))
        .collect();
    assert!(matches!(
        epoch.apply_batch(seq(3), excessive_deletes),
        Err(VectorError::BufferFull)
    ));

    let replacement = plan.execute(&Cancellation::default()).unwrap();
    epoch
        .commit_flush_l0(plan, replacement, &HashSet::new())
        .unwrap();
    assert_eq!(epoch.snapshot().manifest().active_segments.len(), 1);
    assert_eq!(epoch.mutable_entry_count(), 10_000);
    assert!(
        epoch.matches_note_chunks(&live_chunk.metadata.note, std::slice::from_ref(&live_chunk),)
    );
}

#[test]
fn active_plan_prevents_overlap_and_reopen_skips_fully_tombstoned_newer_notes() {
    let seq = |n| SpaceSeq::new(n).unwrap();

    // 1. Active plan flag forbids overlapping FlushL0 and Compaction plans, and
    // releases on execute error, Drop, and commit.
    let scratch = Scratch::new();
    let scope = HistoryScope {
        space_id: SpaceId::from_bytes([6; 16]),
        incarnation: HistoryIncarnation::from_bytes([6; 16]),
    };
    let layout = Arc::new(SearchLayout::open(&DataRoot::new(&scratch.0), scope).unwrap());
    let mut epoch = VectorEpoch::open(layout, model(), 64).unwrap();
    let c1 = fixture(1, 64);
    let c2 = fixture(2, 64);
    let mut builder = SegmentBuilder::new(&model(), 64).unwrap();
    builder.push(c1.clone()).unwrap();
    builder.push(c2.clone()).unwrap();
    epoch.seed(builder, seq(1)).unwrap();

    let mut c1_v2 = c1.clone();
    c1_v2.metadata.spans = vec![ByteSpan::new(10, 22).unwrap()];
    epoch
        .apply(
            seq(2),
            MutableOperation::Upsert {
                note: c1.metadata.note.clone(),
                chunks: vec![c1_v2],
            },
        )
        .unwrap();
    epoch.flush().unwrap();
    assert!(epoch.should_compact());

    let mut c2_v2 = c2.clone();
    c2_v2.metadata.spans = vec![ByteSpan::new(11, 24).unwrap()];
    epoch
        .apply(
            seq(3),
            MutableOperation::Upsert {
                note: c2.metadata.note.clone(),
                chunks: vec![c2_v2.clone()],
            },
        )
        .unwrap();

    let flush_plan = epoch.plan_flush_l0().unwrap().expect("flush plan");
    assert!(epoch.plan_compact().is_none());
    assert!(epoch.plan_flush_l0().unwrap().is_none());
    assert!(matches!(epoch.flush(), Err(VectorError::BufferFull)));

    let cancelled = Cancellation::default();
    cancelled.cancel();
    assert!(matches!(
        flush_plan.execute(&cancelled),
        Err(VectorError::Cancelled)
    ));
    // Guard released on execute error even while flush_plan stays in scope.
    let compact_plan = epoch.plan_compact().expect("compact plan after cancel");
    assert!(epoch.plan_flush_l0().unwrap().is_none());
    assert!(epoch.plan_compact().is_none());
    // Dropping the plan without committing releases the guard.
    drop(compact_plan);

    let compact_plan = epoch.plan_compact().expect("compact plan after drop");
    let replacement = compact_plan.execute(&Cancellation::default()).unwrap();
    epoch
        .commit_compaction(compact_plan, replacement, &HashSet::new())
        .unwrap();
    let flush_plan2 = epoch
        .plan_flush_l0()
        .unwrap()
        .expect("flush plan after commit");
    let flush_seg = flush_plan2.execute(&Cancellation::default()).unwrap();
    epoch
        .commit_flush_l0(flush_plan2, flush_seg, &HashSet::new())
        .unwrap();
    assert!(epoch.matches_note_chunks(&c2.metadata.note, std::slice::from_ref(&c2_v2)));

    // 2. Reopen reconciliation must skip notes whose slots are all tombstoned
    // in a newer segment (both merge and small-newer binary-search branches).
    for (tag, older_count) in [(7u8, 2u32), (8u8, 25u32)] {
        let reopen_scratch = Scratch::new();
        let reopen_scope = HistoryScope {
            space_id: SpaceId::from_bytes([tag; 16]),
            incarnation: HistoryIncarnation::from_bytes([tag; 16]),
        };
        let reopen_layout =
            Arc::new(SearchLayout::open(&DataRoot::new(&reopen_scratch.0), reopen_scope).unwrap());
        let epoch_dir = reopen_layout
            .model_epoch(&VectorModel::local(model(), 64))
            .unwrap();
        let mut reopen_epoch = VectorEpoch::open(reopen_layout.clone(), model(), 64).unwrap();

        let mut a_v2 = fixture(1, 64);
        a_v2.metadata.spans = vec![ByteSpan::new(10, 22).unwrap()];
        let mut older_rows = vec![a_v2.clone()];
        for idx in 2..=older_count {
            older_rows.push(fixture(idx, 64));
        }
        let seg1 = SegmentBuilder::with_test_rows(&model(), 64, older_rows)
            .finish(&segment_file_path(&epoch_dir, 1))
            .unwrap()
            .unwrap();

        let a_v1 = fixture(1, 64);
        let newer_rows = if older_count == 2 {
            vec![a_v1.clone(), fixture(100, 64)]
        } else {
            vec![a_v1.clone()]
        };
        let seg2 = SegmentBuilder::with_test_rows(&model(), 64, newer_rows)
            .finish(&segment_file_path(&epoch_dir, 2))
            .unwrap()
            .unwrap();
        let mut tomb2 = Tombstones::default();
        for slot in seg2.note_slots(&a_v1.metadata.note).unwrap() {
            tomb2.mark(slot);
        }
        tomb2
            .persist(&epoch_dir.join("seg_0000000000000002.tomb"))
            .unwrap();

        reopen_epoch
            .seed_segments(vec![(1, seg1), (2, seg2)], seq(1))
            .unwrap();
        drop(reopen_epoch);

        let reopened = VectorEpoch::open(reopen_layout, model(), 64).unwrap();
        assert!(
            !epoch_dir.join("seg_0000000000000001.tomb").exists(),
            "fully tombstoned note in newer segment must not tombstone live note in older segment"
        );
        assert!(reopened.matches_note_chunks(&a_v2.metadata.note, std::slice::from_ref(&a_v2)));
    }
}

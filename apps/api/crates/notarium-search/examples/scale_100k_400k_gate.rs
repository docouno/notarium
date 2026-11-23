//! Offline release gate for the search index and retrieval kernels.

#![recursion_limit = "256"]

#[path = "search_scale/priority.rs"]
mod priority;
#[path = "search_scale/support.rs"]
mod support;

use croaring::Bitmap;
use notarium_core::{
    auth::ResourceFacts,
    classes::{ClassEgressFence, ClassifiedDocument, DocClass},
    ids::{ContentDigest, NoteId},
    model::{Lifecycle, NoteRef},
    ports::{Cancellation, ServiceAuthority, ServicePurpose, StructuralSnapshot},
    span::ByteSpan,
};
use notarium_search::{
    fuse_search_candidates,
    layout::{FolderDictionary, SearchLayout, SearchManifest, VectorModel, index_name},
    lexical::{
        HitKey, LexicalFilter, LexicalHit, LexicalIndex, TOKENIZER_VERSION, Update, WriterPool,
    },
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{
        ChunkMetadata, EXACT_SCAN_LIMIT, MutableOperation, ProjectedVectorFilter, QuantizedVector,
        SearchBudget, SegmentBuilder, VectorChunk, VectorEpoch, VectorFilter, VectorHit,
        search_candidate_limit, segment_file_path,
        simd::{Kernel, dot_i8_scalar},
    },
};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    error::Error,
    fs,
    sync::Arc,
    time::{Duration, Instant},
};
use support::{Fixture, PeakDisk, Scratch};

const NOTES: u32 = 100_000;
const CHUNKS: u32 = 4;
const DIMENSION: usize = 384;
const TOPICS: u32 = 1_024;
const SAMPLES: u32 = 48;
const PAGE: u32 = 1_000;
const TOP_K: usize = 20;
const CANDIDATES: usize = search_candidate_limit(TOP_K);
const DISK_LIMIT: u64 = 400 * 1024 * 1024;
const REOPEN_ANON_RSS_LIMIT_KIB: u64 = 512 * 1024;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<(), Box<dyn Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let smoke = arguments.iter().any(|arg| arg == "--smoke");
    let argument = |key| {
        arguments
            .windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| pair[1].as_str())
            .filter(|value| !value.is_empty())
    };
    let tree = argument("--tree");
    let count = match argument("--notes") {
        Some(raw) => raw.parse::<u32>()?,
        None if smoke => 5_000,
        None => NOTES,
    };
    if count < 100 {
        return Err("--notes must be at least 100".into());
    }
    let selective_slots = (count * CHUNKS).min(EXACT_SCAN_LIMIT as u32);
    let scratch = Scratch::new()?;
    let fixture = Fixture::open(scratch.root(), count).await?;
    let peak = PeakDisk::start(scratch.root().root());
    let started = Instant::now();
    let (index, epoch, built_segments) = build(&fixture, count)?;
    let build_ms = started.elapsed().as_millis();
    let memory_after_build = ProcessMemory::sample();
    let samples = if smoke { 8 } else { SAMPLES };
    let metrics = run_samples(&fixture, &index, &epoch, samples, selective_slots).await?;
    drop((epoch, index));

    let (reopen_ms, memory_after_reopen) = measure_warm_reopen(&fixture)?;
    let movement = fixture.move_folder().await?;
    let (compact_ms, compacted_segments, memory_after_compact) = measure_compaction(&fixture)?;
    let peak_bytes = peak.finish();
    eprintln!("Measuring embedding queue priority");
    let (foreground, queued_on_release) = priority::measure(&fixture).await?;
    fixture.shutdown().await?;

    let browse_lookup_cap = (TOP_K * 16).max(256);
    let reopen_rss_ok = memory_after_reopen
        .as_ref()
        .and_then(|mem| mem.rss_anon_kib)
        .is_none_or(|kib| kib <= REOPEN_ANON_RSS_LIMIT_KIB);
    let ok = metrics.lexical.p95() < 40.0
        && metrics.broad_lexical_latency.p95() < 40.0
        && metrics.hybrid.p95() < 95.0
        && metrics.selective.p95() < 1.5
        && metrics.hybrid_recall >= 0.95
        && metrics.ann_recall >= 0.90
        && (metrics.selective_recall - 1.0).abs() < f64::EPSILON
        && metrics.quantization_recall >= 0.85
        && metrics.browse_lookups <= browse_lookup_cap
        && metrics.broad_lexical_lookups < count as usize
        && movement.0 == 0
        && movement.1 == 0
        && movement.2 > 0
        && foreground == 16
        && peak_bytes < DISK_LIMIT
        && reopen_rss_ok;
    let report = json!({
        "profile": if smoke { "smoke" } else { "full" },
        "tree": tree,
        "notes": count,
        "chunks": count * CHUNKS,
        "built_vector_segments": built_segments,
        "sample_count": samples,
        "dimension": DIMENSION,
        "top_k": TOP_K,
        "lexical_candidates": CANDIDATES,
        "build_ms": build_ms,
        "reopen_ms": reopen_ms,
        "compact_ms": compact_ms,
        "compacted_segments": compacted_segments,
        "peak_index_bytes": peak_bytes,
        "disk_sample_interval_ms": PeakDisk::INTERVAL_MS,
        "memory_after_build": memory_after_build.as_ref().map(ProcessMemory::report),
        "memory_after_reopen": memory_after_reopen.as_ref().map(ProcessMemory::report),
        "memory_after_compact": memory_after_compact.as_ref().map(ProcessMemory::report),
        "workspace_cpu_quota": argument("--host-cpu"),
        "workspace_memory_quota_bytes": argument("--host-memory"),
        "runner_cpu_quota": cgroup("cpu.max"),
        "runner_memory_quota_bytes": cgroup("memory.max"),
        "simd": format!("{:?}", Kernel::detect()),
        "lexical_ms": metrics.lexical.report(),
        "hybrid_ms": metrics.hybrid.report(),
        "selective_ms": metrics.selective.report(),
        "selective_planning_ms": metrics.selective_planning.report(),
        "selective_kernel_ms": metrics.selective_kernel.report(),
        "vector_note_candidates": CANDIDATES,
        "selective_chunks": selective_slots,
        "broad_lexical_ms": metrics.broad_lexical_ms,
        "broad_lexical_latency_ms": metrics.broad_lexical_latency.report(),
        "broad_lexical_lookups": metrics.broad_lexical_lookups,
        "browse_ms": metrics.browse_ms,
        "browse_lookups": metrics.browse_lookups,
        "hybrid_recall_at_10": metrics.hybrid_recall,
        "ann_recall_at_10": metrics.ann_recall,
        "selective_recall_at_10": metrics.selective_recall,
        "quantization_recall_at_10": metrics.quantization_recall,
        "recall_reference": "perturbed topic queries against exhaustive quantized cosine RRF, unquantized f32 cosine reference, and independent scalar crossover reference",
        "move_folder": {
            "canonical_descendants": count,
            "tantivy_docs_written": movement.0,
            "vector_slots_mutated": movement.1,
            "post_move_destination_hits": movement.2,
        },
        "lane_2_chunks_before_lane_0": foreground,
        "embedding_queue_depths_on_release": queued_on_release,
        "thresholds_passed": ok,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !smoke && !ok {
        return Err("search scale thresholds failed".into());
    }
    Ok(())
}

fn build(
    fixture: &Fixture,
    count: u32,
) -> Result<(LexicalIndex, VectorEpoch, usize), Box<dyn Error>> {
    let cut = fixture.projection.cut();
    let scope = &cut.scope;
    let notes = fixture.projection.notes();
    let layout = Arc::new(SearchLayout::open(&fixture.root, scope.clone())?);
    let index = LexicalIndex::create(&layout.create_index_generation(1)?)?;
    let writer = WriterPool::default();
    let mut dictionary = FolderDictionary::default();
    dictionary.insert(fixture.root_folder.clone())?;
    let selective = dictionary.insert(fixture.selective.clone())?;
    let broad = dictionary.insert(fixture.broad.clone())?;
    layout.persist_folder_dictionary(&dictionary)?;
    let authority = ServiceAuthority::admit(ServicePurpose::Search);
    let epoch_dir =
        layout.model_epoch(&VectorModel::local(fixture.model.clone(), DIMENSION as u32))?;
    let mut builder = SegmentBuilder::new(&fixture.model, DIMENSION)?;
    let mut staged_segments = Vec::new();
    let mut next_segment_id = 1u64;
    let mut total_chunks = 0usize;
    let mut staged = Vec::with_capacity(PAGE as usize);
    let mut seed_leases = Vec::new();
    for ordinal in 0..count {
        let SourceNote {
            title,
            carrier,
            spans,
        } = source_note(ordinal)?;
        let source = notarium_syntax::content_digest(&carrier);
        let note = notes[ordinal as usize].clone();
        let (ordinal_folder, folder_id) = if u64::from(ordinal * CHUNKS) < EXACT_SCAN_LIMIT {
            (selective, &fixture.selective)
        } else {
            (broad, &fixture.broad)
        };
        let doc = ClassifiedDocument::from_canonical(
            NoteRef {
                space_id: scope.space_id.clone(),
                note_id: note.clone(),
            },
            fixture.revisions[ordinal as usize].clone(),
            ResourceFacts {
                project: None,
                space: fixture.space.clone(),
                class: DocClass::UserDoc,
                ancestor_folders: vec![folder_id.clone(), fixture.root_folder.clone()],
                folder_write_locked: false,
                ability_package: None,
            },
            Lifecycle::Active,
            carrier,
            source,
        )?;
        let content = ClassEgressFence::index_for_search(doc, &authority)?;
        for (part, span) in spans.into_iter().enumerate() {
            let text = span.slice(content.text())?;
            let key = ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes());
            let metadata = ChunkMetadata {
                note: note.clone(),
                key,
                source,
                folder: ordinal_folder.get(),
                class: DocClass::UserDoc,
                tokens: 80,
                context: vec![],
                spans: vec![span],
            };
            builder.push(VectorChunk {
                metadata,
                vector: embedding(ordinal, part as u32)?,
            })?;
            total_chunks += 1;
            if builder.at_budget() || (ordinal + 1 == count && part + 1 == CHUNKS as usize) {
                let finished = std::mem::replace(
                    &mut builder,
                    SegmentBuilder::new(&fixture.model, DIMENSION)?,
                );
                if let Some(segment) =
                    finished.finish(&segment_file_path(&epoch_dir, next_segment_id))?
                {
                    staged_segments.push((next_segment_id, segment));
                    next_segment_id += 1;
                }
            }
        }
        staged.push((content, title, ordinal_folder));
        if staged.len() == PAGE as usize || ordinal + 1 == count {
            let updates: Vec<_> = staged
                .iter()
                .map(|(content, title, folder)| Update::Note {
                    content,
                    title,
                    folder: *folder,
                })
                .collect();
            seed_leases.push(index.stage_seed(&writer, &updates)?);
            staged.clear();
        }
        if ordinal != 0 && ordinal.is_multiple_of(10_000) {
            eprintln!(
                "Built {ordinal} notes and {} vector slots",
                ordinal * CHUNKS
            );
        }
    }
    index.commit_seed(&writer)?;
    drop(seed_leases);
    writer.release(index.path())?;
    assert_eq!(total_chunks, (count * CHUNKS) as usize);
    let built_segments = staged_segments.len();
    let mut epoch = VectorEpoch::open(layout.clone(), fixture.model.clone(), DIMENSION)?;
    epoch.seed_segments(staged_segments, cut.projected_seq)?;
    layout.publish_search(&SearchManifest {
        scope: scope.clone(),
        tantivy_seq: cut.projected_seq,
        tantivy_commit: index.commit_id()?,
        active_index_dir: index_name(1),
        tokenizer_version: TOKENIZER_VERSION,
        remote_admission: None,
        active_model: Some(ResolvedEmbeddingTarget {
            model: fixture.model.clone(),
            dimension: DIMENSION as u32,
            max_input_tokens: 512,
            backend: EmbeddingBackendTarget::LocalOnnx,
        }),
        vector_seq: Some(cut.projected_seq),
        vector_replay_after: None,
        embeddings_pending: false,
    })?;
    Ok((index, epoch, built_segments))
}

fn measure_warm_reopen(fixture: &Fixture) -> Result<(u128, Option<ProcessMemory>), Box<dyn Error>> {
    let cut = fixture.projection.cut();
    let layout = Arc::new(SearchLayout::open(&fixture.root, cut.scope)?);
    let manifest = layout.search_manifest()?.ok_or("missing search manifest")?;
    let started = Instant::now();
    let index = LexicalIndex::open(&layout.index_dir(&manifest)?)?;
    let epoch = VectorEpoch::open(layout, fixture.model.clone(), DIMENSION)?;
    let reopen_ms = started.elapsed().as_millis();
    let memory = ProcessMemory::sample();
    drop((epoch, index));
    Ok((reopen_ms, memory))
}

fn measure_compaction(
    fixture: &Fixture,
) -> Result<(u128, usize, Option<ProcessMemory>), Box<dyn Error>> {
    let cut = fixture.projection.cut();
    let layout = Arc::new(SearchLayout::open(&fixture.root, cut.scope)?);
    let manifest = layout.search_manifest()?.ok_or("missing search manifest")?;
    let mut epoch = VectorEpoch::open(layout, fixture.model.clone(), DIMENSION)?;
    let notes = fixture.projection.notes();
    let cancel = Cancellation::default();
    let mut seq = manifest.tantivy_seq;
    // Create seven small flushed segments (> MAX_SMALL_SEGMENTS = 6) so
    // non-blocking partial compaction has a bounded group to merge.
    for wave in 0u32..7 {
        seq = seq.checked_next()?;
        let note = notes[wave as usize].clone();
        let vector = query_embedding(wave, wave % CHUNKS)?;
        let chunk = VectorChunk {
            metadata: ChunkMetadata {
                note: note.clone(),
                key: ContentDigest::from_bytes(
                    *blake3::hash(format!("compact-wave-{wave}").as_bytes()).as_bytes(),
                ),
                source: ContentDigest::from_bytes([wave as u8 + 1; 32]),
                folder: 2,
                class: DocClass::UserDoc,
                tokens: 64,
                context: Vec::new(),
                spans: vec![ByteSpan::new(0, 16)?],
            },
            vector,
        };
        epoch.apply(
            seq,
            MutableOperation::Upsert {
                note,
                chunks: vec![chunk],
            },
        )?;
        epoch.flush_cancellable(&cancel)?;
    }
    let started = Instant::now();
    let plan = epoch
        .plan_compact()
        .ok_or("expected bounded compaction plan after seven small flushes")?;
    let compacted_segments = plan.replaced_ids().len();
    let replacement = plan.execute(&cancel)?;
    epoch.commit_compaction(plan, replacement, &HashSet::new())?;
    epoch.collect_obsolete()?;
    let compact_ms = started.elapsed().as_millis();
    let memory = ProcessMemory::sample();
    drop(epoch);
    Ok((compact_ms, compacted_segments, memory))
}

struct SourceNote {
    title: String,
    carrier: String,
    spans: Vec<ByteSpan>,
}

fn source_note(ordinal: u32) -> notarium_core::DomainResult<SourceNote> {
    let topic = ordinal % TOPICS;
    let title = format!("Workspace brief for facet{topic:04}");
    let mut carrier = format!("# {title}\n\n");
    let mut spans = Vec::new();
    for part in 0..CHUNKS {
        let start = carrier.len();
        carrier.push_str(&chunk_line(ordinal, part));
        spans.push(ByteSpan::new(start, carrier.len())?);
    }
    Ok(SourceNote {
        title,
        carrier,
        spans,
    })
}

fn embedding_f32(note: u32, part: u32) -> [f32; DIMENSION] {
    let topic = note % TOPICS;
    let neighbor = (topic + 1) % TOPICS;
    let mut anchor = random_seed(u64::from(topic) + 1);
    let mut overlap = random_seed(u64::from(neighbor) + 1);
    let mut signal = random_seed(u64::from(note * CHUNKS + part) ^ 0xe6a9_05aa_43dc_a02e);
    let mut values = [0.0f32; DIMENSION];
    let mut squared = 0.0f64;
    for value in &mut values {
        let base = if next(&mut anchor) & 1 == 0 {
            -1.0f32
        } else {
            1.0f32
        };
        let blend = if next(&mut overlap) & 1 == 0 {
            -0.22f32
        } else {
            0.22f32
        };
        let offset = (next(&mut signal) >> 40) as f32 / 8_388_608.0 - 1.0;
        let component = base + blend + 0.65 * offset;
        *value = component;
        squared += f64::from(component) * f64::from(component);
    }
    let norm = squared.sqrt() as f32;
    for value in &mut values {
        *value /= norm;
    }
    values
}

fn query_embedding_f32(note: u32, part: u32) -> [f32; DIMENSION] {
    let mut base = embedding_f32(note, part);
    let mut noise = random_seed(u64::from(note * CHUNKS + part) ^ 0x94d0_49bb_1331_11eb);
    let mut squared = 0.0f64;
    for value in &mut base {
        let offset = (next(&mut noise) >> 40) as f32 / 8_388_608.0 - 1.0;
        *value += 0.35 * offset / (DIMENSION as f32).sqrt();
        squared += f64::from(*value) * f64::from(*value);
    }
    let norm = squared.sqrt() as f32;
    for value in &mut base {
        *value /= norm;
    }
    base
}

fn embedding(
    note: u32,
    part: u32,
) -> Result<QuantizedVector, notarium_search::vector::VectorError> {
    let values = embedding_f32(note, part);
    QuantizedVector::quantize(&values)
}

fn query_embedding(
    note: u32,
    part: u32,
) -> Result<QuantizedVector, notarium_search::vector::VectorError> {
    let values = query_embedding_f32(note, part);
    QuantizedVector::quantize(&values)
}

fn chunk_line(note: u32, part: u32) -> String {
    let topic = note % TOPICS;
    let signal = note.wrapping_mul(103).wrapping_add(part * 97) % 30_019;
    format!(
        "Facet{topic:04} review batch {signal:05} describes package integration, audit results, and follow-up owners. See `module::run_{part}`. План расчёта и изменения проекта.\n\n"
    )
}

fn exact_selective(
    query: &QuantizedVector,
    selective_slots: u32,
) -> Result<Vec<u32>, Box<dyn Error>> {
    let mut reference = Vec::with_capacity(selective_slots as usize);
    for slot in 0..selective_slots {
        let vector = embedding(slot / CHUNKS, slot % CHUNKS)?;
        let dot = dot_i8_scalar(query.values(), vector.values()).ok_or("reference dimensions")?;
        let score = dot as f32 * query.scale() * vector.scale();
        reference.push((slot, score));
    }
    reference.sort_unstable_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    Ok(reference.into_iter().map(|(slot, _)| slot).collect())
}

fn exact_selective_f32(query: &[f32; DIMENSION], selective_slots: u32) -> Vec<ContentDigest> {
    let mut reference = Vec::with_capacity(selective_slots as usize);
    for slot in 0..selective_slots {
        let vector = embedding_f32(slot / CHUNKS, slot % CHUNKS);
        let score: f32 = query.iter().zip(&vector).map(|(a, b)| a * b).sum();
        reference.push((slot, score));
    }
    reference.sort_unstable_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.0.cmp(&right.0))
    });
    reference
        .into_iter()
        .take(10)
        .map(|(slot, _)| {
            let text = chunk_line(slot / CHUNKS, slot % CHUNKS);
            ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
        })
        .collect()
}

fn random_seed(value: u64) -> u64 {
    let mut bytes = [0; 8];
    bytes.copy_from_slice(&blake3::hash(&value.to_le_bytes()).as_bytes()[..8]);
    u64::from_le_bytes(bytes) | 1
}

fn next(state: &mut u64) -> u64 {
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    state.wrapping_mul(0x2545_f491_4f6c_dd1d)
}

async fn run_samples(
    fixture: &Fixture,
    index: &LexicalIndex,
    epoch: &VectorEpoch,
    samples: u32,
    selective_slots: u32,
) -> Result<Metrics, Box<dyn Error>> {
    let class = BTreeSet::from([DocClass::UserDoc]);
    let view = fixture.projection.snapshot();
    let filter = LexicalFilter::new(&view, None, None, class.iter().copied(), false);
    let open = VectorFilter {
        classes: &class,
        folders: None,
        notes: None,
        excluded: None,
    };
    let dictionary = SearchLayout::open(&fixture.root, view.cut.scope.clone())?
        .folder_dictionary()?
        .ok_or("missing folder dictionary")?;
    let excluded = BTreeSet::new();
    let snapshot = epoch.snapshot();
    let cancellation = Cancellation::default();
    let budget = || SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    let total_notes = view.notes.len() as u32;
    let selective_notes = (selective_slots / CHUNKS).max(1);
    let expect_hnsw = u64::from(total_notes * CHUNKS) > EXACT_SCAN_LIMIT;
    let mut metrics = Metrics::default();
    for sample in 0..samples + 4 {
        let note = (sample * 6_463 + 57) % total_notes;
        let text = format!("facet{:04}", note % TOPICS);
        let query = query_embedding(note, sample % CHUNKS)?;
        let started = Instant::now();
        let lexical = index.search(&text, &filter, CANDIDATES, TOP_K, false)?;
        let lexical_time = started.elapsed();
        assert!(!lexical.is_empty());

        let approx = snapshot.search_projected(
            &query,
            ProjectedVectorFilter {
                snapshot: &view,
                classes: &class,
                folders: None,
                nodes: None,
                excluded: &excluded,
            },
            CANDIDATES,
            budget(),
        )?;
        let fused = fuse_search_candidates(lexical.clone(), approx.hits.clone(), false);
        let hybrid_time = started.elapsed();
        if expect_hnsw {
            assert!(approx.hnsw_hops > 0);
        }
        let approximate_reference = reference_fusion(&lexical, &approx.hits);
        assert!(
            fused
                .iter()
                .map(|row| (&row.note, row.score))
                .eq(approximate_reference)
        );
        let exact = snapshot
            .search_exact(&query, &open, CANDIDATES, budget())?
            .hits;
        let reference = reference_fusion(&lexical, &exact);

        let local_note = note % selective_notes;
        let local_query_f32 = query_embedding_f32(local_note, sample % CHUNKS);
        let local_query = QuantizedVector::quantize(&local_query_f32)?;
        let started = Instant::now();
        let folders: Bitmap = view
            .folder_descendants(&fixture.selective)
            .await?
            .iter()
            .filter_map(|id| dictionary.get(id).map(|ord| ord.get()))
            .collect();
        let nodes: Bitmap = view
            .folder_subtree(&fixture.selective)
            .await?
            .map(|node| node.index(view.cut.generation))
            .collect::<Result<_, _>>()?;
        let plan_time = started.elapsed();
        let kernel = Instant::now();
        let local = snapshot.search_projected(
            &local_query,
            ProjectedVectorFilter {
                snapshot: &view,
                classes: &class,
                folders: Some(&folders),
                nodes: Some(&nodes),
                excluded: &excluded,
            },
            CANDIDATES,
            budget(),
        )?;
        let kernel_time = kernel.elapsed();
        let selective_time = started.elapsed();
        assert_eq!(local.hnsw_hops, 0);
        if sample >= 4 {
            metrics.lexical.push(lexical_time);
            metrics.hybrid.push(hybrid_time);
            metrics.selective.push(selective_time);
            metrics.selective_planning.push(plan_time);
            metrics.selective_kernel.push(kernel_time);
            metrics.hybrid_recall += overlap(
                fused.iter().map(|hit| &hit.note),
                reference.into_iter().map(|(note, _)| note),
            );
            metrics.ann_recall += overlap(
                approx.hits.iter().map(|hit| hit.metadata.key),
                exact.iter().map(|hit| hit.metadata.key),
            );
            let expected = exact_selective(&local_query, selective_slots)?;
            let expected_chunks = expected.iter().take(10).map(|&slot| {
                let text = chunk_line(slot / CHUNKS, slot % CHUNKS);
                ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
            });
            metrics.selective_recall += overlap(
                local.hits.iter().map(|hit| hit.metadata.key),
                expected_chunks,
            );
            let mut expected_seen = HashSet::new();
            let expected_notes = expected
                .iter()
                .map(|&slot| &view.notes[(slot / CHUNKS) as usize])
                .filter(|note| expected_seen.insert(*note))
                .take(CANDIDATES);
            let mut actual_seen = HashSet::new();
            let actual_notes = local
                .hits
                .iter()
                .map(|hit| &hit.metadata.note)
                .filter(|note| actual_seen.insert(*note));
            assert!(
                actual_notes.eq(expected_notes),
                "selective note ranks disagree with exhaustive scalar scoring"
            );
            let expected_f32 = exact_selective_f32(&local_query_f32, selective_slots).into_iter();
            metrics.quantization_recall +=
                overlap(local.hits.iter().map(|hit| hit.metadata.key), expected_f32);
        }
    }
    metrics.hybrid_recall /= f64::from(samples);
    metrics.ann_recall /= f64::from(samples);
    metrics.selective_recall /= f64::from(samples);
    metrics.quantization_recall /= f64::from(samples);

    // Measure broad lexical query (>256 matches) and blank browse query lookup counts.
    fixture.projection.reset_lookups();
    let started = Instant::now();
    let broad_hits = index.search("package", &filter, CANDIDATES, TOP_K, false)?;
    metrics.broad_lexical_ms = started.elapsed().as_secs_f64() * 1_000.0;
    metrics.broad_lexical_lookups = fixture.projection.lookups();
    assert!(!broad_hits.is_empty());

    fixture.projection.reset_lookups();
    let started = Instant::now();
    let browse_hits = index.search("", &filter, CANDIDATES, TOP_K, true)?;
    metrics.browse_ms = started.elapsed().as_secs_f64() * 1_000.0;
    metrics.browse_lookups = fixture.projection.lookups();
    assert_eq!(browse_hits.len(), CANDIDATES);
    assert!(
        browse_hits
            .iter()
            .zip(view.notes.iter())
            .all(|(hit, expected)| matches!(&hit.key, HitKey::Note(actual) if actual == expected))
    );

    for _ in 0..samples {
        let started = Instant::now();
        let hits = index.search("package", &filter, CANDIDATES, TOP_K, false)?;
        metrics.broad_lexical_latency.push(started.elapsed());
        assert!(
            hits.iter()
                .map(|hit| &hit.key)
                .eq(broad_hits.iter().map(|hit| &hit.key))
        );
    }

    Ok(metrics)
}

fn reference_fusion<'a>(
    lexical: &'a [LexicalHit],
    vectors: &'a [VectorHit],
) -> Vec<(&'a NoteId, f64)> {
    let lexical: BTreeMap<_, _> = lexical
        .iter()
        .enumerate()
        .filter_map(|(index, hit)| match &hit.key {
            HitKey::Note(note) => Some((note, index + 1)),
            _ => None,
        })
        .collect();
    let mut vector_ranks = BTreeMap::new();
    for hit in vectors {
        let rank = vector_ranks.len() + 1;
        vector_ranks.entry(&hit.metadata.note).or_insert(rank);
    }
    let members: BTreeSet<_> = lexical.keys().chain(vector_ranks.keys()).copied().collect();
    let weighted = |rank: Option<&usize>| rank.map_or(0.0, |rank| 1.0 / (60.0 + *rank as f64));
    let mut scored: Vec<_> = members
        .into_iter()
        .map(|note| {
            let lex = lexical.get(note);
            let vector = vector_ranks.get(note);
            let score = weighted(lex) + weighted(vector);
            let best_rank = *lex
                .into_iter()
                .chain(vector)
                .min()
                .expect("union of ranked notes");
            (note, score, best_rank)
        })
        .collect();
    scored.sort_unstable_by(|left, right| {
        right
            .1
            .total_cmp(&left.1)
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.0.cmp(right.0))
    });
    scored
        .into_iter()
        .map(|(note, score, _)| (note, score))
        .collect()
}

fn overlap<T: Ord>(result: impl Iterator<Item = T>, reference: impl Iterator<Item = T>) -> f64 {
    let expected: BTreeSet<_> = reference.take(10).collect();
    result
        .take(10)
        .filter(|item| expected.contains(item))
        .count() as f64
        / 10.0
}

#[derive(Default)]
struct Metrics {
    lexical: Latency,
    hybrid: Latency,
    selective: Latency,
    selective_planning: Latency,
    selective_kernel: Latency,
    hybrid_recall: f64,
    ann_recall: f64,
    selective_recall: f64,
    quantization_recall: f64,
    broad_lexical_ms: f64,
    broad_lexical_latency: Latency,
    broad_lexical_lookups: usize,
    browse_ms: f64,
    browse_lookups: usize,
}

#[derive(Default)]
struct Latency(Vec<f64>);
impl Latency {
    fn push(&mut self, duration: Duration) {
        self.0.push(duration.as_secs_f64() * 1_000.0);
    }
    fn percentile(&self, percentile: usize) -> f64 {
        let mut sorted = self.0.clone();
        sorted.sort_by(f64::total_cmp);
        sorted[(sorted.len() * percentile).div_ceil(100) - 1]
    }
    fn p95(&self) -> f64 {
        self.percentile(95)
    }
    fn report(&self) -> serde_json::Value {
        json!({"p50": self.percentile(50), "p95": self.p95(), "p99": self.percentile(99)})
    }
}

struct ProcessMemory {
    anonymous_kib: Option<u64>,
    private_dirty_kib: Option<u64>,
    rss_anon_kib: Option<u64>,
    vm_hwm_kib: Option<u64>,
}

impl ProcessMemory {
    fn sample() -> Option<Self> {
        #[cfg(target_os = "linux")]
        {
            let smaps = fs::read_to_string("/proc/self/smaps_rollup").ok();
            let status = fs::read_to_string("/proc/self/status").ok();
            let parse_kib = |content: Option<&str>, prefix: &str| {
                content?
                    .lines()
                    .find_map(|line| line.strip_prefix(prefix))
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
            };
            Some(Self {
                anonymous_kib: parse_kib(smaps.as_deref(), "Anonymous:"),
                private_dirty_kib: parse_kib(smaps.as_deref(), "Private_Dirty:"),
                rss_anon_kib: parse_kib(status.as_deref(), "RssAnon:"),
                vm_hwm_kib: parse_kib(status.as_deref(), "VmHWM:"),
            })
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }

    fn report(&self) -> serde_json::Value {
        json!({
            "anonymous_kib": self.anonymous_kib,
            "private_dirty_kib": self.private_dirty_kib,
            "rss_anon_kib": self.rss_anon_kib,
            "vm_hwm_kib": self.vm_hwm_kib,
        })
    }
}

fn cgroup(name: &str) -> Option<String> {
    fs::read_to_string(format!("/sys/fs/cgroup/{name}"))
        .ok()
        .map(|quota| quota.trim().to_owned())
}

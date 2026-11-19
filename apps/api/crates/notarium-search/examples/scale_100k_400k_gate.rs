//! Offline release gate for the search index and retrieval kernels.

#[path = "search_scale/support.rs"]
mod support;

use croaring::Bitmap;
use notarium_core::{
    auth::ResourceFacts,
    classes::{ClassEgressFence, ClassifiedDocument, DocClass},
    ids::{ContentDigest, RevisionId},
    model::{Lifecycle, NoteRef},
    ports::{Cancellation, ServiceAuthority, ServicePurpose},
    span::ByteSpan,
};
use notarium_search::{
    fuse_search_candidates,
    layout::{FolderDictionary, SearchLayout, SearchManifest, index_name},
    lexical::{LexicalFilter, LexicalIndex, TOKENIZER_VERSION, Update, WriterPool},
    ports::{EmbeddingBackendTarget, ResolvedEmbeddingTarget},
    vector::{
        ChunkMetadata, EXACT_SCAN_LIMIT, QuantizedVector, SearchBudget, SegmentBuilder,
        VectorChunk, VectorEpoch, VectorFilter,
        simd::{Kernel, dot_i8_scalar},
    },
};
use serde_json::json;
use std::{
    collections::BTreeSet,
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
const CANDIDATES: usize = 100;
const DISK_LIMIT: u64 = 400 * 1024 * 1024;

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
    let count = if smoke { 5_000 } else { NOTES };
    let scratch = Scratch::new()?;
    let fixture = Fixture::open(scratch.root(), count).await?;
    let peak = PeakDisk::start(scratch.root().root());
    let started = Instant::now();
    let (index, epoch) = build(&fixture, count)?;
    let build_ms = started.elapsed().as_millis();
    let samples = if smoke { 8 } else { SAMPLES };
    let metrics = run_samples(&fixture, &index, &epoch, samples)?;
    drop((epoch, index));
    let movement = fixture.move_folder().await?;
    fixture.shutdown().await?;
    let peak_bytes = peak.finish();

    let ok = metrics.lexical.p95() < 40.0
        && metrics.hybrid.p95() < 95.0
        && metrics.selective.p95() < 1.5
        && metrics.hybrid_recall >= 0.95
        && (metrics.selective_recall - 1.0).abs() < f64::EPSILON
        && movement == (0, 0)
        && peak_bytes < DISK_LIMIT;
    let report = json!({
        "profile": if smoke { "smoke" } else { "full" },
        "tree": tree, "notes": count, "chunks": count * CHUNKS,
        "sample_count": samples, "dimension": DIMENSION, "top_k": TOP_K,
        "build_ms": build_ms, "peak_index_bytes": peak_bytes,
        "workspace_cpu_quota": argument("--host-cpu"), "workspace_memory_quota_bytes": argument("--host-memory"),
        "runner_cpu_quota": cgroup("cpu.max"), "runner_memory_quota_bytes": cgroup("memory.max"),
        "simd": format!("{:?}", Kernel::detect()),
        "lexical_ms": metrics.lexical.report(), "hybrid_ms": metrics.hybrid.report(),
        "selective_ms": metrics.selective.report(), "selective_chunks": EXACT_SCAN_LIMIT,
        "hybrid_recall_at_10": metrics.hybrid_recall,
        "ann_recall_at_10": metrics.ann_recall, "selective_recall_at_10": metrics.selective_recall,
        "recall_reference": "exhaustive quantized cosine and an independent scalar crossover reference",
        "move_folder": { "tantivy_docs_written": movement.0, "vector_slots_mutated": movement.1 },
        "thresholds_passed": ok,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    if !smoke && !ok {
        return Err("search scale thresholds failed".into());
    }
    Ok(())
}

fn build(fixture: &Fixture, count: u32) -> Result<(LexicalIndex, VectorEpoch), Box<dyn Error>> {
    let scope = &fixture.projection.cut.scope;
    let layout = Arc::new(SearchLayout::open(&fixture.root, scope.clone())?);
    let index = LexicalIndex::create(&layout.create_index_generation(1)?)?;
    let writer = WriterPool::default();
    let mut dictionary = FolderDictionary::default();
    dictionary.insert(fixture.root_folder.clone())?;
    let selective = dictionary.insert(fixture.selective.clone())?;
    let broad = dictionary.insert(fixture.broad.clone())?;
    layout.persist_folder_dictionary(&dictionary)?;
    let authority = ServiceAuthority::admit(ServicePurpose::Search);
    let mut builder = SegmentBuilder::new(&fixture.model, DIMENSION)?;
    let mut staged = Vec::with_capacity(PAGE as usize);
    for ordinal in 0..count {
        let topic = ordinal % TOPICS;
        let title = format!("Workspace brief for facet{topic:04}");
        let mut carrier = format!("# {title}\n\n");
        let mut spans = Vec::new();
        for part in 0..CHUNKS {
            let start = carrier.len();
            carrier.push_str(&chunk_line(ordinal, part));
            spans.push(ByteSpan::new(start, carrier.len())?);
        }
        let source = notarium_syntax::content_digest(&carrier);
        let note = fixture.projection.notes[ordinal as usize].clone();
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
            RevisionId::from_bytes(u128::from(ordinal + 1).to_be_bytes()),
            ResourceFacts {
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
            index.stage_seed(&writer, &updates)?;
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
    writer.release(index.path())?;
    assert_eq!(builder.len(), (count * CHUNKS) as usize);
    let mut epoch = VectorEpoch::open(layout.clone(), fixture.model.clone(), DIMENSION)?;
    epoch.seed(builder, fixture.projection.cut.projected_seq)?;
    layout.publish_search(&SearchManifest {
        scope: scope.clone(),
        tantivy_seq: fixture.projection.cut.projected_seq,
        tantivy_commit: index.commit_id()?,
        active_index_dir: index_name(1),
        tokenizer_version: TOKENIZER_VERSION,
        active_model: Some(ResolvedEmbeddingTarget {
            model: fixture.model.clone(),
            dimension: DIMENSION as u32,
            max_input_tokens: 512,
            backend: EmbeddingBackendTarget::LocalOnnx,
        }),
        vector_seq: Some(fixture.projection.cut.projected_seq),
        embeddings_pending: false,
    })?;
    Ok((index, epoch))
}

fn embedding(
    note: u32,
    part: u32,
) -> Result<QuantizedVector, notarium_search::vector::VectorError> {
    let topic = note % TOPICS;
    let mut anchor = random_seed(u64::from(topic) + 1);
    let mut signal = random_seed(u64::from(note * CHUNKS + part) ^ 0xe6a9_05aa_43dc_a02e);
    let mut values = [0.0; DIMENSION];
    for value in &mut values {
        let base = if next(&mut anchor) & 1 == 0 {
            -1.0
        } else {
            1.0
        };
        let offset = (next(&mut signal) >> 40) as f32 / 8_388_608.0 - 1.0;
        *value = base + 0.28 * offset;
    }
    QuantizedVector::quantize(&values)
}

fn chunk_line(note: u32, part: u32) -> String {
    let topic = note % TOPICS;
    let signal = note.wrapping_mul(103).wrapping_add(part * 97) % 30_019;
    format!(
        "Facet{topic:04} review batch {signal:05} describes package integration, audit results, and follow-up owners. See `module::run_{part}`. План расчёта и изменения проекта.\n\n"
    )
}

fn exact_selective(query: &QuantizedVector) -> Result<Vec<ContentDigest>, Box<dyn Error>> {
    let mut reference = Vec::with_capacity(EXACT_SCAN_LIMIT as usize);
    for slot in 0..EXACT_SCAN_LIMIT as u32 {
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
    Ok(reference
        .into_iter()
        .take(10)
        .map(|(slot, _)| {
            let text = chunk_line(slot / CHUNKS, slot % CHUNKS);
            ContentDigest::from_bytes(*blake3::hash(text.as_bytes()).as_bytes())
        })
        .collect())
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

fn run_samples(
    fixture: &Fixture,
    index: &LexicalIndex,
    epoch: &VectorEpoch,
    samples: u32,
) -> Result<Metrics, Box<dyn Error>> {
    let class = BTreeSet::from([DocClass::UserDoc]);
    let filter = LexicalFilter::new(
        &*fixture.projection,
        None,
        None,
        class.iter().copied(),
        false,
    );
    let open = VectorFilter {
        classes: &class,
        folders: None,
        notes: None,
        excluded: None,
    };
    let mut behind = Bitmap::new();
    behind.add(2);
    let folder = VectorFilter {
        classes: &class,
        folders: Some(&behind),
        notes: None,
        excluded: None,
    };
    let snapshot = epoch.snapshot();
    let cancellation = Cancellation::default();
    let budget = || SearchBudget {
        cancellation: &cancellation,
        deadline: Instant::now() + Duration::from_secs(30),
    };
    let mut metrics = Metrics::default();
    for sample in 0..samples + 4 {
        let note = (sample * 6_463 + 57) % fixture.projection.notes.len() as u32;
        let text = format!("facet{:04}", note % TOPICS);
        let query = embedding(note, sample % CHUNKS)?;
        let started = Instant::now();
        let lexical = index.search(&text, &filter, TOP_K, false)?;
        let lexical_time = started.elapsed();
        assert!(!lexical.is_empty());

        let started = Instant::now();
        let lexical = index.search(&text, &filter, CANDIDATES, false)?;
        let approx = snapshot.search(&query, &open, CANDIDATES, budget())?;
        let fused = fuse_search_candidates(lexical.clone(), approx.hits.clone(), false);
        let hybrid_time = started.elapsed();
        assert!(approx.hnsw_hops > 0);
        let exact = snapshot
            .search_exact(&query, &open, CANDIDATES, budget())?
            .hits;
        let reference = fuse_search_candidates(lexical, exact.clone(), false);

        let local_query = embedding(note % (EXACT_SCAN_LIMIT as u32 / CHUNKS), sample % CHUNKS)?;
        let started = Instant::now();
        let local = snapshot.search(&local_query, &folder, TOP_K, budget())?;
        let selective_time = started.elapsed();
        assert_eq!(local.hnsw_hops, 0);
        if sample >= 4 {
            metrics.lexical.push(lexical_time);
            metrics.hybrid.push(hybrid_time);
            metrics.selective.push(selective_time);
            metrics.hybrid_recall += overlap(
                fused.iter().map(|hit| &hit.note),
                reference.iter().map(|hit| &hit.note),
            );
            metrics.ann_recall += overlap(
                approx.hits.iter().map(|hit| hit.metadata.key),
                exact.iter().map(|hit| hit.metadata.key),
            );
            let expected = exact_selective(&local_query)?.into_iter();
            metrics.selective_recall +=
                overlap(local.hits.iter().map(|hit| hit.metadata.key), expected);
        }
    }
    metrics.hybrid_recall /= f64::from(samples);
    metrics.ann_recall /= f64::from(samples);
    metrics.selective_recall /= f64::from(samples);
    Ok(metrics)
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
    hybrid_recall: f64,
    ann_recall: f64,
    selective_recall: f64,
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

fn cgroup(name: &str) -> Option<String> {
    fs::read_to_string(format!("/sys/fs/cgroup/{name}"))
        .ok()
        .map(|quota| quota.trim().to_owned())
}

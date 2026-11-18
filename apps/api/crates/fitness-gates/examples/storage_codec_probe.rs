use notarium_canonical::blobs::{BlobCodecTag, PreparedBlobSource};
use serde_json::json;
use std::{fmt::Write, hint::black_box, time::Instant};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const DOCUMENTS: usize = 512;
const BYTES: usize = 4096;
const WARMUP: usize = 4;
const BATCHES: usize = 32;

fn document(index: usize) -> Vec<u8> {
    let mut text = format!("---\ntitle: Note {index}\n---\n");
    for line in 0..120 {
        let value = (index * 79 + line * 89) % 1013;
        writeln!(text, "Text of note {index} on line {line}, value {value}.").unwrap();
    }
    let mut bytes = text.into_bytes();
    bytes.truncate(BYTES);
    assert_eq!(bytes.len(), BYTES);
    bytes
}

fn main() {
    if cfg!(debug_assertions) {
        eprintln!("build this probe in release mode");
        std::process::exit(2);
    }
    let documents: Vec<_> = (0..DOCUMENTS).map(document).collect();
    let mut corpus = blake3::Hasher::new();
    for bytes in &documents {
        corpus.update(bytes);
    }

    let mut samples = Vec::with_capacity(BATCHES);
    for batch in 0..WARMUP + BATCHES {
        let start = Instant::now();
        for bytes in &documents {
            let prepared = PreparedBlobSource::prepare(black_box(bytes), BlobCodecTag::LocalZstdV1)
                .expect("prepare local CAS document");
            black_box(prepared.digest());
            black_box(prepared.compressed_size());
        }
        if batch >= WARMUP {
            samples.push(u64::try_from(start.elapsed().as_nanos()).unwrap());
        }
    }
    println!(
        "{}",
        json!({
            "codec": "LocalZstdV1",
            "corpus_blake3": corpus.finalize().to_hex().as_str(),
            "document_bytes": BYTES,
            "items_per_batch": DOCUMENTS,
            "warmup_batches": WARMUP,
            "batch_ns": samples,
        })
    );
}

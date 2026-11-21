//! Quantized vector storage and filtered nearest-neighbor search.

mod builder;
mod epoch;
mod format;
mod hnsw;
mod mmap_segment;
mod quantization;
pub mod simd;
mod tombstone;
mod wal;

pub use builder::{MAX_SEGMENT_BUILD_BYTES, SegmentBuilder};
#[cfg(any(test, feature = "test-support"))]
pub use epoch::VectorResults;
pub use epoch::{
    CompactionPlan, FlushL0Plan, VectorEpoch, VectorFilter, VectorHit, VectorSnapshot,
    segment_file_path,
};
#[cfg(any(test, feature = "test-support"))]
pub use hnsw::Neighbor;
pub use mmap_segment::MmapSegment;
#[cfg(any(test, feature = "test-support"))]
pub use mmap_segment::SegmentSearch;
pub use quantization::QuantizedVector;
pub use tombstone::Tombstones;
#[cfg(any(test, feature = "test-support"))]
pub use wal::{L0_MAX_BYTES, L0_MAX_CHUNKS};
pub use wal::{MutableBuffer, MutableOperation};

use notarium_core::{
    DomainError, DomainResult,
    classes::DocClass,
    document::{ChunkDescriptor, render_chunk},
    ids::{ContentDigest, ModelProfileId, NoteId},
    ports::Cancellation,
    span::ByteSpan,
};
use std::{io, time::Instant};

pub const MIN_DIMENSION: usize = 64;
pub const MAX_DIMENSION: usize = 4096;
pub const EXACT_SCAN_LIMIT: u64 = 16_384;
pub const MAX_CONTEXT_SPANS: usize = 64;
pub(super) const GLOBAL_EVAL_BUDGET: usize = 48_000;
const M: usize = 16;
const M0: usize = 32;
const MAX_LEVEL: u8 = 16;

#[derive(Debug, thiserror::Error)]
pub enum VectorError {
    #[error("unsupported vector dimension")]
    InvalidDimension,
    #[error("invalid quantized vector")]
    InvalidVector,
    #[error("invalid chunk metadata")]
    InvalidChunk,
    #[error("invalid vector index encoding")]
    CorruptIndex,
    #[error("vector index I/O failed")]
    Io(#[from] io::Error),
    #[error("vector index layout failed")]
    Layout(#[from] crate::layout::LayoutError),
    #[error("vector search domain failure")]
    Domain(#[from] DomainError),
    #[error("vector search budget ended")]
    Cancelled,
    #[error("mutable vector index capacity exceeded")]
    BufferFull,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChunkMetadata {
    pub note: NoteId,
    pub key: ContentDigest,
    pub source: ContentDigest,
    pub folder: u32,
    pub class: DocClass,
    pub tokens: u16,
    pub context: Vec<ByteSpan>,
    pub spans: Vec<ByteSpan>,
}

impl ChunkMetadata {
    pub fn validate(&self) -> Result<(), VectorError> {
        if self.folder == 0
            || self.class == DocClass::EncryptedNote
            || !(1..=512).contains(&self.tokens)
            || !(1..=7).contains(&self.spans.len())
            || self.context.len() > MAX_CONTEXT_SPANS
            || self
                .context
                .iter()
                .chain(&self.spans)
                .any(|span| span.start() >= span.end() || u32::try_from(span.end()).is_err())
        {
            return Err(VectorError::InvalidChunk);
        }
        Ok(())
    }

    pub fn descriptor(
        &self,
        carrier: &str,
        model: ModelProfileId,
    ) -> DomainResult<ChunkDescriptor> {
        Ok(ChunkDescriptor {
            key: self.key,
            source: self.source,
            model,
            tokens: u32::from(self.tokens),
            text: render_chunk(carrier, &self.context, &self.spans)?,
            context: self.context.clone(),
            spans: self.spans.clone(),
        })
    }
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct VectorChunk {
    pub metadata: ChunkMetadata,
    pub vector: QuantizedVector,
}

impl VectorChunk {
    fn validate(&self, dimension: usize) -> Result<(), VectorError> {
        self.metadata.validate()?;
        self.vector.validate(dimension)
    }
}

#[derive(Clone, Copy)]
pub struct SearchBudget<'a> {
    pub cancellation: &'a Cancellation,
    pub deadline: Instant,
}
impl SearchBudget<'_> {
    fn check(self) -> Result<(), VectorError> {
        if self.cancellation.is_cancelled() || Instant::now() >= self.deadline {
            return Err(VectorError::Cancelled);
        }
        Ok(())
    }
}

pub fn model_hash(model: &ModelProfileId) -> [u8; 32] {
    *blake3::hash(model.as_str().as_bytes()).as_bytes()
}

#[cfg(test)]
mod tests;

//! Bounded tokenization and embedding work for the search engine.

mod onnx;
mod preprocess;
mod remote;
mod scheduler;
#[cfg(test)]
mod tests;
mod tokenizer;
mod tokenizer_model;

pub use onnx::{OrtModel, Pooling};
pub use remote::RemoteEmbedder;
pub use scheduler::{EmbeddingScheduler, Priority, bounded_batches};
#[cfg(any(test, feature = "test-support"))]
pub use tokenizer::Encoding;
pub use tokenizer::{LocalTokenizerBudget, RemoteConservativeTokenizerBudget};

#[derive(Debug, thiserror::Error)]
pub enum EmbeddingError {
    #[error("the embedding model is unavailable")]
    ModelUnavailable,
    #[error("the embedding provider is unavailable")]
    ProviderUnavailable,
    #[error("the document no longer qualifies for remote indexing")]
    IndexingDenied,
    #[error("the input cannot be embedded by this model")]
    PermanentInputRejected,
    #[error("the embedding request exceeded its budget")]
    BudgetExceeded,
    #[error("invalid or unsupported tokenizer or model")]
    InvalidModel,
    #[error("embedding work was cancelled")]
    Cancelled,
    #[error("embedding model I/O failed")]
    Io(#[from] std::io::Error),
}

pub(super) fn normalize(values: &[f32]) -> Option<Vec<f32>> {
    let squared = values
        .iter()
        .map(|&component| f64::from(component).powi(2))
        .sum::<f64>();
    if squared <= 0.0 || !squared.is_finite() {
        return None;
    }
    let norm = squared.sqrt();
    Some(
        values
            .iter()
            .map(|&component| (f64::from(component) / norm) as f32)
            .collect(),
    )
}

pub fn deterministic_embedding(text: &str, dimension: u32) -> Option<Vec<f32>> {
    use crate::vector::{MAX_DIMENSION, MIN_DIMENSION};
    let dimension = dimension as usize;
    if !(MIN_DIMENSION..=MAX_DIMENSION).contains(&dimension) {
        return None;
    }
    let mut values = vec![0.0; dimension];
    for token in text
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|token| !token.is_empty())
    {
        let hash = blake3::hash(token.to_lowercase().as_bytes());
        for &[low, high, sign] in hash.as_bytes().as_chunks::<3>().0 {
            let slot = usize::from(u16::from_le_bytes([low, high])) % dimension;
            values[slot] += if sign & 1 == 0 { 1.0 } else { -1.0 };
        }
    }
    normalize(&values)
}

impl EmbeddingError {
    /// Returns `true` when retrying the same document input cannot succeed
    /// (egress policy denial or permanently unembeddable/oversized input),
    /// as opposed to a transient network, rate-limit, budget, or provider error.
    pub fn is_permanent_note_rejection(&self) -> bool {
        matches!(self, Self::IndexingDenied | Self::PermanentInputRejected)
    }

    pub fn degradation(&self) -> notarium_core::ports::SearchDegradation {
        use notarium_core::ports::SearchDegradation;
        match self {
            Self::BudgetExceeded | Self::Cancelled => SearchDegradation::BudgetExceeded,
            Self::ProviderUnavailable | Self::IndexingDenied => {
                SearchDegradation::ProviderUnavailable
            }
            Self::ModelUnavailable
            | Self::InvalidModel
            | Self::PermanentInputRejected
            | Self::Io(_) => SearchDegradation::ModelUnavailable,
        }
    }
}

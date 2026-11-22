use crate::{
    DomainError, DomainResult,
    error::{Diagnostic, ValidationReason},
    ids::*,
    span::ByteSpan,
    value::YamlValue,
};
use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContainerKind {
    BlockQuote,
    ListItem,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkdownContainer {
    pub ordinal: u32,
    pub kind: ContainerKind,
    pub span: ByteSpan,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub title: String,
    pub heading_span: ByteSpan,
    pub section_span: ByteSpan,
    pub containers: Vec<MarkdownContainer>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LinkNavigation {
    Current,
    Parent,
    Named(String),
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WikiTargetKind {
    StableNoteId(NoteId),
    NamePath {
        absolute: bool,
        directory: Vec<LinkNavigation>,
        leaf_key: String,
    },
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WikiTarget {
    pub span: ByteSpan,
    pub raw: String,
    pub label: Option<String>,
    pub target: WikiTargetKind,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TagKey {
    pub key: String,
    pub source_spans: Vec<ByteSpan>,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ViewState {
    Pending,
    Invalid,
    Ready,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ViewBlock {
    pub span: ByteSpan,
    pub state: ViewState,
    pub id: Option<ViewKey>,
    pub raw_yaml: String,
    pub config: Option<YamlValue>,
    pub diagnostics: Vec<Diagnostic>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChunkDescriptor {
    pub source: ContentDigest,
    pub model: ModelProfileId,
    /// Source heading ranges, separated by a fixed breadcrumb delimiter.
    pub context: Vec<ByteSpan>,
    pub spans: Vec<ByteSpan>,
    pub text: String,
    pub tokens: u32,
    pub key: ContentDigest,
}
/// Source-only rendering recipe. No arbitrary prefix can be labelled as content
/// from a classified document. Body ranges are ordered and non-overlapping.
pub fn render_chunk(
    source: &str,
    context: &[ByteSpan],
    spans: &[ByteSpan],
) -> DomainResult<String> {
    let mut output = String::new();
    for (index, span) in context.iter().enumerate() {
        if index > 0 {
            output.push_str(" > ");
        }
        output.push_str(span.slice(source)?);
    }
    if !context.is_empty() {
        output.push_str("\n\n");
    }
    let mut previous_end = 0;
    for span in spans {
        if span.is_empty() || span.start() < previous_end {
            return Err(DomainError::validation(ValidationReason::InvalidSpan));
        }
        output.push_str(span.slice(source)?);
        previous_end = span.end();
    }
    Ok(output)
}
/// Conservative Unicode-aware token upper bound in twelfths of a token:
/// `4/12` for ASCII letters and whitespace, `12/12` for other ASCII and
/// 2-byte UTF-8 scalars, `18/12` for 3-byte UTF-8, and `24/12` for 4-byte UTF-8.
pub fn estimate_token_twelfths(text: &str) -> u64 {
    let mut twelfths = 0u64;
    for ch in text.chars() {
        twelfths = twelfths.saturating_add(match ch.len_utf8() {
            1 if ch.is_ascii_alphabetic() || ch.is_ascii_whitespace() => 4,
            1 | 2 => 12,
            3 => 18,
            _ => 24,
        });
    }
    twelfths
}
/// Conservative upper bound on token count derived from [`estimate_token_twelfths`].
pub fn estimate_conservative_tokens(text: &str) -> usize {
    usize::try_from(estimate_token_twelfths(text).div_ceil(12)).unwrap_or(usize::MAX)
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ChunkPlan {
    Ready {
        model: ModelProfileId,
        chunks: Vec<ChunkDescriptor>,
    },
    Deferred {
        blocks: Vec<ByteSpan>,
    },
}

use crate::{error::Diagnostic, ids::*, span::ByteSpan, value::YamlValue};
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
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ViewState {
    Pending,
    Invalid,
    Ready,
}
#[derive(Clone, Debug, Eq, PartialEq)]
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
    pub spans: Vec<ByteSpan>,
    pub text: String,
    pub tokens: u32,
    pub key: ContentDigest,
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

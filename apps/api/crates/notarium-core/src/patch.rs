//! Origin-aware plans produced by syntax and verified by the applying owner.
use crate::{ids::*, span::*, value::YamlValue};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CarrierSplice {
    pub origin: CarrierEditOrigin,
    pub bytes: CarrierByteSpan,
    pub utf16: CarrierUtf16Span,
    pub replacement: String,
    pub replacement_utf16_len: usize,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CarrierEditOrigin {
    Header,
    Body,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodySplice {
    pub bytes: BodyByteSpan,
    pub utf16: BodyUtf16Span,
    pub replacement: String,
    pub replacement_utf16_len: usize,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CarrierPatchPlan {
    pub base_content_hash: ContentDigest,
    pub body_range: ByteSpan,
    pub edits: Vec<CarrierSplice>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BodyPatchPlan {
    pub base_body_hash: ContentDigest,
    pub body_identity: BodyIdentity,
    pub edits: Vec<BodySplice>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HeaderPatchPlan {
    pub base_header_hash: ContentDigest,
    pub header_identity: HeaderIdentity,
    pub edits: Vec<CarrierSplice>,
    pub semantic_delta: BTreeMap<String, Option<YamlValue>>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HeaderMutation {
    Preserve,
    SemanticFields(BTreeMap<String, Option<YamlValue>>),
    RawHeader(HeaderPatchPlan),
}

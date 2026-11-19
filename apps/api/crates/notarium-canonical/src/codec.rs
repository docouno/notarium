use std::{
    collections::BTreeMap,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use notarium_core::{
    DomainError, DomainResult,
    classes::{AbilityKind, DocClass},
    error::{
        CommitEffect, Diagnostic, OperationalFailure, PortError, RetryAdvice, ValidationReason,
    },
    ids::{
        AbilityId, AgentRunId, ArtifactId, ChatThreadId, ContentDigest, FolderId, NoteId,
        PrincipalId, RevisionId, SpaceSeq, ThreadEntrySeq, ViewKey,
    },
    model::Lifecycle,
    ports::{AbilityRef, ChatThreadKind, GroupKey},
    query::{FieldObservation, FieldSchema, FieldValue},
    value::{Timestamp, YamlValue},
};
use notarium_syntax::unicode::{lookup_key, validate_component};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const MAX_MSGPACK_DECODE_BYTES: usize = 4 * 1024 * 1024;
pub const EFFECT_PAYLOAD_BUDGET_BYTES: usize = 64 * 1024;
pub const EFFECT_MAX_NOTES: usize = 8;

pub fn diagnostic_digest(tag: &str, detail: &str) -> ContentDigest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-canonical-diag-v1:");
    hasher.update(tag.as_bytes());
    hasher.update(b":");
    hasher.update(detail.as_bytes());
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

pub fn internal_not_committed(tag: &str, detail: impl AsRef<str>) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("RetryAdvice::Never is valid for non-idempotent failure");
    PortError::Internal(failure)
}

pub fn unavailable_retryable(tag: &str, detail: impl AsRef<str>, after: Duration) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::NotCommitted,
        RetryAdvice::After(after),
        true,
    )
    .expect("idempotent retryable failure");
    PortError::Unavailable(failure)
}

pub fn cancelled_not_committed(tag: &str, detail: impl AsRef<str>) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("non-idempotent cancellation");
    PortError::Cancelled(failure)
}

pub fn deadline_not_committed(tag: &str, detail: impl AsRef<str>) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::NotCommitted,
        RetryAdvice::Never,
        false,
    )
    .expect("non-idempotent deadline");
    PortError::DeadlineExceeded(failure)
}

pub fn unknown_commit_outcome(tag: &str, detail: impl AsRef<str>) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::Unknown,
        RetryAdvice::RetrySameCommand,
        true,
    )
    .expect("idempotent unknown commit outcome");
    PortError::Unavailable(failure)
}

pub(crate) fn retry_unknown_commit(tag: &str, error: PortError) -> PortError {
    match error {
        PortError::Internal(failure) if failure.effect() == CommitEffect::Unknown => {
            unknown_commit_outcome(tag, error.to_string())
        }
        other => other,
    }
}

pub fn unknown_commit_non_idempotent(tag: &str, detail: impl AsRef<str>) -> PortError {
    let failure = OperationalFailure::new(
        diagnostic_digest(tag, detail.as_ref()),
        CommitEffect::Unknown,
        RetryAdvice::Never,
        false,
    )
    .expect("non-idempotent unknown commit outcome");
    PortError::Internal(failure)
}

pub fn csprng_16() -> Result<[u8; 16], PortError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|err| internal_not_committed("csprng_16", err.to_string()))?;
    Ok(bytes)
}

static MONO_ID_SEQ: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

/// Generates a UUIDv7-style lexicographically monotonic 128-bit ID (`[48b unix_ms BE || 16b seq BE || 64b CSPRNG]`)
/// so B-tree primary keys and secondary indexes append sequentially at the right edge while preserving 64-bit OS CSPRNG entropy.
pub fn ordered_id_16() -> Result<[u8; 16], PortError> {
    thread_local! {
        static CSPRNG_POOL: std::cell::RefCell<([u8; 512], usize)> =
            const { std::cell::RefCell::new(([0u8; 512], 512)) };
    }
    let mut bytes = [0u8; 16];
    CSPRNG_POOL.with(|cell| -> Result<(), PortError> {
        if let Ok(mut state) = cell.try_borrow_mut() {
            if state.1 + 8 > state.0.len() {
                getrandom::fill(&mut state.0)
                    .map_err(|err| internal_not_committed("ordered_id_csprng", err.to_string()))?;
                state.1 = 0;
            }
            let off = state.1;
            bytes[8..16].copy_from_slice(&state.0[off..off + 8]);
            state.1 = off + 8;
            Ok(())
        } else {
            getrandom::fill(&mut bytes[8..16])
                .map_err(|err| internal_not_committed("ordered_id_csprng", err.to_string()))
        }
    })?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let ms_be = ms.to_be_bytes();
    bytes[0..6].copy_from_slice(&ms_be[2..8]);
    let seq = MONO_ID_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    bytes[6..8].copy_from_slice(&seq.to_be_bytes());
    Ok(bytes)
}

/// Generates `count` monotonic 128-bit IDs using a single CSPRNG syscall.
pub fn ordered_ids_batch(count: usize) -> Result<Vec<[u8; 16]>, PortError> {
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut rand_buf = vec![0u8; count * 8];
    getrandom::fill(&mut rand_buf)
        .map_err(|err| internal_not_committed("ordered_ids_batch_csprng", err.to_string()))?;
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let ms_be = ms.to_be_bytes();
    let count_u16 = u16::try_from(count).unwrap_or(u16::MAX);
    let base_seq = MONO_ID_SEQ.fetch_add(count_u16, std::sync::atomic::Ordering::Relaxed);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let mut bytes = [0u8; 16];
        bytes[0..6].copy_from_slice(&ms_be[2..8]);
        let seq = base_seq.wrapping_add(i as u16);
        bytes[6..8].copy_from_slice(&seq.to_be_bytes());
        bytes[8..16].copy_from_slice(&rand_buf[i * 8..(i + 1) * 8]);
        out.push(bytes);
    }
    Ok(out)
}

pub fn csprng_32() -> Result<[u8; 32], PortError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|err| internal_not_committed("csprng_32", err.to_string()))?;
    Ok(bytes)
}

pub fn new_revision_id() -> Result<RevisionId, PortError> {
    Ok(RevisionId::from_bytes(ordered_id_16()?))
}

pub fn new_artifact_id() -> Result<ArtifactId, PortError> {
    Ok(ArtifactId::from_bytes(ordered_id_16()?))
}

pub fn new_prefixed_hex_id(prefix: &str) -> Result<String, PortError> {
    let bytes = ordered_id_16()?;
    Ok(format!("{prefix}{:032x}", u128::from_be_bytes(bytes)))
}

pub fn now_utc_timestamp() -> Result<Timestamp, PortError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| internal_not_committed("system_clock", err.to_string()))?;
    let secs = i64::try_from(duration.as_secs())
        .map_err(|err| internal_not_committed("system_clock_overflow", err.to_string()))?;
    Timestamp::from_unix_parts(secs, duration.subsec_nanos())
        .map_err(|err| internal_not_committed("system_clock_timestamp", err.to_string()))
}

pub fn now_unix_ms() -> Result<i64, PortError> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| internal_not_committed("system_clock_ms", err.to_string()))?;
    i64::try_from(duration.as_millis())
        .map_err(|err| internal_not_committed("system_clock_ms_overflow", err.to_string()))
}

pub fn encode_timestamp_parts(ts: Timestamp) -> (i64, i32) {
    (ts.unix_seconds(), ts.nanosecond() as i32)
}

pub fn decode_timestamp_parts(sec: i64, nsec: i32) -> DomainResult<Timestamp> {
    let nsec = u32::try_from(nsec)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidTimestamp))?;
    Timestamp::from_unix_parts(sec, nsec)
}

pub fn normalize_slug_key(slug: &str) -> DomainResult<String> {
    validate_component(slug)?;
    Ok(lookup_key(slug))
}

pub fn normalize_title_key(title: &str) -> String {
    lookup_key(title)
}

pub fn encode_msgpack<T: Serialize>(value: &T) -> Result<Vec<u8>, PortError> {
    rmp_serde::to_vec_named(value)
        .map_err(|err| internal_not_committed("msgpack_encode", err.to_string()))
}

pub fn decode_msgpack_bounded<T: DeserializeOwned>(
    bytes: &[u8],
    max_bytes: usize,
) -> Result<T, PortError> {
    if bytes.len() > max_bytes {
        return Err(internal_not_committed(
            "msgpack_size_limit",
            format!("payload {} exceeds limit {max_bytes}", bytes.len()),
        ));
    }
    rmp_serde::from_slice(bytes)
        .map_err(|err| internal_not_committed("msgpack_decode", err.to_string()))
}

pub fn group_key_hex(group: &GroupKey) -> Result<(Vec<u8>, String), PortError> {
    let encoded = encode_msgpack(group)?;
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"notarium-group-key-v1:");
    hasher.update(&encoded);
    let digest = ContentDigest::from_bytes(*hasher.finalize().as_bytes());
    Ok((encoded, digest.to_hex()))
}

pub fn checked_seq_to_i64(seq: SpaceSeq) -> i64 {
    seq.get() as i64
}

pub fn i64_to_space_seq(raw: i64) -> DomainResult<SpaceSeq> {
    let unsigned = u64::try_from(raw)
        .map_err(|_| DomainError::validation(ValidationReason::SequenceOverflow))?;
    SpaceSeq::new(unsigned)
}

pub fn doc_class_to_db(class: DocClass) -> &'static str {
    match class {
        DocClass::UserDoc => "user-doc",
        DocClass::EncryptedNote => "encrypted-note",
        DocClass::AgentMemory => "agent-memory",
        DocClass::Skill => "skill",
        DocClass::Profile => "profile",
    }
}

pub fn doc_class_from_db(value: &str) -> Result<DocClass, PortError> {
    match value {
        "user-doc" => Ok(DocClass::UserDoc),
        "encrypted-note" => Ok(DocClass::EncryptedNote),
        "agent-memory" => Ok(DocClass::AgentMemory),
        "skill" => Ok(DocClass::Skill),
        "profile" => Ok(DocClass::Profile),
        other => Err(internal_not_committed(
            "corrupt_doc_class",
            format!("unexpected doc_class '{other}'"),
        )),
    }
}

pub fn lifecycle_to_db(lifecycle: Lifecycle) -> &'static str {
    match lifecycle {
        Lifecycle::Active => "active",
        Lifecycle::Trashed => "trashed",
        Lifecycle::Purged => "purged",
    }
}

pub fn lifecycle_from_db(value: &str) -> Result<Lifecycle, PortError> {
    match value {
        "active" => Ok(Lifecycle::Active),
        "trashed" => Ok(Lifecycle::Trashed),
        "purged" => Ok(Lifecycle::Purged),
        other => Err(internal_not_committed(
            "corrupt_lifecycle",
            format!("unexpected lifecycle '{other}'"),
        )),
    }
}

pub fn ability_kind_to_db(kind: AbilityKind) -> &'static str {
    match kind {
        AbilityKind::Role => "role",
        AbilityKind::Skill => "skill",
    }
}

pub fn ability_kind_from_db(value: &str) -> Result<AbilityKind, PortError> {
    match value {
        "role" => Ok(AbilityKind::Role),
        "skill" => Ok(AbilityKind::Skill),
        other => Err(internal_not_committed(
            "corrupt_ability_kind",
            format!("unexpected ability kind '{other}'"),
        )),
    }
}

pub fn chat_thread_kind_to_db(kind: ChatThreadKind) -> &'static str {
    match kind {
        ChatThreadKind::Personal => "personal",
        ChatThreadKind::SpaceGroup => "space_group",
        ChatThreadKind::KeeperLog => "keeper_log",
    }
}

pub fn chat_thread_kind_from_db(value: &str) -> Result<ChatThreadKind, PortError> {
    match value {
        "personal" => Ok(ChatThreadKind::Personal),
        "space_group" => Ok(ChatThreadKind::SpaceGroup),
        "keeper_log" => Ok(ChatThreadKind::KeeperLog),
        other => Err(internal_not_committed(
            "corrupt_chat_thread_kind",
            format!("unexpected chat thread kind '{other}'"),
        )),
    }
}

/// Complete immutable metadata snapshot stored in `revisions.metadata_msgpack`.
///
/// Historical point reads, causal overlays, and cold seeds decode this snapshot at
/// `visibility_seq <= cutoff` rather than reading mutable head rows.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RevisionMetadataEnvelope {
    pub version: u8,
    pub payload: RevisionMetadataPayload,
}

impl RevisionMetadataEnvelope {
    pub const VERSION: u8 = 1;

    pub fn v1(payload: RevisionMetadataPayload) -> Self {
        Self {
            version: Self::VERSION,
            payload,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, PortError> {
        encode_msgpack(self)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PortError> {
        let decoded: Self = decode_msgpack_bounded(bytes, MAX_MSGPACK_DECODE_BYTES)?;
        if decoded.version != Self::VERSION {
            return Err(internal_not_committed(
                "unsupported_revision_metadata_version",
                format!("version {}", decoded.version),
            ));
        }
        Ok(decoded)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum RevisionMetadataPayload {
    Note(NoteRevisionMetadata),
    Folder(FolderRevisionMetadata),
    Thread(ThreadRevisionMetadata),
    Ability(AbilityRevisionMetadata),
    Rank(RankRevisionMetadata),
    AgentRun(AgentRunRevisionMetadata),
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct NoteRevisionMetadata {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub folder_page: bool,
    pub note_id: NoteId,
    pub parent_folder_id: FolderId,
    pub is_root_child: bool,
    pub slug: String,
    pub slug_fold: String,
    pub title: String,
    pub doc_class: DocClass,
    pub ability_id: Option<AbilityId>,
    pub lifecycle: Lifecycle,
    pub visibility_mask: i32,
    pub byte_size: u64,
    pub content_digest: Option<ContentDigest>,
    pub schema_revision: Option<RevisionId>,
    pub raw_fields: Option<BTreeMap<String, YamlValue>>,
    pub evaluated_fields: BTreeMap<String, FieldObservation<FieldValue>>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FolderRevisionMetadata {
    pub folder_id: FolderId,
    pub parent_folder_id: Option<FolderId>,
    pub is_root: bool,
    pub slug: String,
    pub slug_fold: String,
    pub display_name: String,
    pub is_project: bool,
    pub project_slug: Option<String>,
    pub description: Option<String>,
    pub cover_note_id: Option<NoteId>,
    pub write_locked: bool,
    pub lifecycle: Lifecycle,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ThreadRevisionMetadata {
    pub thread_id: ChatThreadId,
    pub kind: ChatThreadKind,
    pub owner_id: PrincipalId,
    pub project_folder_id: Option<FolderId>,
    pub title: String,
    pub head_leaf_seq: ThreadEntrySeq,
    pub tainted: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AbilityRevisionMetadata {
    pub ability_id: AbilityId,
    pub kind: AbilityKind,
    pub slug_fold: String,
    pub entrypoint_note_id: NoteId,
    pub entrypoint_revision: RevisionId,
    pub lifecycle: Lifecycle,
    pub resources: BTreeMap<String, ContentDigest>,
    pub total_bytes: u64,
    #[serde(default)]
    pub attached_skills: Vec<AbilityRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promoted_from: Option<AbilityRef>,
    #[serde(default)]
    pub requires_explicit_binding: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RankRevisionMetadata {
    pub view_note_id: NoteId,
    pub view_key: ViewKey,
    pub target_note_id: NoteId,
    pub group_key: GroupKey,
    pub sort_rank_lexo: String,
    pub placement_revision: RevisionId,
    pub placement_actor_id: PrincipalId,
    pub placement_run_id: Option<AgentRunId>,
    pub is_pma_normalization: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct AgentRunRevisionMetadata {
    pub run_id: AgentRunId,
    pub last_seq: SpaceSeq,
}

/// Evaluates extracted YAML frontmatter fields against an optional Space field schema.
pub fn evaluate_fields_with_schema(
    raw_fields: Option<&BTreeMap<String, YamlValue>>,
    header_diagnostic: Option<&Diagnostic>,
    schema: Option<&BTreeMap<String, FieldSchema>>,
) -> BTreeMap<String, FieldObservation<FieldValue>> {
    let mut out = BTreeMap::new();
    let Some(raw) = raw_fields else {
        if let (Some(diag), Some(schema_map)) = (header_diagnostic, schema) {
            for key in schema_map.keys() {
                out.insert(
                    key.clone(),
                    FieldObservation::Bad {
                        diagnostic: diag.clone(),
                    },
                );
            }
        }
        return out;
    };

    for (key, val) in raw {
        let schema_entry = schema.and_then(|s| s.get(key));
        out.insert(key.clone(), convert_yaml_to_field(val, schema_entry));
    }
    if let Some(schema_map) = schema {
        for key in schema_map.keys() {
            out.entry(key.clone()).or_insert(FieldObservation::Absent);
        }
    }
    out
}

fn convert_yaml_to_field(
    val: &YamlValue,
    schema: Option<&FieldSchema>,
) -> FieldObservation<FieldValue> {
    use notarium_core::{
        query::FieldType,
        value::{Date, ScalarValue},
    };

    let bad = |reason| FieldObservation::Bad {
        diagnostic: Diagnostic {
            reason,
            location: None,
        },
    };

    if let Some(field_schema) = schema {
        if *val == YamlValue::Null {
            return if field_schema.nullable {
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Null))
            } else {
                bad(ValidationReason::InvalidState)
            };
        }
        match &field_schema.kind {
            FieldType::Scalar(scalar_ty) => match convert_yaml_scalar(val, Some(*scalar_ty)) {
                Ok(s) => FieldObservation::Ok(FieldValue::Scalar(s)),
                Err(reason) => bad(reason),
            },
            FieldType::List(scalar_ty) => {
                let YamlValue::Sequence(items) = val else {
                    return bad(ValidationReason::InvalidState);
                };
                let mut converted = Vec::with_capacity(items.len());
                for item in items {
                    match convert_yaml_scalar(item, Some(*scalar_ty)) {
                        Ok(s) => converted.push(s),
                        Err(reason) => return bad(reason),
                    }
                }
                FieldObservation::Ok(FieldValue::List(converted))
            }
            FieldType::Map => {
                let YamlValue::Mapping(map) = val else {
                    return bad(ValidationReason::InvalidState);
                };
                FieldObservation::Ok(FieldValue::Map(map.clone()))
            }
        }
    } else {
        match val {
            YamlValue::Null => FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Null)),
            YamlValue::String(s) => {
                if let Ok(ts) = Timestamp::parse(s) {
                    FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Timestamp(ts)))
                } else if let Ok(d) = Date::parse(s) {
                    FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Date(d)))
                } else {
                    FieldObservation::Ok(FieldValue::Scalar(ScalarValue::String(s.clone())))
                }
            }
            YamlValue::Bool(b) => FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Bool(*b))),
            YamlValue::Number(n) => {
                FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(n.clone())))
            }
            YamlValue::Sequence(items) => {
                let mut list = Vec::with_capacity(items.len());
                for item in items {
                    match convert_yaml_scalar(item, None) {
                        Ok(s) => list.push(s),
                        Err(reason) => return bad(reason),
                    }
                }
                FieldObservation::Ok(FieldValue::List(list))
            }
            YamlValue::Mapping(map) => FieldObservation::Ok(FieldValue::Map(map.clone())),
        }
    }
}

fn convert_yaml_scalar(
    val: &YamlValue,
    expected: Option<notarium_core::query::ScalarType>,
) -> Result<notarium_core::value::ScalarValue, ValidationReason> {
    use notarium_core::{
        query::ScalarType,
        value::{Date, ScalarValue},
    };
    match (val, expected) {
        (YamlValue::String(s), Some(ScalarType::String)) => Ok(ScalarValue::String(s.clone())),
        (YamlValue::String(s), Some(ScalarType::Date)) => Date::parse(s)
            .map(ScalarValue::Date)
            .map_err(|_| ValidationReason::InvalidDate),
        (YamlValue::String(s), Some(ScalarType::Timestamp)) => Timestamp::parse(s)
            .map(ScalarValue::Timestamp)
            .map_err(|_| ValidationReason::InvalidTimestamp),
        (YamlValue::Bool(b), Some(ScalarType::Bool)) => Ok(ScalarValue::Bool(*b)),
        (YamlValue::Number(n), Some(ScalarType::Number)) => Ok(ScalarValue::Number(n.clone())),
        (_, Some(ScalarType::Date)) => Err(ValidationReason::InvalidDate),
        (_, Some(ScalarType::Timestamp)) => Err(ValidationReason::InvalidTimestamp),
        (_, Some(ScalarType::Number)) => Err(ValidationReason::InvalidNumber),
        (_, Some(_)) => Err(ValidationReason::InvalidState),
        (YamlValue::Null, None) => Ok(ScalarValue::Null),
        (YamlValue::String(s), None) => Ok(ScalarValue::String(s.clone())),
        (YamlValue::Bool(b), None) => Ok(ScalarValue::Bool(*b)),
        (YamlValue::Number(n), None) => Ok(ScalarValue::Number(n.clone())),
        (_, None) => Err(ValidationReason::InvalidState),
    }
}

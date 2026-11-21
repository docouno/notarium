use std::collections::{BTreeMap, BTreeSet};

use notarium_core::{
    classes::DocClass,
    ids::{AbilityId, ClusterId, NoteId},
    model::Lifecycle,
    query::{FieldObservation, FieldValue},
    value::{Date, ExactNumber, ScalarValue, Timestamp},
};

use super::IndexError;

const ACTIVE: u8 = 1;
const TRASHED: u8 = 2;
const TOMBSTONE: u8 = 4;
const ENCRYPTED: u8 = 8;

const PACKED_LIFECYCLE_ACTIVE: u32 = 1;
const PACKED_LIFECYCLE_TRASHED: u32 = 2;
const PACKED_LIFECYCLE_PURGED: u32 = 3;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NoteSortHeader {
    pub updated_at_ms: i64,
    pub created_at_ms: i64,
    pub parent_dense_folder_id: u32,
    pub doc_class: DocClass,
    state_flags: u8,
    pub updated_subms_us: u16,
    updated_subus_ns: u16,
}

impl NoteSortHeader {
    pub const WIDTH: usize = 24;

    pub fn new(
        updated: Timestamp,
        created: Timestamp,
        parent_dense_folder_id: u32,
        doc_class: DocClass,
        lifecycle: Lifecycle,
    ) -> Self {
        let millis = |stamp: Timestamp| {
            stamp.unix_seconds() * 1_000 + i64::from(stamp.nanosecond() / 1_000_000)
        };
        let remainder = updated.nanosecond() % 1_000;
        let lifecycle = match lifecycle {
            Lifecycle::Active => ACTIVE,
            Lifecycle::Trashed => TRASHED,
            Lifecycle::Purged => TOMBSTONE,
        };
        Self {
            updated_at_ms: millis(updated),
            created_at_ms: millis(created),
            parent_dense_folder_id,
            doc_class,
            state_flags: lifecycle
                | if doc_class == DocClass::EncryptedNote {
                    ENCRYPTED
                } else {
                    0
                },
            updated_subms_us: ((updated.nanosecond() % 1_000_000) / 1_000) as u16,
            updated_subus_ns: remainder as u16,
        }
    }

    pub fn lifecycle(self) -> Lifecycle {
        match self.state_flags & (ACTIVE | TRASHED | TOMBSTONE) {
            ACTIVE => Lifecycle::Active,
            TRASHED => Lifecycle::Trashed,
            _ => Lifecycle::Purged,
        }
    }

    pub fn updated_at(self) -> Option<Timestamp> {
        let seconds = self.updated_at_ms.div_euclid(1_000);
        let nanos = self.updated_at_ms.rem_euclid(1_000) as u32 * 1_000_000
            + u32::from(self.updated_subms_us) * 1_000
            + u32::from(self.updated_subus_ns);
        Timestamp::from_unix_parts(seconds, nanos).ok()
    }

    pub(crate) fn updated_prefix(self) -> (i64, u16) {
        (self.updated_at_ms, self.updated_subms_us)
    }

    pub(crate) fn ns_remainder(self) -> u16 {
        self.updated_subus_ns
    }

    pub(crate) fn encode(self, out: &mut Vec<u8>) {
        // Pack full sub-millisecond nanoseconds (0..999_999 -> 20 bits),
        // doc_class (0..4 -> 3 bits), and lifecycle (1..3 -> 2 bits) into 4 bytes.
        let subms_ns = u32::from(self.updated_subms_us) * 1_000 + u32::from(self.updated_subus_ns);
        let class_bits = u32::from(class_tag(self.doc_class));
        let life_bits = match self.lifecycle() {
            Lifecycle::Active => PACKED_LIFECYCLE_ACTIVE,
            Lifecycle::Trashed => PACKED_LIFECYCLE_TRASHED,
            Lifecycle::Purged => PACKED_LIFECYCLE_PURGED,
        };
        let packed = (subms_ns & 0x000F_FFFF) | (class_bits << 20) | (life_bits << 23);
        out.extend(self.updated_at_ms.to_le_bytes());
        out.extend(self.created_at_ms.to_le_bytes());
        out.extend(self.parent_dense_folder_id.to_le_bytes());
        out.extend(packed.to_le_bytes());
    }

    pub(crate) fn decode_updated_prefix(raw: &[u8]) -> Option<(i64, u16)> {
        Some(Self::decode(raw)?.updated_prefix())
    }

    pub(crate) fn decode(raw: &[u8]) -> Option<Self> {
        let packed = u32::from_le_bytes(raw.get(20..24)?.try_into().ok()?);
        // Upper 7 bits are reserved and must be zero.
        if packed >> 25 != 0 {
            return None;
        }
        let subms_ns = packed & 0x000F_FFFF;
        if subms_ns >= 1_000_000 {
            return None;
        }
        let doc_class = match (packed >> 20) & 0x7 {
            0 => DocClass::UserDoc,
            1 => DocClass::EncryptedNote,
            2 => DocClass::AgentMemory,
            3 => DocClass::Skill,
            4 => DocClass::Profile,
            _ => return None,
        };
        let lifecycle = match (packed >> 23) & 0x3 {
            PACKED_LIFECYCLE_ACTIVE => ACTIVE,
            PACKED_LIFECYCLE_TRASHED => TRASHED,
            PACKED_LIFECYCLE_PURGED => TOMBSTONE,
            _ => return None,
        };
        let state_flags = lifecycle
            | if doc_class == DocClass::EncryptedNote {
                ENCRYPTED
            } else {
                0
            };
        Some(Self {
            updated_at_ms: i64::from_le_bytes(raw.get(..8)?.try_into().ok()?),
            created_at_ms: i64::from_le_bytes(raw.get(8..16)?.try_into().ok()?),
            parent_dense_folder_id: u32::from_le_bytes(raw.get(16..20)?.try_into().ok()?),
            doc_class,
            state_flags,
            updated_subms_us: (subms_ns / 1_000) as u16,
            updated_subus_ns: (subms_ns % 1_000) as u16,
        })
    }
}

fn class_tag(class: DocClass) -> u8 {
    match class {
        DocClass::UserDoc => 0,
        DocClass::EncryptedNote => 1,
        DocClass::AgentMemory => 2,
        DocClass::Skill => 3,
        DocClass::Profile => 4,
    }
}

pub(crate) fn lifecycle_tag(value: Lifecycle) -> u8 {
    match value {
        Lifecycle::Active => ACTIVE,
        Lifecycle::Trashed => TRASHED,
        Lifecycle::Purged => TOMBSTONE,
    }
}

#[cfg(any(test, feature = "test-support"))]
pub(crate) fn folder_lifecycle(tag: u8) -> Option<Lifecycle> {
    match tag {
        ACTIVE => Some(Lifecycle::Active),
        TRASHED => Some(Lifecycle::Trashed),
        TOMBSTONE => Some(Lifecycle::Purged),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub enum PostingKey {
    Active,
    Trashed,
    TrashedSubtree,
    Encrypted,
    DocClass(DocClass),
    FolderDirect(u32),
    FolderSubtree(u32),
    Ability(AbilityId),
    Tag(String),
    FieldOk(String),
    FieldBad(String),
    FieldNull(String),
    FieldEmptyList(String),
    ClusterMembers(ClusterId),
}

impl PostingKey {
    pub(crate) fn encode(&self) -> Vec<u8> {
        match self {
            Self::Active => vec![1],
            Self::Trashed => vec![2],
            Self::TrashedSubtree => vec![3],
            Self::Encrypted => vec![4],
            Self::DocClass(class) => vec![5, class_tag(*class)],
            Self::FolderDirect(folder) => encode_fixed(6, &folder.to_be_bytes()),
            Self::FolderSubtree(folder) => encode_fixed(7, &folder.to_be_bytes()),
            Self::Ability(id) => encode_fixed(8, id.as_str().as_bytes()),
            Self::Tag(tag) => encode_fixed(9, tag.as_bytes()),
            Self::FieldOk(key) => encode_fixed(10, key.as_bytes()),
            Self::FieldBad(key) => encode_fixed(11, key.as_bytes()),
            Self::FieldNull(key) => encode_fixed(12, key.as_bytes()),
            Self::FieldEmptyList(key) => encode_fixed(13, key.as_bytes()),
            Self::ClusterMembers(id) => encode_fixed(14, id.as_str().as_bytes()),
        }
    }
}

fn encode_fixed(namespace: u8, bytes: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(bytes.len() + 1);
    key.push(namespace);
    key.extend(bytes);
    key
}

// Length-prefixing the field key makes all values of that field contiguous.
pub(crate) fn field_prefix(namespace: u8, key: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(5 + key.len());
    out.push(namespace);
    out.extend((key.len() as u32).to_be_bytes());
    out.extend(key.as_bytes());
    out
}

pub(crate) const TAG_NAMESPACE: u8 = 9;
pub(crate) const FIELD_SCALAR: u8 = 16;
pub(crate) const FIELD_LIST_ELEM: u8 = 17;
pub(crate) const FIELD_BUCKET: u8 = 18;

pub(crate) fn value_key(namespace: u8, key: &str, value: &ScalarValue) -> Vec<u8> {
    let mut encoded = field_prefix(namespace, key);
    scalar_bytes(value, &mut encoded);
    encoded
}

pub(crate) fn bucket_marker(prefix: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(1 + prefix.len());
    key.push(FIELD_BUCKET);
    key.extend(prefix);
    key
}

pub(crate) fn bucket_key(prefix: &[u8], scalar_bytes: &[u8]) -> Vec<u8> {
    let mut key = Vec::with_capacity(3 + prefix.len());
    key.push(FIELD_BUCKET);
    key.extend(prefix);
    let digest = blake3::hash(scalar_bytes);
    let bucket = u16::from_be_bytes([digest.as_bytes()[0], digest.as_bytes()[1]]) & 0x0FFF;
    key.extend(bucket.to_be_bytes());
    key
}

fn scalar_bytes(value: &ScalarValue, out: &mut Vec<u8>) {
    match value {
        ScalarValue::Bool(value) => out.extend([1, u8::from(*value)]),
        ScalarValue::String(value) => {
            out.push(2);
            out.extend(value.as_bytes());
        }
        ScalarValue::Number(value) => {
            if let Some(integer) = scalar_integer(value) {
                out.push(3);
                out.extend(integer.to_be_bytes());
            } else {
                out.push(4);
                out.extend(number_float(value).to_bits().to_be_bytes());
            }
        }
        ScalarValue::Date(value) => {
            out.push(5);
            out.extend(date_key(*value).to_be_bytes());
        }
        ScalarValue::Timestamp(value) => {
            out.push(6);
            out.extend(timestamp_key(*value).to_be_bytes());
        }
        ScalarValue::Null => out.push(0),
    }
}

pub(crate) fn simple_scalar(raw: &[u8]) -> Option<ScalarValue> {
    match raw {
        [1, 0] => Some(ScalarValue::Bool(false)),
        [1, 1] => Some(ScalarValue::Bool(true)),
        [2, text @ ..] => Some(ScalarValue::String(
            std::str::from_utf8(text).ok()?.to_owned(),
        )),
        _ => None,
    }
}

fn scalar_integer(number: &ExactNumber) -> Option<i128> {
    if let Some(integer) = exact_integer(number) {
        return Some(integer);
    }
    let float = number_float(number);
    let range = (i64::MIN as f64)..(u64::MAX as f64);
    if range.contains(&float) && float.fract() == 0.0 {
        Some(float as i128)
    } else {
        None
    }
}

pub(crate) fn exact_integer(number: &ExactNumber) -> Option<i128> {
    number
        .as_json()
        .as_i64()
        .map(i128::from)
        .or_else(|| number.as_json().as_u64().map(i128::from))
}

pub(crate) fn number_float(number: &ExactNumber) -> f64 {
    let value = number.as_json().as_f64().expect("ExactNumber is finite");
    if value == 0.0 { 0.0 } else { value }
}

pub(crate) fn number_key(value: f64) -> u128 {
    let bits = value.to_bits();
    let sign = 1u64 << 63;
    (if bits & sign == 0 { bits ^ sign } else { !bits }).into()
}

pub(crate) fn number_from_key(key: u128) -> f64 {
    let bits = key as u64;
    let sign = 1u64 << 63;
    f64::from_bits(if bits & sign == 0 { !bits } else { bits ^ sign })
}

pub(crate) fn date_key(date: Date) -> u32 {
    let (year, month, day) = date.ymd();
    (year as u32) * 10_000 + u32::from(month) * 100 + u32::from(day)
}

pub(crate) fn timestamp_key(timestamp: Timestamp) -> u128 {
    let seconds = (timestamp.unix_seconds() as u64) ^ (1u64 << 63);
    (u128::from(seconds) << 30) | u128::from(timestamp.nanosecond())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BsiKind {
    Number,
    Date,
    Timestamp,
}

impl BsiKind {
    pub(crate) fn width(self) -> u8 {
        match self {
            Self::Number => 64,
            // 9999-12-31 encodes as 99_991_231 < 2^27 (134_217_728).
            Self::Date => 27,
            Self::Timestamp => 94,
        }
    }

    pub(crate) fn prefix(self, key: &str) -> Vec<u8> {
        field_prefix(
            match self {
                Self::Number => 1,
                Self::Date => 2,
                Self::Timestamp => 3,
            },
            key,
        )
    }

    pub(crate) fn for_scalar(value: &ScalarValue) -> Option<Self> {
        match value {
            ScalarValue::Number(_) => Some(Self::Number),
            ScalarValue::Date(_) => Some(Self::Date),
            ScalarValue::Timestamp(_) => Some(Self::Timestamp),
            _ => None,
        }
    }

    pub(crate) fn key(value: &ScalarValue) -> Option<u128> {
        match value {
            ScalarValue::Number(number) => Some(number_key(number_float(number))),
            ScalarValue::Date(date) => Some(date_key(*date).into()),
            ScalarValue::Timestamp(timestamp) => Some(timestamp_key(*timestamp)),
            _ => None,
        }
    }
}

pub const L0_EVENT_LIMIT: u32 = 10_000;
pub const L0_BYTE_LIMIT: usize = 16 * 1024 * 1024;
pub const L0_IDLE: std::time::Duration = std::time::Duration::from_secs(5);

pub struct IndexNote<'a> {
    pub dense: u32,
    pub id: &'a NoteId,
    pub header: NoteSortHeader,
    pub ancestors: &'a [u32],
    pub trashed_ancestor: bool,
    pub fields: &'a BTreeMap<String, FieldObservation<FieldValue>>,
    pub tags: &'a [String],
    pub ability: Option<&'a AbilityId>,
}

pub(crate) struct NotePostings {
    pub ordinary: BTreeSet<Vec<u8>>,
    pub scalars: BTreeMap<Vec<u8>, (BsiKind, ScalarValue)>,
}

impl IndexNote<'_> {
    pub(crate) fn postings(&self) -> Result<NotePostings, IndexError> {
        if self.dense == u32::MAX || self.header.lifecycle() == Lifecycle::Purged {
            return Err(IndexError::InvalidInput(
                "purged notes must occupy an empty dense slot",
            ));
        }
        let mut keys = BTreeSet::new();
        let mut scalars = BTreeMap::new();
        let mut add = |key: PostingKey| {
            keys.insert(key.encode());
        };
        let lifecycle = match self.header.lifecycle() {
            Lifecycle::Active => PostingKey::Active,
            Lifecycle::Trashed => PostingKey::Trashed,
            Lifecycle::Purged => unreachable!("checked above"),
        };
        add(lifecycle);
        add(PostingKey::DocClass(self.header.doc_class));
        let parent = self.header.parent_dense_folder_id;
        add(PostingKey::FolderDirect(parent));
        add(PostingKey::FolderSubtree(parent));
        for folder in self.ancestors {
            add(PostingKey::FolderSubtree(*folder));
        }
        if self.trashed_ancestor {
            add(PostingKey::TrashedSubtree);
        }
        if self.header.doc_class == DocClass::EncryptedNote {
            add(PostingKey::Encrypted);
            return Ok(NotePostings {
                ordinary: keys,
                scalars,
            });
        }
        if let Some(ability) = self.ability {
            add(PostingKey::Ability(ability.clone()));
        }
        for tag in self.tags {
            add(PostingKey::Tag(tag.clone()));
        }
        for (field, state) in self.fields {
            match state {
                FieldObservation::Absent => {}
                FieldObservation::Bad { .. } => {
                    keys.insert(PostingKey::FieldBad(field.clone()).encode());
                }
                FieldObservation::Ok(value) => {
                    keys.insert(PostingKey::FieldOk(field.clone()).encode());
                    match value {
                        FieldValue::Scalar(ScalarValue::Null) => {
                            keys.insert(PostingKey::FieldNull(field.clone()).encode());
                        }
                        FieldValue::Scalar(value) => {
                            if let Some(kind) = BsiKind::for_scalar(value) {
                                scalars.insert(kind.prefix(field), (kind, value.clone()));
                            } else {
                                keys.insert(value_key(FIELD_SCALAR, field, value));
                            }
                        }
                        FieldValue::List(values) => {
                            if values.is_empty() {
                                keys.insert(PostingKey::FieldEmptyList(field.clone()).encode());
                            }
                            keys.extend(
                                values
                                    .iter()
                                    .filter(|value| **value != ScalarValue::Null)
                                    .map(|value| value_key(FIELD_LIST_ELEM, field, value)),
                            );
                        }
                        FieldValue::Map(_) => {}
                    }
                }
            }
        }
        Ok(NotePostings {
            ordinary: keys,
            scalars,
        })
    }
}

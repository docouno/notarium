//! Typed filters, field-state truth tables and stable keysets; no query engine.
use crate::{
    DomainError, DomainResult,
    error::{Diagnostic, ValidationReason},
    ids::*,
    model::*,
    receipt::*,
    value::*,
};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::BTreeMap};

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FieldObservation<T> {
    Ok(T),
    Bad { diagnostic: Diagnostic },
    Absent,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FieldValue {
    Scalar(ScalarValue),
    List(Vec<ScalarValue>),
    Map(BTreeMap<String, YamlValue>),
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ScalarType {
    String,
    Bool,
    Number,
    Date,
    Timestamp,
}
impl ScalarType {
    pub fn accepts(self, value: &ScalarValue) -> bool {
        matches!(
            (self, value),
            (Self::String, ScalarValue::String(_))
                | (Self::Bool, ScalarValue::Bool(_))
                | (Self::Number, ScalarValue::Number(_))
                | (Self::Date, ScalarValue::Date(_))
                | (Self::Timestamp, ScalarValue::Timestamp(_))
        )
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum FieldType {
    Scalar(ScalarType),
    List(ScalarType),
    Map,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FieldSchema {
    pub kind: FieldType,
    pub nullable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Bound<T> {
    pub value: T,
    pub inclusive: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ValueRange<T> {
    pub lower: Option<Bound<T>>,
    pub upper: Option<Bound<T>>,
}
impl<T: Ord> ValueRange<T> {
    pub fn validate(&self) -> DomainResult<()> {
        if let (Some(a), Some(b)) = (&self.lower, &self.upper)
            && (a.value > b.value || (a.value == b.value && !(a.inclusive && b.inclusive)))
        {
            return Err(DomainError::validation(ValidationReason::InvalidRange));
        }
        Ok(())
    }
    pub fn contains(&self, value: &T) -> bool {
        self.lower
            .as_ref()
            .is_none_or(|b| value > &b.value || (b.inclusive && value == &b.value))
            && self
                .upper
                .as_ref()
                .is_none_or(|b| value < &b.value || (b.inclusive && value == &b.value))
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Predicate {
    Eq {
        key: String,
        value: ScalarValue,
    },
    Contains {
        key: String,
        value: ScalarValue,
    },
    Exists {
        key: String,
    },
    IsBad {
        key: String,
    },
    IsAbsent {
        key: String,
    },
    NumberRange {
        key: String,
        range: ValueRange<ExactNumber>,
    },
    DateRange {
        key: String,
        range: ValueRange<Date>,
    },
    TimestampRange {
        key: String,
        range: ValueRange<Timestamp>,
    },
    All(Vec<Predicate>),
    Any(Vec<Predicate>),
    Not(Box<Predicate>),
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FieldFilterAstV1 {
    pub version: u8,
    pub predicate: Predicate,
}
impl FieldFilterAstV1 {
    pub fn validate(&self, schema: &BTreeMap<String, FieldSchema>) -> DomainResult<()> {
        if self.version != 1 {
            return Err(DomainError::validation(
                ValidationReason::UnsupportedQueryVersion,
            ));
        }
        self.predicate.validate(schema, 0, &mut 0)
    }
    pub fn matches(
        &self,
        fields: &BTreeMap<String, FieldObservation<FieldValue>>,
        schema: &BTreeMap<String, FieldSchema>,
    ) -> DomainResult<bool> {
        self.validate(schema)?;
        Ok(self.predicate.matches(fields))
    }
}
impl Predicate {
    fn validate(
        &self,
        schema: &BTreeMap<String, FieldSchema>,
        depth: usize,
        count: &mut usize,
    ) -> DomainResult<()> {
        *count += 1;
        if depth > 32 || *count > 1024 {
            return Err(DomainError::validation(ValidationReason::InvalidQuery));
        }
        let invalid = || DomainError::validation(ValidationReason::InvalidQuery);
        let field = |key: &str| schema.get(key).ok_or_else(invalid);
        match self {
            Self::All(items) | Self::Any(items) => {
                for item in items {
                    item.validate(schema, depth + 1, count)?;
                }
            }
            Self::Not(item) => item.validate(schema, depth + 1, count)?,
            Self::Eq { key, value } => {
                let f = field(key)?;
                if !matches!(f.kind,FieldType::Scalar(t) if t.accepts(value) || (f.nullable && *value==ScalarValue::Null))
                {
                    return Err(invalid());
                }
            }
            Self::Contains { key, value } => {
                let f = field(key)?;
                if !matches!(f.kind,FieldType::List(t) if t.accepts(value)) {
                    return Err(invalid());
                }
            }
            Self::NumberRange { key, range } => {
                if field(key)?.kind != FieldType::Scalar(ScalarType::Number) {
                    return Err(invalid());
                }
                range.validate()?;
            }
            Self::DateRange { key, range } => {
                if field(key)?.kind != FieldType::Scalar(ScalarType::Date) {
                    return Err(invalid());
                }
                range.validate()?;
            }
            Self::TimestampRange { key, range } => {
                if field(key)?.kind != FieldType::Scalar(ScalarType::Timestamp) {
                    return Err(invalid());
                }
                range.validate()?;
            }
            Self::Exists { key } | Self::IsBad { key } | Self::IsAbsent { key } => {
                field(key)?;
            }
        }
        Ok(())
    }
    fn matches(&self, fields: &BTreeMap<String, FieldObservation<FieldValue>>) -> bool {
        let observed = |key: &String| fields.get(key).unwrap_or(&FieldObservation::Absent);
        match self {
            Self::All(items) => items.iter().all(|p| p.matches(fields)),
            Self::Any(items) => items.iter().any(|p| p.matches(fields)),
            Self::Not(item) => !item.matches(fields),
            Self::Eq { key, value } => {
                matches!(observed(key),FieldObservation::Ok(FieldValue::Scalar(actual)) if actual==value)
            }
            Self::Contains { key, value } => {
                matches!(observed(key),FieldObservation::Ok(FieldValue::List(values)) if values.contains(value))
            }
            Self::Exists { key } => !matches!(observed(key), FieldObservation::Absent),
            Self::IsBad { key } => matches!(observed(key), FieldObservation::Bad { .. }),
            Self::IsAbsent { key } => matches!(observed(key), FieldObservation::Absent),
            Self::NumberRange { key, range } => {
                matches!(observed(key),FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Number(v))) if range.contains(v))
            }
            Self::DateRange { key, range } => {
                matches!(observed(key),FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Date(v))) if range.contains(v))
            }
            Self::TimestampRange { key, range } => {
                matches!(observed(key),FieldObservation::Ok(FieldValue::Scalar(ScalarValue::Timestamp(v))) if range.contains(v))
            }
        }
    }
}

/// Repeatable comparisons within one key are OR; distinct keys are AND.
pub fn repeatable_filters(groups: BTreeMap<String, Vec<ScalarValue>>) -> FieldFilterAstV1 {
    FieldFilterAstV1 {
        version: 1,
        predicate: Predicate::All(
            groups
                .into_iter()
                .map(|(key, values)| {
                    Predicate::Any(
                        values
                            .into_iter()
                            .map(|value| Predicate::Eq {
                                key: key.clone(),
                                value,
                            })
                            .collect(),
                    )
                })
                .collect(),
        ),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum Direction {
    Asc,
    Desc,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SortColumn {
    UpdatedAt,
    Field { key: String, schema: FieldSchema },
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SortKey {
    pub column: SortColumn,
    pub direction: Direction,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "Vec<SortKey>", into = "Vec<SortKey>")]
pub struct SortSpec(Vec<SortKey>);
impl SortSpec {
    pub fn new(keys: Vec<SortKey>) -> DomainResult<Self> {
        if keys.is_empty() || keys.len() > 8 {
            return Err(DomainError::validation(ValidationReason::InvalidLimit));
        }
        if keys.iter().any(|k|matches!(&k.column,SortColumn::Field{schema,..} if !matches!(schema.kind,FieldType::Scalar(_)))){
            return Err(DomainError::validation(ValidationReason::UnsupportedSortType));
        }
        Ok(Self(keys))
    }
    pub fn keys(&self) -> &[SortKey] {
        &self.0
    }
    pub fn compare(&self, left: &SortTuple, right: &SortTuple) -> DomainResult<Ordering> {
        if left.cells.len() != self.0.len() || right.cells.len() != self.0.len() {
            return Err(DomainError::validation(ValidationReason::InvalidQuery));
        }
        for ((a, b), key) in left.cells.iter().zip(&right.cells).zip(&self.0) {
            let a = normalize_cell(a, key);
            let b = normalize_cell(b, key);
            let category = |c: &SortCell| match c {
                SortCell::Value(_) => 0,
                SortCell::Null => 1,
                SortCell::Bad => 2,
                SortCell::Absent => 3,
            };
            let order = category(a).cmp(&category(b));
            if order != Ordering::Equal {
                return Ok(order);
            }
            if let (SortCell::Value(a), SortCell::Value(b)) = (a, b) {
                let mut order = a.compare_same_type(b)?;
                if key.direction == Direction::Desc {
                    order = order.reverse();
                }
                if order != Ordering::Equal {
                    return Ok(order);
                }
            }
        }
        Ok(left.note_id.cmp(&right.note_id))
    }
}
impl Default for SortSpec {
    fn default() -> Self {
        Self(vec![SortKey {
            column: SortColumn::UpdatedAt,
            direction: Direction::Desc,
        }])
    }
}
impl TryFrom<Vec<SortKey>> for SortSpec {
    type Error = DomainError;
    fn try_from(v: Vec<SortKey>) -> DomainResult<Self> {
        Self::new(v)
    }
}
impl From<SortSpec> for Vec<SortKey> {
    fn from(v: SortSpec) -> Self {
        v.0
    }
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SortCell {
    Value(ScalarValue),
    Null,
    Bad,
    Absent,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SortTuple {
    pub cells: Vec<SortCell>,
    pub note_id: NoteId,
}
fn normalize_cell<'a>(cell: &'a SortCell, key: &SortKey) -> &'a SortCell {
    let (kind, nullable) = match &key.column {
        SortColumn::UpdatedAt => (ScalarType::Timestamp, false),
        SortColumn::Field { schema, .. } => {
            let FieldType::Scalar(kind) = schema.kind else {
                return &SortCell::Bad;
            };
            (kind, schema.nullable)
        }
    };
    match cell {
        SortCell::Value(value) if !kind.accepts(value) => {
            if *value == ScalarValue::Null && nullable {
                &SortCell::Null
            } else {
                &SortCell::Bad
            }
        }
        SortCell::Null if !nullable => &SortCell::Bad,
        _ => cell,
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct KeysetCursor {
    pub version: u8,
    pub scope: HistoryScope,
    pub fingerprint: ContentDigest,
    pub effective_read: EffectiveReadId,
    pub generation: ProjectionGeneration,
    pub base_cut: SpaceSeq,
    pub last: SortTuple,
}
impl KeysetCursor {
    pub fn check(&self, read: &EffectiveRead) -> DomainResult<()> {
        read.cut.scope.check(&self.scope)?;
        if self.version != 1 || self.fingerprint != read.fingerprint {
            return Err(DomainError::validation(
                ValidationReason::CursorScopeMismatch,
            ));
        }
        if self.effective_read != read.id
            || self.generation != read.cut.generation
            || self.base_cut != read.cut.projected_seq
        {
            return Err(DomainError::validation(ValidationReason::CursorStale));
        }
        Ok(())
    }
}
/// Owned by projection retention. Continuations use these immutable versions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EffectiveRead {
    pub id: EffectiveReadId,
    pub cut: SnapshotCut,
    pub fingerprint: ContentDigest,
    pub exact_receipts: ReceiptSet,
    pub overlay: Vec<OverlayRowVersion>,
}
#[derive(Clone, Debug)]
pub enum ReadRequest<Q> {
    Open { query: Q, causal: CausalBasis },
    Continue { cursor: KeysetCursor },
}
#[derive(Clone, Debug)]
pub struct CursorPage<T> {
    pub items: Vec<T>,
    pub next: Option<KeysetCursor>,
    pub scope: HistoryScope,
    pub canonical_seq: SpaceSeq,
    pub projected_seq: SpaceSeq,
    pub incomplete: bool,
    pub diagnostics: Vec<Diagnostic>,
}

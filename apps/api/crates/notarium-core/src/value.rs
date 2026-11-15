//! Authored values and exact scalar comparison. No schema or disk access.
use crate::{DomainError, DomainResult, error::ValidationReason};
use serde::{Deserialize, Serialize};
use std::{cmp::Ordering, collections::BTreeMap};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ExactNumber(serde_json::Number);
impl ExactNumber {
    pub fn new(value: serde_json::Number) -> Self {
        Self(value)
    }
    pub fn as_json(&self) -> &serde_json::Number {
        &self.0
    }
    pub fn from_f64(value: f64) -> DomainResult<Self> {
        serde_json::Number::from_f64(value)
            .map(Self)
            .ok_or_else(|| DomainError::validation(ValidationReason::InvalidNumber))
    }
}
impl From<i64> for ExactNumber {
    fn from(value: i64) -> Self {
        Self(value.into())
    }
}
impl From<u64> for ExactNumber {
    fn from(value: u64) -> Self {
        Self(value.into())
    }
}
impl PartialEq for ExactNumber {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for ExactNumber {}
impl PartialOrd for ExactNumber {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ExactNumber {
    fn cmp(&self, other: &Self) -> Ordering {
        let integer = |n: &serde_json::Number| {
            n.as_i64()
                .map(i128::from)
                .or_else(|| n.as_u64().map(i128::from))
        };
        match (integer(&self.0), integer(&other.0)) {
            (Some(a), Some(b)) => a.cmp(&b),
            (Some(a), None) => int_float_cmp(a, other.0.as_f64().expect("finite JSON number")),
            (None, Some(b)) => {
                int_float_cmp(b, self.0.as_f64().expect("finite JSON number")).reverse()
            }
            (None, None) => self
                .0
                .as_f64()
                .partial_cmp(&other.0.as_f64())
                .expect("finite JSON numbers"),
        }
    }
}
fn int_float_cmp(integer: i128, float: f64) -> Ordering {
    if float == 0.0 {
        return integer.cmp(&0);
    }
    if (integer < 0) != float.is_sign_negative() {
        return if integer < 0 {
            Ordering::Less
        } else {
            Ordering::Greater
        };
    }
    let abs = integer.unsigned_abs();
    let bits = float.abs().to_bits();
    let raw_exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if raw_exponent == 0 { 0 } else { 1u64 << 52 };
    let exponent = raw_exponent.max(1) - 1023 - 52;
    let order = if exponent >= 0 {
        if exponent > 74 {
            Ordering::Less
        } else {
            abs.cmp(&((mantissa as u128) << exponent))
        }
    } else {
        let shift = -exponent as u32;
        if shift >= 64 {
            if abs == 0 {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        } else {
            let whole = (mantissa >> shift) as u128;
            match abs.cmp(&whole) {
                Ordering::Equal if mantissa & ((1u64 << shift) - 1) != 0 => Ordering::Less,
                order => order,
            }
        }
    };
    if float.is_sign_negative() {
        order.reverse()
    } else {
        order
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Date(time::Date);
impl Date {
    pub fn parse(value: &str) -> DomainResult<Self> {
        if value.len() != 10
            || !value.bytes().enumerate().all(|(i, b)| {
                if i == 4 || i == 7 {
                    b == b'-'
                } else {
                    b.is_ascii_digit()
                }
            })
        {
            return Err(DomainError::validation(ValidationReason::InvalidDate));
        }
        time::Date::parse(
            value,
            time::macros::format_description!("[year]-[month]-[day]"),
        )
        .map(Self)
        .map_err(|_| DomainError::validation(ValidationReason::InvalidDate))
    }
}
impl TryFrom<String> for Date {
    type Error = DomainError;
    fn try_from(s: String) -> DomainResult<Self> {
        Self::parse(&s)
    }
}
impl From<Date> for String {
    fn from(value: Date) -> Self {
        value.0.to_string()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Timestamp(time::OffsetDateTime);
impl Timestamp {
    pub fn parse(value: &str) -> DomainResult<Self> {
        if let Some((_, fraction)) = value.split_once('.')
            && fraction.bytes().take_while(u8::is_ascii_digit).count() > 9
        {
            return Err(DomainError::validation(ValidationReason::InvalidTimestamp));
        }
        let parsed =
            time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
                .map_err(|_| DomainError::validation(ValidationReason::InvalidTimestamp))?;
        let utc = parsed.to_offset(time::UtcOffset::UTC);
        if !(0..=9999).contains(&utc.year()) {
            return Err(DomainError::validation(ValidationReason::InvalidTimestamp));
        }
        Ok(Self(utc))
    }
    pub fn unix_seconds(self) -> i64 {
        self.0.unix_timestamp()
    }
    pub fn nanosecond(self) -> u32 {
        self.0.nanosecond()
    }
}
impl TryFrom<String> for Timestamp {
    type Error = DomainError;
    fn try_from(s: String) -> DomainResult<Self> {
        Self::parse(&s)
    }
}
impl From<Timestamp> for String {
    fn from(value: Timestamp) -> Self {
        value
            .0
            .format(&time::format_description::well_known::Rfc3339)
            .expect("parsed RFC3339 timestamp")
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum ScalarValue {
    Null,
    String(String),
    Bool(bool),
    Number(ExactNumber),
    Date(Date),
    Timestamp(Timestamp),
}
impl ScalarValue {
    pub fn compare_same_type(&self, other: &Self) -> DomainResult<Ordering> {
        match (self, other) {
            (Self::Null, Self::Null) => Ok(Ordering::Equal),
            (Self::String(a), Self::String(b)) => Ok(a.cmp(b)),
            (Self::Bool(a), Self::Bool(b)) => Ok(a.cmp(b)),
            (Self::Number(a), Self::Number(b)) => Ok(a.cmp(b)),
            (Self::Date(a), Self::Date(b)) => Ok(a.cmp(b)),
            (Self::Timestamp(a), Self::Timestamp(b)) => Ok(a.cmp(b)),
            _ => Err(DomainError::validation(ValidationReason::InvalidQuery)),
        }
    }
}

/// Lossless authored tree for supported YAML values; schema interpretation is separate.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum YamlValue {
    Null,
    String(String),
    Bool(bool),
    Number(ExactNumber),
    Sequence(Vec<YamlValue>),
    Mapping(BTreeMap<String, YamlValue>),
}
impl YamlValue {
    pub fn validate_keys(&self) -> DomainResult<()> {
        fn visit(value: &YamlValue, depth: usize) -> DomainResult<()> {
            if depth > 64 {
                return Err(DomainError::validation(ValidationReason::InvalidYaml));
            }
            match value {
                YamlValue::Mapping(values) => {
                    for (key, value) in values {
                        if key == "__proto__" {
                            return Err(DomainError::validation(ValidationReason::ForbiddenKey));
                        }
                        visit(value, depth + 1)?;
                    }
                }
                YamlValue::Sequence(values) => {
                    for value in values {
                        visit(value, depth + 1)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        visit(self, 0)
    }
}

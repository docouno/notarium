//! Primitive decoding shared by persisted admission and runtime projection.
use crate::error::invalid;
use notarium_core::{
    error::{PortError, ValidationReason},
    value::Timestamp,
};
use serde::{Serialize, de::DeserializeOwned};

/// Preserve the complete typed structure. Some reusable core DTOs intentionally
/// accept unknown fields on deserialization, but persisted metadata must not keep
/// arbitrary fields that its runtime decoder would discard. Object order and
/// whitespace remain irrelevant here; SQL equality keys have a stricter check.
pub(crate) fn closed_json<T: DeserializeOwned + Serialize>(source: &str) -> Result<T, PortError> {
    if source.len() > 65536 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let value: T =
        serde_json::from_str(source).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let original: serde_json::Value =
        serde_json::from_str(source).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let typed =
        serde_json::to_value(&value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if typed != original {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(value)
}

/// Cron slots are whole UTC seconds representable by the core Timestamp type.
/// Chrono alone accepts a wider year range, and an SQL i64 is wider still.
pub(crate) fn schedule_timestamp(milliseconds: i64) -> Result<Timestamp, PortError> {
    if milliseconds % 1000 != 0 {
        return Err(invalid(ValidationReason::InvalidTimestamp));
    }
    let date = chrono::DateTime::from_timestamp_millis(milliseconds)
        .ok_or_else(|| invalid(ValidationReason::InvalidTimestamp))?;
    Ok(Timestamp::parse(
        &date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    )?)
}

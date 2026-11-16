//! Primitive decoding shared by persisted admission and runtime projection.
use crate::error::invalid;
use notarium_core::{
    error::{PortError, ValidationReason},
    value::Timestamp,
};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

fn is_closed_subset(original: &Value, typed: &Value) -> bool {
    match (original, typed) {
        (Value::Object(orig), Value::Object(typ)) => orig
            .iter()
            .all(|(key, val)| typ.get(key).is_some_and(|tval| is_closed_subset(val, tval))),
        (Value::Array(orig), Value::Array(typ)) => {
            orig.len() == typ.len()
                && orig
                    .iter()
                    .zip(typ)
                    .all(|(oval, tval)| is_closed_subset(oval, tval))
        }
        (orig, typ) => orig == typ,
    }
}

/// Preserve the complete typed structure via a single text parse. Reusable core
/// DTOs without `deny_unknown_fields` still reject extra keys in persisted JSON,
/// while omitted `#[serde(default)]` fields remain forward-compatible.
pub(crate) fn closed_json<T: DeserializeOwned + Serialize>(source: &str) -> Result<T, PortError> {
    if source.len() > 65536 {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let original: Value =
        serde_json::from_str(source).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let value = T::deserialize(&original).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let typed =
        serde_json::to_value(&value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    if !is_closed_subset(&original, &typed) {
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

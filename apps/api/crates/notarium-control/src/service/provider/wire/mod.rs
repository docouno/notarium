//! Deliberately bounded codecs; they do not choose a provider or send requests.
mod bounded_json;
mod embeddings;
mod encode;
mod stream;
pub(super) use embeddings::decode_embedding;
pub(super) use encode::{
    completion, completion_fingerprint, embedding, embedding_fingerprint, endpoint,
    estimate_completion_input_tokens, estimate_completion_wire_bytes,
    estimate_embedding_input_tokens, text_tokens,
};
pub(super) use stream::CompletionDecoder;
#[cfg(test)]
mod tests;

use notarium_core::{
    DomainError,
    error::{PortError, ValidationReason},
    ports::ProviderErrorCode,
};
pub(super) const MAX_PAYLOAD: usize = 8 * 1024 * 1024;
pub(super) const MAX_FRAME: usize = 1024 * 1024;
pub(super) const MAX_TOOLS: usize = 64;
pub(super) const MAX_TOOL_BYTES: usize = 256 * 1024;
pub(super) const MAX_EMBED_VALUES: usize = 1_048_576;
fn invalid() -> PortError {
    DomainError::validation(ValidationReason::InvalidQuery).into()
}
fn limited() -> PortError {
    DomainError::validation(ValidationReason::InvalidLimit).into()
}
fn protocol() -> PortError {
    DomainError::Provider {
        error: ProviderErrorCode::Protocol,
    }
    .into()
}
pub(super) fn check_connection(
    wire: notarium_core::ports::ProviderWireKind,
    bytes: &[u8],
) -> Result<(), PortError> {
    use notarium_core::ports::ProviderWireKind;
    if bytes.len() > 1024 * 1024 {
        return Err(protocol());
    }
    let value = bounded_json::parse(bytes, 16_384).map_err(|_| protocol())?;
    let (collection, name) = match wire {
        ProviderWireKind::OpenaiCompatible => ("data", "id"),
        ProviderWireKind::Ollama => ("models", "name"),
    };
    let models = value
        .get(collection)
        .and_then(serde_json::Value::as_array)
        .filter(|v| v.len() <= 1024)
        .ok_or_else(protocol)?;
    if value.get("error").is_some()
        || models.iter().any(|model| {
            model
                .get(name)
                .and_then(serde_json::Value::as_str)
                .is_none_or(|name| {
                    name.is_empty() || name.len() > 256 || name.chars().any(char::is_control)
                })
        })
    {
        return Err(protocol());
    }
    Ok(())
}
fn name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn json_bound(
    value: &serde_json::Value,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> Result<(), PortError> {
    *nodes = nodes.checked_add(1).ok_or_else(limited)?;
    *bytes = bytes.checked_add(32).ok_or_else(limited)?;
    if depth > 16 || *nodes > 16_384 {
        return Err(limited());
    }
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                json_bound(value, depth + 1, nodes, bytes)?;
            }
        }
        serde_json::Value::Object(values) => {
            for (key, value) in values {
                if key.len() > 4096 || key.contains('\0') {
                    return Err(invalid());
                }
                *bytes = bytes.checked_add(key.len()).ok_or_else(limited)?;
                json_bound(value, depth + 1, nodes, bytes)?;
            }
        }
        serde_json::Value::String(value) => {
            if value.contains('\0') {
                return Err(invalid());
            }
            *bytes = bytes.checked_add(value.len()).ok_or_else(limited)?;
        }
        _ => {}
    }
    if *bytes > MAX_TOOL_BYTES {
        return Err(limited());
    }
    Ok(())
}

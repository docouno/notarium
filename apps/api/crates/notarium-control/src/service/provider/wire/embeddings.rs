use super::*;
use notarium_core::ports::*;
use serde_json::Value;

pub(in crate::service::provider) struct DecodedEmbedding {
    pub vectors: Vec<Vec<f32>>,
    pub usage: ProviderUsage,
}
pub(in crate::service::provider) fn decode_embedding(
    wire: ProviderWireKind,
    model: &ProviderModelSpec,
    count: usize,
    bytes: &[u8],
) -> Result<DecodedEmbedding, PortError> {
    let ProviderModelKind::Embedding { dimension } = model.kind else {
        return Err(protocol());
    };
    if count == 0
        || count > 256
        || dimension == 0
        || dimension > 65536
        || count.saturating_mul(dimension as usize) > MAX_EMBED_VALUES
        || bytes.len() > 32 * 1024 * 1024
    {
        return Err(protocol());
    }
    let nodes = count * dimension as usize + count * 8 + 4096;
    let value = super::bounded_json::parse(bytes, nodes).map_err(|_| protocol())?;
    if value.get("error").is_some_and(|v| !v.is_null())
        || value
            .get("model")
            .and_then(Value::as_str)
            .is_none_or(|m| m.is_empty() || m.len() > 256 || m.chars().any(char::is_control))
    {
        return Err(protocol());
    }
    let mut vectors = vec![None; count];
    let usage = match wire {
        ProviderWireKind::OpenaiCompatible => {
            let data = value
                .get("data")
                .and_then(Value::as_array)
                .filter(|v| v.len() == count)
                .ok_or_else(protocol)?;
            for item in data {
                let index = item
                    .get("index")
                    .and_then(Value::as_u64)
                    .filter(|v| *v < count as u64)
                    .ok_or_else(protocol)? as usize;
                if vectors[index].is_some() {
                    return Err(protocol());
                }
                vectors[index] = Some(vector(
                    item.get("embedding").ok_or_else(protocol)?,
                    dimension,
                )?);
            }
            match value.get("usage").filter(|v| !v.is_null()) {
                Some(usage) => {
                    let input = usage
                        .get("prompt_tokens")
                        .and_then(Value::as_u64)
                        .filter(|v| *v <= i64::MAX as u64)
                        .ok_or_else(protocol)?;
                    if usage
                        .get("total_tokens")
                        .filter(|v| !v.is_null())
                        .is_some_and(|v| v.as_u64().is_none_or(|t| t < input))
                    {
                        return Err(protocol());
                    }
                    ProviderUsage::Exact {
                        input_tokens: input,
                        output_tokens: 0,
                    }
                }
                None => ProviderUsage::Unknown,
            }
        }
        ProviderWireKind::Ollama => {
            let data = value
                .get("embeddings")
                .and_then(Value::as_array)
                .filter(|v| v.len() == count)
                .ok_or_else(protocol)?;
            for (target, item) in vectors.iter_mut().zip(data) {
                *target = Some(vector(item, dimension)?);
            }
            match value.get("prompt_eval_count").filter(|v| !v.is_null()) {
                Some(input) => ProviderUsage::Exact {
                    input_tokens: input
                        .as_u64()
                        .filter(|v| *v <= i64::MAX as u64)
                        .ok_or_else(protocol)?,
                    output_tokens: 0,
                },
                None => ProviderUsage::Unknown,
            }
        }
    };
    Ok(DecodedEmbedding {
        vectors: vectors
            .into_iter()
            .collect::<Option<Vec<_>>>()
            .ok_or_else(protocol)?,
        usage,
    })
}
fn vector(value: &Value, dimension: u32) -> Result<Vec<f32>, PortError> {
    value
        .as_array()
        .filter(|v| v.len() == dimension as usize)
        .ok_or_else(protocol)?
        .iter()
        .map(|v| {
            let number = v.as_f64().filter(|v| v.is_finite()).ok_or_else(protocol)? as f32;
            if !number.is_finite() {
                return Err(protocol());
            }
            Ok(number)
        })
        .collect()
}

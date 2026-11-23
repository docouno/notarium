use super::*;
use notarium_core::{
    classes::{DocClass, ProviderOrigin},
    document::estimate_token_twelfths,
    error::ValidationReason,
    ids::FolderId,
    model::FolderRef,
    ports::{control::CompletionRequest, *},
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

struct Fingerprint {
    state: blake3::Hasher,
    bytes: usize,
}
impl std::io::Write for Fingerprint {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.bytes = self
            .bytes
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("provider fingerprint budget"))?;
        if self.bytes > 16 * 1024 * 1024 {
            return Err(std::io::Error::other("provider fingerprint budget"));
        }
        self.state.update(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn fingerprint(value: impl serde::Serialize) -> Result<[u8; 32], PortError> {
    let mut writer = Fingerprint {
        state: blake3::Hasher::new(),
        bytes: 0,
    };
    serde_json::to_writer(&mut writer, &value).map_err(|_| limited())?;
    Ok(*writer.state.finalize().as_bytes())
}
/// Bind semantic input independently of mutable endpoint/model/credential
/// configuration. Retrying an accepted intent after rotation still finds its
/// durable status, and never prepares a second request to the new destination.
pub(in crate::service::provider) fn completion_fingerprint(
    request: &CompletionRequest,
) -> Result<[u8; 32], PortError> {
    if request.messages.is_empty() || request.messages.len() > 256 {
        return Err(limited());
    }
    if request
        .messages
        .iter()
        .try_fold(0usize, |total, message| {
            total.checked_add(message.parts.len())
        })
        .ok_or_else(limited)?
        > 4096
    {
        return Err(limited());
    }
    let messages = history(request, ProviderWireKind::OpenaiCompatible)?;
    let tools = tools(&request.tools)?;
    let origins: Vec<_> = request
        .messages
        .iter()
        .flat_map(|message| message.parts.iter().map(|part| part.origin()))
        .collect();
    let input = (
        "completion-v1",
        &request.selection.provider,
        &request.selection.model,
        &request.selection.project,
        (
            request.budget.max_input_tokens,
            request.budget.max_output_tokens,
            request.budget.max_tool_calls,
        ),
        messages,
        tools,
        origins,
    );
    if request.secondary_projects.is_empty() {
        fingerprint(input)
    } else {
        fingerprint((
            "completion-secondary-projects-v1",
            input,
            &request.secondary_projects,
        ))
    }
}
pub(in crate::service::provider) fn embedding_fingerprint(
    request: &EmbeddingRequest,
) -> Result<[u8; 32], PortError> {
    request.validate()?;
    let mut bytes = 0usize;
    for input in &request.inputs {
        bytes = bytes.checked_add(input.text().len()).ok_or_else(limited)?;
        if bytes > MAX_PAYLOAD {
            return Err(limited());
        }
    }
    #[derive(serde::Serialize)]
    #[serde(untagged)]
    enum Input<'a> {
        Part(ProviderOrigin, &'a str, u32),
        Query(
            &'a str,
            u32,
            &'a BTreeSet<DocClass>,
            &'a Option<FolderRef>,
            &'a Option<FolderId>,
        ),
    }
    let content: Vec<_> = request
        .inputs
        .iter()
        .map(|input| match input {
            EmbeddingInput::Part(part) => Input::Part(
                notarium_core::classes::ProviderMessage::Part(part.clone()).origin(),
                part.text(),
                part.part().tokens(),
            ),
            EmbeddingInput::Query(query) => Input::Query(
                &query.text,
                query.tokens,
                &query.classes,
                &query.project_scope,
                &query.folder,
            ),
        })
        .collect();
    let payload = (
        "embedding-v1",
        &request.provider,
        &request.model,
        &request.project,
        request.declared_tokens,
        content,
    );
    match &request.selection {
        EmbeddingSelection::Explicit => fingerprint(payload),
        selection => fingerprint((payload, selection, request.runtime_epochs())),
    }
}

pub(in crate::service::provider) fn endpoint(
    base: &str,
    wire: ProviderWireKind,
    operation: &str,
) -> Result<String, PortError> {
    let mut url = url::Url::parse(base).map_err(|_| invalid())?;
    if url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
    {
        return Err(invalid());
    }
    let suffix = match (wire, operation) {
        (ProviderWireKind::OpenaiCompatible, "completion") => "chat/completions",
        (ProviderWireKind::OpenaiCompatible, "embedding") => "embeddings",
        (ProviderWireKind::OpenaiCompatible, "check") => "models",
        (ProviderWireKind::Ollama, "completion") => "api/chat",
        (ProviderWireKind::Ollama, "embedding") => "api/embed",
        (ProviderWireKind::Ollama, "check") => "api/tags",
        _ => return Err(invalid()),
    };
    let path = format!("{}/{}", url.path().trim_end_matches('/'), suffix);
    url.set_path(&path);
    Ok(url.into())
}
fn schema(
    value: &ProviderToolSchema,
    depth: usize,
    nodes: &mut usize,
    bytes: &mut usize,
) -> Result<Value, PortError> {
    *nodes = nodes.checked_add(1).ok_or_else(limited)?;
    if depth > 12 || *nodes > 4096 {
        return Err(limited());
    }
    Ok(match value {
        ProviderToolSchema::String { choices } => {
            if choices.len() > 128 {
                return Err(limited());
            }
            for choice in choices {
                *bytes = bytes.checked_add(choice.len()).ok_or_else(limited)?;
                if choice.len() > 4096 || *bytes > MAX_TOOL_BYTES || choice.contains('\0') {
                    return Err(limited());
                }
            }
            if choices.is_empty() {
                json!({"type":"string"})
            } else {
                json!({"type":"string", "enum":choices})
            }
        }
        ProviderToolSchema::Number => json!({"type":"number"}),
        ProviderToolSchema::Integer => json!({"type":"integer"}),
        ProviderToolSchema::Boolean => json!({"type":"boolean"}),
        ProviderToolSchema::Null => json!({"type":"null"}),
        ProviderToolSchema::Array { items, maximum } => {
            if *maximum > 4096 {
                return Err(limited());
            }
            json!({"type":"array", "items":schema(items, depth + 1, nodes, bytes)?, "maxItems":maximum})
        }
        ProviderToolSchema::Object {
            properties,
            required,
        } => {
            if properties.len() > 128 || !required.iter().all(|key| properties.contains_key(key)) {
                return Err(invalid());
            }
            let mut fields = serde_json::Map::new();
            for (key, value) in properties {
                if !name(key) {
                    return Err(invalid());
                }
                *bytes = bytes.checked_add(key.len()).ok_or_else(limited)?;
                if *bytes > MAX_TOOL_BYTES {
                    return Err(limited());
                }
                fields.insert(key.clone(), schema(value, depth + 1, nodes, bytes)?);
            }
            json!({"type":"object", "properties":fields, "required":required, "additionalProperties":false})
        }
        ProviderToolSchema::Map { values } => {
            json!({"type":"object","additionalProperties":schema(values, depth + 1, nodes, bytes)?})
        }
        ProviderToolSchema::JsonValue => {
            json!({"type":["string","number","boolean","null","array","object"]})
        }
        ProviderToolSchema::AnyOf(options) => {
            if !(1..=8).contains(&options.len()) {
                return Err(limited());
            }
            let options = options
                .iter()
                .map(|option| schema(option, depth + 1, nodes, bytes))
                .collect::<Result<Vec<_>, _>>()?;
            json!({"anyOf":options})
        }
    })
}
fn tools(definitions: &[ProviderToolDefinition]) -> Result<Vec<Value>, PortError> {
    if definitions.len() > MAX_TOOLS {
        return Err(limited());
    }
    let mut names = BTreeSet::new();
    let (mut nodes, mut bytes) = (0, 0);
    let mut result = Vec::new();
    for tool in definitions {
        if !name(&tool.name)
            || !names.insert(&tool.name)
            || tool.description.len() > 16 * 1024
            || tool.description.contains('\0')
            || !matches!(tool.parameters, ProviderToolSchema::Object { .. })
        {
            return Err(invalid());
        }
        bytes += tool.name.len() + tool.description.len();
        if bytes > MAX_TOOL_BYTES {
            return Err(limited());
        }
        result.push(json!({"type":"function", "function":{
            "name":tool.name, "description":tool.description,
            "parameters":schema(&tool.parameters, 0, &mut nodes, &mut bytes)?
        }}));
    }
    if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > MAX_TOOL_BYTES {
        return Err(limited());
    }
    Ok(result)
}
fn text(
    message: &CompletionMessage,
    request: &CompletionRequest,
    total: &mut usize,
) -> Result<String, PortError> {
    if message.parts.len() > 256 {
        return Err(limited());
    }
    let mut pieces = Vec::new();
    if let Some(instruction) = &message.instruction {
        pieces.push(instruction.text());
    }
    for part in &message.parts {
        if part.provider() != &request.selection.provider {
            return Err(invalid());
        }
        pieces.push(part.text());
    }
    for piece in &pieces {
        *total = total.checked_add(piece.len() + 1).ok_or_else(limited)?;
        if *total > MAX_PAYLOAD {
            return Err(limited());
        }
    }
    Ok(pieces.join("\n"))
}
fn history(request: &CompletionRequest, wire: ProviderWireKind) -> Result<Vec<Value>, PortError> {
    if request.messages.is_empty() || request.messages.len() > 256 {
        return Err(limited());
    }
    let mut pending: BTreeMap<String, String> = BTreeMap::new();
    let mut seen = BTreeSet::new();
    let mut messages = Vec::new();
    let mut bytes = 0usize;
    for message in &request.messages {
        if message.role != CompletionRole::Tool && !pending.is_empty() {
            return Err(invalid());
        }
        if message.role != CompletionRole::Assistant && !message.tool_calls.is_empty()
            || message.role != CompletionRole::Tool && message.result_for.is_some()
        {
            return Err(invalid());
        }
        let content = text(message, request, &mut bytes)?;
        if content.is_empty()
            && message.tool_calls.is_empty()
            && message.role != CompletionRole::Tool
        {
            return Err(invalid());
        }
        let role = match message.role {
            CompletionRole::System => "system",
            CompletionRole::User => "user",
            CompletionRole::Assistant => "assistant",
            CompletionRole::Tool => "tool",
        };
        let mut item = json!({"role":role,"content":content});
        if message.role == CompletionRole::Tool {
            let id = message.result_for.as_ref().ok_or_else(invalid)?;
            let tool_name = pending.remove(id.as_str()).ok_or_else(invalid)?;
            match wire {
                ProviderWireKind::OpenaiCompatible => item["tool_call_id"] = json!(id.as_str()),
                ProviderWireKind::Ollama => item["tool_name"] = json!(tool_name),
            }
        }
        if !message.tool_calls.is_empty() {
            if message.tool_calls.len() > MAX_TOOLS {
                return Err(limited());
            }
            let mut calls = Vec::new();
            for call in &message.tool_calls {
                if !name(&call.name)
                    || !seen.insert(call.id.as_str().to_owned())
                    || seen.len() > 1024
                {
                    return Err(invalid());
                }
                let (mut nodes, mut argument_bytes) = (0, 0usize);
                for (key, value) in &call.arguments {
                    if key.len() > 4096 || key.contains('\0') {
                        return Err(invalid());
                    }
                    argument_bytes = argument_bytes.checked_add(key.len()).ok_or_else(limited)?;
                    json_bound(value, 1, &mut nodes, &mut argument_bytes)?;
                }
                let args = serde_json::to_value(&call.arguments).map_err(|_| invalid())?;
                let encoded = serde_json::to_string(&args).map_err(|_| invalid())?;
                if encoded.len() > MAX_TOOL_BYTES {
                    return Err(limited());
                }
                bytes = bytes.checked_add(encoded.len()).ok_or_else(limited)?;
                if bytes > MAX_PAYLOAD {
                    return Err(limited());
                }
                pending.insert(call.id.as_str().into(), call.name.clone());
                calls.push(match wire {
                    ProviderWireKind::OpenaiCompatible => json!({"id":call.id.as_str(),"type":"function","function":{"name":call.name,"arguments":encoded}}),
                    ProviderWireKind::Ollama => json!({"function":{"name":call.name,"arguments":args}}),
                });
            }
            item["tool_calls"] = Value::Array(calls);
        }
        messages.push(item);
    }
    if !pending.is_empty() {
        return Err(invalid());
    }
    Ok(messages)
}
pub(in crate::service::provider) fn text_tokens(value: &str) -> u64 {
    estimate_token_twelfths(value).div_ceil(12)
}
pub(in crate::service::provider) fn estimate_completion_input_tokens(
    request: &CompletionRequest,
) -> Result<u32, PortError> {
    let mut total = 0u64;
    for message in &request.messages {
        total = total.saturating_add(4);
        let mut msg_twelfths = 0u64;
        if let Some(instruction) = &message.instruction {
            msg_twelfths = msg_twelfths.saturating_add(estimate_token_twelfths(instruction.text()));
        }
        for part in &message.parts {
            msg_twelfths = msg_twelfths.saturating_add(estimate_token_twelfths(part.text()));
        }
        total = total.saturating_add(msg_twelfths.div_ceil(12));
        for call in &message.tool_calls {
            let args = serde_json::to_string(&call.arguments).map_err(|_| invalid())?;
            total = total
                .saturating_add(8)
                .saturating_add(text_tokens(&call.name))
                .saturating_add(text_tokens(&args));
        }
    }
    if !request.tools.is_empty() {
        let definitions = tools(&request.tools)?;
        let raw = serde_json::to_string(&definitions).map_err(|_| invalid())?;
        // Tool schemas are structural JSON; count ~1 token per 4 UTF-8 bytes + framing.
        total = total
            .saturating_add((raw.len() as u64).div_ceil(4))
            .saturating_add((request.tools.len() as u64).saturating_mul(8));
    }
    u32::try_from(total.max(1)).map_err(|_| limited())
}
pub(in crate::service::provider) fn estimate_embedding_input_tokens(
    request: &EmbeddingRequest,
) -> Result<u32, PortError> {
    let mut estimated = 0u64;
    for input in &request.inputs {
        estimated = estimated.saturating_add(text_tokens(input.text()).max(1));
    }
    let estimated = u32::try_from(estimated.max(1)).map_err(|_| limited())?;
    Ok(request.declared_tokens.max(estimated))
}
fn encoded(value: Value) -> Result<Vec<u8>, PortError> {
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid())?;
    if bytes.len() > MAX_PAYLOAD {
        return Err(limited());
    }
    Ok(bytes)
}
pub(in crate::service::provider) fn completion(
    wire: ProviderWireKind,
    model: &ProviderModelSpec,
    request: &CompletionRequest,
) -> Result<Vec<u8>, PortError> {
    if model.kind != ProviderModelKind::Completion
        || request.selection.model != model.id
        || request.budget.max_output_tokens == 0
        || request.budget.max_output_tokens > model.max_output_tokens
        || request.budget.max_input_tokens == 0
        || request.budget.max_input_tokens > model.max_input_tokens
        || request.budget.max_tool_calls as usize > MAX_TOOLS
        || !request.tools.is_empty() && (!model.tools || request.budget.max_tool_calls == 0)
    {
        return Err(DomainError::validation(ValidationReason::TokenBudgetExceeded).into());
    }
    let messages = history(request, wire)?;
    let definitions = tools(&request.tools)?;
    if estimate_completion_input_tokens(request)? > request.budget.max_input_tokens {
        return Err(DomainError::validation(ValidationReason::TokenBudgetExceeded).into());
    }
    let mut body = match wire {
        ProviderWireKind::OpenaiCompatible => {
            json!({"model":model.wire_name,"messages":messages,"stream":true,"n":1,"max_completion_tokens":request.budget.max_output_tokens,"stream_options":{"include_usage":true}})
        }
        ProviderWireKind::Ollama => {
            json!({"model":model.wire_name,"messages":messages,"stream":true,"options":{"num_predict":request.budget.max_output_tokens}})
        }
    };
    if !definitions.is_empty() {
        body["tools"] = Value::Array(definitions);
    }
    encoded(body)
}
pub(in crate::service::provider) fn embedding(
    wire: ProviderWireKind,
    model: &ProviderModelSpec,
    request: &EmbeddingRequest,
) -> Result<Vec<u8>, PortError> {
    request.validate()?;
    let ProviderModelKind::Embedding { dimension } = model.kind else {
        return Err(invalid());
    };
    if request.inputs.len().saturating_mul(dimension as usize) > MAX_EMBED_VALUES {
        return Err(limited());
    }
    if request.model != model.id {
        return Err(invalid());
    }
    if request.declared_tokens > model.max_input_tokens
        || estimate_embedding_input_tokens(request)? > model.max_input_tokens
    {
        return Err(DomainError::validation(ValidationReason::TokenBudgetExceeded).into());
    }
    let mut total = 0usize;
    for input in &request.inputs {
        total = total.checked_add(input.text().len()).ok_or_else(limited)?;
        if total > MAX_PAYLOAD {
            return Err(limited());
        }
    }
    let input = request
        .inputs
        .iter()
        .map(EmbeddingInput::text)
        .collect::<Vec<_>>();
    encoded(match wire {
        ProviderWireKind::OpenaiCompatible => {
            json!({"model":model.wire_name,"input":input,"encoding_format":"float"})
        }
        ProviderWireKind::Ollama => {
            json!({"model":model.wire_name,"input":input,"truncate":false})
        }
    })
}

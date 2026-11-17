use super::*;
use notarium_core::{
    ids::CommandKey,
    ports::{control::CompletionEvent, *},
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Default)]
struct Tool {
    id: String,
    name: String,
    arguments: String,
}
/// Network chunks may split any byte, including UTF-8 and CRLF boundaries.
/// Nothing from this decoder is executable; the orchestrator owns tool policy.
pub(in crate::service::provider) struct CompletionDecoder {
    wire: ProviderWireKind,
    intent: CommandKey,
    allowed_tools: BTreeSet<String>,
    tool_limit: usize,
    line: Vec<u8>,
    event: Vec<u8>,
    skip_lf: bool,
    first_line: bool,
    tools: BTreeMap<usize, Tool>,
    tool_bytes: usize,
    reason: Option<CompletionFinish>,
    usage: Option<ProviderUsage>,
    done: bool,
    failed: bool,
}
impl CompletionDecoder {
    pub(in crate::service::provider) fn new(
        wire: ProviderWireKind,
        model: String,
        intent: CommandKey,
        allowed_tools: BTreeSet<String>,
        tool_limit: u16,
    ) -> Result<Self, PortError> {
        let _ = model;
        if tool_limit as usize > MAX_TOOLS || allowed_tools.len() > MAX_TOOLS {
            return Err(limited());
        }
        Ok(Self {
            wire,
            intent,
            allowed_tools,
            tool_limit: tool_limit as usize,
            line: Vec::new(),
            event: Vec::new(),
            skip_lf: false,
            first_line: true,
            tools: BTreeMap::new(),
            tool_bytes: 0,
            reason: None,
            usage: None,
            done: false,
            failed: false,
        })
    }
    pub(in crate::service::provider) fn usage(&self) -> ProviderUsage {
        if self.failed {
            ProviderUsage::Unknown
        } else {
            self.usage.unwrap_or(ProviderUsage::Unknown)
        }
    }
    pub(in crate::service::provider) fn is_done(&self) -> bool {
        self.done && !self.failed
    }
    pub(in crate::service::provider) fn feed(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<CompletionEvent>, PortError> {
        if self.failed {
            return Err(protocol());
        }
        let result = self.feed_inner(bytes);
        if result.is_err() {
            self.failed = true;
        }
        result
    }
    fn feed_inner(&mut self, bytes: &[u8]) -> Result<Vec<CompletionEvent>, PortError> {
        let mut events = Vec::new();
        for &byte in bytes {
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    continue;
                }
            }
            if matches!(byte, b'\r' | b'\n') {
                self.skip_lf = byte == b'\r';
                let line = std::mem::take(&mut self.line);
                self.line(&line, &mut events)?;
            } else {
                if self.line.len() == MAX_FRAME {
                    return Err(protocol());
                }
                self.line.push(byte);
            }
        }
        Ok(events)
    }
    fn line(&mut self, raw: &[u8], events: &mut Vec<CompletionEvent>) -> Result<(), PortError> {
        let raw = if self.first_line {
            self.first_line = false;
            raw.strip_prefix(b"\xef\xbb\xbf").unwrap_or(raw)
        } else {
            raw
        };
        let line = std::str::from_utf8(raw).map_err(|_| protocol())?;
        if self.wire == ProviderWireKind::Ollama {
            if line.trim().is_empty() {
                return Ok(());
            }
            if self.done {
                return Err(protocol());
            }
            return self.ollama(serde_json::from_str(line).map_err(|_| protocol())?, events);
        }
        if line.is_empty() {
            if self.event.is_empty() {
                return Ok(());
            }
            let mut data = std::mem::take(&mut self.event);
            data.pop();
            if self.done {
                return Err(protocol());
            }
            if data == b"[DONE]" {
                return self.finish(events);
            }
            return self.openai(
                serde_json::from_slice(&data).map_err(|_| protocol())?,
                events,
            );
        }
        if line.starts_with(':') {
            return Ok(());
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        if field == "data" {
            let value = value.strip_prefix(' ').unwrap_or(value);
            if self
                .event
                .len()
                .saturating_add(value.len())
                .saturating_add(1)
                > MAX_FRAME
            {
                return Err(protocol());
            }
            self.event.extend_from_slice(value.as_bytes());
            self.event.push(b'\n');
        }
        Ok(())
    }
    fn model(&self, value: &Value) -> Result<(), PortError> {
        if value.get("error").is_some_and(|v| !v.is_null()) {
            return Err(protocol());
        }
        let Some(model) = value.get("model").and_then(Value::as_str) else {
            return Err(protocol());
        };
        if model.is_empty() || model.len() > 256 || model.chars().any(char::is_control) {
            return Err(protocol());
        }
        Ok(())
    }
    fn set_usage(&mut self, input: u64, output: u64) -> Result<(), PortError> {
        let sum = input
            .checked_add(output)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(protocol)?;
        let _ = sum;
        let usage = ProviderUsage::Exact {
            input_tokens: input,
            output_tokens: output,
        };
        if self.usage.is_some_and(|old| old != usage) {
            return Err(protocol());
        }
        self.usage = Some(usage);
        Ok(())
    }
    fn openai(&mut self, value: Value, events: &mut Vec<CompletionEvent>) -> Result<(), PortError> {
        self.model(&value)?;
        if let Some(usage) = value.get("usage").filter(|v| !v.is_null()) {
            let input = usage
                .get("prompt_tokens")
                .and_then(Value::as_u64)
                .ok_or_else(protocol)?;
            let output = usage
                .get("completion_tokens")
                .and_then(Value::as_u64)
                .ok_or_else(protocol)?;
            let sum = input.checked_add(output).ok_or_else(protocol)?;
            if let Some(total) = usage.get("total_tokens").filter(|v| !v.is_null())
                && total.as_u64().is_none_or(|t| t < sum)
            {
                return Err(protocol());
            }
            self.set_usage(input, output)?;
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(protocol)?;
        if choices.len() > 1 {
            return Err(protocol());
        }
        for choice in choices {
            if choice.get("index").and_then(Value::as_u64) != Some(0) {
                return Err(protocol());
            }
            let delta = choice
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(protocol)?;
            let has_post_finish_payload = delta
                .get("content")
                .is_some_and(|v| !v.is_null() && v.as_str() != Some(""))
                || delta.get("tool_calls").is_some_and(|v| !v.is_null());
            if self.reason.is_some()
                && (has_post_finish_payload
                    || choice.get("finish_reason").is_some_and(|v| !v.is_null()))
            {
                return Err(protocol());
            }
            if let Some(role) = delta.get("role").filter(|v| !v.is_null())
                && role.as_str() != Some("assistant")
            {
                return Err(protocol());
            }
            if let Some(content) = delta.get("content").filter(|v| !v.is_null()) {
                let text = content.as_str().ok_or_else(protocol)?;
                if !text.is_empty() {
                    events.push(CompletionEvent::Text(text.into()));
                }
            }
            if let Some(calls) = delta.get("tool_calls").filter(|v| !v.is_null()) {
                let calls = calls.as_array().ok_or_else(protocol)?;
                if calls.len() > MAX_TOOLS {
                    return Err(protocol());
                }
                for call in calls {
                    let index = call
                        .get("index")
                        .and_then(Value::as_u64)
                        .filter(|v| *v < self.tool_limit as u64)
                        .ok_or_else(protocol)? as usize;
                    if let Some(kind) = call.get("type").filter(|v| !v.is_null())
                        && kind.as_str() != Some("function")
                    {
                        return Err(protocol());
                    }
                    let tool = self.tools.entry(index).or_default();
                    append(call.get("id"), &mut tool.id, 128, &mut self.tool_bytes)?;
                    if let Some(function) = call.get("function").filter(|v| !v.is_null()) {
                        if !function.is_object() {
                            return Err(protocol());
                        }
                        append(
                            function.get("name"),
                            &mut tool.name,
                            64,
                            &mut self.tool_bytes,
                        )?;
                        append(
                            function.get("arguments"),
                            &mut tool.arguments,
                            MAX_TOOL_BYTES,
                            &mut self.tool_bytes,
                        )?;
                    }
                }
            }
            if let Some(reason) = choice.get("finish_reason").filter(|v| !v.is_null()) {
                self.reason = Some(match reason.as_str() {
                    Some("stop") => CompletionFinish::Stop,
                    Some("length") => CompletionFinish::Length,
                    Some("tool_calls") => CompletionFinish::ToolCalls,
                    Some("content_filter") => CompletionFinish::ContentFilter,
                    _ => return Err(protocol()),
                });
            }
        }
        Ok(())
    }
    fn ollama(&mut self, value: Value, events: &mut Vec<CompletionEvent>) -> Result<(), PortError> {
        self.model(&value)?;
        if let Some(message) = value.get("message").filter(|v| !v.is_null()) {
            if !message.is_object()
                || message
                    .get("role")
                    .filter(|v| !v.is_null())
                    .is_some_and(|v| v.as_str() != Some("assistant"))
            {
                return Err(protocol());
            }
            if let Some(content) = message.get("content").filter(|v| !v.is_null()) {
                let text = content.as_str().ok_or_else(protocol)?;
                if !text.is_empty() {
                    events.push(CompletionEvent::Text(text.into()));
                }
            }
            if let Some(calls) = message.get("tool_calls").filter(|v| !v.is_null()) {
                let calls = calls.as_array().ok_or_else(protocol)?;
                if calls.len() > MAX_TOOLS {
                    return Err(protocol());
                }
                for call in calls {
                    let function = call
                        .get("function")
                        .and_then(Value::as_object)
                        .ok_or_else(protocol)?;
                    let index = match function.get("index").filter(|v| !v.is_null()) {
                        Some(value) => usize::try_from(value.as_u64().ok_or_else(protocol)?)
                            .map_err(|_| protocol())?,
                        None => self.tools.len(),
                    };
                    if index >= self.tool_limit || self.tools.contains_key(&index) {
                        return Err(protocol());
                    }
                    let name = function
                        .get("name")
                        .and_then(Value::as_str)
                        .ok_or_else(protocol)?;
                    let args = function
                        .get("arguments")
                        .filter(|v| v.is_object())
                        .ok_or_else(protocol)?;
                    json_bound(args, 0, &mut 0, &mut 0).map_err(|_| protocol())?;
                    let arguments = serde_json::to_string(args).map_err(|_| protocol())?;
                    self.tool_bytes = self
                        .tool_bytes
                        .checked_add(arguments.len() + name.len())
                        .ok_or_else(protocol)?;
                    if self.tool_bytes > MAX_TOOL_BYTES {
                        return Err(protocol());
                    }
                    self.tools.insert(
                        index,
                        Tool {
                            id: format!("ollama-{}-{index}", self.intent),
                            name: name.into(),
                            arguments,
                        },
                    );
                }
            }
        }
        let done = value
            .get("done")
            .and_then(Value::as_bool)
            .ok_or_else(protocol)?;
        if done {
            let prompt_eval = value.get("prompt_eval_count").filter(|v| !v.is_null());
            let eval = value.get("eval_count").filter(|v| !v.is_null());
            match (prompt_eval, eval) {
                (Some(input), Some(output)) => self.set_usage(
                    input.as_u64().ok_or_else(protocol)?,
                    output.as_u64().ok_or_else(protocol)?,
                )?,
                (Some(input), None) => self.set_usage(input.as_u64().ok_or_else(protocol)?, 0)?,
                (None, Some(output)) => self.set_usage(0, output.as_u64().ok_or_else(protocol)?)?,
                (None, None) => {}
            }
            self.reason = Some(
                match value
                    .get("done_reason")
                    .filter(|v| !v.is_null())
                    .and_then(Value::as_str)
                {
                    Some("length") => CompletionFinish::Length,
                    Some("tool_calls") => CompletionFinish::ToolCalls,
                    Some("stop") | None if !self.tools.is_empty() => CompletionFinish::ToolCalls,
                    Some("stop") | None => CompletionFinish::Stop,
                    _ => return Err(protocol()),
                },
            );
            self.finish(events)?;
        }
        Ok(())
    }
    fn finish(&mut self, events: &mut Vec<CompletionEvent>) -> Result<(), PortError> {
        let reason = self.reason.ok_or_else(protocol)?;
        if reason == CompletionFinish::ToolCalls && self.tools.is_empty()
            || !self.tools.is_empty()
                && !matches!(
                    reason,
                    CompletionFinish::ToolCalls | CompletionFinish::Length
                )
        {
            return Err(protocol());
        }
        let mut ids = BTreeSet::new();
        for (expected, (&index, tool)) in self.tools.iter().enumerate() {
            if index != expected || !name(&tool.name) || !self.allowed_tools.contains(&tool.name) {
                return Err(protocol());
            }
            let id = ProviderToolCallId::new(tool.id.clone()).map_err(|_| protocol())?;
            if !ids.insert(id.clone()) {
                return Err(protocol());
            }
            let arguments: Value = serde_json::from_str(&tool.arguments).map_err(|_| protocol())?;
            json_bound(&arguments, 0, &mut 0, &mut 0).map_err(|_| protocol())?;
            let arguments = arguments
                .as_object()
                .ok_or_else(protocol)?
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            events.push(CompletionEvent::ToolCall(ProviderToolCall {
                id,
                name: tool.name.clone(),
                arguments,
            }));
        }
        events.push(CompletionEvent::Usage(self.usage()));
        events.push(CompletionEvent::Finished(reason));
        self.done = true;
        Ok(())
    }
    pub(in crate::service::provider) fn eof(&mut self) -> Result<Vec<CompletionEvent>, PortError> {
        if self.failed {
            return Err(protocol());
        }
        let mut events = Vec::new();
        let result = (|| {
            if !self.line.is_empty() {
                let line = std::mem::take(&mut self.line);
                self.line(&line, &mut events)?;
            }
            if !self.done || !self.event.is_empty() {
                return Err(protocol());
            }
            Ok(events)
        })();
        if result.is_err() {
            self.failed = true;
        }
        result
    }
}
fn append(
    value: Option<&Value>,
    target: &mut String,
    maximum: usize,
    total: &mut usize,
) -> Result<(), PortError> {
    if let Some(value) = value.filter(|v| !v.is_null()) {
        let value = value.as_str().ok_or_else(protocol)?;
        *total = total.checked_add(value.len()).ok_or_else(protocol)?;
        if target.len().saturating_add(value.len()) > maximum || *total > MAX_TOOL_BYTES {
            return Err(protocol());
        }
        target.push_str(value);
    }
    Ok(())
}

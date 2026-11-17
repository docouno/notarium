use super::*;
use crate::service::provider::admission::Snapshot;

pub(super) async fn receive(
    runtime: &Runtime,
    job: &Job,
    snapshot: &Snapshot,
    progress: &mut Progress,
    sender: Option<&mpsc::Sender<CompletionEvent>>,
) -> Result<Output, PortError> {
    let response = progress.response.as_mut().expect("started transport");
    let kind = wire(&snapshot.resource.wire)?;
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        .ok_or_else(protocol)?;
    let valid_type = match (&job.request, kind) {
        (Request::Completion(_), ProviderWireKind::OpenaiCompatible) => {
            content_type.eq_ignore_ascii_case("text/event-stream")
        }
        (Request::Completion(_), ProviderWireKind::Ollama) => {
            content_type.eq_ignore_ascii_case("application/x-ndjson")
                || content_type.eq_ignore_ascii_case("application/json")
        }
        _ => content_type.eq_ignore_ascii_case("application/json"),
    };
    if !valid_type {
        return Err(protocol());
    }
    match &job.request {
        Request::Completion(request) => {
            let model = snapshot.model.as_ref().ok_or_else(protocol)?;
            let sender = sender.ok_or_else(protocol)?;
            let mut decoder = wire::CompletionDecoder::new(
                kind,
                model.wire_name.clone(),
                request.intent.clone(),
                request.tools.iter().map(|tool| tool.name.clone()).collect(),
                request.budget.max_tool_calls,
            )?;
            let mut terminal = Vec::new();
            let mut text_bytes = 0usize;
            // A memory/wire bound, not a claim to tokenize model output.
            let maximum = (request.budget.max_output_tokens as usize)
                .saturating_mul(64)
                .min(32 * 1024 * 1024);
            loop {
                let chunk = progress.leases.run(runtime, response.next_chunk()).await?;
                let mut events = match chunk {
                    Some(chunk) => decoder.feed(&chunk)?,
                    None => decoder.eof()?,
                };
                let done = decoder.is_done();
                if done {
                    // Retain already verified usage even if the consumer drops
                    // while this final chunk's text waits for channel capacity.
                    events.extend(decoder.eof()?);
                    progress.usage = decoder.usage();
                    if job.usage_mismatch(Some(model), progress.usage) {
                        progress.mismatch = true;
                    }
                }
                for event in events {
                    if let CompletionEvent::Text(text) = &event {
                        text_bytes = text_bytes.checked_add(text.len()).ok_or_else(protocol)?;
                        if text_bytes > maximum {
                            return Err(protocol());
                        }
                        progress
                            .leases
                            .run(runtime, async {
                                sender.send(event).await.map_err(|_| failed())
                            })
                            .await?;
                    } else {
                        terminal.push(event);
                    }
                }
                if done {
                    return Ok(Output::Completion(terminal));
                }
            }
        }
        Request::Embedding(request) => {
            let mut bytes = Vec::new();
            while let Some(chunk) = progress.leases.run(runtime, response.next_chunk()).await? {
                bytes.extend(chunk);
            }
            let model = snapshot.model.as_ref().ok_or_else(protocol)?;
            let decoded = wire::decode_embedding(kind, model, request.chunks.len(), &bytes)?;
            progress.usage = decoded.usage;
            if job.usage_mismatch(Some(model), progress.usage) {
                progress.mismatch = true;
            }
            let ProviderModelKind::Embedding { dimension } = model.kind else {
                return Err(protocol());
            };
            Ok(Output::Embedding(EmbeddingResult {
                model: model.id.clone(),
                dimension,
                vectors: decoded.vectors.into_iter().map(Ok).collect(),
                usage: decoded.usage,
            }))
        }
        Request::Check(_) => {
            let mut bytes = Vec::new();
            while let Some(chunk) = progress.leases.run(runtime, response.next_chunk()).await? {
                bytes.extend(chunk);
            }
            wire::check_connection(kind, &bytes)?;
            progress.usage = ProviderUsage::Exact {
                input_tokens: 0,
                output_tokens: 0,
            };
            Ok(Output::Connection(ProviderConnectionStatus {
                call: progress.call.clone(),
                reachable: true,
            }))
        }
    }
}

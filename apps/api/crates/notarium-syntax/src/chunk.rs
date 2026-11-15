use crate::markdown::MarkdownAnalysis;
use notarium_core::{
    DomainError, DomainResult,
    document::{ChunkDescriptor, ChunkPlan, render_chunk},
    error::ValidationReason,
    ids::{ContentDigest, ModelProfileId},
    span::ByteSpan,
};

/// Counts the exact serving input, including model wrappers and special tokens.
/// A split hint is advisory; every emitted input is independently counted again.
pub trait TokenizerBudget {
    fn profile(&self) -> ModelProfileId;
    fn max_tokens(&self) -> u32;
    fn count(&self, input: &str) -> DomainResult<u32>;
    fn split_hint(&self, text: &str, budget: u32) -> Option<usize>;
}
pub fn chunks(
    source: &str,
    markdown: &MarkdownAnalysis,
    tokenizer: Option<&dyn TokenizerBudget>,
) -> DomainResult<ChunkPlan> {
    let Some(tokenizer) = tokenizer else {
        return Ok(ChunkPlan::Deferred {
            blocks: markdown.blocks.clone(),
        });
    };
    let limit = tokenizer.max_tokens();
    if limit == 0 || limit > 512 {
        return Err(DomainError::validation(
            ValidationReason::TokenBudgetExceeded,
        ));
    }
    let model = tokenizer.profile();
    let source_digest = crate::content_digest(source);
    let mut output = Vec::new();
    let mut pending: Option<(ByteSpan, Vec<ByteSpan>)> = None;
    let mut next_heading = 0;
    let mut active_headings = Vec::new();
    for block in &markdown.blocks {
        while let Some(heading) = markdown.headings.get(next_heading)
            && heading.section_span.start() <= block.start()
        {
            active_headings.push(heading);
            next_heading += 1;
        }
        active_headings.retain(|h| h.section_span.end() >= block.end());
        let prefix = active_headings
            .iter()
            .map(|h| {
                let raw = h.heading_span.slice(source)?;
                // Preserve a source-bound heading context, including authored
                // Markdown. Rendered titles alone cannot prove byte provenance.
                ByteSpan::new(
                    h.heading_span.start(),
                    h.heading_span.start() + raw.trim_end_matches(['\r', '\n']).len(),
                )
            })
            .collect::<DomainResult<Vec<_>>>()?;
        if let Some((previous, old_prefix)) = pending.take() {
            if old_prefix == prefix {
                let joined = ByteSpan::new(previous.start(), block.end())?;
                if tokenizer.count(&render_chunk(source, &prefix, &[joined])?)? <= limit {
                    pending = Some((joined, prefix));
                    continue;
                }
            }
            emit(
                source,
                previous,
                &old_prefix,
                tokenizer,
                &model,
                source_digest,
                &mut output,
            )?;
        }
        let full = render_chunk(source, &prefix, &[*block])?;
        if tokenizer.count(&full)? <= limit {
            pending = Some((*block, prefix));
        } else {
            emit(
                source,
                *block,
                &prefix,
                tokenizer,
                &model,
                source_digest,
                &mut output,
            )?;
        }
    }
    if let Some((range, prefix)) = pending {
        emit(
            source,
            range,
            &prefix,
            tokenizer,
            &model,
            source_digest,
            &mut output,
        )?;
    }
    Ok(ChunkPlan::Ready {
        model,
        chunks: output,
    })
}
fn emit(
    source: &str,
    range: ByteSpan,
    prefix: &[ByteSpan],
    tokenizer: &dyn TokenizerBudget,
    model: &ModelProfileId,
    source_digest: ContentDigest,
    output: &mut Vec<ChunkDescriptor>,
) -> DomainResult<()> {
    let text = range.slice(source)?;
    let limit = tokenizer.max_tokens();
    let full = render_chunk(source, prefix, &[range])?;
    if tokenizer.count(&full)? <= limit {
        return push(
            source,
            range,
            prefix,
            tokenizer,
            model,
            source_digest,
            output,
        );
    }
    let mut offset = 0;
    let mut context = prefix.to_vec();
    while offset < text.len() {
        let rest = &text[offset..];
        let mut window = rest.len().min((limit as usize).saturating_mul(16).max(4));
        while !rest.is_char_boundary(window) {
            window -= 1;
        }
        let hinted = tokenizer
            .split_hint(&rest[..window], limit)
            .unwrap_or(window)
            .min(window)
            .max(1);
        let mut end = hinted;
        while !rest.is_char_boundary(end) {
            end += 1;
        }
        let candidate_end = end;
        loop {
            let selected = ByteSpan::new(range.start() + offset, range.start() + offset + end)?;
            let candidate = render_chunk(source, &context, &[selected])?;
            if tokenizer.count(&candidate)? <= limit {
                push(
                    source,
                    selected,
                    &context,
                    tokenizer,
                    model,
                    source_digest,
                    output,
                )?;
                offset += end;
                break;
            }
            let first = rest
                .chars()
                .next()
                .expect("nonempty remaining text")
                .len_utf8();
            if end > first {
                let half = end / 2;
                let line = rest[..end].rfind('\n').filter(|n| *n < half).map(|n| n + 1);
                end = line.unwrap_or(half.max(first));
                while !rest.is_char_boundary(end) {
                    end -= 1;
                }
                end = end.max(first);
            } else if !context.is_empty() {
                if context.len() > 1 {
                    context.remove(0);
                } else {
                    let span = context[0];
                    let mut end = span.start() + (span.end() - span.start()) / 2;
                    while !source.is_char_boundary(end) {
                        end -= 1;
                    }
                    if end == span.start() {
                        context.clear();
                    } else {
                        context[0] = ByteSpan::new(span.start(), end)?;
                    }
                }
                // A shorter breadcrumb frees body budget. Retry the original
                // bounded candidate instead of emitting a single scalar; keep
                // the validated shortening for the next chunk of this block.
                end = candidate_end;
            } else {
                return Err(DomainError::validation(
                    ValidationReason::TokenBudgetExceeded,
                ));
            }
        }
    }
    Ok(())
}
fn push(
    source: &str,
    range: ByteSpan,
    context: &[ByteSpan],
    tokenizer: &dyn TokenizerBudget,
    model: &ModelProfileId,
    source_digest: ContentDigest,
    output: &mut Vec<ChunkDescriptor>,
) -> DomainResult<()> {
    let text = render_chunk(source, context, &[range])?;
    let count = tokenizer.count(&text)?;
    if count > tokenizer.max_tokens() {
        return Err(DomainError::validation(
            ValidationReason::TokenBudgetExceeded,
        ));
    }
    let mut hash = blake3::Hasher::new();
    hash.update(&(model.as_str().len() as u64).to_be_bytes());
    hash.update(model.as_str().as_bytes());
    hash.update(&(text.len() as u64).to_be_bytes());
    hash.update(text.as_bytes());
    output.push(ChunkDescriptor {
        source: source_digest,
        model: model.clone(),
        context: context.to_vec(),
        spans: vec![range],
        text,
        tokens: count,
        key: ContentDigest::from_bytes(*hash.finalize().as_bytes()),
    });
    Ok(())
}

use crate::markdown::MarkdownAnalysis;
use notarium_core::{
    DomainError, DomainResult,
    document::{ChunkDescriptor, ChunkPlan},
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
    let mut output = Vec::new();
    let mut pending: Option<(ByteSpan, String)> = None;
    for block in &markdown.blocks {
        let breadcrumbs = markdown
            .headings
            .iter()
            .filter(|h| {
                h.section_span.start() <= block.start() && h.section_span.end() >= block.end()
            })
            .map(|h| h.title.as_str())
            .collect::<Vec<_>>()
            .join(" > ");
        let prefix = if breadcrumbs.is_empty() {
            String::new()
        } else {
            format!("{breadcrumbs}\n\n")
        };
        if let Some((previous, old_prefix)) = pending.take() {
            if old_prefix == prefix {
                let joined = ByteSpan::new(previous.start(), block.end())?;
                if tokenizer.count(&format!("{prefix}{}", joined.slice(source)?))? <= limit {
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
                &mut output,
            )?;
        }
        let full = format!("{prefix}{}", block.slice(source)?);
        if tokenizer.count(&full)? <= limit {
            pending = Some((*block, prefix));
        } else {
            emit(source, *block, &prefix, tokenizer, &model, &mut output)?;
        }
    }
    if let Some((range, prefix)) = pending {
        emit(source, range, &prefix, tokenizer, &model, &mut output)?;
    }
    Ok(ChunkPlan::Ready {
        model,
        chunks: output,
    })
}
fn emit(
    source: &str,
    range: ByteSpan,
    prefix: &str,
    tokenizer: &dyn TokenizerBudget,
    model: &ModelProfileId,
    output: &mut Vec<ChunkDescriptor>,
) -> DomainResult<()> {
    let text = range.slice(source)?;
    let limit = tokenizer.max_tokens();
    let full = format!("{prefix}{text}");
    if tokenizer.count(&full)? <= limit {
        return push(range, full, tokenizer, model, output);
    }
    let mut offset = 0;
    while offset < text.len() {
        let rest = &text[offset..];
        let window = rest.len().min((limit as usize).saturating_mul(16).max(4));
        let mut end = tokenizer
            .split_hint(rest, limit)
            .unwrap_or(window)
            .min(window)
            .max(1);
        while !rest.is_char_boundary(end) {
            end += 1;
        }
        let mut context = prefix.to_owned();
        loop {
            let candidate = format!("{context}{}", &rest[..end]);
            if tokenizer.count(&candidate)? <= limit {
                push(
                    ByteSpan::new(range.start() + offset, range.start() + offset + end)?,
                    candidate,
                    tokenizer,
                    model,
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
                if let Some((_, last)) = context.split_once(" > ") {
                    context = last.to_owned();
                } else {
                    let mut end = context.len() / 2;
                    while !context.is_char_boundary(end) {
                        end -= 1;
                    }
                    context.truncate(end);
                }
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
    range: ByteSpan,
    text: String,
    tokenizer: &dyn TokenizerBudget,
    model: &ModelProfileId,
    output: &mut Vec<ChunkDescriptor>,
) -> DomainResult<()> {
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
        spans: vec![range],
        text,
        tokens: count,
        key: ContentDigest::from_bytes(*hash.finalize().as_bytes()),
    });
    Ok(())
}

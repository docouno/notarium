use crate::markdown::MarkdownAnalysis;
use notarium_core::{
    DomainError, DomainResult,
    document::{ChunkDescriptor, ChunkPlan, Heading, render_chunk},
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

// A heading can be omitted as a distant ancestor and still be useful when it
// becomes the nearest heading again. Keep the two source-bound recipes separate.
// These are chosen renderings, not claims about a tokenizer's monotonicity.
struct HeadingContext<'a> {
    heading: &'a Heading,
    original: ByteSpan,
    nearest: Option<ByteSpan>,
    ancestor: Option<ByteSpan>,
}
impl<'a> HeadingContext<'a> {
    fn new(source: &str, heading: &'a Heading) -> DomainResult<Self> {
        let raw = heading.heading_span.slice(source)?;
        let original = ByteSpan::new(
            heading.heading_span.start(),
            heading.heading_span.start() + raw.trim_end_matches(['\r', '\n']).len(),
        )?;
        Ok(Self {
            heading,
            original,
            nearest: Some(original),
            ancestor: Some(original),
        })
    }
    fn recipe(&mut self, nearest: bool) -> &mut Option<ByteSpan> {
        if nearest {
            &mut self.nearest
        } else {
            &mut self.ancestor
        }
    }
}

fn context(headings: &[HeadingContext<'_>]) -> (Vec<usize>, Vec<ByteSpan>) {
    headings
        .iter()
        .enumerate()
        .filter_map(|(index, heading)| {
            if index + 1 == headings.len() {
                heading.nearest
            } else {
                heading.ancestor
            }
            .map(|span| (index, span))
        })
        .unzip()
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
    let mut pending: Option<ByteSpan> = None;
    let mut next_heading = 0;
    let mut active_headings = Vec::<HeadingContext<'_>>::new();
    for block in &markdown.blocks {
        let first_heading = next_heading;
        while let Some(heading) = markdown.headings.get(next_heading)
            && heading.section_span.start() <= block.start()
        {
            next_heading += 1;
        }
        let entering = &markdown.headings[first_heading..next_heading];
        let changed = active_headings
            .iter()
            .any(|h| h.heading.section_span.end() < block.end())
            || entering.iter().any(|h| h.section_span.end() >= block.end());
        if changed {
            if let Some(previous) = pending.take() {
                emit(
                    source,
                    previous,
                    &mut active_headings,
                    tokenizer,
                    &model,
                    source_digest,
                    &mut output,
                )?;
            }
            active_headings.retain(|h| h.heading.section_span.end() >= block.end());
            for heading in entering
                .iter()
                .filter(|h| h.section_span.end() >= block.end())
            {
                active_headings.push(HeadingContext::new(source, heading)?);
            }
        }
        if let Some(previous) = pending.take() {
            let (_, prefix) = context(&active_headings);
            let joined = ByteSpan::new(previous.start(), block.end())?;
            if tokenizer.count(&render_chunk(source, &prefix, &[joined])?)? <= limit {
                pending = Some(joined);
                continue;
            }
            emit(
                source,
                previous,
                &mut active_headings,
                tokenizer,
                &model,
                source_digest,
                &mut output,
            )?;
        }
        let (_, prefix) = context(&active_headings);
        let full = render_chunk(source, &prefix, &[*block])?;
        if tokenizer.count(&full)? <= limit {
            pending = Some(*block);
        } else {
            emit(
                source,
                *block,
                &mut active_headings,
                tokenizer,
                &model,
                source_digest,
                &mut output,
            )?;
        }
    }
    if let Some(range) = pending {
        emit(
            source,
            range,
            &mut active_headings,
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
    headings: &mut [HeadingContext<'_>],
    tokenizer: &dyn TokenizerBudget,
    model: &ModelProfileId,
    source_digest: ContentDigest,
    output: &mut Vec<ChunkDescriptor>,
) -> DomainResult<()> {
    let output_start = output.len();
    let text = range.slice(source)?;
    let limit = tokenizer.max_tokens();
    let (mut selected_headings, mut context) = context(headings);
    let full = render_chunk(source, &context, &[range])?;
    if tokenizer.count(&full)? <= limit {
        return push(
            source,
            range,
            &context,
            tokenizer,
            model,
            source_digest,
            output,
        );
    }
    let mut offset = 0;
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
                    let index = selected_headings.remove(0);
                    let nearest = index + 1 == headings.len();
                    *headings[index].recipe(nearest) = None;
                } else {
                    let index = selected_headings[0];
                    let nearest = index + 1 == headings.len();
                    let span = context[0];
                    let mut end = span.start() + (span.end() - span.start()) / 2;
                    while !source.is_char_boundary(end) {
                        end -= 1;
                    }
                    if end == span.start() {
                        context.clear();
                        selected_headings.clear();
                        *headings[index].recipe(nearest) = None;
                    } else {
                        context[0] = ByteSpan::new(span.start(), end)?;
                        *headings[index].recipe(nearest) = Some(context[0]);
                    }
                }
                // A shorter breadcrumb frees body budget. Retry the original
                // bounded candidate instead of emitting a single scalar; keep
                // its recipe for later blocks and descendants of this heading.
                end = candidate_end;
            } else {
                // A different full context may tokenize more cheaply than a
                // shortened one. Before rejecting, rescue the original whole
                // block if it fits, discarding any partial chunks of this block.
                // A successful large check is paid for by its emitted output;
                // a failed check ends this operation rather than every sibling.
                let original: Vec<_> = headings.iter().map(|h| h.original).collect();
                if tokenizer.count(&render_chunk(source, &original, &[range])?)? <= limit {
                    output.truncate(output_start);
                    return push(
                        source,
                        range,
                        &original,
                        tokenizer,
                        model,
                        source_digest,
                        output,
                    );
                }
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

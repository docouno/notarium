use crate::{carrier::Carrier, patch};
use notarium_core::{
    DomainError, DomainResult,
    document::*,
    error::ValidationReason,
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    span::ByteSpan,
};
use pulldown_cmark::{CodeBlockKind, Event, Options, Parser, Tag, TagEnd};

#[derive(Clone, Debug)]
pub struct FencedBlock {
    pub span: ByteSpan,
    pub info: String,
    pub closed: bool,
    pub text: String,
    /// Canonical parser text fragments mapped to their physical source bytes.
    pub lines: Vec<(ByteSpan, ByteSpan)>,
    pub closing_start: usize,
    pub continuation_prefix: String,
    content_end: usize,
}
#[derive(Clone, Debug)]
pub struct MarkdownAnalysis {
    pub headings: Vec<Heading>,
    pub fences: Vec<FencedBlock>,
    pub text_ranges: Vec<ByteSpan>,
    pub blocks: Vec<ByteSpan>,
}

pub fn analyze(source: &str, body: ByteSpan) -> DomainResult<MarkdownAnalysis> {
    let text = body.slice(source)?;
    let offset = body.start();
    let mut result = MarkdownAnalysis {
        headings: vec![],
        fences: vec![],
        text_ranges: vec![],
        blocks: vec![],
    };
    let mut containers = Vec::new();
    let mut ordinal = 0u32;
    let mut heading: Option<Heading> = None;
    let mut code = false;
    let mut active_fence = None;
    let mut link_depth = 0u32;
    for (event, range) in Parser::new_ext(
        text,
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS,
    )
    .into_offset_iter()
    {
        let span = ByteSpan::new(offset + range.start, offset + range.end)?;
        match event {
            Event::Start(Tag::BlockQuote(_)) | Event::Start(Tag::Item) => {
                let kind = if matches!(event, Event::Start(Tag::Item)) {
                    // Tight lists do not emit Paragraph events.
                    result.blocks.push(span);
                    ContainerKind::ListItem
                } else {
                    ContainerKind::BlockQuote
                };
                containers.push(MarkdownContainer {
                    ordinal,
                    kind,
                    span,
                });
                ordinal += 1;
            }
            Event::End(TagEnd::BlockQuote(_)) | Event::End(TagEnd::Item) => {
                containers.pop();
            }
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(Heading {
                    level: level as u8,
                    title: String::new(),
                    heading_span: span,
                    section_span: ByteSpan::new(span.end(), body.end())?,
                    containers: containers.clone(),
                });
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some(h) = heading.take() {
                    result.headings.push(h);
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                code = true;
                result.blocks.push(span);
                if let CodeBlockKind::Fenced(info) = kind {
                    result.fences.push(fenced(source, span, info.to_string())?);
                    active_fence = Some(result.fences.len() - 1);
                }
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some(index) = active_fence.take() {
                    finish_fence(source, &mut result.fences[index])?;
                }
                code = false;
            }
            Event::Start(Tag::Link { .. }) | Event::Start(Tag::Image { .. }) => link_depth += 1,
            Event::End(TagEnd::Link) | Event::End(TagEnd::Image) => {
                link_depth = link_depth.saturating_sub(1)
            }
            Event::Start(Tag::Paragraph) | Event::Start(Tag::Table(_)) => {
                if !code {
                    result.blocks.push(span);
                }
            }
            Event::Text(value) => {
                if let Some(index) = active_fence {
                    let fence = &mut result.fences[index];
                    let start = fence.text.len();
                    fence.text.push_str(&value);
                    fence.content_end = span.end();
                    // CommonMark can synthesize spaces for a partially consumed
                    // tab. Keep them readable but never invent a writable offset.
                    if value.as_ref() == span.slice(source)? {
                        fence
                            .lines
                            .push((ByteSpan::new(start, fence.text.len())?, span));
                    }
                }
                if let Some(h) = &mut heading {
                    h.title.push_str(&value);
                }
                if !code && link_depth == 0 {
                    result.text_ranges.push(span);
                }
            }
            Event::Code(value) => {
                if let Some(h) = &mut heading {
                    h.title.push_str(&value);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some(h) = &mut heading {
                    h.title.push(' ');
                }
            }
            _ => {}
        }
    }
    for index in 0..result.headings.len() {
        let h = &result.headings[index];
        let owner_end = h.containers.last().map_or(body.end(), |c| c.span.end());
        let end = result.headings[index + 1..]
            .iter()
            .find(|next| next.level <= h.level && next.containers == h.containers)
            .map_or(owner_end, |h| {
                line_start(source, h.heading_span.start()).min(owner_end)
            });
        result.headings[index].section_span = ByteSpan::new(h.heading_span.end().min(end), end)?;
    }
    result
        .blocks
        .sort_by_key(|s| (s.start(), usize::MAX - s.end()));
    let mut blocks = Vec::<ByteSpan>::new();
    for block in &result.blocks {
        if !blocks
            .last()
            .is_some_and(|b| b.start() <= block.start() && b.end() >= block.end())
        {
            blocks.push(*block);
        }
    }
    result.blocks = blocks;
    Ok(result)
}

fn continuation_prefix(source: &str, start: usize) -> DomainResult<String> {
    let beginning = line_start(source, start);
    let prefix = &source[beginning..start];
    let prefix = if beginning == 0 {
        prefix.strip_prefix('\u{feff}').unwrap_or(prefix)
    } else {
        prefix
    };
    let mut result = String::new();
    let mut chars = prefix.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            ' ' | '\t' | '>' => result.push(ch),
            '-' | '+' | '*' => result.push(' '),
            '0'..='9' => {
                result.push(' ');
                while chars.peek().is_some_and(char::is_ascii_digit) {
                    chars.next();
                    result.push(' ');
                }
                if matches!(chars.peek(), Some('.' | ')')) {
                    chars.next();
                    result.push(' ');
                }
            }
            _ => {
                return Err(DomainError::validation(
                    ValidationReason::UnsupportedContainer,
                ));
            }
        }
    }
    Ok(result)
}
fn line_start(source: &str, offset: usize) -> usize {
    source[..offset].rfind(['\r', '\n']).map_or(0, |n| n + 1)
}
fn fenced(source: &str, span: ByteSpan, info: String) -> DomainResult<FencedBlock> {
    let prefix = continuation_prefix(source, span.start())?;
    Ok(FencedBlock {
        span,
        info,
        closed: false,
        text: String::new(),
        lines: vec![],
        closing_start: span.end(),
        continuation_prefix: prefix,
        content_end: span.start(),
    })
}
fn finish_fence(source: &str, fence: &mut FencedBlock) -> DomainResult<()> {
    let raw = fence.span.slice(source)?;
    let marker = raw.as_bytes()[0];
    let count = raw.bytes().take_while(|b| *b == marker).count();
    let last_start = line_start(source, fence.span.end());
    if last_start <= fence.span.start() {
        return Ok(());
    }
    // A real closing marker has no Text event. For an unclosed fence the parser
    // includes the candidate marker in its logical content, including EOF lines.
    let candidate = source[last_start..fence.span.end()].trim_start_matches([' ', '\t', '>']);
    let candidate = candidate.trim_end_matches([' ', '\t']);
    if fence.content_end <= last_start
        && candidate.len() >= count
        && candidate.bytes().all(|b| b == marker)
    {
        fence.closed = true;
        fence.closing_start = last_start;
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct SectionSelector {
    pub title: String,
    pub occurrence: Option<usize>,
}
pub fn replace_section(
    source: &str,
    selector: &SectionSelector,
    replacement: &str,
) -> DomainResult<CarrierPatchPlan> {
    let carrier = Carrier::scan(source)?;
    let analysis = analyze(source, carrier.body)?;
    let matches: Vec<_> = analysis
        .headings
        .iter()
        .filter(|h| h.title == selector.title)
        .collect();
    let selected = match selector.occurrence {
        Some(n) => matches.get(n).copied(),
        None if matches.len() == 1 => matches.first().copied(),
        _ => None,
    }
    .ok_or_else(|| DomainError::validation(ValidationReason::AmbiguousSection))?;
    let prefix = if selected.containers.is_empty() {
        String::new()
    } else {
        continuation_prefix(source, selected.heading_span.start())?
    };
    let mut text = String::new();
    for line in crate::lines::with_endings(replacement) {
        text.push_str(&prefix);
        text.push_str(line);
    }
    if !text.is_empty() && !source[..selected.section_span.start()].ends_with(['\r', '\n']) {
        // An EOF heading may have no terminal line break. Inserting its body
        // still needs a separator, even though the original section was empty.
        text.insert_str(0, carrier.eol);
    }
    if !text.is_empty()
        && !text.ends_with(['\r', '\n'])
        && (selected.section_span.slice(source)?.ends_with(['\r', '\n'])
            || selected.section_span.end() < source.len()
                && !source[selected.section_span.end()..].starts_with(['\r', '\n']))
    {
        text.push_str(carrier.eol);
    }
    patch::plan(
        source,
        carrier.body,
        vec![(CarrierEditOrigin::Body, selected.section_span, text)],
    )
}

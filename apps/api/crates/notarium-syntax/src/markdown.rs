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
    /// Logical content bytes mapped to their physical source bytes, one line at a time.
    pub lines: Vec<(ByteSpan, ByteSpan)>,
    pub closing_start: usize,
    pub continuation_prefix: String,
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
                }
            }
            Event::End(TagEnd::CodeBlock) => code = false,
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
            .map_or(owner_end, |h| h.heading_span.start().min(owner_end));
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
    let line_start = source[..start].rfind('\n').map_or(0, |n| n + 1);
    let prefix = &source[line_start..start];
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
fn strip_prefix<'a>(line: &'a str, prefix: &str) -> (&'a str, usize) {
    if let Some(rest) = line.strip_prefix(prefix) {
        return (rest, prefix.len());
    }
    // Quote continuation may omit a single following space, including an empty line.
    let trimmed = prefix.trim_end_matches([' ', '\t']);
    if !trimmed.is_empty()
        && let Some(rest) = line.strip_prefix(trimmed)
    {
        return (rest, trimmed.len());
    }
    (line, 0)
}
fn fenced(source: &str, span: ByteSpan, info: String) -> DomainResult<FencedBlock> {
    let raw = span.slice(source)?;
    let mut physical = span.start();
    let mut input = raw.split_inclusive('\n');
    let first = input.next().unwrap_or("");
    let prefix = continuation_prefix(source, span.start())?;
    let marker = first
        .trim_start()
        .as_bytes()
        .first()
        .copied()
        .unwrap_or(b'`');
    let count = first
        .trim_start()
        .bytes()
        .take_while(|b| *b == marker)
        .count();
    physical += first.len();
    let mut logical = String::new();
    let mut lines = Vec::new();
    let mut closed = false;
    let mut closing_start = span.end();
    for line in input {
        let (unprefixed, removed) = strip_prefix(line, &prefix);
        let indentation = unprefixed.bytes().take_while(|b| *b == b' ').count();
        let candidate = unprefixed[indentation..].trim_end_matches([' ', '\t', '\r', '\n']);
        if indentation <= 3 && candidate.len() >= count && candidate.bytes().all(|b| b == marker) {
            closed = true;
            closing_start = physical + removed;
            break;
        }
        let start = logical.len();
        logical.push_str(unprefixed);
        lines.push((
            ByteSpan::new(start, logical.len())?,
            ByteSpan::new(physical + removed, physical + line.len())?,
        ));
        physical += line.len();
    }
    Ok(FencedBlock {
        span,
        info,
        closed,
        text: logical,
        lines,
        closing_start,
        continuation_prefix: prefix,
    })
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
    for line in replacement.split_inclusive('\n') {
        text.push_str(&prefix);
        text.push_str(line);
    }
    if !text.is_empty()
        && !text.ends_with('\n')
        && selected.section_span.slice(source)?.ends_with('\n')
    {
        text.push_str(carrier.eol);
    }
    patch::plan(
        source,
        carrier.body,
        vec![(CarrierEditOrigin::Body, selected.section_span, text)],
    )
}

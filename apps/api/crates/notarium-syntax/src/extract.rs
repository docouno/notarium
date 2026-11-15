use crate::{
    chunk::{self, TokenizerBudget},
    content_digest,
    encrypted::{self, EncryptedCarrierValidated},
    frontmatter::{self, FieldEdit},
    markdown, nota, patch,
    unicode::lookup_key,
};
use notarium_core::{
    DomainResult,
    classes::DocClass,
    document::*,
    error::Diagnostic,
    ids::*,
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    span::ByteSpan,
    value::YamlValue,
};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
pub struct PlainDocDelta {
    pub source: ContentDigest,
    pub class: DocClass,
    pub fields: Option<BTreeMap<String, YamlValue>>,
    pub diagnostics: Vec<Diagnostic>,
    pub slug_fold: String,
    pub headings: Vec<Heading>,
    pub links: Vec<WikiTarget>,
    pub tags: Vec<TagKey>,
    pub views: Vec<ViewBlock>,
    pub chunks: ChunkPlan,
}
#[derive(Clone, Debug)]
pub enum ExtractedDocDelta {
    Plain(PlainDocDelta),
    Encrypted(EncryptedCarrierValidated),
}

pub fn extract(
    source: &str,
    class: DocClass,
    note: &NoteId,
    title: &str,
    tokenizer: Option<&dyn TokenizerBudget>,
) -> DomainResult<ExtractedDocDelta> {
    if class == DocClass::EncryptedNote {
        return Ok(ExtractedDocDelta::Encrypted(encrypted::validate(source)?));
    }
    let header = frontmatter::analyze(source, class)?;
    let parsed = markdown::analyze(source, header.carrier.body)?;
    let views = nota::analyze(source, header.carrier.body, note, &parsed, false)?.blocks;
    let (links, tags) = links_and_tags(source, &parsed.text_ranges)?;
    let chunks = chunk::chunks(source, &parsed, tokenizer)?;
    Ok(ExtractedDocDelta::Plain(PlainDocDelta {
        source: content_digest(source),
        class,
        fields: header.fields,
        diagnostics: header
            .diagnostic
            .map(|reason| Diagnostic {
                reason,
                location: None,
            })
            .into_iter()
            .collect(),
        slug_fold: lookup_key(title),
        headings: parsed.headings,
        links,
        tags,
        views,
        chunks,
    }))
}

/// Combine explicit field edits and permitted view-ID insertions on one original
/// carrier. Ordinary incomplete views remain authored text with local diagnostics.
pub fn finalize_document(
    source: &str,
    class: DocClass,
    note: &NoteId,
    fields: &[FieldEdit],
) -> DomainResult<CarrierPatchPlan> {
    let header = frontmatter::analyze(source, class)?;
    if class == DocClass::EncryptedNote {
        encrypted::validate(source)?;
    }
    let fm = if fields.is_empty() {
        patch::plan(source, header.carrier.body, vec![])?
    } else {
        frontmatter::patch_frontmatter(source, class, fields)?
    };
    let mut edits: Vec<_> = fm
        .edits
        .into_iter()
        .map(|e| (e.origin, e.bytes.0, e.replacement))
        .collect();
    if class != DocClass::EncryptedNote {
        let markdown = markdown::analyze(source, header.carrier.body)?;
        let views = nota::analyze(source, header.carrier.body, note, &markdown, true)?;
        edits.extend(
            views
                .plan
                .edits
                .into_iter()
                .map(|e| (CarrierEditOrigin::Body, e.bytes.0, e.replacement)),
        );
    }
    let result = patch::plan(source, header.carrier.body, edits)?;
    let changed = patch::apply(source, &result)?;
    if class == DocClass::EncryptedNote {
        encrypted::validate(&changed)?;
    } else {
        frontmatter::analyze(&changed, class)?;
    }
    Ok(result)
}

fn escaped(source: &str, index: usize) -> bool {
    source[..index]
        .bytes()
        .rev()
        .take_while(|b| *b == b'\\')
        .count()
        % 2
        == 1
}
fn links_and_tags(
    source: &str,
    ranges: &[ByteSpan],
) -> DomainResult<(Vec<WikiTarget>, Vec<TagKey>)> {
    let mut merged = Vec::<ByteSpan>::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut()
            && previous.end() == range.start()
        {
            *previous = ByteSpan::new(previous.start(), range.end())?;
            continue;
        }
        merged.push(*range);
    }
    let mut links = Vec::new();
    let mut tags = BTreeMap::<String, Vec<ByteSpan>>::new();
    for range in merged {
        let mut index = range.start();
        let mut no_closer = false;
        while index < range.end() {
            let rest = &source[index..range.end()];
            let closer = if !no_closer && rest.starts_with("[[") && !escaped(source, index) {
                let closer = rest[2..].find("]]");
                no_closer = closer.is_none();
                closer
            } else {
                None
            };
            if let Some(end) = closer {
                let end = index + 2 + end;
                let raw = &source[index + 2..end];
                let (target, label) = raw
                    .split_once('|')
                    .map_or((raw, None), |(t, l)| (t, Some(l.to_owned())));
                let target = target.trim();
                if !target.is_empty() && !target.contains(['\r', '\n']) {
                    let kind = if let Ok(id) = NoteId::parse(target) {
                        WikiTargetKind::StableNoteId(id)
                    } else {
                        let mut parts: Vec<_> = target.split('/').collect();
                        let leaf = parts.pop().unwrap_or("");
                        let directory = parts
                            .into_iter()
                            .filter(|p| !p.is_empty())
                            .map(|p| match p {
                                "." => LinkNavigation::Current,
                                ".." => LinkNavigation::Parent,
                                _ => LinkNavigation::Named(lookup_key(p)),
                            })
                            .collect();
                        WikiTargetKind::NamePath {
                            absolute: target.starts_with('/'),
                            directory,
                            leaf_key: lookup_key(leaf),
                        }
                    };
                    links.push(WikiTarget {
                        span: ByteSpan::new(index, end + 2)?,
                        raw: target.into(),
                        label,
                        target: kind,
                    });
                }
                index = end + 2;
                continue;
            }
            let ch = rest.chars().next().expect("nonempty text range");
            if ch == '#'
                && !escaped(source, index)
                && source[..index]
                    .chars()
                    .next_back()
                    .is_none_or(|ch| ch.is_whitespace() || matches!(ch, '(' | '[' | '{'))
            {
                let end = index
                    + 1
                    + source[index + 1..range.end()]
                        .chars()
                        .take_while(|ch| {
                            ch.is_alphanumeric()
                                || matches!(ch, '_' | '-' | '/')
                                || unicode_normalization::char::is_combining_mark(*ch)
                        })
                        .map(char::len_utf8)
                        .sum::<usize>();
                if end > index + 1 {
                    tags.entry(lookup_key(&source[index + 1..end]))
                        .or_default()
                        .push(ByteSpan::new(index, end)?);
                    index = end;
                    continue;
                }
            }
            index += ch.len_utf8();
        }
    }
    Ok((
        links,
        tags.into_iter()
            .map(|(key, source_spans)| TagKey { key, source_spans })
            .collect(),
    ))
}

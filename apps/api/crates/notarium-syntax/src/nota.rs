use crate::{
    frontmatter::{self, FieldEdit},
    markdown::{FencedBlock, MarkdownAnalysis},
    patch, yaml,
};
use notarium_core::{
    DomainResult,
    document::{ViewBlock, ViewState},
    error::{Diagnostic, ValidationReason},
    ids::{NoteId, ViewKey},
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    span::ByteSpan,
    value::YamlValue,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct NotaAnalysis {
    pub blocks: Vec<ViewBlock>,
    pub plan: CarrierPatchPlan,
}
fn diagnostic(reason: ValidationReason) -> Diagnostic {
    Diagnostic {
        reason,
        location: None,
    }
}
pub fn analyze(
    source: &str,
    body: ByteSpan,
    note: &NoteId,
    markdown: &MarkdownAnalysis,
    insert_missing: bool,
) -> DomainResult<NotaAnalysis> {
    let fences: Vec<_> = markdown
        .fences
        .iter()
        .filter(|f| f.info == "nota")
        .collect();
    let mut blocks = Vec::new();
    let mut reserved = BTreeSet::new();
    let mut counts = BTreeMap::new();
    let mut uncertain = false;
    for fence in &fences {
        let mut block = ViewBlock {
            span: fence.span,
            state: ViewState::Invalid,
            id: None,
            raw_yaml: fence.text.clone(),
            config: None,
            diagnostics: vec![],
        };
        if !fence.closed {
            block.state = ViewState::Pending;
            block
                .diagnostics
                .push(diagnostic(ValidationReason::PendingView));
            uncertain = true;
        } else {
            match yaml::parse(&fence.text) {
                Ok(YamlValue::Mapping(fields)) => {
                    match fields.get("id") {
                        Some(YamlValue::String(value)) => match ViewKey::parse(value) {
                            Ok(id) => {
                                *counts.entry(id.clone()).or_insert(0usize) += 1;
                                reserved.insert(id.clone());
                                block.id = Some(id);
                                block.state = ViewState::Ready;
                            }
                            Err(_) => block
                                .diagnostics
                                .push(diagnostic(ValidationReason::InvalidView)),
                        },
                        Some(_) => block
                            .diagnostics
                            .push(diagnostic(ValidationReason::InvalidView)),
                        None => block
                            .diagnostics
                            .push(diagnostic(ValidationReason::InvalidView)),
                    }
                    block.config = Some(YamlValue::Mapping(fields));
                }
                _ => {
                    block
                        .diagnostics
                        .push(diagnostic(ValidationReason::InvalidView));
                    uncertain = true;
                }
            }
        }
        blocks.push(block);
    }
    for block in &mut blocks {
        if block.id.as_ref().is_some_and(|id| counts[id] > 1) {
            block.state = ViewState::Invalid;
            block
                .diagnostics
                .push(diagnostic(ValidationReason::DuplicateViewId));
        }
    }
    let mut edits = Vec::new();
    if insert_missing && !uncertain {
        for (ordinal, (block, fence)) in blocks.iter_mut().zip(fences.iter()).enumerate() {
            let Some(YamlValue::Mapping(fields)) = &mut block.config else {
                continue;
            };
            if fields.contains_key("id") {
                continue;
            }
            let mut collision = 0u64;
            let id = loop {
                let mut hash = blake3::Hasher::new();
                hash.update(b"notarium-view-v1");
                hash.update(&(note.as_str().len() as u64).to_be_bytes());
                hash.update(note.as_str().as_bytes());
                hash.update(&(ordinal as u64).to_be_bytes());
                hash.update(&(fence.text.len() as u64).to_be_bytes());
                hash.update(fence.text.as_bytes());
                hash.update(&collision.to_be_bytes());
                let mut bytes = [0; 16];
                bytes.copy_from_slice(&hash.finalize().as_bytes()[..16]);
                let id = ViewKey::from_bytes(bytes);
                if reserved.insert(id.clone()) {
                    break id;
                }
                collision += 1;
            };
            let value = YamlValue::String(id.to_string());
            let eol = if fence.span.slice(source)?.contains("\r\n") {
                "\r\n"
            } else {
                "\n"
            };
            let changes = frontmatter::edit_mapping(
                &fence.text,
                &[FieldEdit::Set {
                    key: "id".into(),
                    value: value.clone(),
                }],
                "\n",
            )
            .and_then(|changes| {
                changes
                    .into_iter()
                    .map(|(span, text)| {
                        let (physical, text) =
                            map_insertion(fence, span, &text.replace('\n', eol))?;
                        Ok((CarrierEditOrigin::Body, physical, text))
                    })
                    .collect::<DomainResult<Vec<_>>>()
            });
            let Ok(changes) = changes else {
                // Persistence of ordinary authored bytes does not depend on an
                // optional concrete-syntax insertion being representable.
                block.state = ViewState::Invalid;
                block
                    .diagnostics
                    .push(diagnostic(ValidationReason::FmNotWritable));
                continue;
            };
            edits.extend(changes);
            fields.insert("id".into(), value);
            block.id = Some(id);
            block.state = ViewState::Ready;
            block.diagnostics.clear();
        }
    }
    Ok(NotaAnalysis {
        blocks,
        plan: patch::plan(source, body, edits)?,
    })
}
fn map_insertion(
    fence: &FencedBlock,
    span: ByteSpan,
    text: &str,
) -> DomainResult<(ByteSpan, String)> {
    use notarium_core::{DomainError, error::ValidationReason};
    if !span.is_empty() {
        return Err(DomainError::validation(ValidationReason::InvalidView));
    }
    let position = span.start();
    for (logical, physical) in &fence.lines {
        if position >= logical.start() && position <= logical.end() {
            let offset = physical.start() + position - logical.start();
            let is_line_start = position == 0 || fence.text[..position].ends_with('\n');
            let mut replacement = String::new();
            for (index, line) in text.split_inclusive('\n').enumerate() {
                if is_line_start || index > 0 {
                    replacement.push_str(&fence.continuation_prefix);
                }
                replacement.push_str(line);
            }
            return Ok((ByteSpan::new(offset, offset)?, replacement));
        }
    }
    // An empty closed block has no content lines; insert before the closing prefix.
    if !fence.text.is_empty() || position != 0 {
        return Err(DomainError::validation(ValidationReason::InvalidView));
    }
    let offset = fence.closing_start;
    let replacement = text
        .split_inclusive('\n')
        .map(|line| format!("{}{line}", fence.continuation_prefix))
        .collect();
    Ok((ByteSpan::new(offset, offset)?, replacement))
}

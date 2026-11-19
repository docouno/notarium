use crate::{
    frontmatter::{self, FieldEdit},
    markdown::{FencedBlock, MarkdownAnalysis},
    patch, yaml,
};
use notarium_core::{
    DomainError, DomainResult,
    classes::{DocClass, authorize_field_key},
    document::{ViewBlock, ViewState},
    error::{Diagnostic, ValidationReason},
    ids::{NoteId, ViewKey},
    patch::{CarrierEditOrigin, CarrierPatchPlan},
    ports::ViewRef,
    span::ByteSpan,
    value::YamlValue,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug)]
pub struct NotaAnalysis {
    pub blocks: Vec<ViewBlock>,
    pub plan: CarrierPatchPlan,
}

#[derive(Clone, Debug, Default)]
pub struct ViewBlockPatch {
    pub source: Vec<FieldEdit>,
    pub common: Vec<FieldEdit>,
    pub options: Vec<FieldEdit>,
}

/// Edit one ready block. The stable view ID and the bytes outside the target
/// block are preserved, including when the fence is nested in Markdown.
pub fn patch_view_block(
    source: &str,
    class: DocClass,
    view: &ViewRef,
    edits: &ViewBlockPatch,
) -> DomainResult<CarrierPatchPlan> {
    let header = frontmatter::analyze(source, class)?;
    let body = header.carrier.body;
    let markdown = crate::markdown::analyze(source, body)?;
    let parsed = analyze(source, body, &view.note, &markdown, false)?;
    let (index, target) = parsed
        .blocks
        .iter()
        .enumerate()
        .find(|(_, block)| block.state == ViewState::Ready && block.id.as_ref() == Some(&view.key))
        .ok_or_else(invalid_view)?;
    let Some(YamlValue::Mapping(mut expected)) = target.config.clone() else {
        return Err(invalid_view());
    };
    let fence = markdown
        .fences
        .iter()
        .find(|fence| fence.span == target.span)
        .ok_or_else(invalid_view)?;
    let mut mapping_edits = edits.common.clone();
    if mapping_edits
        .iter()
        .any(|edit| matches!(edit.key(), "id" | "source" | "options"))
    {
        return Err(invalid_view());
    }

    for (key, group) in [("source", &edits.source), ("options", &edits.options)] {
        if group.is_empty() {
            continue;
        }
        let mut fields = match expected.get(key) {
            Some(YamlValue::Mapping(fields)) => fields.clone(),
            Some(_) => return Err(invalid_view()),
            None => BTreeMap::new(),
        };
        apply_fields(&mut fields, group)?;
        if expected.contains_key(key) || !fields.is_empty() {
            mapping_edits.push(FieldEdit::Set {
                key: key.to_owned(),
                value: YamlValue::Mapping(fields),
            });
        }
    }
    apply_fields(&mut expected, &mapping_edits)?;
    let eol = if target.span.slice(source)?.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let physical = frontmatter::edit_mapping(&fence.text, &mapping_edits, "\n")?
        .into_iter()
        .map(|(span, text)| {
            let (span, replacement) = map_view_edit(fence, span, &text.replace('\n', eol))?;
            Ok((CarrierEditOrigin::Body, span, replacement))
        })
        .collect::<DomainResult<Vec<_>>>()?;
    let plan = patch::plan(source, body, physical)?;
    let changed = patch::apply(source, &plan)?;
    let changed_body = crate::carrier::Carrier::scan(&changed)?.body;
    let changed_markdown = crate::markdown::analyze(&changed, changed_body)?;
    let reparsed = analyze(&changed, changed_body, &view.note, &changed_markdown, false)?;
    if parsed.blocks.len() != reparsed.blocks.len()
        || parsed
            .blocks
            .iter()
            .zip(&reparsed.blocks)
            .enumerate()
            .any(|(i, (before, after))| {
                if i == index {
                    after.state != ViewState::Ready
                        || after.config.as_ref() != Some(&YamlValue::Mapping(expected.clone()))
                } else {
                    before.raw_yaml != after.raw_yaml || before.state != after.state
                }
            })
    {
        return Err(invalid_view());
    }
    Ok(plan)
}

fn invalid_view() -> DomainError {
    DomainError::validation(ValidationReason::InvalidView)
}

fn apply_fields(fields: &mut BTreeMap<String, YamlValue>, edits: &[FieldEdit]) -> DomainResult<()> {
    let mut seen = BTreeSet::new();
    for edit in edits {
        authorize_field_key(edit.key())?;
        if edit.key().is_empty() || !seen.insert(edit.key()) {
            return Err(invalid_view());
        }
        match edit {
            FieldEdit::Set { key, value } => {
                value.validate_keys()?;
                fields.insert(key.clone(), value.clone());
            }
            FieldEdit::Unset { key } => {
                fields.remove(key);
            }
        }
    }
    Ok(())
}

fn map_view_edit(
    fence: &FencedBlock,
    span: ByteSpan,
    replacement: &str,
) -> DomainResult<(ByteSpan, String)> {
    if span.is_empty() {
        return map_insertion(fence, span, replacement);
    }
    let start = fence
        .lines
        .iter()
        .find(|(logical, _)| (logical.start()..logical.end()).contains(&span.start()))
        .map(|(logical, physical)| physical.start() + span.start() - logical.start())
        .ok_or_else(invalid_view)?;
    let end = fence
        .lines
        .iter()
        .find(|(logical, _)| (logical.start() + 1..=logical.end()).contains(&span.end()))
        .map(|(logical, physical)| physical.start() + span.end() - logical.start())
        .ok_or_else(invalid_view)?;
    let mut mapped = String::new();
    for (index, line) in crate::lines::with_endings(replacement).enumerate() {
        if index > 0 {
            mapped.push_str(&fence.continuation_prefix);
        }
        mapped.push_str(line);
    }
    Ok((ByteSpan::new(start, end)?, mapped))
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
    let mut inserted = Vec::new();
    if insert_missing && !uncertain {
        for (ordinal, (block, fence)) in blocks.iter_mut().zip(fences.iter()).enumerate() {
            let Some(YamlValue::Mapping(fields)) = &mut block.config else {
                continue;
            };
            if fields.contains_key("id") {
                continue;
            }
            // Reservations can include any number of predictable candidates.
            // Hash the unchanged payload once without changing ID framing.
            let mut seed = blake3::Hasher::new();
            seed.update(b"notarium-view-v1");
            seed.update(&(note.as_str().len() as u64).to_be_bytes());
            seed.update(note.as_str().as_bytes());
            seed.update(&(ordinal as u64).to_be_bytes());
            seed.update(&(fence.text.len() as u64).to_be_bytes());
            seed.update(fence.text.as_bytes());
            let mut collision = 0u64;
            let id = loop {
                let mut hash = seed.clone();
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
            inserted.push(ordinal);
        }
    }
    if !edits.is_empty() {
        // Validate the actual persisted Markdown, not only the logical YAML edit.
        // If a physical mapping cannot preserve the intended config, defer all
        // optional identities without rejecting or partially changing raw input.
        let verified = (|| {
            let plan = patch::plan(source, body, edits.clone())?;
            let changed = patch::apply(source, &plan)?;
            let carrier = crate::carrier::Carrier::scan(&changed)?;
            let parsed = crate::markdown::analyze(&changed, carrier.body)?;
            let actual: Vec<_> = parsed.fences.iter().filter(|f| f.info == "nota").collect();
            Ok::<_, notarium_core::DomainError>(
                actual.len() == fences.len()
                    && inserted.iter().all(|index| {
                        actual[*index].closed
                            && yaml::parse(&actual[*index].text).ok().as_ref()
                                == blocks[*index].config.as_ref()
                    }),
            )
        })()
        .unwrap_or(false);
        if !verified {
            edits.clear();
            for index in inserted {
                let block = &mut blocks[index];
                if let Some(YamlValue::Mapping(fields)) = &mut block.config {
                    fields.remove("id");
                }
                block.id = None;
                block.state = ViewState::Invalid;
                block
                    .diagnostics
                    .push(diagnostic(ValidationReason::UnsupportedContainer));
            }
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
    // Within content, anchor to the character on the right of the insertion.
    // A gap between fragments contains a physical quote/list prefix which must
    // stay before the inserted inline YAML, never in the middle of its value.
    if position < fence.text.len() {
        if text.contains(['\r', '\n']) {
            return Err(DomainError::validation(ValidationReason::InvalidView));
        }
        for (logical, physical) in &fence.lines {
            if position >= logical.start() && position < logical.end() {
                let offset = physical.start() + position - logical.start();
                return Ok((ByteSpan::new(offset, offset)?, text.to_owned()));
            }
        }
        return Err(DomainError::validation(ValidationReason::InvalidView));
    }
    for (logical, physical) in &fence.lines {
        if position == logical.end() {
            let offset = physical.start() + position - logical.start();
            let is_line_start = position == 0 || fence.text[..position].ends_with(['\r', '\n']);
            let mut replacement = String::new();
            for (index, line) in crate::lines::with_endings(text).enumerate() {
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
    let replacement = crate::lines::with_endings(text)
        .map(|line| format!("{}{line}", fence.continuation_prefix))
        .collect();
    Ok((ByteSpan::new(offset, offset)?, replacement))
}

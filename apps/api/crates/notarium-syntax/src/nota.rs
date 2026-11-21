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
/// Best-effort identity recovery in incomplete or malformed nota YAML.
/// Only a unique top-level scalar identity is accepted, and this never
/// certifies the rest of the authored block as parseable.
pub fn recover_top_level_id(raw: &str) -> Option<ViewKey> {
    let mut root: Option<usize> = None;
    let mut found: Option<ViewKey> = None;
    let mut block_scalar_indent: Option<usize> = None;
    let mut open_quote: Option<char> = None;
    let mut flow_depth: usize = 0;

    for raw_line in raw.split('\n') {
        let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let trimmed_spaces = line.trim_start_matches(' ');
        let indent = line.len() - trimmed_spaces.len();
        let trimmed = trimmed_spaces.trim_end_matches([' ', '\t']);

        // Stop at YAML document end or a subsequent document header once content started.
        if open_quote.is_none() && block_scalar_indent.is_none() && flow_depth == 0 {
            if trimmed == "..." {
                break;
            }
            if trimmed == "---" {
                if root.is_some() {
                    break;
                }
                continue;
            }
        }

        if let Some(parent_indent) = block_scalar_indent {
            if trimmed.is_empty() || indent > parent_indent {
                continue;
            }
            block_scalar_indent = None;
            // Re-check document boundary after exiting a block scalar.
            if trimmed == "..." || trimmed == "---" {
                break;
            }
        }

        if open_quote.is_some() || flow_depth > 0 {
            advance_yaml_inline_state(line, &mut open_quote, &mut flow_depth);
            continue;
        }

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let root_indent = match root {
            Some(r) => r,
            None => {
                if trimmed_spaces.starts_with(['[', '{', '|', '>'])
                    || trimmed_spaces.starts_with("- ")
                    || trimmed == "-"
                {
                    return None;
                }
                root = Some(indent);
                indent
            }
        };

        // Lines indented deeper than root belong to a nested value; still track
        // multiline quotes/flow/block scalars so an inner `id:` cannot masquerade
        // as a top-level key when its continuation starts at column `root_indent`.
        if indent != root_indent
            || !line
                .as_bytes()
                .get(..root_indent)
                .is_some_and(|prefix| prefix.iter().all(|&byte| byte == b' '))
        {
            if let Some((_, rest)) = trimmed_spaces.split_once(':') {
                if starts_block_scalar(rest) {
                    block_scalar_indent = Some(indent);
                } else {
                    advance_yaml_inline_state(rest, &mut open_quote, &mut flow_depth);
                }
            } else {
                advance_yaml_inline_state(trimmed_spaces, &mut open_quote, &mut flow_depth);
            }
            continue;
        }

        let Some(at_root) = line.get(root_indent..) else {
            continue;
        };
        if at_root.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, rest)) = at_root.split_once(':') else {
            advance_yaml_inline_state(at_root, &mut open_quote, &mut flow_depth);
            continue;
        };

        let is_id_key = matches!(key.trim_end(), "id" | "\"id\"" | "'id'");
        if starts_block_scalar(rest) {
            if is_id_key {
                // Multiline block-scalar `id:` is not recovered as a simple scalar.
                return None;
            }
            block_scalar_indent = Some(root_indent);
            continue;
        }
        advance_yaml_inline_state(rest, &mut open_quote, &mut flow_depth);
        if !is_id_key {
            continue;
        }
        if open_quote.is_some() || flow_depth > 0 || found.is_some() {
            return None;
        }
        let YamlValue::Mapping(fields) = yaml::parse(at_root).ok()? else {
            return None;
        };
        let YamlValue::String(value) = fields.get("id")? else {
            return None;
        };
        found = Some(ViewKey::parse(value).ok()?);
    }
    found
}

fn starts_block_scalar(rest: &str) -> bool {
    let trimmed = rest.trim_start_matches([' ', '\t']);
    let Some(indicator) = trimmed.chars().next() else {
        return false;
    };
    if indicator != '|' && indicator != '>' {
        return false;
    }
    let after = &trimmed[1..];
    let after = after
        .split_once('#')
        .map_or(after, |(before, _)| before)
        .trim();
    after
        .bytes()
        .all(|b| matches!(b, b'+' | b'-' | b'1'..=b'9'))
}

fn advance_yaml_inline_state(text: &str, open_quote: &mut Option<char>, flow_depth: &mut usize) {
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(quote) = *open_quote {
            if quote == '"' {
                if ch == '\\' {
                    let _ = chars.next();
                } else if ch == '"' {
                    *open_quote = None;
                }
            } else if ch == '\'' {
                if chars.peek() == Some(&'\'') {
                    let _ = chars.next();
                } else {
                    *open_quote = None;
                }
            }
            continue;
        }
        match ch {
            '#' => break,
            '"' | '\'' => *open_quote = Some(ch),
            '[' | '{' => *flow_depth = flow_depth.saturating_add(1),
            ']' | '}' => *flow_depth = flow_depth.saturating_sub(1),
            _ => {}
        }
    }
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

#[cfg(test)]
mod tests {
    use super::recover_top_level_id;
    use notarium_core::ids::ViewKey;

    #[test]
    fn recover_top_level_id_requires_leading_spaces_only() {
        let key = ViewKey::from_bytes([1; 16]);
        let valid = format!("  kind: list\n  id: {}\n  bad: [", key.as_str());
        assert_eq!(recover_top_level_id(&valid), Some(key.clone()));

        let non_space_prefix = format!("  kind: list\nabid: {}\n  bad: [", key.as_str());
        assert_eq!(recover_top_level_id(&non_space_prefix), None);
    }

    #[test]
    fn recover_top_level_id_ignores_multiline_scalars_and_document_boundaries() {
        let key = ViewKey::from_bytes([2; 16]);
        let in_block_scalar = format!("title: |\n  id: {}\nbad: [", key.as_str());
        assert_eq!(recover_top_level_id(&in_block_scalar), None);

        let in_quoted = format!("title: \"hello\nid: {}\"\nbad: [", key.as_str());
        assert_eq!(recover_top_level_id(&in_quoted), None);

        let after_doc_end = format!("kind: list\n...\nid: {}", key.as_str());
        assert_eq!(recover_top_level_id(&after_doc_end), None);

        let after_second_doc = format!("kind: list\n---\nid: {}", key.as_str());
        assert_eq!(recover_top_level_id(&after_second_doc), None);

        let after_leading_doc_start = format!("---\nkind: list\nid: {}\nbad: [", key.as_str());
        assert_eq!(recover_top_level_id(&after_leading_doc_start), Some(key));
    }
}

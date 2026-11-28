//! Read-only preparation and guarded execution of confirmed note actions.
use std::fmt;

use notarium_core::{
    DomainError,
    auth::{PrincipalKind, ResourceFacts},
    classes::{ClassEgressFence, DocClass},
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, RevisionId},
    model::{FolderRef, HistoryScope, Lifecycle, NoteRef},
    ports::{
        ConfirmedNoteDestination, DeleteDisposition, DeleteNote, EditNote, EnsureFolderPath,
        FolderSnapshot, MoveNote, Mutation, Preconditions, RenameNote, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    EgressTarget, MoveInput, NoteInput, NoteRoute, RenameInput, ToolCallContext, ToolName,
    authorize_note_write, clean_path, corpus, create, decode, edit::EditInput, folder_base,
    generated_slug, invalid, metadata_snapshot, note_slug, observe_note, preconditions,
    receipt_result, snapshot, validated_title,
};

pub(in crate::mcp) type ConfirmedStep<'a> = dyn Fn(&HistoryScope, &'static str, u16) -> Result<(SpaceContext, CommandIdentity), PortError>
    + Send
    + Sync
    + 'a;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::mcp) struct UnifiedPreview {
    pub diff: String,
    pub truncated: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::mcp) enum PreparedNoteAction {
    Create(create::proposal::ProposedCreates),
    Edit {
        route: NoteRoute,
        plan: notarium_core::patch::CarrierPatchPlan,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        edited_view: Option<notarium_core::ids::ViewKey>,
    },
    Delete {
        route: NoteRoute,
    },
    Move {
        route: NoteRoute,
        destination: Destination,
        slug: String,
        class: DocClass,
    },
    Rename {
        route: NoteRoute,
        slug: String,
        title: String,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(in crate::mcp) struct Destination {
    pub(super) anchor: FolderRef,
    revision: RevisionId,
    tail: String,
    path: String,
    pub(super) ancestors: Vec<FolderId>,
}

impl PreparedNoteAction {
    pub(in crate::mcp) fn scope(&self) -> &HistoryScope {
        match self {
            Self::Create(create) => create.scope(),
            Self::Edit { route, .. }
            | Self::Delete { route }
            | Self::Move { route, .. }
            | Self::Rename { route, .. } => &route.scope,
        }
    }

    pub(in crate::mcp) fn tool_name(&self) -> ToolName {
        match self {
            Self::Create(create) => create.tool_name(),
            Self::Edit { .. } => ToolName::EditNote,
            Self::Delete { .. } => ToolName::DeleteNote,
            Self::Move { .. } => ToolName::MoveNote,
            Self::Rename { .. } => ToolName::RenameNote,
        }
    }
}

impl fmt::Debug for PreparedNoteAction {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedNoteAction")
            .field("tool", &self.tool_name())
            .field("scope", self.scope())
            .finish_non_exhaustive()
    }
}

async fn review_note_scope(
    reviewer: &ToolCallContext<'_>,
    route: &NoteRoute,
) -> Result<SpaceContext, PortError> {
    let scope = reviewer.space(route.scope.clone())?;
    let current = corpus::note_in_space(reviewer, &scope, &route.note).await?;
    authorize_note_write(&scope, &current.facts)?;
    Ok(scope)
}

pub(in crate::mcp) async fn describe_proposal(
    reviewer: &mut ToolCallContext<'_>,
    action: &PreparedNoteAction,
) -> Result<Value, PortError> {
    if !matches!(reviewer.target, EgressTarget::ExternalMcp)
        || !matches!(reviewer.auth.kind(), PrincipalKind::DirectHuman)
    {
        return Err(DomainError::AccessDenied.into());
    }
    let route = match action {
        PreparedNoteAction::Create(creates) => {
            return create::proposal::describe(reviewer, creates).await;
        }
        PreparedNoteAction::Edit { route, .. }
        | PreparedNoteAction::Delete { route }
        | PreparedNoteAction::Move { route, .. }
        | PreparedNoteAction::Rename { route, .. } => route,
    };
    let scope = review_note_scope(reviewer, route).await?;
    let mut change = json!({ "spaceId":route.scope.space_id, "noteId":route.note, "versionToken":route.revision });
    if matches!(action, PreparedNoteAction::Edit { .. }) {
        return Ok(change);
    }
    let before = metadata_snapshot(
        reviewer,
        &scope,
        &route.note,
        Some(route.revision.clone()),
        CausalBasis::Await(Default::default()),
    )
    .await?;
    corpus::note_metadata(reviewer, &scope, &before.metadata).await?;
    let metadata = before
        .provenance
        .ok_or_else(|| invalid(ValidationReason::NotReady))?;
    change["title"] = json!(metadata.title);
    change["path"] = json!(metadata.path);
    match action {
        PreparedNoteAction::Move {
            destination, class, ..
        } => {
            change["destination"] = destination.describe(reviewer, &scope, *class).await?;
        }
        PreparedNoteAction::Rename { title, slug, .. } => {
            change["newTitle"] = json!(title);
            change["fileName"] = json!(format!("{slug}.md"));
        }
        _ => (),
    }
    Ok(change)
}

pub(in crate::mcp) async fn preview_proposal(
    viewer: &mut ToolCallContext<'_>,
    action: &PreparedNoteAction,
) -> Result<Option<UnifiedPreview>, PortError> {
    let PreparedNoteAction::Edit { route, plan, .. } = action else {
        return Ok(None);
    };
    let result = async {
        let scope = if matches!(viewer.target, EgressTarget::ExternalMcp) {
            review_note_scope(viewer, route).await?
        } else {
            viewer.space(route.scope.clone())?
        };
        let before = snapshot(
            viewer,
            &scope,
            &route.note,
            Some(route.revision.clone()),
            CausalBasis::Await(Default::default()),
        )
        .await?;
        let original = corpus::note_document(viewer, &scope, &before.document).await?;
        if before.document.digest() != plan.base_content_hash {
            return Err(DomainError::RevisionConflict {
                current: before.document.revision().clone(),
                lineage: None,
            }
            .into());
        }
        Ok(unified_preview_from_plan(&original, plan))
    }
    .await;
    match result {
        Err(error) if corpus::hidden(&error) => Ok(None),
        other => other,
    }
}

fn floor_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_char_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn count_lines(text: &str) -> usize {
    if text.is_empty() {
        0
    } else {
        text.split_inclusive('\n').count()
    }
}

/// Render a multi-hunk unified diff directly from `ByteSpan` edits without
/// cloning the full target document. Bounds unchanged context lines and huge
/// single-line edits so changed bytes remain visible within the display cap
/// (leaving JSON-escaping headroom under `MAX_DISPLAY_BYTES`), and reports
/// `truncated = true` whenever any byte or hunk is omitted.
fn unified_preview_from_plan(
    before: &str,
    plan: &notarium_core::patch::CarrierPatchPlan,
) -> Option<UnifiedPreview> {
    const PREVIEW_CAP_BYTES: usize = 20 * 1024;
    const CONTEXT_LINES: usize = 3;
    const MAX_CONTEXT_LINE_BYTES: usize = 512;
    const LARGE_REGION_THRESHOLD: usize = 8 * 1024;
    const INLINE_WINDOW_BYTES: usize = 128;
    const NO_NEWLINE_MARKER: &str = "\n\\ No newline at end of file\n";

    let active_edits: Vec<(usize, usize, &str)> = plan
        .edits
        .iter()
        .filter_map(|edit| {
            let start = edit.bytes.0.start();
            let end = edit.bytes.0.end();
            let old_slice = before.get(start..end)?;
            if old_slice == edit.replacement.as_str() {
                None
            } else {
                Some((start, end, edit.replacement.as_str()))
            }
        })
        .collect();
    if active_edits.is_empty() {
        return None;
    }

    let mut lines: Vec<(usize, usize)> = Vec::new();
    let mut offset = 0usize;
    for line in before.split_inclusive('\n') {
        let end = offset + line.len();
        lines.push((offset, end));
        offset = end;
    }
    let total_lines = lines.len();

    struct EditSpan {
        start: usize,
        end: usize,
        replacement: usize,
        first_line: usize,
        last_line_excl: usize,
    }

    let mut mapped = Vec::with_capacity(active_edits.len());
    for (idx, &(start, end, replacement)) in active_edits.iter().enumerate() {
        let (first_line, last_line_excl) = if total_lines == 0 {
            (0, 0)
        } else if start == end {
            if start == before.len() {
                if before.ends_with('\n') {
                    (total_lines, total_lines)
                } else {
                    (total_lines - 1, total_lines)
                }
            } else {
                let line_idx = lines.partition_point(|&(_, line_end)| line_end <= start);
                if start == lines[line_idx].0 && replacement.ends_with('\n') {
                    (line_idx, line_idx)
                } else {
                    (line_idx, (line_idx + 1).min(total_lines))
                }
            }
        } else {
            let first = lines.partition_point(|&(_, line_end)| line_end <= start);
            let mut last_excl = lines.partition_point(|&(_, line_end)| line_end < end) + 1;
            if last_excl < total_lines
                && lines[last_excl - 1].1 == end
                && before.as_bytes().get(end - 1) == Some(&b'\n')
                && !replacement.ends_with('\n')
                && (!replacement.is_empty() || start > lines[first].0)
            {
                last_excl += 1;
            }
            (first.min(total_lines), last_excl.min(total_lines))
        };
        mapped.push(EditSpan {
            start,
            end,
            replacement: idx,
            first_line,
            last_line_excl,
        });
    }

    struct HunkGroup {
        ctx_start: usize,
        edit_start: usize,
        edit_end: usize,
        ctx_end: usize,
        edits: Vec<usize>,
    }

    let mut hunks: Vec<HunkGroup> = Vec::new();
    for (idx, edit) in mapped.iter().enumerate() {
        let ctx_start = edit.first_line.saturating_sub(CONTEXT_LINES);
        let ctx_end = (edit.last_line_excl + CONTEXT_LINES).min(total_lines);
        if let Some(prev) = hunks.last_mut()
            && ctx_start <= prev.ctx_end
        {
            prev.edit_end = prev.edit_end.max(edit.last_line_excl);
            prev.ctx_end = prev.ctx_end.max(ctx_end);
            prev.edits.push(idx);
        } else {
            hunks.push(HunkGroup {
                ctx_start,
                edit_start: edit.first_line,
                edit_end: edit.last_line_excl,
                ctx_end,
                edits: vec![idx],
            });
        }
    }

    let mut output = String::from("--- current\n+++ proposed\n");
    let mut truncated = false;
    let mut line_delta: isize = 0;

    let push_raw = |out: &mut String, piece: &str, truncated: &mut bool| -> bool {
        if out.len().saturating_add(piece.len()) <= PREVIEW_CAP_BYTES {
            out.push_str(piece);
            true
        } else {
            let room = PREVIEW_CAP_BYTES.saturating_sub(out.len());
            let end = floor_char_boundary(piece, room);
            out.push_str(&piece[..end]);
            *truncated = true;
            false
        }
    };

    let push_diff_line = |out: &mut String,
                          marker: char,
                          line: &str,
                          cap: Option<usize>,
                          truncated: &mut bool|
     -> bool {
        if out.len() >= PREVIEW_CAP_BYTES {
            *truncated = true;
            return false;
        }
        let mut was_capped = false;
        let display = if let Some(limit) = cap
            && line.len() > limit
        {
            was_capped = true;
            *truncated = true;
            let trimmed = line.trim_end_matches('\n');
            let end = floor_char_boundary(trimmed, limit.saturating_sub(4));
            &trimmed[..end]
        } else {
            line
        };
        if out.len().saturating_add(1) > PREVIEW_CAP_BYTES {
            *truncated = true;
            return false;
        }
        out.push(marker);
        if was_capped {
            if !push_raw(out, display, truncated) {
                return false;
            }
            return push_raw(out, "...\n", truncated);
        }
        if !push_raw(out, display, truncated) {
            return false;
        }
        if !display.ends_with('\n') {
            if out.len().saturating_add(NO_NEWLINE_MARKER.len()) <= PREVIEW_CAP_BYTES {
                out.push_str(NO_NEWLINE_MARKER);
            } else {
                *truncated = true;
                return false;
            }
        }
        true
    };

    'hunks: for hunk in hunks {
        let region_start = if hunk.edit_start < total_lines {
            lines[hunk.edit_start].0
        } else {
            before.len()
        };
        let region_end = if hunk.edit_end == hunk.edit_start {
            region_start
        } else {
            lines[hunk.edit_end - 1].1
        };
        let old_region = &before[region_start..region_end];
        let old_region_lines = hunk.edit_end - hunk.edit_start;
        let pre_count = hunk.edit_start - hunk.ctx_start;
        let post_count = hunk.ctx_end - hunk.edit_end;

        let estimated_new_bytes = {
            let mut size = old_region.len();
            for &edit_idx in &hunk.edits {
                let edit = &mapped[edit_idx];
                let repl = active_edits[edit.replacement].2;
                size = size
                    .saturating_sub(edit.end - edit.start)
                    .saturating_add(repl.len());
            }
            size
        };

        if old_region.len() <= LARGE_REGION_THRESHOLD
            && estimated_new_bytes <= LARGE_REGION_THRESHOLD
        {
            let mut new_region = String::with_capacity(estimated_new_bytes);
            let mut cursor = region_start;
            for &edit_idx in &hunk.edits {
                let edit = &mapped[edit_idx];
                let repl = active_edits[edit.replacement].2;
                new_region.push_str(&before[cursor..edit.start]);
                new_region.push_str(repl);
                cursor = edit.end;
            }
            new_region.push_str(&before[cursor..region_end]);

            let new_region_lines = count_lines(&new_region);
            let old_count = pre_count + old_region_lines + post_count;
            let new_count = pre_count + new_region_lines + post_count;
            let old_line = hunk.ctx_start + usize::from(old_count > 0);
            let new_base = (hunk.ctx_start as isize + line_delta).max(0) as usize;
            let new_line = new_base + usize::from(new_count > 0);
            line_delta += new_region_lines as isize - old_region_lines as isize;

            let header = format!("@@ -{old_line},{old_count} +{new_line},{new_count} @@\n");
            if !push_raw(&mut output, &header, &mut truncated) {
                break 'hunks;
            }
            for &(ls, le) in &lines[hunk.ctx_start..hunk.edit_start] {
                if !push_diff_line(
                    &mut output,
                    ' ',
                    &before[ls..le],
                    Some(MAX_CONTEXT_LINE_BYTES),
                    &mut truncated,
                ) {
                    break 'hunks;
                }
            }
            for line in old_region.split_inclusive('\n') {
                if !push_diff_line(&mut output, '-', line, None, &mut truncated) {
                    break 'hunks;
                }
            }
            for line in new_region.split_inclusive('\n') {
                if !push_diff_line(&mut output, '+', line, None, &mut truncated) {
                    break 'hunks;
                }
            }
            for &(ls, le) in &lines[hunk.edit_end..hunk.ctx_end] {
                if !push_diff_line(
                    &mut output,
                    ' ',
                    &before[ls..le],
                    Some(MAX_CONTEXT_LINE_BYTES),
                    &mut truncated,
                ) {
                    break 'hunks;
                }
            }
        } else {
            // Large edited region (for example, a long single line with a localized
            // replacement): window directly around each edited ByteSpan without
            // allocating a full copy of the untouched prefix/suffix.
            truncated = true;
            let mut new_newlines = 0usize;
            let mut cursor = region_start;
            let mut last_byte: Option<u8> = None;
            let mut non_empty = false;
            for &edit_idx in &hunk.edits {
                let edit = &mapped[edit_idx];
                let repl = active_edits[edit.replacement].2;
                let unchanged = &before[cursor..edit.start];
                if !unchanged.is_empty() {
                    non_empty = true;
                    last_byte = unchanged.as_bytes().last().copied();
                    new_newlines += unchanged.bytes().filter(|&b| b == b'\n').count();
                }
                if !repl.is_empty() {
                    non_empty = true;
                    last_byte = repl.as_bytes().last().copied();
                    new_newlines += repl.bytes().filter(|&b| b == b'\n').count();
                }
                cursor = edit.end;
            }
            let tail = &before[cursor..region_end];
            if !tail.is_empty() {
                non_empty = true;
                last_byte = tail.as_bytes().last().copied();
                new_newlines += tail.bytes().filter(|&b| b == b'\n').count();
            }
            let new_region_lines = if !non_empty {
                0
            } else if last_byte == Some(b'\n') {
                new_newlines
            } else {
                new_newlines + 1
            };

            let old_count = pre_count + old_region_lines + post_count;
            let new_count = pre_count + new_region_lines + post_count;
            let old_line = hunk.ctx_start + usize::from(old_count > 0);
            let new_base = (hunk.ctx_start as isize + line_delta).max(0) as usize;
            let new_line = new_base + usize::from(new_count > 0);
            line_delta += new_region_lines as isize - old_region_lines as isize;

            let header = format!("@@ -{old_line},{old_count} +{new_line},{new_count} @@\n");
            if !push_raw(&mut output, &header, &mut truncated) {
                break 'hunks;
            }
            for &(ls, le) in &lines[hunk.ctx_start..hunk.edit_start] {
                if !push_diff_line(
                    &mut output,
                    ' ',
                    &before[ls..le],
                    Some(MAX_CONTEXT_LINE_BYTES),
                    &mut truncated,
                ) {
                    break 'hunks;
                }
            }
            for &edit_idx in &hunk.edits {
                let edit = &mapped[edit_idx];
                let repl = active_edits[edit.replacement].2;
                let win_start =
                    ceil_char_boundary(before, edit.start.saturating_sub(INLINE_WINDOW_BYTES))
                        .max(region_start);
                let win_end = floor_char_boundary(
                    before,
                    edit.end.saturating_add(INLINE_WINDOW_BYTES).min(region_end),
                );
                let pre = &before[win_start..edit.start];
                let old_mid = &before[edit.start..edit.end];
                let post = &before[edit.end..win_end];
                let pre_elided = win_start > region_start;
                let post_elided = win_end < region_end;
                let old_cap = floor_char_boundary(old_mid, 4096);
                let new_cap = floor_char_boundary(repl, 4096);
                let mut old_snippet = String::new();
                if pre_elided {
                    old_snippet.push_str("...");
                }
                old_snippet.push_str(pre);
                old_snippet.push_str(&old_mid[..old_cap]);
                if old_cap < old_mid.len() {
                    old_snippet.push_str("...");
                }
                old_snippet.push_str(post);
                if post_elided {
                    old_snippet.push_str("...");
                }
                if !old_snippet.is_empty() {
                    if !old_snippet.ends_with('\n') {
                        old_snippet.push('\n');
                    }
                    for line in old_snippet.split_inclusive('\n') {
                        if !push_diff_line(&mut output, '-', line, None, &mut truncated) {
                            break 'hunks;
                        }
                    }
                }
                let mut new_snippet = String::new();
                if pre_elided {
                    new_snippet.push_str("...");
                }
                new_snippet.push_str(pre);
                new_snippet.push_str(&repl[..new_cap]);
                if new_cap < repl.len() {
                    new_snippet.push_str("...");
                }
                new_snippet.push_str(post);
                if post_elided {
                    new_snippet.push_str("...");
                }
                if !new_snippet.is_empty() {
                    if !new_snippet.ends_with('\n') {
                        new_snippet.push('\n');
                    }
                    for line in new_snippet.split_inclusive('\n') {
                        if !push_diff_line(&mut output, '+', line, None, &mut truncated) {
                            break 'hunks;
                        }
                    }
                }
            }
            for &(ls, le) in &lines[hunk.edit_end..hunk.ctx_end] {
                if !push_diff_line(
                    &mut output,
                    ' ',
                    &before[ls..le],
                    Some(MAX_CONTEXT_LINE_BYTES),
                    &mut truncated,
                ) {
                    break 'hunks;
                }
            }
        }
    }

    debug_assert!(output.len() <= PREVIEW_CAP_BYTES);
    Some(UnifiedPreview {
        diff: output,
        truncated,
    })
}

#[cfg(test)]
#[test]
fn preview_keeps_changed_lines_and_final_newline_semantics() {
    let plan_for = |before: &str, edits: Vec<(usize, usize, &str)>| {
        let body = notarium_core::span::ByteSpan::new(0, before.len()).unwrap();
        let ops = edits
            .into_iter()
            .map(|(s, e, r)| {
                (
                    notarium_core::patch::CarrierEditOrigin::Body,
                    notarium_core::span::ByteSpan::new(s, e).unwrap(),
                    r.to_owned(),
                )
            })
            .collect();
        notarium_syntax::patch::plan(before, body, ops).unwrap()
    };

    let old = "Far away.\nFirst.\nSecond.\nThird.\nOld.";
    assert_eq!(unified_preview_from_plan(old, &plan_for(old, vec![])), None);
    let old_pos = old.find("Old.").unwrap();
    let preview =
        unified_preview_from_plan(old, &plan_for(old, vec![(old_pos, old.len(), "New.\n")]))
            .unwrap();
    assert!(!preview.truncated);
    assert_eq!(
        preview.diff,
        concat!(
            "--- current\n+++ proposed\n@@ -2,4 +2,4 @@\n",
            " First.\n Second.\n Third.\n-Old.\n\\ No newline at end of file\n+New.\n",
        )
    );

    // Separate huge unchanged preceding line must not crowd out `-OLD`/`+NEW`.
    let huge_prefix_line = format!("{}\nOLD\n", "x".repeat(70_000));
    let old_idx = huge_prefix_line.find("OLD").unwrap();
    let preview_sep = unified_preview_from_plan(
        &huge_prefix_line,
        &plan_for(&huge_prefix_line, vec![(old_idx, old_idx + 3, "NEW")]),
    )
    .unwrap();
    assert!(preview_sep.truncated);
    assert!(preview_sep.diff.len() <= 32 * 1024);
    assert!(preview_sep.diff.contains("-OLD\n+NEW\n"));

    // Huge unchanged prefix on the SAME line must still expose OLD -> NEW directly.
    let same_line = format!("{}OLD\n", "x".repeat(70_000));
    let same_idx = same_line.find("OLD").unwrap();
    let preview_same = unified_preview_from_plan(
        &same_line,
        &plan_for(&same_line, vec![(same_idx, same_idx + 3, "NEW")]),
    )
    .unwrap();
    assert!(preview_same.truncated);
    assert!(preview_same.diff.len() <= 32 * 1024);
    assert!(preview_same.diff.contains("OLD"));
    assert!(preview_same.diff.contains("NEW"));

    // Multi-hunk distant edits stay compact with 2 separate hunks.
    let prefix = "\n".repeat(100_000);
    let large_old = format!("first\n{prefix}old\n");
    let end_idx = large_old.len() - 4;
    let multi = unified_preview_from_plan(
        &large_old,
        &plan_for(
            &large_old,
            vec![(0, 5, "FIRST"), (end_idx, end_idx + 3, "new")],
        ),
    )
    .unwrap();
    assert!(!multi.truncated);
    assert!(multi.diff.contains("-first\n+FIRST\n"));
    assert!(multi.diff.contains("-old\n+new\n"));
    assert!(multi.diff.len() < 512);

    // Exact 20 KiB cap even with missing trailing newline marker (leaves JSON headroom under 32 KiB).
    let huge_before = "a".repeat(100_000);
    let capped = unified_preview_from_plan(
        &huge_before,
        &plan_for(
            &huge_before,
            vec![(0, huge_before.len(), &"b".repeat(100_000))],
        ),
    )
    .unwrap();
    assert!(capped.truncated);
    assert!(capped.diff.len() <= 20 * 1024);

    // Whole-line deletion before a huge next line must not pull the next line into the diff.
    let del_before = format!("line1\n{}\n", "x".repeat(10_000));
    let del_preview =
        unified_preview_from_plan(&del_before, &plan_for(&del_before, vec![(0, 6, "")])).unwrap();
    assert!(del_preview.diff.contains("-line1\n"));
    assert!(!del_preview.diff.contains("-xxxx"));
    assert!(!del_preview.diff.contains("+xxxx"));

    // Large insertion into an empty document must not emit a phantom deleted blank line.
    let ins_preview =
        unified_preview_from_plan("", &plan_for("", vec![(0, 0, &"a".repeat(10_000))])).unwrap();
    assert!(!ins_preview.diff.contains("\n-\n"));
    assert!(ins_preview.diff.contains("\n+aaaa"));
}

pub(super) async fn authorize_folder(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    target: &FolderRef,
    class: DocClass,
) -> Result<(), PortError> {
    let live = call
        .registry
        .catalog
        .folder(call.account(), target.clone())
        .await?;
    if live.reference != *target
        || live.space.id != scope.scope().space_id
        || live.lifecycle != Lifecycle::Active
    {
        return Err(DomainError::ResourceNotFound.into());
    }
    let facts = ResourceFacts {
        space: live.space,
        class,
        project: None,
        ancestor_folders: live.ancestor_folders,
        folder_write_locked: live.write_locked,
        ability_package: None,
    };
    scope.auth().authorize_direct_write(&facts, &facts)?;
    Ok(())
}

pub(super) async fn resolve_destination(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: Option<FolderId>,
    path: &str,
) -> Result<Destination, PortError> {
    let resolve = |path: String| {
        call.registry
            .engine
            .resolve_folder_path(scope.clone(), base.clone(), path)
    };
    let base_snap = resolve(String::new())
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    let base_path = base_snap.path.clone();
    let expected_exact = super::join_folder_path(&base_path, path);
    let (anchor, tail) = if path.is_empty() {
        (base_snap, String::new())
    } else if let Some(exact) = resolve(path.to_owned()).await?
        && super::same_folder_path(&exact.path, &expected_exact)
    {
        (exact, String::new())
    } else {
        // Find the nearest existing live ancestor with read operations only (ignoring
        // historical folder aliases whose canonical path differs from the requested prefix).
        // Its write permission must cover the creation of the missing suffix.
        let mut nearest = base_snap;
        let mut edges = vec![0];
        edges.extend(path.match_indices('/').map(|(offset, _)| offset));
        edges.push(path.len());
        let (mut present, mut absent) = (0, edges.len() - 1);
        while absent - present > 1 {
            let probe = present + (absent - present) / 2;
            let prefix = &path[..edges[probe]];
            let expected_prefix = super::join_folder_path(&base_path, prefix);
            if let Some(found) = resolve(prefix.to_owned()).await?
                && super::same_folder_path(&found.path, &expected_prefix)
            {
                present = probe;
                nearest = found;
            } else {
                absent = probe;
            }
        }
        (
            nearest,
            path[edges[present]..].trim_start_matches('/').to_owned(),
        )
    };
    scope.scope().check(&anchor.history)?;
    if anchor.reference.space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    Ok(Destination {
        anchor: anchor.reference,
        revision: anchor.revision,
        tail,
        path: anchor.path,
        ancestors: anchor.ancestor_folders,
    })
}

impl Destination {
    pub(super) fn exact(&self) -> Option<&FolderRef> {
        self.tail.is_empty().then_some(&self.anchor)
    }

    async fn checked_anchor(
        &self,
        call: &ToolCallContext<'_>,
        scope: &SpaceContext,
        class: DocClass,
    ) -> Result<FolderSnapshot, PortError> {
        let current = folder_base(call, scope, &self.anchor.folder_id).await?;
        if current.reference != self.anchor {
            return Err(invalid(ValidationReason::ScopeMismatch));
        }
        authorize_folder(call, scope, &self.anchor, class).await?;
        if current.revision != self.revision
            || current.path != self.path
            || current.ancestor_folders != self.ancestors
        {
            return Err(DomainError::RevisionConflict {
                current: current.revision,
                lineage: None,
            }
            .into());
        }
        Ok(current)
    }

    pub(super) async fn describe(
        &self,
        reviewer: &mut ToolCallContext<'_>,
        scope: &SpaceContext,
        class: DocClass,
    ) -> Result<Value, PortError> {
        let anchor = self.checked_anchor(reviewer, scope, class).await?;
        let visible = corpus::folder_metadata(reviewer, scope, &anchor).await?;
        if visible["path"].as_str() != Some(self.path.as_str()) {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        let path = [self.path.as_str(), &self.tail]
            .into_iter()
            .filter(|component| !component.is_empty())
            .collect::<Vec<_>>()
            .join("/");
        Ok(json!({ "folderPath":path, "folderId":self.exact().map(|folder| &folder.folder_id) }))
    }

    pub(super) fn bind(
        &self,
        scope: SpaceContext,
        expected_source: Option<&NoteRoute>,
    ) -> Result<SpaceContext, PortError> {
        Ok(
            scope.with_confirmed_note_destination(ConfirmedNoteDestination {
                anchor: self.anchor.clone(),
                anchor_revision: self.revision.clone(),
                anchor_path: self.path.clone(),
                anchor_ancestors: self.ancestors.clone(),
                missing_suffix: self.tail.clone(),
                move_source: expected_source
                    .map(|route| (route.note.clone(), route.revision.clone())),
            })?,
        )
    }

    pub(super) async fn apply(
        &self,
        call: &ToolCallContext<'_>,
        scope: SpaceContext,
        identity: CommandIdentity,
        expected_source: Option<&NoteRoute>,
    ) -> Result<FolderRef, PortError> {
        if let Some(exact) = self.exact() {
            return Ok(exact.clone());
        }
        if let Some(hit) = call
            .lookup_journal_with_key::<FolderRef>(
                "confirmed_destination",
                &identity.key,
                identity.hash,
            )
            .await?
        {
            return Ok(hit);
        }
        const CONFIRMED_DEST_LABEL: &str = "notarium.confirmed-destination.v1";
        let mut attempted_replayed = true;
        let _: bool = call
            .journal_with_key(
                "confirmed_destination_attempted",
                &identity.key,
                identity.hash,
                || async {
                    attempted_replayed = false;
                    Ok(true)
                },
            )
            .await
            .map_err(|error| super::batch_operational_error(CONFIRMED_DEST_LABEL, error, false))?;
        // Record the resolved identity for replay even when a sibling step
        // created the whole suffix. The subsequent note write rechecks it.
        let scope = call
            .fence_confirmed_effect(self.bind(scope, expected_source)?)
            .await
            .map_err(|error| {
                super::batch_operational_error(CONFIRMED_DEST_LABEL, error, attempted_replayed)
            })?;
        let folder = call
            .registry
            .engine
            .ensure_folder_path(
                scope,
                Mutation {
                    identity: identity.clone(),
                    preconditions: Preconditions::default(),
                    input: EnsureFolderPath {
                        base: Some(self.anchor.folder_id.clone()),
                        path: self.tail.clone(),
                    },
                },
            )
            .await
            .map_err(|error| {
                super::batch_operational_error(CONFIRMED_DEST_LABEL, error, attempted_replayed)
            })?
            .folder;
        call.record_journal_with_key(
            "confirmed_destination",
            &identity.key,
            identity.hash,
            &folder,
        )
        .await
        .map_err(|error| super::post_commit_error(CONFIRMED_DEST_LABEL, error))
    }
}

/// Validate pure note-tool proposal argument syntax without touching canonical
/// or catalog state. Runs before proposal target resolution so malformed inputs
/// cannot distinguish missing vs existing foreign targets.
pub(in crate::mcp) fn validate_proposal_input(
    tool: ToolName,
    args: &Value,
) -> Result<bool, PortError> {
    match tool {
        ToolName::CreateNote | ToolName::CreateNotes => {
            create::proposal::preflight_input(tool, args)
        }
        ToolName::EditNote => {
            let input: EditInput = decode(args.clone())?;
            input.validate()?;
            Ok(true)
        }
        ToolName::DeleteNote => {
            let _: NoteInput = decode(args.clone())?;
            Ok(true)
        }
        ToolName::RenameNote => {
            let input: RenameInput = decode(args.clone())?;
            let _ = validated_title(&input.title)?;
            Ok(true)
        }
        ToolName::MoveNote => {
            let input: MoveInput = decode(args.clone())?;
            let _ = clean_path(&input.to_folder)?;
            Ok(true)
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

/// Validate pure note-tool proposal arguments and (for `MoveNote`) destination
/// folder consent before marking cross-space `BranchTaint` or probing any note
/// bodies under detached human authority. Returns `true` when planning will
/// probe corpus note content/targets.
pub(in crate::mcp) async fn preflight_proposal(
    provider: &ToolCallContext<'_>,
    owner: &ToolCallContext<'_>,
    tool: ToolName,
    args: &Value,
) -> Result<bool, PortError> {
    let collapse = |error: PortError| {
        if corpus::hidden(&error) {
            DomainError::ResourceNotFound.into()
        } else {
            error
        }
    };
    match tool {
        ToolName::CreateNote | ToolName::CreateNotes => {
            create::proposal::preflight_input(tool, args)
        }
        ToolName::EditNote => {
            let input: EditInput = decode(args.clone())?;
            input.validate()?;
            Ok(true)
        }
        ToolName::DeleteNote => {
            let _: NoteInput = decode(args.clone())?;
            Ok(true)
        }
        ToolName::RenameNote => {
            let input: RenameInput = decode(args.clone())?;
            let _ = validated_title(&input.title)?;
            Ok(true)
        }
        ToolName::MoveNote => {
            let input: MoveInput = decode(args.clone())?;
            let raw_path = clean_path(&input.to_folder)?;
            let (provider_scope, note) =
                corpus::locate_note_preflight(provider, &input.target.note)
                    .await
                    .map_err(collapse)?;
            corpus::admit_provider_note_read(provider, &provider_scope, &note)
                .await
                .map_err(collapse)?;
            let owner_scope = owner.space(provider_scope.scope().clone())?;
            let base = provider_scope
                .auth()
                .spaces()
                .get(&provider_scope.scope().space_id)
                .and_then(|grant| grant.project_root.clone());
            let path = if let Some(base) = &base {
                let root = folder_base(owner, &owner_scope, base).await?;
                corpus::strip_folder_prefix(&raw_path, &root.path)
                    .ok_or(DomainError::SpaceReadOnly)?
            } else {
                raw_path
            };
            let destination = resolve_destination(owner, &owner_scope, base, &path).await?;
            let dest_project = folder_base(owner, &owner_scope, &destination.anchor.folder_id)
                .await?
                .project
                .map(|folder_id| FolderRef {
                    space_id: provider_scope.scope().space_id.clone(),
                    folder_id,
                });
            corpus::admit_folder_write(
                provider,
                &provider_scope,
                &destination.anchor,
                dest_project.clone(),
                &destination.ancestors,
                note.facts.class,
            )
            .await
            .map_err(collapse)?;
            corpus::record_folder_origin(
                provider,
                &provider_scope,
                &destination.anchor,
                dest_project,
            )
            .await
            .map_err(collapse)?;
            authorize_folder(owner, &owner_scope, &destination.anchor, note.facts.class).await?;
            Ok(true)
        }
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(in crate::mcp) async fn plan_proposal(
    owner: &ToolCallContext<'_>,
    provider: &ToolCallContext<'_>,
    tool: ToolName,
    arguments: Value,
) -> Result<PreparedNoteAction, PortError> {
    Ok(match tool {
        ToolName::CreateNote | ToolName::CreateNotes => PreparedNoteAction::Create(
            create::proposal::prepare(owner, provider, tool, arguments).await?,
        ),
        ToolName::EditNote => {
            let input: EditInput = decode(arguments)?;
            input.validate()?;
            let route = observe_note(owner, &input.note, input.version_token.as_ref()).await?;
            let scope = owner.space(route.scope.clone())?;
            let before = snapshot(
                owner,
                &scope,
                &route.note,
                Some(route.revision.clone()),
                CausalBasis::Await(Default::default()),
            )
            .await?;
            let original = ClassEgressFence::mcp_note(&before.document, scope.auth())?;
            let schema = if input.edits_view() {
                owner.registry.engine.space_schema(scope.clone()).await?
            } else {
                std::collections::BTreeMap::new()
            };
            let edited_view = input.edited_view_key()?;
            let plan = input.plan(original, before.document.class(), &route, &schema)?;
            PreparedNoteAction::Edit {
                route,
                plan,
                edited_view,
            }
        }
        ToolName::DeleteNote => {
            let input: NoteInput = decode(arguments)?;
            let route = observe_note(owner, &input.note, None).await?;
            PreparedNoteAction::Delete { route }
        }
        ToolName::MoveNote => {
            let input: MoveInput = decode(arguments)?;
            let route = observe_note(owner, &input.target.note, None).await?;
            let scope = owner.space(route.scope.clone())?;
            let before = metadata_snapshot(
                owner,
                &scope,
                &route.note,
                Some(route.revision.clone()),
                CausalBasis::Await(Default::default()),
            )
            .await?;
            let slug = note_slug(before.provenance.as_ref())?;
            let class = before.metadata.class();
            let collapse = |error: PortError| {
                if corpus::hidden(&error) {
                    DomainError::ResourceNotFound.into()
                } else {
                    error
                }
            };
            let provider_scope = provider.space(route.scope.clone()).map_err(collapse)?;
            let base = provider_scope
                .auth()
                .spaces()
                .get(&route.scope.space_id)
                .and_then(|grant| grant.project_root.clone());
            let path = clean_path(&input.to_folder)?;
            let path = if let Some(base) = &base {
                let root = folder_base(owner, &scope, base).await?;
                corpus::strip_folder_prefix(&path, &root.path).ok_or(DomainError::SpaceReadOnly)?
            } else {
                path
            };
            let destination = resolve_destination(owner, &scope, base, &path).await?;
            let dest_project = folder_base(owner, &scope, &destination.anchor.folder_id)
                .await?
                .project
                .map(|folder_id| FolderRef {
                    space_id: route.scope.space_id.clone(),
                    folder_id,
                });
            corpus::admit_folder_write(
                provider,
                &provider_scope,
                &destination.anchor,
                dest_project.clone(),
                &destination.ancestors,
                class,
            )
            .await
            .map_err(collapse)?;
            corpus::record_folder_origin(
                provider,
                &provider_scope,
                &destination.anchor,
                dest_project,
            )
            .await
            .map_err(collapse)?;
            authorize_folder(owner, &scope, &destination.anchor, class).await?;
            PreparedNoteAction::Move {
                route,
                destination,
                slug,
                class,
            }
        }
        ToolName::RenameNote => {
            let input: RenameInput = decode(arguments)?;
            let title = validated_title(&input.title)?;
            let route = observe_note(owner, &input.target.note, None).await?;
            let scope = owner.space(route.scope.clone())?;
            let before = metadata_snapshot(
                owner,
                &scope,
                &route.note,
                Some(route.revision.clone()),
                CausalBasis::Await(Default::default()),
            )
            .await?;
            let metadata = before
                .provenance
                .ok_or_else(|| invalid(ValidationReason::NotReady))?;
            let slug = if metadata.folder_page {
                "index".to_owned()
            } else {
                generated_slug(&title, &route.note)
            };
            if !metadata.folder_page && notarium_syntax::unicode::lookup_key(&slug) == "index" {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
            PreparedNoteAction::Rename { route, slug, title }
        }
        _ => return Err(invalid(ValidationReason::InvalidQuery)),
    })
}

pub(super) async fn assert_absent_id(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
) -> Result<(), PortError> {
    let target = NoteRef {
        space_id: scope.scope().space_id.clone(),
        note_id: note.clone(),
    };
    match call.registry.catalog.note(call.account(), target).await {
        Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(()),
        Err(error) => Err(error),
        Ok(_) => {
            let current = metadata_snapshot(
                call,
                scope,
                note,
                None,
                CausalBasis::Await(Default::default()),
            )
            .await?;
            Err(DomainError::RevisionConflict {
                current: current.metadata.revision().clone(),
                lineage: None,
            }
            .into())
        }
    }
}

pub(in crate::mcp) async fn apply_proposal(
    owner: &mut ToolCallContext<'_>,
    action: PreparedNoteAction,
    step: &ConfirmedStep<'_>,
) -> Result<Value, PortError> {
    match action {
        PreparedNoteAction::Create(creates) => create::proposal::apply(owner, creates, step).await,
        PreparedNoteAction::Edit {
            route,
            plan,
            edited_view,
        } => {
            let (scope, identity) = step(&route.scope, "edit_note", 0)?;
            let before = snapshot(
                owner,
                &scope,
                &route.note,
                Some(route.revision.clone()),
                CausalBasis::Await(Default::default()),
            )
            .await?;
            if before.document.class() == DocClass::EncryptedNote {
                return Err(DomainError::ResourceNotFound.into());
            }
            let original = before.document.explicit_read(scope.auth())?;
            if before.document.digest() != plan.base_content_hash {
                return Err(DomainError::RevisionConflict {
                    current: before.document.revision().clone(),
                    lineage: None,
                }
                .into());
            }
            if let Some(view_key) = edited_view {
                let changed = notarium_syntax::patch::apply(original, &plan)?;
                let changed_body = notarium_syntax::carrier::Carrier::scan(&changed)?.body;
                let changed_md = notarium_syntax::markdown::analyze(&changed, changed_body)?;
                let reparsed = notarium_syntax::nota::analyze(
                    &changed,
                    changed_body,
                    &route.note,
                    &changed_md,
                    false,
                )?;
                let block = reparsed
                    .blocks
                    .iter()
                    .find(|block| block.id.as_ref() == Some(&view_key))
                    .ok_or_else(|| invalid(ValidationReason::InvalidView))?;
                if block.state != notarium_core::document::ViewState::Ready {
                    return Err(invalid(ValidationReason::InvalidView));
                }
                let config = block
                    .config
                    .as_ref()
                    .ok_or_else(|| invalid(ValidationReason::InvalidView))?;
                let live_schema = owner.registry.engine.space_schema(scope.clone()).await?;
                notarium_syntax::nota::spec::validate_view_config(config, &view_key, &live_schema)?;
            }
            let result = owner
                .registry
                .engine
                .edit_note(
                    owner.fence_confirmed_effect(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions: preconditions(&route),
                        input: EditNote {
                            note: route.note.clone(),
                            plan,
                        },
                    },
                )
                .await?;
            receipt_result(owner, scope, &route.note, result, "edited")
                .await
                .map_err(|error| {
                    super::batch_operational_error(
                        "notarium.mcp.confirmed-edit-note.v1",
                        error,
                        true,
                    )
                })
        }
        PreparedNoteAction::Delete { route } => {
            let (scope, identity) = step(&route.scope, "trash_note", 0)?;
            let result = owner
                .registry
                .engine
                .delete_note(
                    owner.fence_confirmed_effect(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions: preconditions(&route),
                        input: DeleteNote {
                            note: route.note.clone(),
                            disposition: DeleteDisposition::Trash,
                        },
                    },
                )
                .await?;
            receipt_result(owner, scope, &route.note, result, "trashed")
                .await
                .map_err(|error| {
                    super::post_commit_error("notarium.mcp.confirmed-delete-note.v1", error)
                })
        }
        PreparedNoteAction::Move {
            route,
            destination,
            slug,
            ..
        } => {
            const LABEL: &str = "notarium.mcp.confirmed-move-note.v1";
            let creates_folder = destination.exact().is_none();
            let (scope, identity) = step(&route.scope, "move_note", 0)?;
            let (folder_scope, folder_identity) = step(&route.scope, "move_destination", 0)?;
            let parent = destination
                .apply(owner, folder_scope, folder_identity, Some(&route))
                .await?;
            let bound = destination
                .bind(scope.clone(), Some(&route))
                .map_err(|error| super::batch_operational_error(LABEL, error, creates_folder))?;
            let leased = owner
                .fence_confirmed_effect(bound)
                .await
                .map_err(|error| super::batch_operational_error(LABEL, error, creates_folder))?;
            let result = owner
                .registry
                .engine
                .move_note(
                    leased,
                    Mutation {
                        identity,
                        preconditions: preconditions(&route),
                        input: MoveNote {
                            note: route.note.clone(),
                            parent: Some(parent.folder_id),
                            slug,
                        },
                    },
                )
                .await
                .map_err(|error| super::batch_operational_error(LABEL, error, creates_folder))?;
            receipt_result(owner, scope, &route.note, result, "moved")
                .await
                .map_err(|error| super::post_commit_error(LABEL, error))
        }
        PreparedNoteAction::Rename { route, slug, title } => {
            let (scope, identity) = step(&route.scope, "rename_note", 0)?;
            let result = owner
                .registry
                .engine
                .rename_note(
                    owner.fence_confirmed_effect(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions: preconditions(&route),
                        input: RenameNote {
                            note: route.note.clone(),
                            slug,
                            title: Some(title),
                        },
                    },
                )
                .await?;
            receipt_result(owner, scope, &route.note, result, "renamed")
                .await
                .map_err(|error| {
                    super::post_commit_error("notarium.mcp.confirmed-rename-note.v1", error)
                })
        }
    }
}

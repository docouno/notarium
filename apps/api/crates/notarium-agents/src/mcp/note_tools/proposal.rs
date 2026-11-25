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

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(in crate::mcp) enum PreparedNoteAction {
    Create(create::proposal::ProposedCreates),
    Edit {
        route: NoteRoute,
        input: EditInput,
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
    anchor: FolderRef,
    revision: RevisionId,
    tail: String,
    path: String,
    ancestors: Vec<FolderId>,
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
) -> Result<Option<String>, PortError> {
    let PreparedNoteAction::Edit { route, input } = action else {
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
        let schema = if input.edits_view() {
            viewer.registry.engine.space_schema(scope.clone()).await?
        } else {
            std::collections::BTreeMap::new()
        };
        let plan = input.plan(&original, before.document.class(), route, &schema)?;
        let updated = notarium_syntax::patch::apply(&original, &plan)?;
        Ok(unified_preview(&original, &updated))
    }
    .await;
    match result {
        Err(error) if corpus::hidden(&error) => Ok(None),
        other => other,
    }
}

fn unified_preview(before: &str, after: &str) -> Option<String> {
    if before == after {
        return None;
    }
    let old: Vec<_> = before.split_inclusive('\n').collect();
    let new: Vec<_> = after.split_inclusive('\n').collect();
    let first = old
        .iter()
        .zip(&new)
        .take_while(|(left, right)| left == right)
        .count();
    let suffix = old[first..]
        .iter()
        .rev()
        .zip(new[first..].iter().rev())
        .take_while(|(left, right)| left == right)
        .count();
    let begin = first.saturating_sub(3);
    let (old_end, new_end) = (old.len() - suffix, new.len() - suffix);
    let following = suffix.min(3);
    let (old_count, new_count) = (old_end - begin + following, new_end - begin + following);
    let (old_line, new_line) = (
        begin + usize::from(old_count > 0),
        begin + usize::from(new_count > 0),
    );
    let mut output = format!(
        "--- current\n+++ proposed\n@@ -{old_line},{old_count} +{new_line},{new_count} @@\n"
    );
    for (marker, lines) in [
        (' ', &old[begin..first]),
        ('-', &old[first..old_end]),
        ('+', &new[first..new_end]),
        (' ', &old[old_end..old_end + following]),
    ] {
        for line in lines {
            output.push(marker);
            output.push_str(line);
            if !line.ends_with('\n') {
                output.push_str("\n\\ No newline at end of file\n");
            }
        }
    }
    Some(output)
}

#[cfg(test)]
#[test]
fn preview_keeps_changed_lines_and_final_newline_semantics() {
    let old = "Far away.\nFirst.\nSecond.\nThird.\nOld.";
    let new = "Far away.\nFirst.\nSecond.\nThird.\nNew.\n";
    assert_eq!(unified_preview(old, old), None);
    assert_eq!(
        unified_preview(old, new).unwrap(),
        concat!(
            "--- current\n+++ proposed\n@@ -2,4 +2,4 @@\n",
            " First.\n Second.\n Third.\n-Old.\n\\ No newline at end of file\n+New.\n",
        )
    );
}

async fn authorize_folder(
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

async fn resolve_destination(
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
    let (anchor, tail) = if let Some(exact) = resolve(path.to_owned()).await? {
        (exact, String::new())
    } else {
        // Find the nearest existing ancestor with read operations only. Its
        // write permission must cover the creation of the missing suffix.
        let mut nearest = resolve(String::new())
            .await?
            .ok_or(DomainError::ResourceNotFound)?;
        let mut edges = vec![0];
        edges.extend(path.match_indices('/').map(|(offset, _)| offset));
        edges.push(path.len());
        let (mut present, mut absent) = (0, edges.len() - 1);
        while absent - present > 1 {
            let probe = present + (absent - present) / 2;
            if let Some(found) = resolve(path[..edges[probe]].to_owned()).await? {
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

pub(super) async fn observe_destination(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: Option<FolderId>,
    path: &str,
    class: DocClass,
) -> Result<Destination, PortError> {
    let destination = resolve_destination(call, scope, base, path).await?;
    authorize_folder(call, scope, &destination.anchor, class).await?;
    Ok(destination)
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
        // Record the resolved identity for replay even when a sibling step
        // created the whole suffix. The subsequent note write rechecks it.
        let scope = call
            .fence_confirmed_effect(self.bind(scope, expected_source)?)
            .await?;
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
            .await?;
        call.record_journal_with_key(
            "confirmed_destination",
            &identity.key,
            identity.hash,
            &folder,
        )
        .await
        .map_err(|error| super::post_commit_error("notarium.confirmed-destination.v1", error))
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
                dest_project,
                &destination.ancestors,
                note.facts.class,
            )
            .await
            .map_err(collapse)?;
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
            input.plan(original, before.document.class(), &route, &schema)?;
            PreparedNoteAction::Edit { route, input }
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
                dest_project,
                &destination.ancestors,
                class,
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
        PreparedNoteAction::Edit { route, input } => {
            let (scope, identity) = step(&route.scope, "edit_note", 0)?;
            input.validate()?;
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
            let plan = input.plan(original, before.document.class(), &route, &schema)?;
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
                    super::batch_operational_error(
                        "notarium.mcp.confirmed-delete-note.v1",
                        error,
                        true,
                    )
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
                .map_err(|error| super::batch_operational_error(LABEL, error, true))
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
                    super::batch_operational_error(
                        "notarium.mcp.confirmed-rename-note.v1",
                        error,
                        true,
                    )
                })
        }
    }
}

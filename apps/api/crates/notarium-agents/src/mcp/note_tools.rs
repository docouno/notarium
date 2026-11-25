use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, NoteId, RevisionId},
    model::{FolderRef, HistoryScope, Lifecycle, NoteRef},
    ports::{
        Committed, DeleteDisposition, DeleteNote, EnsureFolderPath, FolderSnapshot, GetNote,
        MoveNote, Mutation, NoteMetadataSnapshot, NoteRevision, NoteSnapshot, Preconditions,
        RenameNote, SpaceContext,
    },
    receipt::{CausalBasis, CommandIdentity, ReceiptSet},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    EgressTarget, ToolCallContext, ToolName, corpus, decode, derive_key, invalid, session,
};

mod create;
mod edit;
mod proposal;

pub(super) use create::{batch_operational_error, post_commit_error};
pub(super) use proposal::{
    PreparedNoteAction, apply_proposal, describe_proposal, plan_proposal, preview_proposal,
};

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(in crate::mcp) struct NoteRoute {
    pub(super) scope: HistoryScope,
    pub(super) note: NoteId,
    pub(super) revision: RevisionId,
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    tool: ToolName,
    arguments: Value,
) -> Result<Value, PortError> {
    match tool {
        ToolName::CreateNote => create::create_one(call, arguments).await,
        ToolName::CreateNotes => create::create_many(call, arguments).await,
        ToolName::EditNote => edit::edit_note(call, arguments).await,
        ToolName::DeleteNote => delete(call, decode(arguments)?).await,
        ToolName::MoveNote => move_note(call, decode(arguments)?).await,
        ToolName::RenameNote => rename(call, decode(arguments)?).await,
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

#[derive(Deserialize)]
struct NoteInput {
    #[serde(rename = "ref")]
    note: NoteId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveInput {
    #[serde(flatten)]
    target: NoteInput,
    to_folder: String,
}

#[derive(Deserialize)]
struct RenameInput {
    #[serde(flatten)]
    target: NoteInput,
    title: String,
}

/// Resolve a fresh mutation target using live facts. Proposals can reuse this
/// with a separately attested human scope, without creating an invocation journal.
pub(super) async fn observe_note(
    call: &ToolCallContext<'_>,
    note: &NoteId,
    expected: Option<&RevisionId>,
) -> Result<NoteRoute, PortError> {
    let (scope, catalog) = corpus::locate_note_preflight(call, note).await?;
    corpus::admit_note_write(call, &scope, &catalog).await?;
    authorize_note_write(&scope, &catalog.facts)?;
    let current = metadata_snapshot(
        call,
        &scope,
        note,
        None,
        CausalBasis::Await(Default::default()),
    )
    .await?;
    if current.metadata.lifecycle() != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let revision = current.metadata.revision().clone();
    if expected.is_some_and(|expected| expected != &revision) {
        return Err(DomainError::RevisionConflict {
            current: revision,
            lineage: None,
        }
        .into());
    }
    Ok(NoteRoute {
        scope: scope.scope().clone(),
        note: note.clone(),
        revision,
    })
}

fn authorize_note_write(scope: &SpaceContext, facts: &ResourceFacts) -> Result<(), PortError> {
    scope.auth().authorize_direct_write(facts, facts)?;
    // Package writes need package validation and the control-side binding.
    if facts.ability_package.is_some() {
        return Err(DomainError::AbilityWriteForbidden.into());
    }
    Ok(())
}

async fn route(
    call: &ToolCallContext<'_>,
    note: &NoteId,
    expected: Option<&RevisionId>,
) -> Result<NoteRoute, PortError> {
    route_inner(call, note, expected, false).await
}

async fn route_for_delete(
    call: &ToolCallContext<'_>,
    note: &NoteId,
) -> Result<NoteRoute, PortError> {
    route_inner(call, note, None, true).await
}

async fn route_inner(
    call: &ToolCallContext<'_>,
    note: &NoteId,
    expected: Option<&RevisionId>,
    allow_trashed_replay: bool,
) -> Result<NoteRoute, PortError> {
    let route: NoteRoute = call
        .journal("note_route", || observe_note(call, note, expected))
        .await?;
    if &route.note != note || expected.is_some_and(|revision| revision != &route.revision) {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if matches!(call.target, EgressTarget::InAppProvider { .. }) {
        if call
            .auth
            .pinned_write_space()
            .is_some_and(|pin| pin != &route.scope.space_id)
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let scope = call.space(route.scope.clone())?;
        match corpus::note_in_space(call, &scope, &route.note).await {
            Ok(catalog) => corpus::admit_note_write(call, &scope, &catalog).await?,
            Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_replay => {
                let observed = metadata_snapshot(
                    call,
                    &scope,
                    &route.note,
                    None,
                    CausalBasis::Await(Default::default()),
                )
                .await?;
                if observed.metadata.lifecycle() != Lifecycle::Trashed {
                    return Err(DomainError::ResourceNotFound.into());
                }
                corpus::admit_note_metadata_write(call, &scope, &observed.metadata).await?;
            }
            Err(error) => return Err(error),
        }
    }
    Ok(route)
}

async fn snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
    revision: Option<RevisionId>,
    causal: CausalBasis,
) -> Result<NoteSnapshot, PortError> {
    let read = call
        .registry
        .engine
        .get_note(
            scope.clone(),
            GetNote {
                note: note.clone(),
                revision: revision.clone(),
                causal,
            },
        )
        .await?;
    let reference = NoteRef {
        space_id: scope.scope().space_id.clone(),
        note_id: note.clone(),
    };
    if read.document.reference() != &reference
        || revision
            .as_ref()
            .is_some_and(|revision| revision != read.document.revision())
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if read.document.class() == DocClass::EncryptedNote {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(read)
}

async fn metadata_snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    note: &NoteId,
    revision: Option<RevisionId>,
    causal: CausalBasis,
) -> Result<NoteMetadataSnapshot, PortError> {
    let read = call
        .registry
        .engine
        .get_note_metadata(
            scope.clone(),
            GetNote {
                note: note.clone(),
                revision: revision.clone(),
                causal,
            },
        )
        .await?;
    let reference = NoteRef {
        space_id: scope.scope().space_id.clone(),
        note_id: note.clone(),
    };
    if read.metadata.reference() != &reference
        || revision
            .as_ref()
            .is_some_and(|revision| revision != read.metadata.revision())
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    if read.metadata.class() == DocClass::EncryptedNote {
        return Err(DomainError::ResourceNotFound.into());
    }
    Ok(read)
}

async fn route_metadata_snapshot(
    call: &ToolCallContext<'_>,
    route: &NoteRoute,
) -> Result<(SpaceContext, NoteMetadataSnapshot), PortError> {
    let scope = call.space(route.scope.clone())?;
    let observed = metadata_snapshot(
        call,
        &scope,
        &route.note,
        Some(route.revision.clone()),
        CausalBasis::Await(Default::default()),
    )
    .await?;
    Ok((scope, observed))
}

async fn route_snapshot(
    call: &ToolCallContext<'_>,
    route: &NoteRoute,
) -> Result<(SpaceContext, NoteSnapshot), PortError> {
    let scope = call.space(route.scope.clone())?;
    let observed = snapshot(
        call,
        &scope,
        &route.note,
        Some(route.revision.clone()),
        CausalBasis::Await(Default::default()),
    )
    .await?;
    Ok((scope, observed))
}

fn preconditions(route: &NoteRoute) -> Preconditions {
    Preconditions {
        revision: Some(route.revision.clone()),
        ..Preconditions::default()
    }
}

async fn delete(call: &mut ToolCallContext<'_>, input: NoteInput) -> Result<Value, PortError> {
    let route = route_for_delete(call, &input.note).await?;
    let scope = call.space(route.scope.clone())?;
    let command = Mutation {
        identity: call.command_identity(&route.scope, "trash_note", 0),
        preconditions: preconditions(&route),
        input: DeleteNote {
            note: route.note.clone(),
            disposition: DeleteDisposition::Trash,
        },
    };
    let committed = call
        .registry
        .engine
        .delete_note(call.corpus_writer(scope.clone()).await?, command)
        .await?;
    receipt_result(call, scope, &route.note, committed, "trashed")
        .await
        .map_err(|error| batch_operational_error("notarium.mcp.delete-note.v1", error, true))
}

/// Validate a path without making folders. The empty path names the base.
pub(super) fn clean_path(input: &str) -> Result<String, PortError> {
    let path = input.trim_matches('/');
    if !path.is_empty() {
        for component in path.split('/') {
            notarium_syntax::unicode::validate_component(component)?;
        }
    }
    Ok(path.to_owned())
}

fn separator_after(text: &str, eol: &str) -> &'static str {
    if text.is_empty() {
        return "";
    }
    let start = text.trim_end_matches(['\r', '\n']).len();
    let endings = text[start..]
        .bytes()
        .filter(|&byte| byte == b'\n')
        .take(2)
        .count();
    match endings {
        2 => "",
        1 if eol == "\r\n" => "\r\n",
        1 => "\n",
        0 if eol == "\r\n" => "\r\n\r\n",
        _ => "\n\n",
    }
}

async fn folder_base(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    folder: &FolderId,
) -> Result<FolderSnapshot, PortError> {
    let snapshot = call
        .registry
        .engine
        .resolve_folder_path(scope.clone(), Some(folder.clone()), String::new())
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    scope.scope().check(&snapshot.history)?;
    if snapshot.reference.space_id != scope.scope().space_id
        || &snapshot.reference.folder_id != folder
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(snapshot)
}

async fn admit_destination_anchor(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: &Option<FolderId>,
    path: &str,
    class: DocClass,
) -> Result<(), PortError> {
    if matches!(call.target, EgressTarget::ExternalMcp) {
        return Ok(());
    }
    let anchor = if let Some(exact) = call
        .registry
        .engine
        .resolve_folder_path(scope.clone(), base.clone(), path.to_owned())
        .await?
    {
        exact
    } else if base.is_none()
        && let Some(first) = path.split('/').next().filter(|seg| !seg.is_empty())
        && let Some(top) = call
            .registry
            .engine
            .resolve_folder_path(scope.clone(), None, first.to_owned())
            .await?
    {
        top
    } else {
        call.registry
            .engine
            .resolve_folder_path(scope.clone(), base.clone(), String::new())
            .await?
            .ok_or(DomainError::ResourceNotFound)?
    };
    let project = anchor.project.clone().map(|folder_id| FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id,
    });
    corpus::admit_folder_write(
        call,
        scope,
        &anchor.reference,
        project,
        &anchor.ancestor_folders,
        class,
    )
    .await
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum JournaledDestination {
    Detailed { folder: FolderRef, created: bool },
    Legacy(FolderRef),
}

impl JournaledDestination {
    fn into_parts(self, has_path: bool) -> (FolderRef, bool) {
        match self {
            Self::Detailed { folder, created } => (folder, created),
            Self::Legacy(folder) => (folder, has_path),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn ensure_destination(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: Option<FolderId>,
    path: String,
    class: DocClass,
    content_command: &CommandIdentity,
    label: &str,
    expected_source: Option<&NoteRoute>,
) -> Result<(FolderRef, bool), PortError> {
    admit_destination_anchor(call, scope, &base, &path, class).await?;
    const ERR_LABEL: &str = "notarium.mcp.folder-destination.v1";
    let has_path = !path.is_empty();
    let ensured: JournaledDestination = if let Some(hit) = call
        .lookup_journal_with_key::<JournaledDestination>(
            label,
            &content_command.key,
            content_command.hash,
        )
        .await?
    {
        hit
    } else {
        // Persist the pre-existence check before calling `ensure_folder_path`
        // so a dedup failure after folder creation cannot lose `created: true`
        // on retry or falsely report `NotCommitted`.
        let existed_label = format!("{label}_existed");
        let existed: bool = call
            .journal_with_key(
                &existed_label,
                &content_command.key,
                content_command.hash,
                || async {
                    if let Some(route) = expected_source {
                        let live = metadata_snapshot(
                            call,
                            scope,
                            &route.note,
                            None,
                            CausalBasis::Await(Default::default()),
                        )
                        .await?;
                        if live.metadata.lifecycle() != Lifecycle::Active {
                            return Err(DomainError::ResourceNotFound.into());
                        }
                        if live.metadata.revision() != &route.revision {
                            return Err(DomainError::RevisionConflict {
                                current: live.metadata.revision().clone(),
                                lineage: None,
                            }
                            .into());
                        }
                    }
                    Ok(!has_path
                        || call
                            .registry
                            .engine
                            .resolve_folder_path(scope.clone(), base.clone(), path.clone())
                            .await?
                            .is_some())
                },
            )
            .await?;
        let folder = call
            .registry
            .engine
            .ensure_folder_path(
                call.corpus_writer(scope.clone()).await?,
                Mutation {
                    identity: CommandIdentity {
                        scope: content_command.scope.clone(),
                        actor: content_command.actor.clone(),
                        key: derive_key(
                            "notarium.mcp.folder-destination.v1",
                            &[content_command.key.as_str().as_bytes(), label.as_bytes()],
                        ),
                        hash: content_command.hash,
                    },
                    preconditions: Preconditions::default(),
                    input: EnsureFolderPath { base, path },
                },
            )
            .await?;
        let plan = JournaledDestination::Detailed {
            folder,
            created: !existed,
        };
        call.record_journal_with_key(label, &content_command.key, content_command.hash, &plan)
            .await
            .map_err(|error| {
                if !existed {
                    post_commit_error(ERR_LABEL, error)
                } else {
                    batch_operational_error(ERR_LABEL, error, false)
                }
            })?
    };
    let (destination, created) = ensured.into_parts(has_path);
    if destination.space_id != scope.scope().space_id {
        let mismatch = invalid(ValidationReason::ScopeMismatch);
        return Err(if created {
            post_commit_error(ERR_LABEL, mismatch)
        } else {
            mismatch
        });
    }
    let live = call
        .registry
        .catalog
        .folder(call.account(), destination.clone())
        .await
        .map_err(|error| {
            if created {
                post_commit_error(ERR_LABEL, error)
            } else {
                batch_operational_error(ERR_LABEL, error, false)
            }
        })?;
    if live.reference != destination
        || live.space.id != destination.space_id
        || live.lifecycle != Lifecycle::Active
    {
        let not_found: PortError = DomainError::ResourceNotFound.into();
        return Err(if created {
            post_commit_error(ERR_LABEL, not_found)
        } else {
            not_found
        });
    }
    scope
        .auth()
        .can_view_folder(&live.space, &destination.folder_id, &live.ancestor_folders)
        .map_err(|error| {
            let err: PortError = error.into();
            if created {
                post_commit_error(ERR_LABEL, err)
            } else {
                err
            }
        })?;
    if matches!(call.target, EgressTarget::InAppProvider { .. }) {
        let resolved = folder_base(call, scope, &destination.folder_id)
            .await
            .map_err(|error| {
                if created {
                    post_commit_error(ERR_LABEL, error)
                } else {
                    batch_operational_error(ERR_LABEL, error, false)
                }
            })?;
        let project = resolved.project.map(|folder_id| FolderRef {
            space_id: destination.space_id.clone(),
            folder_id,
        });
        corpus::admit_folder_write(
            call,
            scope,
            &destination,
            project,
            &live.ancestor_folders,
            class,
        )
        .await
        .map_err(|error| {
            if created {
                post_commit_error(ERR_LABEL, error)
            } else {
                batch_operational_error(ERR_LABEL, error, false)
            }
        })?;
    }
    Ok((destination, created))
}

async fn move_note(call: &mut ToolCallContext<'_>, input: MoveInput) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.move-note.v1";
    let folder = clean_path(&input.to_folder)?;
    let route = route(call, &input.target.note, None).await?;
    let (scope, before) = route_metadata_snapshot(call, &route).await?;
    let slug = note_slug(before.provenance.as_ref())?;
    let class = before.metadata.class();
    let base = scope
        .auth()
        .spaces()
        .get(&route.scope.space_id)
        .and_then(|grant| grant.project_root.clone());
    let path = if let Some(base) = &base {
        let root = folder_base(call, &scope, base).await?;
        corpus::strip_folder_prefix(&folder, &root.path).ok_or(DomainError::SpaceReadOnly)?
    } else {
        folder
    };
    let identity = call.command_identity(&route.scope, "move_note", 0);
    let (parent, created_folder) = ensure_destination(
        call,
        &scope,
        base,
        path,
        class,
        &identity,
        "move_destination",
        Some(&route),
    )
    .await?;
    let writer = call
        .corpus_writer(scope.clone())
        .await
        .map_err(|error| batch_operational_error(LABEL, error, created_folder))?;
    let committed = call
        .registry
        .engine
        .move_note(
            writer,
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
        .map_err(|error| batch_operational_error(LABEL, error, created_folder))?;
    receipt_result(call, scope, &route.note, committed, "moved")
        .await
        .map_err(|error| batch_operational_error(LABEL, error, true))
}

fn note_slug(
    provenance: Option<&notarium_core::ports::NoteProvenance>,
) -> Result<String, PortError> {
    let provenance = provenance.ok_or_else(|| invalid(ValidationReason::NotReady))?;
    let basename = provenance
        .path
        .rsplit('/')
        .next()
        .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
    let slug = basename
        .strip_suffix(".md")
        .ok_or_else(|| invalid(ValidationReason::SourceMismatch))?;
    notarium_syntax::unicode::validate_component(slug)?;
    Ok(slug.to_owned())
}

pub(super) fn validated_title(value: &str) -> Result<String, PortError> {
    let title = value.trim();
    if title.is_empty() || title.chars().any(char::is_control) {
        return Err(invalid(ValidationReason::InvalidQuery));
    }
    Ok(title.to_owned())
}

fn generated_slug(title: &str, note: &NoteId) -> String {
    let mut output = String::new();
    let mut separator = false;
    for ch in notarium_syntax::unicode::lookup_key(title).chars() {
        if ch.is_alphanumeric() || ch == '_' {
            if separator && !output.is_empty() {
                output.push('-');
            }
            output.push(ch);
            separator = false;
        } else {
            separator = true;
        }
    }
    if notarium_syntax::unicode::validate_component(&output).is_err() {
        note.as_str().to_owned()
    } else {
        output
    }
}

async fn rename(call: &mut ToolCallContext<'_>, input: RenameInput) -> Result<Value, PortError> {
    let title = validated_title(&input.title)?;
    let route = route(call, &input.target.note, None).await?;
    let (scope, before) = route_metadata_snapshot(call, &route).await?;
    let metadata = before
        .provenance
        .as_ref()
        .ok_or_else(|| invalid(ValidationReason::NotReady))?;
    let slug = if metadata.folder_page {
        "index".to_owned()
    } else {
        generated_slug(&title, &route.note)
    };
    if !metadata.folder_page && notarium_syntax::unicode::lookup_key(&slug) == "index" {
        return Err(invalid(ValidationReason::InvalidPathComponent));
    }
    let committed = call
        .registry
        .engine
        .rename_note(
            call.corpus_writer(scope.clone()).await?,
            Mutation {
                identity: call.command_identity(&route.scope, "rename_note", 0),
                preconditions: preconditions(&route),
                input: RenameNote {
                    note: route.note.clone(),
                    slug,
                    title: Some(title),
                },
            },
        )
        .await?;
    receipt_result(call, scope, &route.note, committed, "renamed")
        .await
        .map_err(|error| batch_operational_error("notarium.mcp.rename-note.v1", error, true))
}

async fn receipt_result(
    call: &mut ToolCallContext<'_>,
    scope: SpaceContext,
    note: &NoteId,
    committed: Committed<NoteRevision>,
    outcome: &'static str,
) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.note-receipt.v1";
    scope
        .scope()
        .check(committed.receipt.scope())
        .map_err(|error| post_commit_error(LABEL, error.into()))?;
    if &committed.value.note != note {
        return Err(post_commit_error(
            LABEL,
            invalid(ValidationReason::SourceMismatch),
        ));
    }
    if matches!(call.target, EgressTarget::InAppProvider { .. }) {
        if outcome == "trashed" {
            return Ok(json!({ "outcome": outcome }));
        }
        let read = async {
            let observed = metadata_snapshot(
                call,
                &scope,
                note,
                Some(committed.value.revision.clone()),
                CausalBasis::Exact(ReceiptSet::new([committed.receipt])?),
            )
            .await?;
            corpus::note_metadata(call, &scope, &observed.metadata).await
        }
        .await;
        if let Err(error) = read {
            tracing::debug!(code = error.code(), "note receipt metadata unavailable");
            return Ok(json!({ "outcome": outcome }));
        }
    }
    Ok(json!({
        "noteId": committed.value.note,
        "versionToken": committed.value.revision,
        "outcome": outcome,
    }))
}

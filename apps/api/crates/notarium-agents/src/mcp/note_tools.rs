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
    PreparedNoteAction, apply_proposal, describe_proposal, plan_proposal, preflight_proposal,
    preview_proposal, validate_proposal_input,
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
        ToolName::CreateNote => Box::pin(create::create_one(call, arguments)).await,
        ToolName::CreateNotes => Box::pin(create::create_many(call, arguments)).await,
        ToolName::EditNote => Box::pin(edit::edit_note(call, arguments)).await,
        ToolName::DeleteNote => Box::pin(delete(call, decode(arguments)?)).await,
        ToolName::MoveNote => Box::pin(move_note(call, decode(arguments)?)).await,
        ToolName::RenameNote => Box::pin(rename(call, decode(arguments)?)).await,
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
    let (scope, catalog) = if let Some(pin) = call.auth.pinned_write_space() {
        let scope = session::space(call, pin).await?;
        let catalog = corpus::note_in_space_preflight(call, &scope, note).await?;
        (scope, catalog)
    } else {
        corpus::locate_note_preflight(call, note).await?
    };
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
    if matches!(call.target, EgressTarget::InAppProvider { .. })
        && call.tool != ToolName::DeleteNote
    {
        corpus::note_metadata(call, &scope, &current.metadata).await?;
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

pub(in crate::mcp) fn authorize_note_write(
    scope: &SpaceContext,
    facts: &ResourceFacts,
) -> Result<(), PortError> {
    scope.auth().authorize_direct_write(facts, facts)?;
    // Package writes need package validation and the control-side binding.
    if facts.ability_package.is_some() {
        return Err(DomainError::AbilityWriteForbidden.into());
    }
    Ok(())
}

pub(in crate::mcp) fn authorize_metadata_note_write(
    scope: &SpaceContext,
    metadata: &notarium_core::classes::ClassifiedMetadata,
) -> Result<(), PortError> {
    metadata.authorize_current_write(scope.auth())?;
    if metadata.current_has_ability_package() {
        return Err(DomainError::AbilityWriteForbidden.into());
    }
    Ok(())
}

async fn route(
    call: &ToolCallContext<'_>,
    note: &NoteId,
    expected: Option<&RevisionId>,
) -> Result<(NoteRoute, bool), PortError> {
    route_inner(call, note, expected).await
}

async fn route_for_delete(
    call: &ToolCallContext<'_>,
    note: &NoteId,
) -> Result<NoteRoute, PortError> {
    route_inner(call, note, None).await.map(|(route, _)| route)
}

async fn route_inner(
    call: &ToolCallContext<'_>,
    note: &NoteId,
    expected: Option<&RevisionId>,
) -> Result<(NoteRoute, bool), PortError> {
    let mut replayed = true;
    let route: NoteRoute = call
        .journal("note_route", || async {
            replayed = false;
            observe_note(call, note, expected).await
        })
        .await?;
    if &route.note != note || expected.is_some_and(|revision| revision != &route.revision) {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let mut trashed_replay = false;
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
            Ok(catalog) => {
                corpus::admit_note_write(call, &scope, &catalog).await?;
                authorize_note_write(&scope, &catalog.facts)?;
            }
            Err(PortError::Domain(DomainError::ResourceNotFound)) if replayed => {
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
                authorize_metadata_note_write(&scope, &observed.metadata)?;
                trashed_replay = true;
            }
            Err(error) => return Err(error),
        }
    } else if replayed {
        let scope = call.space(route.scope.clone())?;
        match corpus::note_in_space(call, &scope, &route.note).await {
            Ok(catalog) => {
                authorize_note_write(&scope, &catalog.facts)?;
            }
            Err(PortError::Domain(DomainError::ResourceNotFound)) => {
                let observed = metadata_snapshot(
                    call,
                    &scope,
                    &route.note,
                    None,
                    CausalBasis::Await(Default::default()),
                )
                .await?;
                authorize_metadata_note_write(&scope, &observed.metadata)?;
                if observed.metadata.lifecycle() == Lifecycle::Trashed {
                    trashed_replay = true;
                }
            }
            Err(error) => return Err(error),
        }
    }
    Ok((route, trashed_replay))
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
    if matches!(call.target, EgressTarget::InAppProvider { .. })
        && let Ok(observed) = metadata_snapshot(
            call,
            &scope,
            &route.note,
            None,
            CausalBasis::Await(Default::default()),
        )
        .await
        && let Some(parent_id) = observed.parent
    {
        let parent_ref = FolderRef {
            space_id: scope.scope().space_id.clone(),
            folder_id: parent_id,
        };
        let project = observed.metadata.current_project();
        if let Err(error) = corpus::record_folder_origin(call, &scope, &parent_ref, project).await
            && !corpus::hidden(&error)
        {
            return Err(error);
        }
    }
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
        let mut depth = 0usize;
        for component in path.split('/') {
            depth += 1;
            if depth > 256 {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum DestinationPrecheck {
    WithStrip {
        existed: bool,
        stripped_segments: u16,
    },
    Legacy(bool),
}

impl DestinationPrecheck {
    fn existed(self) -> bool {
        match self {
            Self::WithStrip { existed, .. } | Self::Legacy(existed) => existed,
        }
    }

    fn stored_stripped_segments(self) -> Option<u16> {
        match self {
            Self::WithStrip {
                stripped_segments, ..
            } => Some(stripped_segments),
            Self::Legacy(_) => None,
        }
    }
}

enum DestinationPrefix<'a> {
    None,
    OptionalProjectPath(&'a str),
    RequiredProjectRoot,
}

async fn resolve_stripped_segments(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: &Option<FolderId>,
    raw_path: &str,
    prefix: &DestinationPrefix<'_>,
    allow_trashed_root: bool,
) -> Result<u16, PortError> {
    match prefix {
        DestinationPrefix::None => Ok(0),
        DestinationPrefix::OptionalProjectPath(project_path) => {
            if !project_path.is_empty()
                && corpus::strip_folder_prefix(raw_path, project_path).is_some()
            {
                segment_count(project_path)
            } else if allow_trashed_root
                && let Some(base_id) = base.as_ref()
                && let Some(first_seg) = raw_path
                    .trim_matches('/')
                    .split('/')
                    .next()
                    .filter(|seg| !seg.is_empty())
            {
                // Legacy pre-`WithStrip` replay after project rename: check whether
                // the leading segment resolves via `folder_aliases` to `base_id`.
                match call
                    .registry
                    .catalog
                    .project_by_slug(scope.with_preflight_taint(), first_seg.to_owned())
                    .await
                {
                    Ok(found) if &found.folder.folder_id == base_id => Ok(1),
                    Ok(_) | Err(PortError::Domain(DomainError::ResourceNotFound)) => Ok(0),
                    Err(error) => Err(error),
                }
            } else {
                Ok(0)
            }
        }
        DestinationPrefix::RequiredProjectRoot => {
            let root_id = base
                .as_ref()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let root = match folder_base(call, scope, root_id).await {
                Ok(root) => root,
                Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_root => {
                    let root_ref = FolderRef {
                        space_id: scope.scope().space_id.clone(),
                        folder_id: root_id.clone(),
                    };
                    let trashed_account = notarium_core::ports::AccountContext::new(
                        scope.auth().with_preflight_taint(),
                        call.budget(),
                    );
                    match call
                        .registry
                        .catalog
                        .trashed_folder_ancestry(trashed_account, root_ref)
                        .await
                    {
                        Ok(trashed) => {
                            // `ancestors` includes `root_id` through the Space root; the path
                            // depth omits the Space root itself (at least 1 segment for a project).
                            let depth = trashed.ancestors.len().saturating_sub(1).max(1);
                            if let Ok(count) = u16::try_from(depth)
                                && usize::from(count) <= usize::from(segment_count(raw_path)?)
                            {
                                return Ok(count);
                            }
                            return Ok(0);
                        }
                        Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(0),
                        Err(error) => return Err(error),
                    }
                }
                Err(error) => return Err(error),
            };
            if corpus::strip_folder_prefix(raw_path, &root.path).is_none() {
                if allow_trashed_root {
                    let count = segment_count(&root.path)?;
                    if count <= segment_count(raw_path)? {
                        return Ok(count);
                    }
                    return Ok(0);
                }
                return Err(DomainError::SpaceReadOnly.into());
            }
            segment_count(&root.path)
        }
    }
}

fn segment_count(path: &str) -> Result<u16, PortError> {
    u16::try_from(path.split('/').filter(|seg| !seg.is_empty()).count())
        .map_err(|_| invalid(ValidationReason::InvalidPathComponent))
}

fn strip_leading_segments(path: &str, count: u16) -> Result<String, PortError> {
    if count == 0 {
        return Ok(path.to_owned());
    }
    let segments: Vec<&str> = path.split('/').filter(|seg| !seg.is_empty()).collect();
    let skip = usize::from(count);
    if segments.len() < skip {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(segments[skip..].join("/"))
}

async fn admit_destination_anchor_for_replay(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: &Option<FolderId>,
    path: &str,
    class: DocClass,
    allow_trashed_base: bool,
) -> Result<(), PortError> {
    match admit_destination_anchor(call, scope, base, path, class).await {
        Ok(()) => Ok(()),
        Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_base => {
            if matches!(call.target, EgressTarget::ExternalMcp) {
                return Ok(());
            }
            let Some(base_id) = base else {
                return Err(DomainError::ResourceNotFound.into());
            };
            let base_ref = FolderRef {
                space_id: scope.scope().space_id.clone(),
                folder_id: base_id.clone(),
            };
            let trashed_account = notarium_core::ports::AccountContext::new(
                scope.auth().with_preflight_taint(),
                call.budget(),
            );
            let trashed = call
                .registry
                .catalog
                .trashed_folder_ancestry(trashed_account, base_ref.clone())
                .await?;
            if trashed.reference != base_ref {
                return Err(DomainError::ResourceNotFound.into());
            }
            let project = trashed.project.map(|folder_id| FolderRef {
                space_id: scope.scope().space_id.clone(),
                folder_id,
            });
            corpus::admit_folder_write(call, scope, &base_ref, project, &trashed.ancestors, class)
                .await
        }
        Err(error) => Err(error),
    }
}

#[allow(clippy::too_many_arguments)]
async fn validate_destination(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    class: DocClass,
    ensured: JournaledDestination,
    has_path: bool,
    allow_trashed_replay: bool,
) -> Result<(FolderRef, bool), PortError> {
    const ERR_LABEL: &str = "notarium.mcp.folder-destination.v1";
    let (destination, created) = ensured.into_parts(has_path);
    if destination.space_id != scope.scope().space_id {
        let mismatch = invalid(ValidationReason::ScopeMismatch);
        return Err(if created {
            post_commit_error(ERR_LABEL, mismatch)
        } else {
            mismatch
        });
    }
    let map_err = |error: PortError| {
        if created {
            post_commit_error(ERR_LABEL, error)
        } else {
            batch_operational_error(ERR_LABEL, error, false)
        }
    };
    let map_replay_err = |error: PortError| {
        if allow_trashed_replay
            && matches!(error, PortError::Domain(_))
            && !matches!(error, PortError::Domain(DomainError::RateLimited { .. }))
        {
            error
        } else {
            map_err(error)
        }
    };
    let live_opt = match call
        .registry
        .catalog
        .folder(call.account(), destination.clone())
        .await
    {
        Ok(live) => Some(live),
        Err(PortError::Domain(DomainError::ResourceNotFound)) if allow_trashed_replay => None,
        Err(error) => return Err(map_replay_err(error)),
    };
    if let Some(live) = live_opt {
        let lifecycle_hidden = if allow_trashed_replay {
            live.lifecycle == Lifecycle::Purged
        } else {
            live.lifecycle != Lifecycle::Active
        };
        if live.reference != destination
            || live.space.id != destination.space_id
            || lifecycle_hidden
        {
            let not_found: PortError = DomainError::ResourceNotFound.into();
            return Err(map_replay_err(not_found));
        }
        scope
            .auth()
            .can_view_folder(&live.space, &destination.folder_id, &live.ancestor_folders)
            .map_err(|error| map_replay_err(error.into()))?;
        if matches!(call.target, EgressTarget::InAppProvider { .. }) {
            let resolved = folder_base(call, scope, &destination.folder_id)
                .await
                .map_err(map_replay_err)?;
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
            .map_err(map_replay_err)?;
        }
        return Ok((destination, created));
    }
    let trashed_account = notarium_core::ports::AccountContext::new(
        scope.auth().with_preflight_taint(),
        call.budget(),
    );
    let trashed = call
        .registry
        .catalog
        .trashed_folder_ancestry(trashed_account, destination.clone())
        .await
        .map_err(map_replay_err)?;
    if trashed.reference != destination {
        return Err(DomainError::ResourceNotFound.into());
    }
    if matches!(call.target, EgressTarget::InAppProvider { .. }) {
        let project = trashed.project.map(|folder_id| FolderRef {
            space_id: destination.space_id.clone(),
            folder_id,
        });
        corpus::admit_folder_write(
            call,
            scope,
            &destination,
            project,
            &trashed.ancestors,
            class,
        )
        .await
        .map_err(map_replay_err)?;
    }
    Ok((destination, created))
}

#[allow(clippy::too_many_arguments)]
async fn ensure_destination(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: Option<FolderId>,
    raw_path: String,
    prefix: DestinationPrefix<'_>,
    class: DocClass,
    content_command: &CommandIdentity,
    label: &str,
    expected_source: Option<&NoteRoute>,
) -> Result<(FolderRef, bool), PortError> {
    const ERR_LABEL: &str = "notarium.mcp.folder-destination.v1";
    let (ensured, has_path, allow_trashed_replay): (JournaledDestination, bool, bool) =
        if let Some(hit) = call
            .lookup_journal_with_key::<JournaledDestination>(
                label,
                &content_command.key,
                content_command.hash,
            )
            .await?
        {
            (hit, !raw_path.is_empty(), true)
        } else {
            // Persist both the pre-existence check and the leading-segment
            // strip count before calling `ensure_folder_path` so a dedup
            // failure after folder creation survives project renames/trash
            // without storing user folder names in `control.mcp_dedup` or
            // losing `created: true` on retry.
            let existed_label = format!("{label}_existed");
            let mut existed_replayed = true;
            let precheck: DestinationPrecheck = call
                .journal_with_key(
                    &existed_label,
                    &content_command.key,
                    content_command.hash,
                    || async {
                        existed_replayed = false;
                        let stripped_segments = resolve_stripped_segments(
                            call, scope, &base, &raw_path, &prefix, false,
                        )
                        .await?;
                        let path = strip_leading_segments(&raw_path, stripped_segments)?;
                        admit_destination_anchor(call, scope, &base, &path, class).await?;
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
                        let existed = path.is_empty()
                            || call
                                .registry
                                .engine
                                .resolve_folder_path(scope.clone(), base.clone(), path)
                                .await?
                                .is_some();
                        Ok(DestinationPrecheck::WithStrip {
                            existed,
                            stripped_segments,
                        })
                    },
                )
                .await?;
            let existed = precheck.existed();
            let mut folder_created = !existed;
            let escalate_unknown = existed_replayed && !existed;
            let legacy_precheck = precheck.stored_stripped_segments().is_none();
            let stripped_segments = match precheck.stored_stripped_segments() {
                Some(count) => count,
                None => resolve_stripped_segments(call, scope, &base, &raw_path, &prefix, true)
                    .await
                    .map_err(|error| batch_operational_error(ERR_LABEL, error, escalate_unknown))?,
            };
            let mut path = strip_leading_segments(&raw_path, stripped_segments)?;
            if existed_replayed {
                admit_destination_anchor_for_replay(call, scope, &base, &path, class, true)
                    .await
                    .map_err(|error| batch_operational_error(ERR_LABEL, error, escalate_unknown))?;
            }
            let folder_key = derive_key(
                "notarium.mcp.folder-destination.v1",
                &[content_command.key.as_str().as_bytes(), label.as_bytes()],
            );
            let run_ensure = |candidate_path: String| {
                let base = base.clone();
                let folder_key = folder_key.clone();
                async move {
                    call.registry
                        .engine
                        .ensure_folder_path(
                            call.corpus_writer(scope.clone()).await?,
                            Mutation {
                                identity: CommandIdentity {
                                    scope: content_command.scope.clone(),
                                    actor: content_command.actor.clone(),
                                    key: folder_key,
                                    hash: content_command.hash,
                                },
                                preconditions: Preconditions::default(),
                                input: EnsureFolderPath {
                                    base,
                                    path: candidate_path,
                                },
                            },
                        )
                        .await
                }
            };
            let folder = match run_ensure(path.clone()).await {
                Ok(folder) => folder,
                Err(PortError::Domain(DomainError::IdempotencyKeyReused)) if legacy_precheck => {
                    // `IdempotencyKeyReused` proves `folder_key` already committed under some
                    // stripped path on attempt 1 before `DestinationPrecheck::WithStrip` existed.
                    // Because `folder_key` is already committed, probing other strip counts can
                    // only replay the exact committed hash and can never create new folders.
                    folder_created = true;
                    let max_strip = segment_count(&raw_path)?;
                    let mut recovered = None;
                    for candidate_strip in 0..=max_strip {
                        if candidate_strip == stripped_segments {
                            continue;
                        }
                        let candidate_path = strip_leading_segments(&raw_path, candidate_strip)?;
                        match run_ensure(candidate_path.clone()).await {
                            Ok(folder) => {
                                path = candidate_path;
                                recovered = Some(folder);
                                break;
                            }
                            Err(PortError::Domain(DomainError::IdempotencyKeyReused)) => continue,
                            Err(error) => {
                                return Err(batch_operational_error(ERR_LABEL, error, true));
                            }
                        }
                    }
                    recovered.ok_or(DomainError::IdempotencyKeyReused)?
                }
                Err(error) => {
                    return Err(batch_operational_error(ERR_LABEL, error, escalate_unknown));
                }
            };
            let has_path = !path.is_empty();
            let plan = JournaledDestination::Detailed {
                folder,
                created: folder_created,
            };
            let recorded = call
                .record_journal_with_key(label, &content_command.key, content_command.hash, &plan)
                .await
                .map_err(|error| {
                    if folder_created {
                        post_commit_error(ERR_LABEL, error)
                    } else {
                        batch_operational_error(ERR_LABEL, error, false)
                    }
                })?;
            (recorded, has_path, existed_replayed)
        };
    validate_destination(call, scope, class, ensured, has_path, allow_trashed_replay).await
}

async fn move_note(call: &mut ToolCallContext<'_>, input: MoveInput) -> Result<Value, PortError> {
    const LABEL: &str = "notarium.mcp.move-note.v1";
    let folder = clean_path(&input.to_folder)?;
    let (route, _) = route(call, &input.target.note, None).await?;
    let (scope, before) = route_metadata_snapshot(call, &route).await?;
    let slug = note_slug(before.provenance.as_ref())?;
    let class = before.metadata.class();
    let identity = call.command_identity(&route.scope, "move_note", 0);
    // Consult the journaled destination and precheck before stripping the live
    // project path prefix so a project-scoped replay survives project rename/trash.
    let (parent, created_folder) = if let Some(hit) = call
        .lookup_journal_with_key::<JournaledDestination>(
            "move_destination",
            &identity.key,
            identity.hash,
        )
        .await?
    {
        validate_destination(call, &scope, class, hit, !folder.is_empty(), true).await?
    } else {
        let base = scope
            .auth()
            .spaces()
            .get(&route.scope.space_id)
            .and_then(|grant| grant.project_root.clone());
        let prefix = if base.is_some() {
            DestinationPrefix::RequiredProjectRoot
        } else {
            DestinationPrefix::None
        };
        ensure_destination(
            call,
            &scope,
            base,
            folder,
            prefix,
            class,
            &identity,
            "move_destination",
            Some(&route),
        )
        .await?
    };
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
    let (route, _) = route(call, &input.target.note, None).await?;
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
            if corpus::hidden(&error) {
                tracing::debug!(code = error.code(), "note receipt metadata unavailable");
                return Ok(json!({ "outcome": outcome }));
            }
            return Err(post_commit_error(LABEL, error));
        }
    }
    Ok(json!({
        "noteId": committed.value.note,
        "versionToken": committed.value.revision,
        "outcome": outcome,
    }))
}

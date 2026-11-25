use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{EpisodeId, FolderId, RevisionId, SpaceSeq},
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        ChangeKind, ChangeRead, ChangeReadResult, EntityId, FolderSnapshot, MoveFolder, Mutation,
        PageLimit, Preconditions, RenameFolder, RenameProject, SpaceContext,
    },
    receipt::{ChangeCursor, MutationReceiptToken},
};
use notarium_syntax::unicode::validate_component;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{ToolCallContext, ToolName, corpus, decode, invalid, session};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    folder: String,
    to_folder: String,
    project: Option<String>,
    session: Option<EpisodeId>,
}

#[derive(Deserialize)]
struct RenameArgs {
    folder: String,
    name: String,
    project: Option<String>,
    session: Option<EpisodeId>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameProjectArgs {
    project: String,
    slug: String,
    display_name: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct FolderRoute {
    scope: HistoryScope,
    folder: FolderId,
    revision: RevisionId,
    operation: FolderOperation,
    #[serde(default)]
    ancestor_revisions: Vec<(FolderId, RevisionId)>,
}

#[derive(Deserialize, Serialize)]
enum FolderOperation {
    Unchanged,
    Move { parent: FolderId },
    Rename,
    RenameProject,
}

enum ParsedFolderArgs {
    Move(MoveArgs),
    Rename(RenameArgs),
    RenameProject(RenameProjectArgs),
}

fn parse_args(name: ToolName, args: Value) -> Result<ParsedFolderArgs, PortError> {
    match name {
        ToolName::MoveFolder => Ok(ParsedFolderArgs::Move(decode(args)?)),
        ToolName::RenameFolder => {
            let args: RenameArgs = decode(args)?;
            validate_component(&args.name)?;
            Ok(ParsedFolderArgs::Rename(args))
        }
        ToolName::RenameProject => {
            let args: RenameProjectArgs = decode(args)?;
            validate_component(&args.slug)?;
            if let Some(display_name) = &args.display_name
                && (display_name.trim().is_empty() || display_name.chars().any(char::is_control))
            {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
            Ok(ParsedFolderArgs::RenameProject(args))
        }
        _ => Err(DomainError::ResourceNotFound.into()),
    }
}

impl FolderRoute {
    fn new(
        source: FolderSnapshot,
        operation: FolderOperation,
        ancestor_revisions: Vec<(FolderId, RevisionId)>,
    ) -> Result<Self, PortError> {
        if source.parent.is_none() {
            return Err(invalid(ValidationReason::InvalidPathComponent));
        }
        Ok(Self {
            scope: source.history,
            folder: source.reference.folder_id,
            revision: source.revision,
            operation,
            ancestor_revisions,
        })
    }
}

async fn capture_ancestor_revisions(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    ancestors: &[FolderId],
    self_id: &FolderId,
    extra_parent: Option<&FolderSnapshot>,
) -> Result<Vec<(FolderId, RevisionId)>, PortError> {
    let mut revs = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    if let Some(parent) = extra_parent
        && parent.reference.folder_id != *self_id
        && seen.insert(parent.reference.folder_id.clone())
    {
        revs.push((parent.reference.folder_id.clone(), parent.revision.clone()));
    }
    for ancestor in ancestors {
        if ancestor == self_id || !seen.insert(ancestor.clone()) {
            continue;
        }
        let snap = snapshot_by_id(call, scope, ancestor).await?;
        revs.push((ancestor.clone(), snap.revision));
    }
    Ok(revs)
}

async fn ancestors_unchanged(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    current: &FolderSnapshot,
    expected: &[(FolderId, RevisionId)],
) -> Result<bool, PortError> {
    let live_ancestors: std::collections::BTreeSet<&FolderId> = current
        .ancestor_folders
        .iter()
        .filter(|id| *id != &current.reference.folder_id)
        .collect();
    if live_ancestors.len() != expected.len() {
        return Ok(false);
    }
    for (ancestor_id, expected_rev) in expected {
        if !live_ancestors.contains(ancestor_id) {
            return Ok(false);
        }
        match snapshot_by_id(call, scope, ancestor_id).await {
            Ok(snap) if &snap.revision == expected_rev => (),
            Ok(_) | Err(PortError::Domain(DomainError::ResourceNotFound)) => return Ok(false),
            Err(error) => return Err(error),
        }
    }
    Ok(true)
}

struct FolderAddress {
    scope: SpaceContext,
    project: Option<FolderSnapshot>,
}

impl FolderAddress {
    async fn open(
        call: &ToolCallContext<'_>,
        project: Option<&str>,
        episode: Option<&EpisodeId>,
    ) -> Result<Self, PortError> {
        let selected = session::selected_project(call, project, episode).await?;
        let space = match &selected {
            Some(project) => project.space_id.clone(),
            None => match call.auth.pinned_write_space() {
                Some(space) => space.clone(),
                None => call
                    .registry
                    .control
                    .whoami(call.account())
                    .await?
                    .personal_space
                    .ok_or(DomainError::ResourceNotFound)?,
            },
        };
        if call
            .auth
            .pinned_write_space()
            .is_some_and(|pin| pin != &space)
        {
            return Err(DomainError::SpaceReadOnly.into());
        }
        let scope = session::space(call, &space).await?;
        let grant = call
            .auth
            .spaces()
            .get(&space)
            .ok_or(DomainError::ResourceNotFound)?;
        if let (Some(binding), Some(pin)) = (&selected, &grant.project_root)
            && &binding.folder_id != pin
        {
            return Err(DomainError::ResourceNotFound.into());
        }
        let base = selected
            .map(|p| p.folder_id)
            .or_else(|| grant.project_root.clone());
        let project = match base {
            Some(id) => Some(snapshot_by_id(call, &scope, &id).await?),
            None => None,
        };
        Ok(Self { scope, project })
    }

    async fn resolve(
        &self,
        call: &ToolCallContext<'_>,
        path: &str,
    ) -> Result<FolderSnapshot, PortError> {
        let root_relative = path.starts_with('/');
        let path = path.trim_start_matches('/');
        let (base, relative) = match &self.project {
            Some(project) => {
                if let Some(suffix) = corpus::strip_folder_prefix(path, &project.path) {
                    (Some(project.reference.folder_id.clone()), suffix)
                } else if root_relative {
                    (None, path.to_owned())
                } else {
                    (Some(project.reference.folder_id.clone()), path.to_owned())
                }
            }
            None => (None, path.to_owned()),
        };
        resolve_snapshot(call, &self.scope, base, &relative).await
    }
}

async fn admit_folder_snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    folder: &FolderSnapshot,
) -> Result<(), PortError> {
    let project = folder.project.clone().map(|folder_id| FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id,
    });
    corpus::admit_folder_write(
        call,
        scope,
        &folder.reference,
        project,
        &folder.ancestor_folders,
        DocClass::UserDoc,
    )
    .await
}

async fn resolve_snapshot(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    base: Option<FolderId>,
    path: &str,
) -> Result<FolderSnapshot, PortError> {
    let resolved = call
        .registry
        .engine
        .resolve_folder_path(scope.with_preflight_taint(), base, path.to_owned())
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    scope.scope().check(&resolved.history)?;
    if resolved.reference.space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(resolved)
}

async fn snapshot_by_id(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    id: &FolderId,
) -> Result<FolderSnapshot, PortError> {
    let resolved = resolve_snapshot(call, scope, Some(id.clone()), "").await?;
    if resolved.reference.folder_id != *id {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(resolved)
}

async fn plan(
    call: &ToolCallContext<'_>,
    parsed: &ParsedFolderArgs,
) -> Result<FolderRoute, PortError> {
    match parsed {
        ParsedFolderArgs::Move(args) => {
            let address =
                FolderAddress::open(call, args.project.as_deref(), args.session.as_ref()).await?;
            let source = address.resolve(call, &args.folder).await?;
            admit_folder_snapshot(call, &address.scope, &source).await?;
            let dest = address.resolve(call, &args.to_folder).await?;
            admit_folder_snapshot(call, &address.scope, &dest).await?;
            let parent = dest.reference.folder_id.clone();
            let (operation, ancestor_revisions) = if source.parent.as_ref() == Some(&parent) {
                let revs = capture_ancestor_revisions(
                    call,
                    &address.scope,
                    &source.ancestor_folders,
                    &source.reference.folder_id,
                    None,
                )
                .await?;
                (FolderOperation::Unchanged, revs)
            } else {
                let revs = capture_ancestor_revisions(
                    call,
                    &address.scope,
                    &dest.ancestor_folders,
                    &source.reference.folder_id,
                    Some(&dest),
                )
                .await?;
                (FolderOperation::Move { parent }, revs)
            };
            FolderRoute::new(source, operation, ancestor_revisions)
        }
        ParsedFolderArgs::Rename(args) => {
            let address =
                FolderAddress::open(call, args.project.as_deref(), args.session.as_ref()).await?;
            let source = address.resolve(call, &args.folder).await?;
            admit_folder_snapshot(call, &address.scope, &source).await?;
            let ancestor_revisions = capture_ancestor_revisions(
                call,
                &address.scope,
                &source.ancestor_folders,
                &source.reference.folder_id,
                None,
            )
            .await?;
            let operation = if same_name(&source, &args.name, &args.name) {
                FolderOperation::Unchanged
            } else {
                FolderOperation::Rename
            };
            FolderRoute::new(source, operation, ancestor_revisions)
        }
        ParsedFolderArgs::RenameProject(args) => {
            let project = session::resolve_project(call, &args.project).await?;
            if call
                .auth
                .pinned_write_space()
                .is_some_and(|pin| pin != &project.folder.space_id)
            {
                return Err(DomainError::SpaceReadOnly.into());
            }
            let scope = session::space(call, &project.folder.space_id).await?;
            let source = snapshot_by_id(call, &scope, &project.folder.folder_id).await?;
            admit_folder_snapshot(call, &scope, &source).await?;
            let display_name = args.display_name.as_deref().unwrap_or(&source.name);
            if display_name.trim().is_empty() || display_name.chars().any(char::is_control) {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
            let ancestor_revisions = capture_ancestor_revisions(
                call,
                &scope,
                &source.ancestor_folders,
                &source.reference.folder_id,
                None,
            )
            .await?;
            let operation = if project.project_slug == args.slug
                && same_name(&source, &args.slug, display_name)
            {
                FolderOperation::Unchanged
            } else {
                FolderOperation::RenameProject
            };
            FolderRoute::new(source, operation, ancestor_revisions)
        }
    }
}

fn same_name(source: &FolderSnapshot, leaf: &str, display_name: &str) -> bool {
    source.path.rsplit('/').next() == Some(leaf) && source.name == display_name
}

async fn check_noop(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    source: &FolderSnapshot,
    expected: &RevisionId,
) -> Result<(), PortError> {
    let facts = call
        .registry
        .catalog
        .folder(call.account(), source.reference.clone())
        .await?;
    if facts.reference != source.reference || facts.lifecycle != Lifecycle::Active {
        return Err(DomainError::ResourceNotFound.into());
    }
    let grant = call
        .auth
        .spaces()
        .get(&scope.scope().space_id)
        .ok_or(DomainError::ResourceNotFound)?;
    let class = grant
        .write_classes
        .iter()
        .copied()
        .find(|class| !matches!(class, DocClass::AgentMemory | DocClass::Skill))
        .ok_or(DomainError::SpaceReadOnly)?;
    let resource = ResourceFacts {
        space: facts.space,
        class,
        project: None,
        ancestor_folders: facts.ancestor_folders,
        folder_write_locked: facts.write_locked,
        ability_package: None,
    };
    scope.auth().authorize_direct_write(&resource, &resource)?;
    if &source.revision != expected {
        return Err(DomainError::RevisionConflict {
            current: source.revision.clone(),
            lineage: None,
        }
        .into());
    }
    Ok(())
}

async fn exact_folder_revision(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    folder: &FolderId,
    receipt: &MutationReceiptToken,
    expected_kind: ChangeKind,
) -> Result<RevisionId, PortError> {
    scope.scope().check(receipt.scope())?;
    let seq = receipt.seq();
    let after = ChangeCursor {
        scope: receipt.scope().clone(),
        after: SpaceSeq::new(seq.get() - 1)?,
    };
    let result = call
        .registry
        .engine
        .read_changes(
            scope.with_preflight_taint(),
            ChangeRead::Log {
                after,
                through: seq,
                limit: PageLimit::new(1)?,
            },
        )
        .await?;
    let ChangeReadResult::Log(page) = result else {
        return Err(invalid(ValidationReason::SourceMismatch));
    };
    if page.cutoff != seq || page.changes.len() != 1 || page.next.scope != *receipt.scope() {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    let change = page.changes.into_iter().next().expect("one result");
    if change.cursor.scope != *receipt.scope()
        || change.cursor.after != seq
        || change.command_range.first_seq != seq
        || change.command_range.last_seq != seq
        || change.entity != EntityId::Folder(folder.clone())
        || change.kind != expected_kind
        || change.lifecycle != Lifecycle::Active
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(change.revision)
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    let parsed = parse_args(name, args)?;
    let route = call.journal("folder-route", || plan(call, &parsed)).await?;
    let scope = call.space(route.scope.clone())?;
    let in_app = matches!(
        call.target,
        super::super::EgressTarget::InAppProvider { .. }
    );
    if in_app {
        let source = snapshot_by_id(call, &scope, &route.folder).await?;
        admit_folder_snapshot(call, &scope, &source).await?;
        if let FolderOperation::Move { parent } = &route.operation {
            let live_dest = snapshot_by_id(call, &scope, parent).await?;
            admit_folder_snapshot(call, &scope, &live_dest).await?;
        }
    }
    let identity = call.command_identity(&route.scope, name.name(), 0);
    let preconditions = Preconditions {
        revision: Some(route.revision.clone()),
        ..Preconditions::default()
    };
    let folder = route.folder;
    let expected_change_kind = match &route.operation {
        FolderOperation::Move { .. } => Some(ChangeKind::Move),
        FolderOperation::Rename | FolderOperation::RenameProject => Some(ChangeKind::Rename),
        FolderOperation::Unchanged => None,
    };
    let committed = match (route.operation, parsed) {
        (FolderOperation::Move { parent }, ParsedFolderArgs::Move(_)) => Some(
            call.registry
                .engine
                .move_folder(
                    call.corpus_writer(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions,
                        input: MoveFolder {
                            folder: folder.clone(),
                            new_parent: Some(parent),
                        },
                    },
                )
                .await?,
        ),
        (FolderOperation::Rename, ParsedFolderArgs::Rename(args)) => Some(
            call.registry
                .engine
                .rename_folder(
                    call.corpus_writer(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions,
                        input: RenameFolder {
                            folder: folder.clone(),
                            name: args.name,
                        },
                    },
                )
                .await?,
        ),
        (FolderOperation::RenameProject, ParsedFolderArgs::RenameProject(args)) => Some(
            call.registry
                .engine
                .rename_project(
                    call.corpus_writer(scope.clone()).await?,
                    Mutation {
                        identity,
                        preconditions,
                        input: RenameProject {
                            folder: folder.clone(),
                            name: args.slug,
                            display_name: args.display_name,
                        },
                    },
                )
                .await?,
        ),
        (FolderOperation::Unchanged, _) => None,
        _ => return Err(invalid(ValidationReason::SourceMismatch)),
    };
    const LABEL: &str = "notarium.mcp.folder-receipt.v1";
    if let Some(committed) = committed {
        route
            .scope
            .check(committed.receipt.scope())
            .map_err(|error| super::super::note_tools::post_commit_error(LABEL, error.into()))?;
        if committed.value
            != (FolderRef {
                space_id: route.scope.space_id.clone(),
                folder_id: folder.clone(),
            })
        {
            return Err(super::super::note_tools::post_commit_error(
                LABEL,
                invalid(ValidationReason::SourceMismatch),
            ));
        }
        // Resolve the exact revision produced by this folder mutation from the
        // immutable change log so replays never leak a later manual edit's revision.
        let exact_rev = exact_folder_revision(
            call,
            &scope,
            &folder,
            &committed.receipt,
            expected_change_kind.expect("committed folder op has change kind"),
        )
        .await
        .map_err(|error| super::super::note_tools::post_commit_error(LABEL, error))?;
        let snapshot = match snapshot_by_id(call, &scope, &folder).await {
            Ok(current) => Some(current),
            Err(error) if in_app && corpus::hidden(&error) => {
                tracing::debug!(code = error.code(), "folder receipt metadata unavailable");
                return Ok(json!({"outcome": "applied"}));
            }
            Err(PortError::Domain(DomainError::ResourceNotFound)) if !in_app => None,
            Err(error) => return Err(super::super::note_tools::post_commit_error(LABEL, error)),
        };
        let mut result = json!({
            "outcome": "applied",
            "folderId": folder,
            "versionToken": exact_rev,
        });
        if let Some(current) = snapshot {
            let stable_ancestors = if current.revision == exact_rev {
                match ancestors_unchanged(call, &scope, &current, &route.ancestor_revisions).await {
                    Ok(unchanged) => unchanged,
                    Err(error) if in_app && corpus::hidden(&error) => {
                        tracing::debug!(code = error.code(), "folder receipt metadata unavailable");
                        return Ok(json!({"outcome": "applied"}));
                    }
                    Err(error) => {
                        return Err(super::super::note_tools::post_commit_error(LABEL, error));
                    }
                }
            } else {
                false
            };
            if current.revision == exact_rev && stable_ancestors {
                let proof = match corpus::folder_metadata(call, &scope, &current).await {
                    Ok(proof) => proof,
                    Err(error) if in_app && corpus::hidden(&error) => {
                        tracing::debug!(code = error.code(), "folder receipt metadata unavailable");
                        return Ok(json!({"outcome": "applied"}));
                    }
                    Err(error) => {
                        return Err(super::super::note_tools::post_commit_error(LABEL, error));
                    }
                };
                result["path"] = proof["path"].clone();
                if name == ToolName::RenameProject {
                    let space = proof["spaceSlug"].as_str().ok_or_else(|| {
                        super::super::note_tools::post_commit_error(
                            LABEL,
                            invalid(ValidationReason::InvalidState),
                        )
                    })?;
                    let slug = proof["projectSlug"].as_str().ok_or_else(|| {
                        super::super::note_tools::post_commit_error(
                            LABEL,
                            invalid(ValidationReason::InvalidState),
                        )
                    })?;
                    result["handle"] = Value::String(format!("{space}/{slug}"));
                    result["displayName"] = proof["name"].clone();
                }
            } else if in_app {
                // Verify live provider disclosure visibility without returning
                // a later manual edit's mutated path or display name.
                if let Err(error) = corpus::folder_metadata(call, &scope, &current).await {
                    if corpus::hidden(&error) {
                        tracing::debug!(code = error.code(), "folder receipt metadata unavailable");
                        return Ok(json!({"outcome": "applied"}));
                    }
                    return Err(super::super::note_tools::post_commit_error(LABEL, error));
                }
            }
        }
        return Ok(result);
    }
    let current = snapshot_by_id(call, &scope, &folder).await?;
    check_noop(call, &scope, &current, &route.revision).await?;
    let stable_ancestors =
        ancestors_unchanged(call, &scope, &current, &route.ancestor_revisions).await?;
    let proof = corpus::folder_metadata(call, &scope, &current).await?;
    let mut result = json!({
        "outcome": "unchanged",
        "folderId": current.reference.folder_id,
        "versionToken": current.revision,
    });
    if stable_ancestors {
        result["path"] = proof["path"].clone();
        if name == ToolName::RenameProject {
            let space = proof["spaceSlug"]
                .as_str()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            let slug = proof["projectSlug"]
                .as_str()
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            result["handle"] = Value::String(format!("{space}/{slug}"));
            result["displayName"] = proof["name"].clone();
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::corpus::strip_folder_prefix;

    #[test]
    fn pasted_space_relative_path_has_a_component_boundary() {
        assert_eq!(
            strip_folder_prefix("SHARED/notes/a", "Shared"),
            Some("notes/a".to_owned())
        );
        assert_eq!(strip_folder_prefix("shared", "Shared"), Some(String::new()));
        assert_eq!(strip_folder_prefix("shared-other/a", "Shared"), None);
        assert_eq!(strip_folder_prefix("", "Shared"), None);
    }
}

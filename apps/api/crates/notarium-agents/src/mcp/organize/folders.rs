use notarium_core::{
    DomainError,
    auth::ResourceFacts,
    classes::DocClass,
    error::{PortError, ValidationReason},
    ids::{FolderId, RevisionId},
    model::{FolderRef, HistoryScope, Lifecycle},
    ports::{
        FolderSnapshot, MoveFolder, Mutation, Preconditions, RenameFolder, RenameProject,
        SpaceContext,
    },
};
use notarium_syntax::unicode::{lookup_key, validate_component};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::super::{EgressTarget, ToolCallContext, ToolName, corpus, decode, invalid, session};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    folder: String,
    to_folder: String,
    project: Option<String>,
}

#[derive(Deserialize)]
struct RenameArgs {
    folder: String,
    name: String,
    project: Option<String>,
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
}

#[derive(Deserialize, Serialize)]
enum FolderOperation {
    Unchanged,
    Move { parent: FolderId },
    Rename { name: String },
    RenameProject { slug: String, display_name: String },
}

impl FolderRoute {
    fn new(source: FolderSnapshot, operation: FolderOperation) -> Result<Self, PortError> {
        if source.parent.is_none() {
            return Err(invalid(ValidationReason::InvalidPathComponent));
        }
        Ok(Self {
            scope: source.history,
            folder: source.reference.folder_id,
            revision: source.revision,
            operation,
        })
    }
}

struct FolderAddress {
    scope: SpaceContext,
    project: Option<FolderSnapshot>,
}

impl FolderAddress {
    async fn open(call: &ToolCallContext<'_>, project: Option<&str>) -> Result<Self, PortError> {
        let explicit = match project {
            Some(project) => Some(session::resolve_project(call, project).await?.folder),
            None => None,
        };
        let selected = explicit.or_else(|| match &call.target {
            EgressTarget::InAppProvider {
                primary_project, ..
            } => primary_project.clone(),
            EgressTarget::ExternalMcp => None,
        });
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
                if let Some(suffix) = path_from_project(path, &project.path) {
                    (Some(project.reference.folder_id.clone()), suffix)
                } else if root_relative {
                    (None, path)
                } else {
                    (Some(project.reference.folder_id.clone()), path)
                }
            }
            None => (None, path),
        };
        resolve_snapshot(call, &self.scope, base, relative).await
    }
}

fn path_from_project<'a>(path: &'a str, project_path: &str) -> Option<&'a str> {
    // Active project roots are canonical children of the Space root. Resolve
    // the suffix directly by FolderId so a project-scoped grant still works.
    let (first, suffix) = path.split_once('/').unwrap_or((path, ""));
    (!first.is_empty() && lookup_key(first) == lookup_key(project_path.trim_matches('/')))
        .then_some(suffix)
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
        .resolve_folder_path(scope.clone(), base, path.to_owned())
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
    name: ToolName,
    args: Value,
) -> Result<FolderRoute, PortError> {
    match name {
        ToolName::MoveFolder => {
            let args: MoveArgs = decode(args)?;
            let address = FolderAddress::open(call, args.project.as_deref()).await?;
            let source = address.resolve(call, &args.folder).await?;
            let dest = address.resolve(call, &args.to_folder).await?;
            let parent = dest.reference.folder_id;
            let operation = if source.parent.as_ref() == Some(&parent) {
                FolderOperation::Unchanged
            } else {
                FolderOperation::Move { parent }
            };
            FolderRoute::new(source, operation)
        }
        ToolName::RenameFolder => {
            let args: RenameArgs = decode(args)?;
            validate_component(&args.name)?;
            let address = FolderAddress::open(call, args.project.as_deref()).await?;
            let source = address.resolve(call, &args.folder).await?;
            let operation = if same_name(&source, &args.name, &args.name) {
                FolderOperation::Unchanged
            } else {
                FolderOperation::Rename { name: args.name }
            };
            FolderRoute::new(source, operation)
        }
        ToolName::RenameProject => {
            let args: RenameProjectArgs = decode(args)?;
            validate_component(&args.slug)?;
            let project = session::resolve_project(call, &args.project).await?;
            let scope = session::space(call, &project.folder.space_id).await?;
            let source = snapshot_by_id(call, &scope, &project.folder.folder_id).await?;
            let display_name = args.display_name.unwrap_or_else(|| source.name.clone());
            if display_name.trim().is_empty() || display_name.chars().any(char::is_control) {
                return Err(invalid(ValidationReason::InvalidPathComponent));
            }
            let operation = if project.project_slug == args.slug
                && same_name(&source, &args.slug, &display_name)
            {
                FolderOperation::Unchanged
            } else {
                FolderOperation::RenameProject {
                    slug: args.slug,
                    display_name,
                }
            };
            FolderRoute::new(source, operation)
        }
        _ => Err(DomainError::ResourceNotFound.into()),
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

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    let route = call
        .journal("folder-route", || plan(call, name, args))
        .await?;
    let scope = call.space(route.scope.clone())?;
    let identity = call.command_identity(&route.scope, name.name(), 0);
    let preconditions = Preconditions {
        revision: Some(route.revision.clone()),
        ..Preconditions::default()
    };
    let folder = route.folder;
    let committed = match route.operation {
        FolderOperation::Move { parent } => Some(
            call.registry
                .engine
                .move_folder(
                    scope.clone(),
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
        FolderOperation::Rename { name } => Some(
            call.registry
                .engine
                .rename_folder(
                    scope.clone(),
                    Mutation {
                        identity,
                        preconditions,
                        input: RenameFolder {
                            folder: folder.clone(),
                            name,
                        },
                    },
                )
                .await?,
        ),
        FolderOperation::RenameProject { slug, display_name } => Some(
            call.registry
                .engine
                .rename_project(
                    scope.clone(),
                    Mutation {
                        identity,
                        preconditions,
                        input: RenameProject {
                            folder: folder.clone(),
                            name: slug,
                            display_name,
                        },
                    },
                )
                .await?,
        ),
        FolderOperation::Unchanged => None,
    };
    if let Some(committed) = &committed {
        route.scope.check(committed.receipt.scope())?;
        if committed.value
            != (FolderRef {
                space_id: route.scope.space_id.clone(),
                folder_id: folder.clone(),
            })
        {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
    }
    let outcome = if committed.is_some() {
        "applied"
    } else {
        "unchanged"
    };
    let rendered: Result<Value, PortError> = async {
        let current = snapshot_by_id(call, &scope, &folder).await?;
        if committed.is_none() {
            check_noop(call, &scope, &current, &route.revision).await?;
        }
        let proof = corpus::folder_metadata(call, &scope, &current).await?;
        let mut result = json!({
            "outcome": outcome,
            "folderId": current.reference.folder_id,
            "path": proof["path"],
            "versionToken": current.revision,
        });
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
        Ok(result)
    }
    .await;
    match rendered {
        Ok(result) => Ok(result),
        Err(error) if committed.is_some() => {
            tracing::debug!(code = error.code(), "folder receipt metadata unavailable");
            Ok(json!({"outcome": outcome}))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::path_from_project;

    #[test]
    fn pasted_space_relative_path_has_a_component_boundary() {
        assert_eq!(
            path_from_project("SHARED/notes/a", "Shared"),
            Some("notes/a")
        );
        assert_eq!(path_from_project("shared", "Shared"), Some(""));
        assert_eq!(path_from_project("shared-other/a", "Shared"), None);
        assert_eq!(path_from_project("", "Shared"), None);
    }
}

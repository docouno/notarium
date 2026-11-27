use notarium_core::{
    DomainError,
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

fn validate_folder_path(raw: &str, allow_empty: bool) -> Result<(), PortError> {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() {
        return if allow_empty {
            Ok(())
        } else {
            Err(invalid(ValidationReason::InvalidPathComponent))
        };
    }
    let mut depth = 0usize;
    for segment in trimmed.split('/') {
        depth += 1;
        if depth > 256 {
            return Err(invalid(ValidationReason::InvalidPathComponent));
        }
        validate_component(segment)?;
    }
    Ok(())
}

fn parse_args(name: ToolName, args: Value) -> Result<ParsedFolderArgs, PortError> {
    match name {
        ToolName::MoveFolder => {
            let args: MoveArgs = decode(args)?;
            validate_folder_path(&args.folder, false)?;
            validate_folder_path(&args.to_folder, true)?;
            Ok(ParsedFolderArgs::Move(args))
        }
        ToolName::RenameFolder => {
            let args: RenameArgs = decode(args)?;
            validate_folder_path(&args.folder, false)?;
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

fn visible_ancestors<'a>(
    scope: &SpaceContext,
    ancestors: &'a [FolderId],
    self_id: &FolderId,
) -> Vec<&'a FolderId> {
    let project_root = scope
        .auth()
        .spaces()
        .get(&scope.scope().space_id)
        .and_then(|grant| grant.project_root.as_ref());
    let mut out = Vec::new();
    for ancestor in ancestors {
        if ancestor != self_id {
            out.push(ancestor);
        }
        if project_root == Some(ancestor) {
            break;
        }
    }
    out
}

fn visible_ancestor_pairs<'a>(
    scope: &SpaceContext,
    ancestors: &'a [FolderId],
    revisions: &'a [RevisionId],
    self_id: &FolderId,
) -> Option<Vec<(&'a FolderId, &'a RevisionId)>> {
    if ancestors.len() != revisions.len() {
        return None;
    }
    let project_root = scope
        .auth()
        .spaces()
        .get(&scope.scope().space_id)
        .and_then(|grant| grant.project_root.as_ref());
    let mut out = Vec::new();
    for (ancestor, rev) in ancestors.iter().zip(revisions.iter()) {
        if ancestor != self_id {
            out.push((ancestor, rev));
        }
        if project_root == Some(ancestor) {
            break;
        }
    }
    Some(out)
}

async fn capture_ancestor_revisions(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    snapshot: &FolderSnapshot,
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
    if let Some(pairs) = visible_ancestor_pairs(
        scope,
        &snapshot.ancestor_folders,
        &snapshot.ancestor_revisions,
        self_id,
    ) {
        for (ancestor, rev) in pairs {
            if seen.insert(ancestor.clone()) {
                revs.push((ancestor.clone(), rev.clone()));
            }
        }
        return Ok(revs);
    }
    for ancestor in visible_ancestors(scope, &snapshot.ancestor_folders, self_id) {
        if !seen.insert(ancestor.clone()) {
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
    if let Some(pairs) = visible_ancestor_pairs(
        scope,
        &current.ancestor_folders,
        &current.ancestor_revisions,
        &current.reference.folder_id,
    ) {
        if pairs.len() != expected.len() {
            return Ok(false);
        }
        let live_map: std::collections::BTreeMap<&FolderId, &RevisionId> =
            pairs.into_iter().collect();
        return Ok(expected
            .iter()
            .all(|(id, rev)| live_map.get(id) == Some(&rev)));
    }
    let live_ancestors: std::collections::BTreeSet<&FolderId> = visible_ancestors(
        scope,
        &current.ancestor_folders,
        &current.reference.folder_id,
    )
    .into_iter()
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
        let selected = session::selected_project_for_direct_write(call, project, episode).await?;
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
        let path = path.trim_matches('/');
        let Some(project) = &self.project else {
            return resolve_snapshot(call, &self.scope, None, path).await;
        };
        let base = Some(project.reference.folder_id.clone());
        if let Some(suffix) = corpus::strip_folder_prefix(path, &project.path) {
            match resolve_snapshot(call, &self.scope, base.clone(), &suffix).await {
                Ok(folder) => return Ok(folder),
                Err(PortError::Domain(DomainError::ResourceNotFound)) => {}
                Err(error) => return Err(error),
            }
        }
        match resolve_snapshot(call, &self.scope, base, path).await {
            Ok(folder) => return Ok(folder),
            Err(PortError::Domain(DomainError::ResourceNotFound)) => {}
            Err(error) => return Err(error),
        }
        // A whole-Space credential can fall back to an older Space-relative alias
        // (e.g. a renamed project's former slug), provided the resolved folder
        // belongs to the selected project.
        if self
            .scope
            .auth()
            .spaces()
            .get(&project.reference.space_id)
            .is_some_and(|grant| grant.project_root.is_none())
        {
            let folder = resolve_snapshot(call, &self.scope, None, path).await?;
            if folder.project.as_ref() == Some(&project.reference.folder_id) {
                return Ok(folder);
            }
        }
        Err(DomainError::ResourceNotFound.into())
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
        project.clone(),
        &folder.ancestor_folders,
        DocClass::UserDoc,
    )
    .await?;
    corpus::record_folder_origin(call, scope, &folder.reference, project).await
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
                    &source,
                    &source.reference.folder_id,
                    None,
                )
                .await?;
                (FolderOperation::Unchanged, revs)
            } else {
                let revs = capture_ancestor_revisions(
                    call,
                    &address.scope,
                    &dest,
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
            if source.project.as_ref() == Some(&source.reference.folder_id) {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let ancestor_revisions = capture_ancestor_revisions(
                call,
                &address.scope,
                &source,
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
            let project = session::resolve_project_for_direct_write(call, &args.project).await?;
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
                &source,
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

async fn admit_trashed_replay_folder(
    call: &ToolCallContext<'_>,
    scope: &SpaceContext,
    folder_id: &FolderId,
) -> Result<(), PortError> {
    let reference = FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id: folder_id.clone(),
    };
    let live = call
        .registry
        .catalog
        .trashed_folder_ancestry(call.account().with_preflight_taint(), reference.clone())
        .await?;
    if live.reference != reference {
        return Err(DomainError::ResourceNotFound.into());
    }
    let project_ref = live.project.map(|id| FolderRef {
        space_id: scope.scope().space_id.clone(),
        folder_id: id,
    });
    corpus::admit_folder_write(
        call,
        scope,
        &reference,
        project_ref,
        &live.ancestors,
        DocClass::UserDoc,
    )
    .await
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    let parsed = parse_args(name, args)?;
    let mut replayed = true;
    let route = call
        .journal("folder-route", || async {
            replayed = false;
            plan(call, &parsed).await
        })
        .await?;
    let scope = call.space(route.scope.clone())?;
    let in_app = matches!(
        call.target,
        super::super::EgressTarget::InAppProvider { .. }
    );
    if in_app {
        match snapshot_by_id(call, &scope, &route.folder).await {
            Ok(source) => admit_folder_snapshot(call, &scope, &source).await?,
            Err(PortError::Domain(DomainError::ResourceNotFound)) if replayed => {
                admit_trashed_replay_folder(call, &scope, &route.folder).await?;
            }
            Err(error) => return Err(error),
        }
        if let FolderOperation::Move { parent, .. } = &route.operation {
            match snapshot_by_id(call, &scope, parent).await {
                Ok(live_dest) => admit_folder_snapshot(call, &scope, &live_dest).await?,
                Err(PortError::Domain(DomainError::ResourceNotFound)) if replayed => {
                    admit_trashed_replay_folder(call, &scope, parent).await?;
                }
                Err(error) => return Err(error),
            }
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
        (FolderOperation::Move { parent, .. }, ParsedFolderArgs::Move(_)) => Some(
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
    let fenced = call.corpus_writer(scope.clone()).await?;
    call.registry
        .catalog
        .authorize_folder_subtree_write(fenced, folder.clone(), route.revision.clone())
        .await?;
    let current = snapshot_by_id(call, &scope, &folder).await?;
    if current.revision != route.revision {
        return Err(DomainError::RevisionConflict {
            current: current.revision,
            lineage: None,
        }
        .into());
    }
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

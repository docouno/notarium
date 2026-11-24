//! Account addressing and lossless session bootstrap delivery.
mod address;
mod delta;

use super::{EgressTarget, ToolCallContext, ToolName, ability_tools, corpus, decode, invalid};
use address::visible_projects;
pub(super) use address::{
    project_for_folder, readable_space, readable_spaces, resolve_project, resolve_space, space,
};
pub(super) use delta::BootstrapContinuations;

use notarium_core::{
    DomainError,
    auth::{PrincipalKind, SpaceKind, SpaceRole},
    classes::{ClassEgressFence, DocClass, ProviderCurrentContent},
    error::{PortError, ValidationReason},
    ids::{ControlRevision, EpisodeId},
    model::{FolderRef, NoteRef},
    ports::{
        AccountMutation, AckOwner, AgentEpisode, BearerScope, CatalogDisclosure,
        ControlPageRequest, EpisodeRevisionGuard, EpisodeSelector, EpisodeStartResult, GetNote,
        MAX_PROJECT_BOOTSTRAP_VALUES, NoteMetadataSnapshot, NoteSnapshot, PageLimit,
        ProviderErrorCode, SpaceContext, StartEpisode,
    },
    receipt::CausalBasis,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadArgs {
    session: Option<EpisodeId>,
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Format {
    #[default]
    Concise,
    Detailed,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StartArgs {
    project: Option<String>,
    role: Option<String>,
    task: Option<String>,
    session: Option<SessionLocator>,
    continuation: Option<String>,
    delivery_receipt: Option<String>,
    #[serde(default = "acknowledge_by_default")]
    acknowledge: bool,
    #[serde(default)]
    response_format: Format,
}

fn acknowledge_by_default() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionLocator {
    id: Option<EpisodeId>,
    name: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct StartPlan {
    // Older journals fingerprinted the observed account revision. Preserve it on replay.
    expected: ControlRevision,
    requested: EpisodeId,
    project: Option<FolderRef>,
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::Whoami | ToolName::GetMyProjects => {
            let args: ReadArgs = decode(args)?;
            if let Some(id) = args.session {
                call.registry
                    .control
                    .get_episode(call.account(), id)
                    .await?;
            }
            match name {
                ToolName::Whoami => whoami(call).await,
                _ => projects(call).await,
            }
        }
        ToolName::StartSession => start(call, decode(args)?).await,
        _ => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

pub(super) async fn selected_project_for_hint(
    call: &ToolCallContext<'_>,
    project: Option<&str>,
    hint: Option<&FolderRef>,
) -> Result<Option<FolderRef>, PortError> {
    let target = match project {
        Some(handle) => Some(resolve_project(call, handle).await?.folder),
        None => hint.cloned(),
    };
    let target = match &call.target {
        EgressTarget::InAppProvider {
            primary_project, ..
        } => target.or_else(|| primary_project.clone()),
        EgressTarget::ExternalMcp => target,
    };
    Ok(target)
}

pub(super) async fn selected_project(
    call: &ToolCallContext<'_>,
    project: Option<&str>,
    episode: Option<&EpisodeId>,
) -> Result<Option<FolderRef>, PortError> {
    let episode_project = match episode {
        Some(id) => {
            call.registry
                .control
                .get_episode(call.account(), id.clone())
                .await?
                .project_hint
        }
        None => None,
    };
    selected_project_for_hint(call, project, episode_project.as_ref()).await
}

async fn whoami(call: &mut ToolCallContext<'_>) -> Result<Value, PortError> {
    let principal = call.registry.control.whoami(call.account()).await?;
    let kind = match principal.kind {
        PrincipalKind::DirectHuman => "direct_human",
        PrincipalKind::Pat => "pat",
        PrincipalKind::OAuth { .. } => "oauth",
        PrincipalKind::AgentRun(_) => "agent_run",
        PrincipalKind::Keeper(_) => "keeper",
        PrincipalKind::SearchIndexing => return Err(DomainError::AccessDenied.into()),
    };
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let mut spaces = Vec::new();
    for card in readable_spaces(call).await?.into_values() {
        let space = card.space;
        let slug = if external {
            card.slug
        } else {
            let ctx = call.space(card.history)?;
            let source = CatalogDisclosure::Space(ctx.scope().clone());
            let Some(proof) = project_metadata(call, ctx, source, None).await? else {
                continue;
            };
            required_text(&proof, "slug")?.to_owned()
        };
        let space_kind = match space.kind {
            SpaceKind::Personal => "personal",
            SpaceKind::Shared => "shared",
        };
        let role = match card.role {
            SpaceRole::Owner => "owner",
            SpaceRole::Editor => "editor",
            SpaceRole::Viewer => "viewer",
        };
        spaces.push(json!({
            "spaceId": space.id,
            "slug": slug,
            "kind": space_kind,
            "role": role,
        }));
    }
    let personal_space = principal.personal_space.filter(|id| {
        spaces
            .iter()
            .any(|space| space["spaceId"].as_str() == Some(id.as_str()))
    });
    Ok(json!({
        "principal": principal.principal,
        "kind": kind,
        "personalSpace": personal_space,
        "spaces": spaces,
        "hasModel": if external { principal.has_completion_provider } else { true },
        "capabilities": { "vector": call.registry.vector_search, "trash": true, "revisions": true },
    }))
}

async fn projects(call: &mut ToolCallContext<'_>) -> Result<Value, PortError> {
    let spaces = readable_spaces(call).await?;
    let external = matches!(call.target, EgressTarget::ExternalMcp);
    let mut items = Vec::new();
    for card in visible_projects(call).await? {
        let Some(space) = spaces.get(&card.folder.space_id) else {
            continue;
        };
        let (space_slug, slug, name) = if external {
            (space.slug.clone(), card.project_slug, card.name)
        } else {
            let scope = call.space(space.history.clone())?;
            let source = CatalogDisclosure::Folder(card.folder.clone());
            let Some(proof) =
                project_metadata(call, scope, source, Some(card.folder.clone())).await?
            else {
                continue;
            };
            (
                required_text(&proof, "spaceSlug")?.to_owned(),
                required_text(&proof, "projectSlug")?.to_owned(),
                required_text(&proof, "name")?.to_owned(),
            )
        };
        let handle = format!("{space_slug}/{slug}");
        let item = json!({
            "projectId": card.folder.folder_id,
            "spaceId": card.folder.space_id,
            "handle": handle,
            "slug": slug,
            "name": name,
        });
        items.push((handle, item));
    }
    items.sort_by(|left, right| left.0.cmp(&right.0));
    if items.windows(2).any(|pair| pair[0].0 == pair[1].0) {
        return Err(invalid(ValidationReason::InvalidState));
    }
    Ok(json!({ "projects": items.into_iter().map(|(_, value)| value).collect::<Vec<_>>() }))
}

async fn project_metadata(
    call: &mut ToolCallContext<'_>,
    scope: SpaceContext,
    source: CatalogDisclosure,
    project: Option<FolderRef>,
) -> Result<Option<Value>, PortError> {
    let auth = call.account();
    let project = match &call.target {
        EgressTarget::InAppProvider {
            primary_project, ..
        } if auth.auth().pinned_write_space() == Some(&scope.scope().space_id) => {
            primary_project.clone()
        }
        _ => project,
    };
    let selection = match call.provider_selection(&scope, project.clone()).await {
        Ok(value) => value,
        Err(PortError::Domain(DomainError::Provider {
            error: ProviderErrorCode::Unavailable,
        })) => {
            return Ok(None);
        }
        Err(error) if corpus::hidden(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let proof = match call
        .registry
        .catalog
        .disclosure(call.account(), source)
        .await
    {
        Ok(proof) => proof,
        Err(error) if corpus::hidden(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if let Some(selection) = selection {
        if let Some(project) = &selection.project_only
            && !matches!(proof.current(), ProviderCurrentContent::Folder { reference, ancestor_folders, .. }
                if reference.space_id == project.space_id
                    && (reference.folder_id == project.folder_id || ancestor_folders.contains(&project.folder_id)))
        {
            return Ok(None);
        }
        if let Err(error) =
            ClassEgressFence::provider_metadata(proof.clone(), scope.auth(), &selection.policy)
        {
            let error = PortError::from(error);
            return if corpus::hidden(&error) {
                Ok(None)
            } else {
                Err(error)
            };
        }
        call.record_origin(proof.current().origin(), selection.project_only)?;
    }
    let text = ClassEgressFence::mcp_metadata(&proof, scope.auth())?;
    let value = serde_json::from_str(text).map_err(|_| invalid(ValidationReason::InvalidState))?;
    Ok(Some(value))
}

fn required_text<'a>(value: &'a Value, key: &str) -> Result<&'a str, PortError> {
    value[key]
        .as_str()
        .ok_or_else(|| invalid(ValidationReason::InvalidState))
}

async fn start(call: &mut ToolCallContext<'_>, args: StartArgs) -> Result<Value, PortError> {
    if !matches!(call.target, EgressTarget::ExternalMcp) {
        return Err(DomainError::AccessDenied.into());
    }
    let new_selection = args.session.is_some()
        || args.project.is_some()
        || args.role.is_some()
        || args.task.is_some();
    if let Some(continuation) = args.continuation.as_deref() {
        if new_selection {
            return Err(invalid(ValidationReason::InvalidQuery));
        }
        return Ok(json!({
            "delta": delta::resume(call, continuation, args.delivery_receipt.as_deref(), args.acknowledge).await?
        }));
    }
    if let Some(receipt) = args.delivery_receipt.as_deref() {
        let acknowledged = delta::deliver(call, receipt, args.acknowledge).await?;
        if !new_selection {
            return Ok(json!({ "acknowledged": acknowledged }));
        }
    }
    let requested = derive_episode_id(call);
    let selector = selector(
        args.session.as_ref(),
        args.task.as_deref(),
        requested.clone(),
    )?;
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    let plan: StartPlan = call
        .journal("start-episode", || async {
            let project = match args.project.as_deref() {
                Some(handle) => Some(resolve_project(call, handle).await?.folder),
                None => None,
            };
            if let EpisodeSelector::Id(id) = &selector {
                let episode = call
                    .registry
                    .control
                    .get_episode(call.account(), id.clone())
                    .await?;
                check_requested_project(project.as_ref(), &episode)?;
            }
            Ok(StartPlan {
                expected: ControlRevision::ZERO,
                requested,
                project,
            })
        })
        .await?;
    if let Some(project) = &plan.project {
        project_for_folder(call, project).await?;
    }
    let selector = match selector {
        EpisodeSelector::New { name, .. } => EpisodeSelector::New {
            name,
            requested: plan.requested,
        },
        other => other,
    };
    let opened = call
        .registry
        .control
        .start_or_resume_episode(
            call.account(),
            AccountMutation {
                identity: call.account_identity(plan.expected, "start-episode", 0),
                input: StartEpisode {
                    selector,
                    project_hint: plan.project.clone(),
                    guard: EpisodeRevisionGuard::Target,
                },
            },
        )
        .await?;
    let (episode, state) = match opened.value {
        EpisodeStartResult::New(episode) => (episode, "new"),
        EpisodeStartResult::Resumed(episode) => (episode, "resumed"),
        EpisodeStartResult::Forked(episode) => (episode, "forked"),
        EpisodeStartResult::Ambiguous(choices) => {
            let recent: Vec<_> = choices
                .into_iter()
                .map(|choice| json!({ "id": choice.id, "name": choice.name }))
                .collect();
            return Ok(json!({ "recentSessions": recent }));
        }
    };
    check_requested_project(plan.project.as_ref(), &episode)?;
    if let Some(project) = &episode.project_hint {
        project_for_folder(call, project).await?;
    }
    let role = ability_tools::activate_session_role(call, &episode, args.role.as_deref()).await?;
    let context = call
        .registry
        .control
        .bootstrap_context(
            call.account(),
            episode.id.clone(),
            None,
            ControlPageRequest::new(20, None)?,
        )
        .await?;
    if context.episode.project_hint != episode.project_hint {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let abilities = ability_tools::session_ability_summaries(call, &context.episode).await?;

    let mut selection = Vec::new();
    let mut favorites = Vec::new();
    let mut remaining = match args.response_format {
        Format::Concise => 12 * 1024,
        Format::Detailed => 32 * 1024,
    };
    for reference in &context.selection.pinned {
        if let Some(note) = bootstrap_note(call, reference).await? {
            let body = ClassEgressFence::mcp_note(&note.document, call.account().auth())?;
            let summary = bounded_text(body, remaining.min(4096));
            remaining -= summary.len();
            selection.push(json!({
                "noteId": reference.note_id,
                "spaceId": reference.space_id,
                "revision": note.document.revision(),
                "title": note.provenance.as_ref().map(|facts| &facts.title),
                "content": summary,
                "truncated": summary.len() < body.len(),
            }));
        }
    }
    for reference in &context.selection.favorites {
        if let Some(note) = bootstrap_note_metadata(call, reference).await? {
            favorites.push(json!({
                "noteId": reference.note_id,
                "spaceId": reference.space_id,
                "revision": note.metadata.revision(),
                "title": note.provenance.as_ref().map(|facts| &facts.title),
            }));
        }
    }
    let mut output = json!({
        "session": { "id": episode.id, "name": episode.name, "state": state, "parentId": episode.parent },
        "profile": { "alwaysLoad": selection, "favorites": favorites, "truncated": context.continuation.is_some() },
        "abilities": abilities["items"],
    });
    if let Some(next_action) = abilities.get("nextAction").filter(|value| !value.is_null()) {
        output["nextAction"] = next_action.clone();
    }
    if !abilities["nextCursor"].is_null() {
        output["abilitiesTruncated"] = json!(true);
    }
    if let Some(role) = role {
        output["activeRole"] = role;
    }
    if let Some(project) = &episode.project_hint {
        output["project"] = project_bundle(call, project).await?;
    }
    let (owner, acknowledgements, allow_ack) = if args.session.is_some() {
        (
            AckOwner::Episode(episode.id.clone()),
            &context.episode.acknowledgements,
            args.acknowledge,
        )
    } else {
        // Read-scoped bearers may acknowledge only their own episode cursor,
        // never advancing the account-wide baseline.
        let allow_ack = args.acknowledge && call.auth.bearer_scope() != Some(BearerScope::Read);
        (
            AckOwner::Account,
            &context.owner_acknowledgements,
            allow_ack,
        )
    };
    output["delta"] = delta::open(
        call,
        episode.id,
        owner,
        episode.project_hint,
        acknowledgements,
        allow_ack,
    )
    .await?;
    Ok(output)
}

fn selector(
    locator: Option<&SessionLocator>,
    task: Option<&str>,
    requested: EpisodeId,
) -> Result<EpisodeSelector, PortError> {
    match locator {
        None => Ok(EpisodeSelector::New {
            requested,
            name: task.and_then(session_name),
        }),
        Some(SessionLocator {
            id: Some(id),
            name: None,
        }) => Ok(EpisodeSelector::Id(id.clone())),
        Some(SessionLocator {
            id: None,
            name: Some(name),
        }) => session_name(name)
            .map(EpisodeSelector::Name)
            .ok_or_else(|| invalid(ValidationReason::InvalidQuery)),
        Some(_) => Err(invalid(ValidationReason::InvalidQuery)),
    }
}

fn session_name(input: &str) -> Option<String> {
    let safe: String = input
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect();
    let safe: String = safe.trim().chars().take(128).collect();
    (!safe.is_empty()).then_some(safe)
}

fn derive_episode_id(call: &ToolCallContext<'_>) -> EpisodeId {
    let key = call.command_key("new-episode", 0);
    let hash = blake3::hash(key.as_str().as_bytes());
    let mut id = [0_u8; 16];
    id.copy_from_slice(&hash.as_bytes()[..16]);
    EpisodeId::from_bytes(id)
}

fn check_requested_project(
    project: Option<&FolderRef>,
    episode: &AgentEpisode,
) -> Result<(), PortError> {
    if project.is_some_and(|project| Some(project) != episode.project_hint.as_ref()) {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    Ok(())
}

async fn project_bundle(
    call: &ToolCallContext<'_>,
    reference: &FolderRef,
) -> Result<Value, PortError> {
    let project = project_for_folder(call, reference).await?;
    let scope = space(call, &reference.space_id).await?;
    let folder = call
        .registry
        .engine
        .resolve_folder_path(
            scope.clone(),
            Some(reference.folder_id.clone()),
            String::new(),
        )
        .await?
        .ok_or(DomainError::ResourceNotFound)?;
    if folder.reference != *reference || folder.history != *scope.scope() {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let children = call
        .registry
        .engine
        .list_child_folders(
            scope.clone(),
            Some(reference.folder_id.clone()),
            None,
            None,
            PageLimit::new(50)?,
        )
        .await?;
    if children.items.len() > 50 {
        return Err(invalid(ValidationReason::InvalidState));
    }
    let folders: Vec<_> = children
        .items
        .into_iter()
        .map(|child| {
            json!({
                "folderId": child.reference.folder_id, "path": child.path, "name": child.name,
            })
        })
        .collect();
    let mut output = json!({
        "id": reference.folder_id,
        "spaceId": reference.space_id,
        "slug": project.project_slug,
        "name": project.name,
        "index": { "folders": folders, "truncated": children.next.is_some() },
    });
    match call
        .registry
        .engine
        .project_note_counts(scope.clone(), reference.clone(), causal())
        .await
    {
        Ok(counts) => {
            if counts.project != *reference
                || counts.cut.scope != *scope.scope()
                || counts.known_tags.len() > MAX_PROJECT_BOOTSTRAP_VALUES
                || counts.known_categories.len() > MAX_PROJECT_BOOTSTRAP_VALUES
            {
                return Err(invalid(ValidationReason::InvalidState));
            }
            let note_count = counts
                .counts
                .into_iter()
                .filter(|(class, _)| *class != DocClass::EncryptedNote)
                .try_fold(0_u64, |total, (_, count)| total.checked_add(count))
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            output["index"]["noteCount"] = json!(note_count);
            output["index"]["cut"] = json!(counts.cut.projected_seq);
            output["knownValues"] = json!({
                "tags": counts.known_tags,
                "categories": counts.known_categories,
            });
        }
        Err(PortError::Domain(DomainError::ValidationFailed { diagnostic }))
            if matches!(
                diagnostic.reason,
                ValidationReason::NotReady
                    | ValidationReason::CursorStale
                    | ValidationReason::GenerationMismatch
            ) =>
        {
            output["index"]["countsAvailable"] = json!(false);
        }
        Err(PortError::Unavailable(_)) => {
            output["index"]["countsAvailable"] = json!(false);
        }
        Err(PortError::DeadlineExceeded(_)) if !call.budget().remaining.is_zero() => {
            output["index"]["countsAvailable"] = json!(false);
        }
        Err(error) => return Err(error),
    }
    if let Some(note_id) = folder.cover_note {
        let cover = NoteRef {
            space_id: reference.space_id.clone(),
            note_id,
        };
        if let Some(note) = bootstrap_note_metadata(call, &cover).await? {
            output["folderPage"] = json!({
                "status": "present",
                "folderId": reference.folder_id,
                "folderPath": folder.path,
                "noteId": cover.note_id,
                "title": note.provenance.as_ref().map(|facts| &facts.title),
            });
        }
    }
    Ok(output)
}

async fn bootstrap_note_metadata(
    call: &ToolCallContext<'_>,
    reference: &NoteRef,
) -> Result<Option<NoteMetadataSnapshot>, PortError> {
    let scope = space(call, &reference.space_id).await?;
    let snapshot = match call
        .registry
        .engine
        .get_note_metadata(
            scope.clone(),
            GetNote {
                note: reference.note_id.clone(),
                revision: None,
                causal: causal(),
            },
        )
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) if corpus::hidden(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if snapshot.metadata.reference() != reference {
        return Err(invalid(ValidationReason::InvalidState));
    }
    match ClassEgressFence::mcp_note_metadata(&snapshot.metadata, scope.auth())
        .map_err(PortError::from)
    {
        Ok(_) => Ok(Some(snapshot)),
        Err(error) if corpus::hidden(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn bootstrap_note(
    call: &ToolCallContext<'_>,
    reference: &NoteRef,
) -> Result<Option<NoteSnapshot>, PortError> {
    let scope = space(call, &reference.space_id).await?;
    let snapshot = match call
        .registry
        .engine
        .get_note(
            scope.clone(),
            GetNote {
                note: reference.note_id.clone(),
                revision: None,
                causal: causal(),
            },
        )
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) if corpus::hidden(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    if snapshot.document.reference() != reference {
        return Err(invalid(ValidationReason::InvalidState));
    }
    match ClassEgressFence::mcp_note_metadata(&snapshot.document.metadata(), scope.auth())
        .map_err(PortError::from)
    {
        Ok(_) => Ok(Some(snapshot)),
        Err(error) if corpus::hidden(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn causal() -> CausalBasis {
    CausalBasis::Await(Default::default())
}

fn bounded_text(value: &str, limit: usize) -> &str {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

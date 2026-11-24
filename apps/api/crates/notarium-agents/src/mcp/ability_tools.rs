use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use notarium_core::{
    DomainError,
    auth::{ChatAudience, PrincipalKind},
    classes::{AbilityKind, ClassEgressFence, ClassifiedAbilityResource, DocClass, ProviderOrigin},
    error::{PortError, ValidationReason},
    ids::*,
    model::{AbilityResourceName, FolderRef},
    ports::*,
    receipt::AccountCommandIdentity,
    value::YamlValue,
};
use notarium_syntax::frontmatter;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

use super::{EgressTarget, ToolCallContext, ToolName, ToolRegistry, decode, invalid, session};
use crate::abilities::read_system_ability;

mod author;

const MAX_TOKEN_BYTES: usize = 2048;
const DEFAULT_ACTIVATION_TOKENS: usize = 4000;
const MAX_ACTIVATION_TOKENS: usize = 16_000;
const MAX_IN_APP_PACKAGE_BODY_BYTES: usize = 32 * 1024;
const ABILITY_CURSOR_PREFIX: &str = "ac1:";
const ABILITY_CURSOR_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_ABILITY_CURSORS: usize = 512;
const MAX_ABILITY_CURSORS_PER_PRINCIPAL: usize = 64;

/// Keep ability pagination positions server-side so unconsented Space IDs and
/// sequence numbers are never encoded into tokens returned to callers or models.
#[derive(Default)]
pub(super) struct AbilityCursors {
    entries: Mutex<VecDeque<AbilityCursorEntry>>,
}

struct AbilityCursorEntry {
    id: u128,
    principal: PrincipalId,
    opened: Instant,
    scope: ContentDigest,
    inner: String,
}

impl AbilityCursors {
    fn insert(
        &self,
        principal: PrincipalId,
        scope: ContentDigest,
        inner: String,
    ) -> Result<String, PortError> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| invalid(ValidationReason::InvalidState))?;
        let id = u128::from_be_bytes(bytes);
        let mut entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        entries.retain(|entry| entry.opened.elapsed() < ABILITY_CURSOR_TTL);
        if entries.iter().any(|entry| entry.id == id) {
            return Err(invalid(ValidationReason::InvalidState));
        }
        let mut owned = entries
            .iter()
            .filter(|entry| entry.principal == principal)
            .count();
        while owned >= MAX_ABILITY_CURSORS_PER_PRINCIPAL {
            if let Some(pos) = entries
                .iter()
                .position(|entry| entry.principal == principal)
            {
                entries.remove(pos);
                owned -= 1;
            } else {
                break;
            }
        }
        if entries.len() == MAX_ABILITY_CURSORS {
            entries.pop_front();
        }
        entries.push_back(AbilityCursorEntry {
            id,
            principal,
            opened: Instant::now(),
            scope,
            inner,
        });
        Ok(format!("{ABILITY_CURSOR_PREFIX}{id:032x}"))
    }

    fn lookup(
        &self,
        principal: &PrincipalId,
        token: &str,
        expected_scope: &ContentDigest,
    ) -> Result<String, PortError> {
        let raw = token
            .strip_prefix(ABILITY_CURSOR_PREFIX)
            .ok_or_else(|| invalid(ValidationReason::InvalidId))?;
        if raw.len() != 32 || !raw.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(invalid(ValidationReason::InvalidId));
        }
        let id = u128::from_str_radix(raw, 16).map_err(|_| invalid(ValidationReason::InvalidId))?;
        let mut entries = self.entries.lock().unwrap_or_else(|err| err.into_inner());
        entries.retain(|entry| entry.opened.elapsed() < ABILITY_CURSOR_TTL);
        let Some(entry) = entries
            .iter()
            .find(|entry| entry.id == id && &entry.principal == principal)
        else {
            return Err(invalid(ValidationReason::CursorStale));
        };
        if &entry.scope != expected_scope {
            return Err(invalid(ValidationReason::CursorStale));
        }
        Ok(entry.inner.clone())
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Role,
    Skill,
}
impl From<Kind> for AbilityKind {
    fn from(kind: Kind) -> Self {
        match kind {
            Kind::Role => Self::Role,
            Kind::Skill => Self::Skill,
        }
    }
}
fn kind_name(kind: AbilityKind) -> &'static str {
    match kind {
        AbilityKind::Role => "role",
        AbilityKind::Skill => "skill",
    }
}

#[derive(Clone, Copy, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum View {
    Runtime,
    Authoring,
}
#[derive(Clone, Copy, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Source {
    System,
    Owned,
}
fn source(reference: &AbilityRef) -> Source {
    if reference.placement == AbilityPlacement::System {
        Source::System
    } else {
        Source::Owned
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListArgs {
    view: Option<View>,
    source: Option<Source>,
    kind: Option<Kind>,
    project: Option<String>,
    q: Option<String>,
    cursor: Option<String>,
    limit: Option<u16>,
    session: Option<EpisodeId>,
}
#[derive(Deserialize)]
struct GetArgs {
    #[serde(rename = "ref")]
    reference: String,
    session: Option<EpisodeId>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UseArgs {
    role: Option<String>,
    skill: Option<String>,
    name: Option<String>,
    project: Option<String>,
    budget_tokens: Option<usize>,
    session: Option<EpisodeId>,
}

pub(super) async fn handle(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: Value,
) -> Result<Value, PortError> {
    match name {
        ToolName::ListAbilities => {
            let args: ListArgs = decode(args)?;
            let episode = load_episode(call, args.session.as_ref()).await?;
            let project = session::selected_project_for_episode(
                call,
                args.project.as_deref(),
                episode.as_ref(),
            )
            .await?;
            list(call, args, project).await
        }
        ToolName::GetAbility => get(call, decode(args)?).await,
        ToolName::UseRole | ToolName::UseSkill => use_ability(call, name, decode(args)?).await,
        ToolName::CreateAbility => author::create(call, decode(args)?).await,
        ToolName::EditAbility => author::edit(call, decode(args)?).await,
        ToolName::DeleteAbility => author::trash(call, decode(args)?).await,
        _ => Err(invalid(ValidationReason::InvalidState)),
    }
}

fn token<T: Serialize>(prefix: &str, value: &T) -> Result<String, PortError> {
    let bytes = serde_json::to_vec(value).map_err(|_| invalid(ValidationReason::InvalidState))?;
    let result = format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes));
    if result.len() > MAX_TOKEN_BYTES {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok(result)
}

fn parse_token<T: DeserializeOwned>(
    text: &str,
    prefix: &str,
    limit: usize,
) -> Result<T, PortError> {
    if text.len() > limit {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    let encoded = text
        .strip_prefix(prefix)
        .ok_or_else(|| invalid(ValidationReason::InvalidId))?;
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| invalid(ValidationReason::InvalidId))?;
    serde_json::from_slice(&bytes).map_err(|_| invalid(ValidationReason::InvalidId))
}

fn reference_token(reference: &AbilityRef) -> Result<String, PortError> {
    token("ar1:", reference)
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
struct Version {
    package: RevisionId,
    binding: ControlRevision,
}
impl Version {
    fn from_inspection(inspection: &AbilityInspection) -> Self {
        Self {
            package: inspection.descriptor.reference.revision.clone(),
            binding: inspection.binding_revision,
        }
    }
    fn decode(text: &str) -> Result<Self, PortError> {
        parse_token(text, "av1:", MAX_TOKEN_BYTES)
    }
    fn encode(&self) -> Result<String, PortError> {
        token("av1:", self)
    }
}

async fn load_episode(
    call: &ToolCallContext<'_>,
    episode: Option<&EpisodeId>,
) -> Result<Option<AgentEpisode>, PortError> {
    match episode {
        Some(id) => call
            .registry
            .control
            .get_episode(call.account(), id.clone())
            .await
            .map(Some),
        None => Ok(None),
    }
}

async fn raw_reference_for_account(
    registry: &ToolRegistry,
    account: &AccountContext,
    id: AbilityId,
) -> Result<Option<AbilityRef>, PortError> {
    let candidates = registry.catalog.locate_ability(account.clone(), id).await?;
    if candidates.is_empty() {
        return Ok(None);
    }
    if candidates.len() == 1 {
        return Ok(Some(candidates.into_iter().next().unwrap().reference));
    }
    let mut visible = None;
    for candidate in candidates {
        match registry
            .control
            .inspect_ability(account.clone(), candidate.reference.identity())
            .await
        {
            Ok(inspection) => {
                if visible.replace(inspection.descriptor.reference).is_some() {
                    return Err(invalid(ValidationReason::ScopeMismatch));
                }
            }
            Err(error) if visible_error(&error) => (),
            Err(error) => return Err(error),
        }
    }
    Ok(visible)
}

async fn resolve_selector_for_account(
    registry: &ToolRegistry,
    account: &AccountContext,
    selector: &str,
    kind: AbilityKind,
    project: Option<FolderRef>,
) -> Result<AbilityResolution, PortError> {
    if selector.starts_with("ar1:") {
        let reference = parse_token(selector, "ar1:", MAX_TOKEN_BYTES)?;
        return registry
            .control
            .resolve_ability(
                account.clone(),
                AbilitySelection::Exact { reference, project },
            )
            .await;
    }
    if let Ok(id) = AbilityId::parse_v1(selector)
        && let Some(reference) = raw_reference_for_account(registry, account, id).await?
    {
        return registry
            .control
            .resolve_ability(
                account.clone(),
                AbilitySelection::Exact { reference, project },
            )
            .await;
    }
    let by_name = registry
        .control
        .resolve_ability(
            account.clone(),
            AbilitySelection::Name {
                name: notarium_syntax::unicode::lookup_key(selector),
                kind,
                project: project.clone(),
            },
        )
        .await?;
    if !matches!(by_name, AbilityResolution::Missing) {
        return Ok(by_name);
    }
    if let Ok(id) = AbilityId::parse(selector)
        && let Some(reference) = raw_reference_for_account(registry, account, id).await?
    {
        return registry
            .control
            .resolve_ability(
                account.clone(),
                AbilitySelection::Exact { reference, project },
            )
            .await;
    }
    Ok(by_name)
}

async fn raw_reference(
    call: &ToolCallContext<'_>,
    id: AbilityId,
) -> Result<Option<AbilityRef>, PortError> {
    raw_reference_for_account(call.registry, &call.account(), id).await
}

async fn inspect(call: &ToolCallContext<'_>, text: &str) -> Result<AbilityInspection, PortError> {
    let reference: AbilityRef = if text.starts_with("ar1:") {
        parse_token(text, "ar1:", MAX_TOKEN_BYTES)?
    } else {
        raw_reference(call, AbilityId::parse(text)?)
            .await?
            .ok_or(DomainError::ResourceNotFound)?
    };
    call.registry
        .control
        .inspect_ability(call.account(), reference.identity())
        .await
}

#[derive(Clone, Debug)]
struct AbilityBody {
    description: String,
    instructions: String,
    attachments: Vec<AuthoredAttachment>,
    origin: ProviderOrigin,
    project: Option<FolderRef>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct AuthoredAttachment {
    #[serde(flatten)]
    identity: AbilityIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
}

fn parse_body(text: &str) -> Result<(String, String, Vec<AuthoredAttachment>), PortError> {
    let analysis = frontmatter::analyze(text, DocClass::Skill)?;
    let fields = analysis.fields.unwrap_or_default();
    let description = match fields.get("description") {
        Some(YamlValue::String(value)) => value.clone(),
        _ => String::new(),
    };
    let authored = fields
        .get("metadata")
        .and_then(yaml_mapping)
        .and_then(|metadata| metadata.get("notarium"))
        .and_then(yaml_mapping)
        .and_then(|notarium| notarium.get("skills"));
    let attachments = match authored {
        Some(value) => serde_json::from_value(yaml_as_json(value)).unwrap_or_default(),
        None => Vec::new(),
    };
    if attachments.len() > MAX_ATTACHED_SKILLS {
        return Err(invalid(ValidationReason::InvalidLimit));
    }
    Ok((
        description,
        analysis.carrier.body.slice(text)?.to_owned(),
        attachments,
    ))
}

fn yaml_mapping(value: &YamlValue) -> Option<&std::collections::BTreeMap<String, YamlValue>> {
    match value {
        YamlValue::Mapping(value) => Some(value),
        _ => None,
    }
}

fn yaml_as_json(value: &YamlValue) -> Value {
    match value {
        YamlValue::Null => Value::Null,
        YamlValue::String(value) => json!(value),
        YamlValue::Bool(value) => json!(value),
        YamlValue::Number(_) => Value::Null,
        YamlValue::Sequence(items) => Value::Array(items.iter().map(yaml_as_json).collect()),
        YamlValue::Mapping(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), yaml_as_json(value)))
                .collect(),
        ),
    }
}

fn requested_project(
    call: &ToolCallContext<'_>,
    reference: &AbilityRef,
    space: &SpaceId,
    hint: Option<&FolderRef>,
) -> Option<FolderRef> {
    let primary = match &call.target {
        EgressTarget::ExternalMcp => None,
        EgressTarget::InAppProvider {
            primary_project, ..
        } => primary_project.as_ref(),
    };
    if matches!(call.target, EgressTarget::InAppProvider { .. })
        && call.auth.pinned_write_space() == Some(space)
    {
        return primary.cloned();
    }
    if let AbilityPlacement::OwnedProject(project) = &reference.placement {
        return Some(project.clone());
    }
    hint.filter(|value| &value.space_id == space)
        .or_else(|| primary.filter(|value| &value.space_id == space))
        .cloned()
}

async fn read_body(
    call: &ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    hint: Option<&FolderRef>,
) -> Result<AbilityBody, PortError> {
    let reference = &descriptor.reference;
    if reference.placement == AbilityPlacement::System {
        let content = read_system_ability(&call.account(), reference)?;
        if let EgressTarget::InAppProvider {
            primary_project, ..
        } = &call.target
        {
            let scope = call
                .auth
                .pinned_write_space()
                .ok_or(DomainError::AccessDenied)?;
            let selection = call
                .provider_selection(&session::space(call, scope).await?, primary_project.clone())
                .await?
                .ok_or_else(|| invalid(ValidationReason::InvalidState))?;
            ClassEgressFence::system_ability(content.clone(), &selection.policy)?;
        }
        return Ok(AbilityBody {
            description: content.text().to_owned(),
            instructions: content.text().to_owned(),
            attachments: vec![],
            origin: content.origin(),
            project: None,
        });
    }
    let body = read_owned_resource(call, descriptor, hint, AbilityResourceName::Entrypoint).await?;
    let (description, instructions, attachments) = parse_body(&body.text)?;
    Ok(AbilityBody {
        description,
        instructions,
        attachments,
        origin: body.origin,
        project: body.project,
    })
}

struct ResourceBody {
    text: String,
    origin: ProviderOrigin,
    project: Option<FolderRef>,
}

async fn read_owned_resource(
    call: &ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    hint: Option<&FolderRef>,
    resource: AbilityResourceName,
) -> Result<ResourceBody, PortError> {
    let reference = &descriptor.reference;
    let entry = descriptor
        .entrypoint
        .as_ref()
        .ok_or(DomainError::ResourceNotFound)?;
    let scope = session::space(call, &entry.space_id).await?;
    let project = requested_project(call, reference, &entry.space_id, hint);
    let body = read_exact_resource(call.registry, &scope, descriptor, resource).await?;
    let origin = body.origin();
    let text = match call.provider_selection(&scope, project.clone()).await? {
        Some(selection) => {
            if selection
                .project_only
                .as_ref()
                .is_some_and(|project| !body.in_project(project))
            {
                return Err(DomainError::AccessDenied.into());
            }
            let admitted = ClassEgressFence::ability(body, scope.auth(), &selection.policy)?;
            admitted.text().to_owned()
        }
        None => ClassEgressFence::mcp_ability(&body, scope.auth())?.to_owned(),
    };
    Ok(ResourceBody {
        text,
        origin,
        project,
    })
}

pub(super) async fn read_exact_resource(
    registry: &ToolRegistry,
    scope: &SpaceContext,
    descriptor: &AbilityDescriptor,
    resource: AbilityResourceName,
) -> Result<ClassifiedAbilityResource, PortError> {
    let reference = &descriptor.reference;
    let entry = descriptor
        .entrypoint
        .as_ref()
        .ok_or(DomainError::ResourceNotFound)?;
    if entry.space_id != scope.scope().space_id {
        return Err(invalid(ValidationReason::ScopeMismatch));
    }
    let body = registry
        .engine
        .read_ability_resource(
            scope.clone(),
            ReadAbilityResource {
                ability: reference.id.clone(),
                package_revision: reference.revision.clone(),
                resource: resource.clone(),
            },
        )
        .await?;
    if body.reference().space != entry.space_id
        || body.reference().ability != reference.id
        || body.reference().package_revision != reference.revision
        || body.reference().resource != resource
        || body.placement() != &reference.placement
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    Ok(body)
}

fn availability(value: &AbilityProjects) -> Value {
    match value {
        AbilityProjects::All => json!({"mode":"all-projects"}),
        AbilityProjects::Selected(projects) => {
            json!({"mode":"selected-projects","projects":projects})
        }
    }
}

fn summary(
    inspection: &AbilityInspection,
    description: &str,
    enabled: bool,
    external: bool,
) -> Result<Value, PortError> {
    let descriptor = &inspection.descriptor;
    let description: String = description.chars().take(4096).collect();
    let mut output = json!({
        "ref": reference_token(&descriptor.reference)?,
        "versionToken": Version::from_inspection(inspection).encode()?,
        "name": descriptor.name,
        "kind": kind_name(descriptor.kind),
        "source": source(&descriptor.reference),
        "scope": descriptor.reference.placement,
        "enabled": enabled && descriptor.enabled,
        "healthy": descriptor.healthy,
        "description": description,
    });
    if external {
        output["availability"] = availability(&inspection.availability);
    }
    Ok(output)
}

fn provider_ability_allowed(
    call: &ToolCallContext<'_>,
    inspection: &AbilityInspection,
    project: Option<&FolderRef>,
) -> bool {
    let EgressTarget::InAppProvider {
        primary_project, ..
    } = &call.target
    else {
        return true;
    };
    if inspection.descriptor.requires_explicit_binding
        && inspection.binding_revision == ControlRevision::ZERO
    {
        return false;
    }
    if !inspection.binding_enabled {
        return false;
    }
    if let AbilityProjects::Selected(projects) = &inspection.availability {
        if !project.is_some_and(|p| projects.contains(p)) {
            return false;
        }
        if let Some(primary) = primary_project
            && inspection
                .descriptor
                .entrypoint
                .as_ref()
                .is_some_and(|entry| entry.space_id == primary.space_id)
            && !projects.contains(primary)
        {
            return false;
        }
    }
    true
}

fn collapse_provider_error(call: &ToolCallContext<'_>, error: PortError) -> PortError {
    if matches!(call.target, EgressTarget::InAppProvider { .. }) && visible_error(&error) {
        DomainError::ResourceNotFound.into()
    } else {
        error
    }
}

fn visible_error(error: &PortError) -> bool {
    matches!(
        error,
        PortError::Domain(DomainError::ResourceNotFound | DomainError::AccessDenied)
    ) || matches!(error, PortError::Domain(DomainError::ValidationFailed { diagnostic })
            if matches!(diagnostic.reason, ValidationReason::ProviderConsentRequired | ValidationReason::ClassEgressForbidden))
        || matches!(error, PortError::Domain(DomainError::Provider { .. }))
}

async fn list(
    call: &mut ToolCallContext<'_>,
    args: ListArgs,
    project: Option<FolderRef>,
) -> Result<Value, PortError> {
    let view = args.view.unwrap_or(View::Runtime);
    let limit = args.limit.unwrap_or(20);
    let receiver = match &call.target {
        EgressTarget::ExternalMcp => None,
        EgressTarget::InAppProvider {
            provider,
            model,
            primary_project,
        } => Some((provider, model, primary_project)),
    };
    let filters = serde_json::to_vec(&(
        call.auth.principal(),
        super::command_actor(&call.auth),
        call.auth.bearer_scope(),
        receiver,
        &project,
        view,
        args.source,
        args.kind,
        &args.q,
        &args.session,
    ))
    .map_err(|_| invalid(ValidationReason::InvalidState))?;
    let scope = ContentDigest::from_bytes(*blake3::hash(&filters).as_bytes());
    let inner = match &args.cursor {
        Some(cursor) => Some(call.registry.ability_cursors.lookup(
            call.auth.principal(),
            cursor,
            &scope,
        )?),
        None => None,
    };
    let page = call
        .registry
        .control
        .discover_abilities(
            call.account(),
            AbilityQuery {
                page: ControlPageRequest::new(limit, inner)?,
                project: project.clone(),
                kind: args.kind.map(Into::into),
                name: None,
                authoring: view == View::Authoring,
            },
        )
        .await?;
    let query = args.q.as_deref().map(notarium_syntax::unicode::lookup_key);
    let mut items = Vec::new();
    for inspection in page.items {
        let descriptor = &inspection.descriptor;
        if args
            .source
            .is_some_and(|expected| source(&descriptor.reference) != expected)
        {
            continue;
        }
        if !provider_ability_allowed(call, &inspection, project.as_ref()) {
            continue;
        }
        let external = matches!(call.target, EgressTarget::ExternalMcp);
        let (description, origin_record) =
            if external && let Some(desc) = descriptor.description.as_ref() {
                (desc.clone(), None)
            } else {
                let body = match read_body(call, descriptor, project.as_ref()).await {
                    Ok(body) => body,
                    Err(error) if visible_error(&error) => continue,
                    Err(error) => return Err(error),
                };
                (body.description, Some((body.origin, body.project)))
            };
        if query.as_ref().is_some_and(|query| {
            !notarium_syntax::unicode::lookup_key(&descriptor.name).contains(query)
                && !notarium_syntax::unicode::lookup_key(&description).contains(query)
        }) {
            continue;
        }
        let enabled = if view == View::Runtime {
            descriptor.enabled
        } else {
            inspection.binding_enabled && inspection.preference_enabled
        };
        items.push(summary(&inspection, &description, enabled, external)?);
        if let Some((origin, proj)) = origin_record {
            call.record_origin(origin, proj)?;
        }
    }
    let next = page
        .continuation
        .map(|inner| {
            call.registry
                .ability_cursors
                .insert(call.auth.principal().clone(), scope, inner)
        })
        .transpose()?;
    let filtered =
        args.kind.is_some() || args.source.is_some() || args.project.is_some() || args.q.is_some();
    let next_action = match &next {
        Some(cursor) => {
            let mut arguments = json!({"view":view,"cursor":cursor,"limit":limit});
            for (key, value) in [
                ("kind", json!(args.kind)),
                ("source", json!(args.source)),
                ("q", json!(args.q)),
                ("project", json!(args.project)),
                ("session", json!(args.session)),
            ] {
                if !value.is_null() {
                    arguments[key] = value;
                }
            }
            Some(json!({"tool":"list_abilities","reason":"next_page","arguments":arguments}))
        }
        None if items.is_empty() && filtered => {
            Some(json!({"tool":"list_abilities","reason":"zero_results","arguments":{"view":view}}))
        }
        None => None,
    };
    Ok(json!({"items":items,"nextCursor":next,"nextAction":next_action}))
}

pub(super) async fn session_ability_summaries(
    call: &mut ToolCallContext<'_>,
    episode: &AgentEpisode,
) -> Result<Value, PortError> {
    let project_unavailable = episode
        .diagnostics
        .contains(&EpisodeDiagnostic::ProjectUnavailable);
    list(
        call,
        ListArgs {
            view: None,
            source: None,
            kind: None,
            project: None,
            q: None,
            cursor: None,
            limit: None,
            session: (!project_unavailable).then(|| episode.id.clone()),
        },
        episode.project_hint.clone(),
    )
    .await
}

async fn get(call: &mut ToolCallContext<'_>, args: GetArgs) -> Result<Value, PortError> {
    let episode = load_episode(call, args.session.as_ref()).await?;
    let project = session::selected_project_for_episode(call, None, episode.as_ref()).await?;
    let inspection = inspect(call, &args.reference)
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    if !provider_ability_allowed(call, &inspection, project.as_ref()) {
        return Err(DomainError::ResourceNotFound.into());
    }
    let body = read_body(call, &inspection.descriptor, project.as_ref())
        .await
        .map_err(|error| collapse_provider_error(call, error))?;
    let mut bytes = body.instructions.len();
    let in_app = matches!(call.target, EgressTarget::InAppProvider { .. });
    if in_app && bytes > MAX_IN_APP_PACKAGE_BODY_BYTES {
        return Err(invalid(ValidationReason::BudgetExceeded));
    }
    let mut result = summary(
        &inspection,
        &body.description,
        inspection.binding_enabled && inspection.preference_enabled,
        matches!(call.target, EgressTarget::ExternalMcp),
    )?;
    result["instructions"] = json!(body.instructions);
    let mut files = Vec::new();
    let mut resources = Vec::new();
    for path in &inspection.descriptor.auxiliary_files {
        let resource = match read_owned_resource(
            call,
            &inspection.descriptor,
            project.as_ref(),
            AbilityResourceName::Auxiliary(path.clone()),
        )
        .await
        {
            Ok(resource) => resource,
            Err(error) if visible_error(&error) => continue,
            Err(error) => return Err(error),
        };
        bytes = bytes
            .checked_add(resource.text.len())
            .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
        if in_app && bytes > MAX_IN_APP_PACKAGE_BODY_BYTES {
            return Err(invalid(ValidationReason::BudgetExceeded));
        }
        call.record_origin(resource.origin, resource.project)?;
        files.push(path.clone());
        resources.push(json!({"path":path,"content":resource.text}));
    }
    result["auxiliaryFiles"] = json!(files);
    result["resources"] = json!(resources);
    let mut attachments = Vec::new();
    for dependency in &inspection.descriptor.attached_skills {
        let label = body
            .attachments
            .iter()
            .find(|attach| attach.identity == dependency.identity())
            .and_then(|attach| attach.label.clone());
        let mut child = current_skill(call, dependency, project.as_ref()).await?;
        if matches!(call.target, EgressTarget::InAppProvider { .. })
            && let Some(inspection) = &child
        {
            if !inspection.descriptor.healthy {
                child = None;
            } else {
                match read_body(call, &inspection.descriptor, project.as_ref()).await {
                    Ok(body) => call.record_origin(body.origin, body.project)?,
                    Err(error) if visible_error(&error) => child = None,
                    Err(error) => return Err(error),
                }
            }
        }
        let (status, reference) = match child {
            Some(inspection)
                if inspection.descriptor.healthy
                    && inspection.binding_enabled
                    && inspection.preference_enabled =>
            {
                ("healthy", inspection.descriptor.reference)
            }
            Some(inspection) => ("disabled", inspection.descriptor.reference),
            None => ("missing", dependency.clone()),
        };
        attachments.push(json!({"ref":reference_token(&reference)?,"label":label,"status":status}));
    }
    result["attachments"] = json!(attachments);
    call.record_origin(body.origin, body.project)?;
    Ok(result)
}

async fn current_skill(
    call: &ToolCallContext<'_>,
    reference: &AbilityRef,
    project: Option<&FolderRef>,
) -> Result<Option<AbilityInspection>, PortError> {
    let inspection = match call
        .registry
        .control
        .inspect_ability(call.account(), reference.identity())
        .await
    {
        Ok(inspection) if inspection.descriptor.kind == AbilityKind::Skill => inspection,
        Ok(_) => return Ok(None),
        Err(error) if visible_error(&error) => return Ok(None),
        Err(error) => return Err(error),
    };
    let mut inspection = inspection;
    if !provider_ability_allowed(call, &inspection, project) {
        return Ok(None);
    }
    if let AbilityProjects::Selected(projects) = &inspection.availability
        && !project.is_some_and(|project| projects.contains(project))
    {
        inspection.binding_enabled = false;
    }
    Ok(Some(inspection))
}

async fn resolve(
    call: &ToolCallContext<'_>,
    selector: &str,
    kind: AbilityKind,
    project: Option<FolderRef>,
) -> Result<AbilityDescriptor, PortError> {
    let resolved = resolve_selector_for_account(
        call.registry,
        &call.account(),
        selector,
        kind,
        project.clone(),
    )
    .await
    .map_err(|error| collapse_provider_error(call, error))?;
    let in_app = matches!(call.target, EgressTarget::InAppProvider { .. });
    let ability = match resolved {
        AbilityResolution::Resolved(ability) if ability.kind == kind => *ability,
        AbilityResolution::Disabled if !in_app => {
            return Err(invalid(ValidationReason::InvalidState));
        }
        AbilityResolution::Stale if !in_app => {
            return Err(invalid(ValidationReason::SourceMismatch));
        }
        _ => return Err(DomainError::ResourceNotFound.into()),
    };
    if in_app {
        let inspection = call
            .registry
            .control
            .inspect_ability(call.account(), ability.reference.identity())
            .await
            .map_err(|error| collapse_provider_error(call, error))?;
        if !provider_ability_allowed(call, &inspection, project.as_ref()) {
            return Err(DomainError::ResourceNotFound.into());
        }
    }
    Ok(ability)
}

pub(crate) async fn bind_chat_role(
    registry: &ToolRegistry,
    account: AccountContext,
    episode_id: &EpisodeId,
    selector: &str,
    project: Option<&FolderRef>,
    run: &AgentRunId,
) -> Result<(), PortError> {
    let ability = match resolve_selector_for_account(
        registry,
        &account,
        selector,
        AbilityKind::Role,
        project.cloned(),
    )
    .await?
    {
        AbilityResolution::Resolved(ability)
            if ability.kind == AbilityKind::Role && ability.healthy && ability.enabled =>
        {
            *ability
        }
        AbilityResolution::Disabled => return Err(invalid(ValidationReason::InvalidState)),
        AbilityResolution::Stale => return Err(invalid(ValidationReason::SourceMismatch)),
        _ => return Err(DomainError::ResourceNotFound.into()),
    };
    let episode = registry
        .control
        .get_episode(account.clone(), episode_id.clone())
        .await?;
    if episode.active_role.as_ref() == Some(&ability.reference)
        && episode.project_hint.as_ref() == project
    {
        return Ok(());
    }
    let key = super::derive_key(
        "notarium.chats.bind-role.v1",
        &[run.as_str().as_bytes(), episode_id.as_str().as_bytes()],
    );
    let mutation = EpisodeMutation::BindRole(BindEpisodeRole {
        episode: episode.id,
        expected: episode.revision,
        active_role: ability.reference,
        project_hint: project.cloned(),
    });
    let hash = super::derive_digest(
        "notarium.chats.bind-role-input.v1",
        &[&serde_json::to_vec(&mutation).map_err(|_| invalid(ValidationReason::InvalidState))?],
    );
    let principal = account.auth().principal().clone();
    registry
        .control
        .update_episode(
            account,
            AccountMutation {
                identity: AccountCommandIdentity {
                    owner: principal.clone(),
                    actor: principal,
                    expected: ControlRevision::ZERO,
                    key,
                    hash,
                },
                input: mutation,
            },
        )
        .await?;
    Ok(())
}

async fn use_ability(
    call: &mut ToolCallContext<'_>,
    name: ToolName,
    args: UseArgs,
) -> Result<Value, PortError> {
    let kind = if name == ToolName::UseRole {
        AbilityKind::Role
    } else {
        AbilityKind::Skill
    };
    let selector = match (args.role.or(args.skill), args.name) {
        (Some(selector), None) | (None, Some(selector)) => selector,
        _ => return Err(invalid(ValidationReason::InvalidQuery)),
    };
    let episode = load_episode(call, args.session.as_ref()).await?;
    let project =
        session::selected_project_for_episode(call, args.project.as_deref(), episode.as_ref())
            .await?;
    let descriptor = resolve(call, &selector, kind, project.clone()).await?;
    let rendered = activation(
        call,
        &descriptor,
        project.as_ref(),
        args.budget_tokens.unwrap_or(DEFAULT_ACTIVATION_TOKENS),
    )
    .await?;
    if kind == AbilityKind::Role
        && let Some(episode) = episode.as_ref()
        && call.auth.chat_audience() != Some(ChatAudience::Shared)
    {
        save_active_role(call, episode, &descriptor.reference, project).await?;
    }
    Ok(rendered)
}

pub(super) async fn activate_session_role(
    call: &mut ToolCallContext<'_>,
    episode: &AgentEpisode,
    explicit: Option<&str>,
) -> Result<Option<Value>, PortError> {
    let project = if explicit.is_some() {
        session::selected_project_for_episode(call, None, Some(episode)).await?
    } else {
        session::selected_project_for_hint(call, None, episode.project_hint.as_ref()).await?
    };
    let descriptor = if let Some(selector) = explicit {
        resolve(call, selector, AbilityKind::Role, project.clone()).await?
    } else {
        let Some(reference) = &episode.active_role else {
            return Ok(None);
        };
        call.registry
            .control
            .get_ability(call.account(), reference.clone(), project.clone())
            .await?
    };
    let body = read_body(call, &descriptor, project.as_ref()).await?;
    let budget = if body.instructions.len() <= MAX_ACTIVATION_TOKENS {
        DEFAULT_ACTIVATION_TOKENS.max(body.instructions.len())
    } else if explicit.is_some() {
        return Err(invalid(ValidationReason::BudgetExceeded));
    } else {
        return Ok(None);
    };
    let rendered = activation_with_body(call, &descriptor, project.as_ref(), body, budget).await?;
    if explicit.is_some() && call.auth.bearer_scope() != Some(BearerScope::Read) {
        save_active_role(call, episode, &descriptor.reference, project).await?;
    }
    Ok(Some(rendered))
}

#[derive(Serialize, Deserialize)]
struct EpisodeRolePlan {
    // Older journals fingerprinted the observed account revision. Preserve it on replay.
    account_revision: ControlRevision,
    update: EpisodeUpdate,
}

async fn save_active_role(
    call: &ToolCallContext<'_>,
    episode: &AgentEpisode,
    role: &AbilityRef,
    project: Option<FolderRef>,
) -> Result<(), PortError> {
    if matches!(call.auth.kind(), PrincipalKind::Keeper(_))
        || call.auth.chat_audience() == Some(ChatAudience::Shared)
        || call.auth.bearer_scope() == Some(BearerScope::Read)
    {
        return Err(DomainError::AccessDenied.into());
    }
    if call.auth.taint().is_tainted() {
        return Err(DomainError::CrossSpaceTainted.into());
    }
    if episode.active_role.as_ref() == Some(role) && episode.project_hint == project {
        return Ok(());
    }
    let plan: EpisodeRolePlan = call
        .journal("activate-role", || async {
            Ok(EpisodeRolePlan {
                account_revision: ControlRevision::ZERO,
                update: EpisodeUpdate {
                    episode: episode.id.clone(),
                    expected: episode.revision,
                    name: episode.name.clone(),
                    active_role: Some(role.clone()),
                    project_hint: project.clone(),
                    lifecycle: episode.lifecycle,
                },
            })
        })
        .await?;
    if plan.update.episode != episode.id
        || plan.update.active_role.as_ref() != Some(role)
        || plan.update.project_hint != project
    {
        return Err(invalid(ValidationReason::SourceMismatch));
    }
    call.registry
        .control
        .update_episode(
            call.account(),
            AccountMutation {
                identity: call.account_identity(plan.account_revision, "activate-role-effect", 0),
                input: EpisodeMutation::BindRole(BindEpisodeRole {
                    episode: plan.update.episode,
                    expected: plan.update.expected,
                    active_role: role.clone(),
                    project_hint: plan.update.project_hint,
                }),
            },
        )
        .await?;
    Ok(())
}

async fn activation(
    call: &mut ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    project: Option<&FolderRef>,
    budget: usize,
) -> Result<Value, PortError> {
    let body = read_body(call, descriptor, project).await?;
    activation_with_body(call, descriptor, project, body, budget).await
}

async fn activation_with_body(
    call: &mut ToolCallContext<'_>,
    descriptor: &AbilityDescriptor,
    project: Option<&FolderRef>,
    body: AbilityBody,
    budget: usize,
) -> Result<Value, PortError> {
    // Each UTF-8 byte can be a token in a byte-fallback tokenizer.
    let mut remaining = budget
        .checked_sub(body.instructions.len())
        .ok_or_else(|| invalid(ValidationReason::BudgetExceeded))?;
    let mut skills = Vec::new();
    let mut omitted = Vec::new();
    for dependency in &descriptor.attached_skills {
        let inspection = current_skill(call, dependency, project).await?;
        let mut added = false;
        if let Some(inspection) = inspection.as_ref()
            && inspection.binding_enabled
            && inspection.preference_enabled
            && inspection.descriptor.healthy
        {
            match read_body(call, &inspection.descriptor, project).await {
                Ok(child) if child.instructions.len() <= remaining => {
                    remaining -= child.instructions.len();
                    let row = json!({
                        "ref":reference_token(&inspection.descriptor.reference)?,
                        "name":inspection.descriptor.name,
                        "instructions":child.instructions,
                    });
                    call.record_origin(child.origin, child.project)?;
                    skills.push(row);
                    added = true;
                }
                Ok(_) => (),
                Err(error) if visible_error(&error) => (),
                Err(error) => return Err(error),
            }
        }
        if !added {
            omitted.push(reference_token(dependency)?);
        }
    }
    call.record_origin(body.origin, body.project)?;
    Ok(json!({
        "ref":reference_token(&descriptor.reference)?,
        "name":descriptor.name,
        "kind":kind_name(descriptor.kind),
        "instructions":body.instructions,
        "skills":skills,
        "omittedSkills":omitted,
    }))
}
